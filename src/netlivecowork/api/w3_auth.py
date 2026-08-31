"""W3 认证路由 — OAuth2 授权码流程，白名单校验走云端 /api/auth/precheck。

主窗口加载 W3 登录页 → 用户输入账号密码 → W3 回调带 code →
Electron 拦截回调提取 code → POST /w3/auth → 后端换 token + 获取用户信息 + 白名单校验。

access_token 仅在后端内部用于换取 userinfo，不返回前端、不落盘。
W3 身份凭证 = uid（工号）。
"""

from __future__ import annotations

import os
import logging
from typing import Any

import requests
import urllib3
from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/w3", tags=["w3-auth"])

W3_BASE_URL = os.getenv("W3_BASE_URL", "https://uniportal.huawei.com")
W3_CLIENT_ID = os.getenv("W3_CLIENT_ID", "com.huawei.ipmastercowork")
W3_CLIENT_SECRET = os.getenv("W3_CLIENT_SECRET", "com.huawei.ipmastercowork")
W3_SCOPE = os.getenv("W3_SCOPE", "base.profile")

COWORK_CLOUD_BASE_URL = os.getenv(
    "COWORK_CLOUD_BASE_URL", "https://ipmastercowork.gts.huawei.com"
)

WHITELIST_DENIED_MESSAGE = "用户权限不足，如需开通，请联系：李天宇 00485973"


def _exchange_w3_code(code: str, redirect_uri: str) -> dict[str, Any]:
    """用授权码换取 W3 access_token。"""
    resp = requests.post(
        f"{W3_BASE_URL}/saaslogin1/oauth2/accesstoken",
        json={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": W3_CLIENT_ID,
            "client_secret": W3_CLIENT_SECRET,
            "redirect_uri": redirect_uri,
        },
        timeout=15,
        verify=False,
    )
    resp.raise_for_status()
    data = resp.json()
    if data.get("errorCode"):
        raise RuntimeError(
            f"W3 token exchange failed: {data.get('errorCode')} - {data.get('errorMsg', '')}"
        )
    return data


def _get_w3_userinfo(access_token: str) -> dict[str, Any]:
    """用 access_token 获取 W3 用户信息。"""
    resp = requests.get(
        f"{W3_BASE_URL}/saaslogin1/oauth2/userinfo",
        params={
            "access_token": access_token,
            "scope": W3_SCOPE,
            "client_id": W3_CLIENT_ID,
        },
        timeout=15,
        verify=False,
    )
    resp.raise_for_status()
    data = resp.json()
    if data.get("errorCode"):
        raise RuntimeError(
            f"W3 userinfo failed: {data.get('errorCode')} - {data.get('errorMsg', '')}"
        )
    return data


def _check_whitelist(username: str) -> bool:
    """调用云端 POST /api/auth/precheck 检查用户是否在 User 白名单中。

    NEEDS_PASSWORD → 在白名单；NOT_ALLOWED 或其他 → 不在。网络异常 fail-closed。
    """
    if not username:
        return False
    try:
        resp = requests.post(
            f"{COWORK_CLOUD_BASE_URL}/api/auth/precheck",
            json={"username": username},
            timeout=15,
            verify=False,
        )
        resp.raise_for_status()
        return resp.json().get("status") == "NEEDS_PASSWORD"
    except Exception:
        return False


def _fetch_local_token(username: str) -> str:
    """调用云端 POST /api/auth/local-token 用工号换取 JWT 凭证。

    地端（W3）登录后用工号（uid）换取云端 JWT，供桌面端后续鉴权（skill 上传
    等）与 token 用量上报使用。失败时不阻断登录（uid 凭证仍可用），仅记日志
    并返回空串——桌面端会回退到 "w3:<uid>" 作为 Bearer 值。
    """
    if not username:
        return ""
    try:
        resp = requests.post(
            f"{COWORK_CLOUD_BASE_URL}/api/auth/local-token",
            json={"username": username},
            timeout=15,
            verify=False,
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("token") or data.get("accessToken") or data.get("access_token") or ""
    except Exception as e:
        logger.warning("[W3] 获取 local-token 失败，将回退 uid 凭证: %s", e)
        return ""


class WhitelistDeniedResponse(BaseModel):
    error: str = "not_in_whitelist"
    message: str = WHITELIST_DENIED_MESSAGE


class W3AuthRequest(BaseModel):
    code: str
    redirect_uri: str


@router.post("/auth")
async def w3_authenticate(request: Request):
    """接收 { code, redirect_uri } → 换 token + 获取用户信息 + 白名单校验。"""
    if not (W3_BASE_URL and W3_CLIENT_ID and W3_CLIENT_SECRET):
        raise HTTPException(status_code=501, detail="W3 认证未配置，请联系管理员")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request body")

    code = body.get("code") if isinstance(body, dict) else None
    redirect_uri = body.get("redirect_uri") if isinstance(body, dict) else None

    if not code:
        raise HTTPException(status_code=400, detail="Missing authorization code")
    if not redirect_uri:
        raise HTTPException(status_code=400, detail="Missing redirect_uri")

    try:
        token_data = _exchange_w3_code(code, redirect_uri)
        access_token = token_data.get("accessToken") or token_data.get("access_token") or ""
        if not access_token:
            raise HTTPException(status_code=401, detail="W3 token 响应无 accessToken")

        user_info = _get_w3_userinfo(access_token)
        uid = user_info.get("uid", "")
        if not uid:
            raise HTTPException(status_code=401, detail="W3 userinfo 返回无 uid")

        if not _check_whitelist(uid):
            logger.warning("[W3] 用户 %s 不在白名单中", uid)
            return WhitelistDeniedResponse()

        logger.info("[W3] 用户 %s 认证成功", uid)
        access_token = _fetch_local_token(uid)
        logger.info("[W3] local-token 获取结果: uid=%s, jwt_len=%d, jwt_preview=%s",
                    uid, len(access_token), access_token[:40] if access_token else "(空)")
        return {
            "uid": uid,
            "access_token": access_token,
            "user": {
                "id": uid,
                "username": uid,
                "displayName": user_info.get("displayName", uid),
                "email": user_info.get("email", ""),
            },
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("[W3] 认证失败: %s", e)
        raise HTTPException(status_code=401, detail=f"W3 认证失败: {e}")


class W3RefreshRequest(BaseModel):
    uid: str


@router.post("/refresh-token")
async def w3_refresh_token(req: W3RefreshRequest):
    """启动会话恢复时补 JWT：用地端已存的 uid 调云端 local-token 换取 JWT。

    场景：用户未退出登录直接关闭 Electron，重启后 getSessionW3 从 auth.bin
    恢复了 uid 但没有 JWT（旧版 session 或 JWT 为空）。此端点用 uid 补换 JWT，
    让 token-usage 上报和 skill 上传鉴权拿到真实凭证而非回退 w3:<uid>。
    """
    uid = req.uid
    if not uid:
        raise HTTPException(status_code=400, detail="Missing uid")
    access_token = _fetch_local_token(uid)
    logger.info("[W3] refresh-token: uid=%s, jwt_len=%d", uid, len(access_token))
    return {"access_token": access_token}

"""W3 认证路由 — OAuth2 授权码流程；白名单预检与 JWT 发放/续期走 substrate
（无 substrate 地址则回退 netcowork 云端，见 _auth_base_url / CLOUD_JWT_MIGRATION）。

主窗口加载 W3 登录页 → 用户输入账号密码 → W3 回调带 code →
Electron 拦截回调提取 code → POST /w3/auth → 后端换 token + 获取用户信息 + 白名单校验。

access_token 仅在后端内部用于换取 userinfo，不返回前端、不落盘。
W3 身份凭证 = uid（工号）；uuid（账号全球唯一识别码，换工号不变）随之上报，
供 substrate 以 uuid 为白名单/归属主键，换号自愈、免迁移。
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


def _auth_base_url() -> str:
    """用户令牌（JWT）发放/续期与白名单预检的目标地址。

    按 CLOUD_JWT_MIGRATION 平移方案：有 substrate 地址就打 substrate —— 它用
    同一把 ``JWT_SECRET`` 铸**字节兼容**的令牌，所有验签方零改动；没有则回退
    netcowork 云端。灰度/回退只改这一个来源（方案 §6）。substrate 地址由
    Electron 主进程按其解析结果注入 ``NLC_SUBSTRATE_BASE_URL``（每次现取，
    不缓存：它在启动时会被 force 复位）。空 = 该部署没有 substrate，回退云端。
    """
    substrate = (
        os.getenv("NLC_SUBSTRATE_BASE_URL") or os.getenv("SUBSTRATE_BASE_URL") or ""
    ).strip().rstrip("/")
    return substrate or COWORK_CLOUD_BASE_URL


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


def _check_whitelist(username: str, uuid: str = "") -> bool:
    """调用 POST /api/auth/precheck 检查用户是否在 User 白名单中。

    目标地址走 substrate（无则回退云端），见 ``_auth_base_url``。
    NEEDS_PASSWORD → 在白名单；NOT_ALLOWED 或其他 → 不在。网络异常 fail-closed。

    ``uuid``（账号全球唯一识别码，换工号不变）随 ``username``(uid) 一并上报：
    substrate 白名单投影以 uuid 为主键时据此命中，换号自愈、无需迁移；uuid 为空
    （scope 未返回）时省略该字段，substrate 回退按 username 匹配，行为不变。
    """
    if not username:
        return False
    try:
        payload: dict[str, Any] = {"username": username}
        if uuid:
            payload["uuid"] = uuid
        resp = requests.post(
            f"{_auth_base_url()}/api/auth/precheck",
            json=payload,
            timeout=15,
            verify=False,
        )
        resp.raise_for_status()
        return resp.json().get("status") == "NEEDS_PASSWORD"
    except Exception:
        return False


def _fetch_local_token(username: str, uuid: str = "") -> str:
    """调用 POST /api/auth/local-token 用工号换取 JWT 凭证。

    目标地址走 substrate（无则回退云端），见 ``_auth_base_url``；substrate 用
    同一把密钥铸字节兼容令牌，桌面端/agent/netcowork 验签均无感。
    地端（W3）登录后用工号（uid）换取 JWT，供桌面端后续鉴权（skill 上传
    等）与 token 用量上报使用。``uuid`` 随 uid 一并上报（换工号不变），供
    substrate 以 uuid 为主键铸令牌/归属；为空时省略，按 uid 处理，行为不变。
    失败时不阻断登录（uid 凭证仍可用），仅记日志并返回空串——桌面端会回退到
    "w3:<uid>" 作为 Bearer 值。
    """
    if not username:
        return ""
    try:
        payload: dict[str, Any] = {"username": username}
        if uuid:
            payload["uuid"] = uuid
        resp = requests.post(
            f"{_auth_base_url()}/api/auth/local-token",
            json=payload,
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

        # uuid：账号全球唯一识别码，换工号不变，必选字段（当前 scope 即返回）。
        # 无条件读出——既进返回体供前端持久关联，也随 uid 上报给 substrate。
        uuid = user_info.get("uuid", "")
        # displayName 不再 fallback 为 uid（工号），空就返空，避免把工号当姓名。
        display_name = user_info.get("displayName", "")
        email = user_info.get("email", "")
        # ⚠ 预留占位（未启用）：employeeNumber / employeeType 当前 scope=base.profile
        #   W3 不返回，`.get` 恒得 ""，仅在返回体占位、**不参与 substrate 上报**。
        #   TODO(issue #8 §4.2)：扩大 OAuth scope 后自动填充，届时删除本状态标记。
        employee_number = user_info.get("employeeNumber", "")
        employee_type = user_info.get("employeeType", "")

        if not _check_whitelist(uid, uuid):
            logger.warning("[W3] 用户 %s 不在白名单中", uid)
            return WhitelistDeniedResponse()

        logger.info("[W3] 用户 %s 认证成功", uid)
        access_token = _fetch_local_token(uid, uuid)
        logger.info("[W3] local-token 获取结果: uid=%s, uuid=%s, jwt_len=%d, jwt_preview=%s",
                    uid, uuid or "(空)", len(access_token), access_token[:40] if access_token else "(空)")
        return {
            "uid": uid,
            "uuid": uuid,
            "access_token": access_token,
            "user": {
                "id": uid,
                "username": uid,
                "displayName": display_name,
                "email": email,
                # 预留占位，扩 scope 前恒 ""（见上 TODO(issue #8 §4.2)）：
                "employeeNumber": employee_number,
                "employeeType": employee_type,
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

    此处**不带 uuid**：uuid 只在换工号那一刻的 W3 登录用来认人（见 netcowork
    doc/IDENTITY_SURROGATE_ANCHOR.md §2/§5）；会话恢复走的是旧 uid，substrate 保留
    旧 ``uid→surrogate`` 映射（含墓碑），旧 uid 补换的令牌仍解析到同一 surrogate，
    无需 uuid。
    """
    uid = req.uid
    if not uid:
        raise HTTPException(status_code=400, detail="Missing uid")
    access_token = _fetch_local_token(uid)
    logger.info("[W3] refresh-token: uid=%s, jwt_len=%d", uid, len(access_token))
    return {"access_token": access_token}

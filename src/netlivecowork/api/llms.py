"""LLM accounts API."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from . import cowork_bridge, deps
from .schemas.llms import (
    AddModelRequest,
    AvailableModelsResponse,
    ListModelsRequest,
    LLMAccountResponse,
    ModelConfigResponse,
    PingRequest,
    PingResponse,
    RegisterAccountRequest,
    SetDefaultModelRequest,
)

router = APIRouter(prefix="/llms", tags=["llms"])


def _to_response(account, *, locked: bool = False) -> LLMAccountResponse:
    return LLMAccountResponse(
        name=account.name,
        style=account.style,
        base_url=account.base_url,
        models=[
            ModelConfigResponse(
                name=m.name,
                context_limit=m.context_limit,
                output_reserve=m.output_reserve,
                output_ceiling=m.output_ceiling,
            )
            for m in account.models
        ],
        default_model=account.default_model,
        timeout_sec=account.timeout_sec,
        locked=locked,
    )


def _locked_account_names(provider) -> set[str]:
    """随包默认账号名（界面可见、显示真名可选，但禁止删除/编辑）。"""
    getter = getattr(provider, "locked_account_names", None)
    return getter() if callable(getter) else set()


@router.get("", response_model=list[LLMAccountResponse])
def list_accounts(
    cowork: str | None = None,
    provider=Depends(deps.get_llm_provider),
) -> list[LLMAccountResponse]:
    """列账号。给了 `cowork` 就只列它允许的那几个（套件 llm.allow）。

    **建会话/切模型时必须带上 cowork**：不带的话用户会选到一个这个 cowork 不允许的账号，
    等真发消息时才被拒，而那时他早已经选完、以为一切正常。配置页不带，因为那里管的是
    "这台机器上有哪些账号"，与归属无关。
    """
    # 默认账号不再隐藏：一并返回，用 locked 标记，让选择器显示、配置页自行过滤。
    locked = _locked_account_names(provider)
    accounts = provider.list_accounts()
    if cowork:
        # 只有**统一交付**的那批受 allow 约束（出厂 + 套件下发）。
        # 用户自己注册的账号是他自己机器上的东西，云端的清单没道理没收它。
        allowed = set(cowork_bridge.allowed_llm_accounts(
            cowork, [a.name for a in accounts], managed=provider.managed_account_names()))
        accounts = [a for a in accounts if a.name in allowed]
    return [_to_response(a, locked=a.name in locked) for a in accounts]


@router.post("", response_model=LLMAccountResponse, status_code=201)
def register_account(
    req: RegisterAccountRequest,
    provider=Depends(deps.get_llm_provider),
) -> LLMAccountResponse:
    from netlivecowork.providers.llm.llm_provider import LLMAccount, ModelConfig, SUPPORTED_STYLES

    if provider.is_registered(req.name):
        raise HTTPException(409, detail=f"Account '{req.name}' already registered")
    if req.style not in SUPPORTED_STYLES:
        raise HTTPException(400, detail=f"Unsupported style '{req.style}'. Must be one of: {SUPPORTED_STYLES}")

    account = LLMAccount(
        name=req.name,
        style=req.style,
        api_key=req.api_key,
        base_url=req.base_url,
        models=[
            ModelConfig(
                name=m.name,
                context_limit=m.context_limit or 128_000,
                output_reserve=m.output_reserve,   # None → core 按窗口尺寸取默认
                output_ceiling=m.output_ceiling,   # None → core 回退 context_limit
            )
            for m in req.models
        ],
        default_model=req.default_model,
        timeout_sec=req.timeout_sec or 120,
    )
    try:
        provider.register_account(account)
    except (KeyError, ValueError) as e:
        raise HTTPException(400, detail=str(e))
    return _to_response(account)


@router.get("/{name}", response_model=LLMAccountResponse)
def get_account(name: str, provider=Depends(deps.get_llm_provider)) -> LLMAccountResponse:
    try:
        acct = provider.get_account(name)
    except KeyError:
        raise HTTPException(404, detail=f"Account '{name}' not found")
    return _to_response(acct, locked=name in _locked_account_names(provider))


@router.delete("/{name}", status_code=204)
def delete_account(name: str, provider=Depends(deps.get_llm_provider)) -> None:
    if name in _locked_account_names(provider):
        raise HTTPException(403, detail="默认模型不可删除")
    try:
        provider.delete_account(name)
    except KeyError:
        raise HTTPException(404, detail=f"Account '{name}' not found")


@router.post("/{name}/models", response_model=LLMAccountResponse)
def add_model(
    name: str, req: AddModelRequest,
    provider=Depends(deps.get_llm_provider),
) -> LLMAccountResponse:
    if name in _locked_account_names(provider):
        raise HTTPException(403, detail="默认模型不可编辑")
    try:
        return _to_response(provider.add_model(
            name, req.model,
            context_limit=req.context_limit,
            output_reserve=req.output_reserve,
            output_ceiling=req.output_ceiling,
        ))
    except KeyError:
        raise HTTPException(404, detail=f"Account '{name}' not found")


@router.delete("/{name}/models", response_model=LLMAccountResponse)
def remove_model(
    name: str, req: AddModelRequest,
    provider=Depends(deps.get_llm_provider),
) -> LLMAccountResponse:
    if name in _locked_account_names(provider):
        raise HTTPException(403, detail="默认模型不可编辑")
    try:
        return _to_response(provider.remove_model(name, req.model))
    except KeyError:
        raise HTTPException(404, detail=f"Account '{name}' not found")


@router.put("/{name}/default_model", response_model=LLMAccountResponse)
def set_default_model(
    name: str, req: SetDefaultModelRequest,
    provider=Depends(deps.get_llm_provider),
) -> LLMAccountResponse:
    if name in _locked_account_names(provider):
        raise HTTPException(403, detail="默认模型不可编辑")
    try:
        return _to_response(provider.set_default_model(name, req.model))
    except KeyError:
        raise HTTPException(404, detail=f"Account '{name}' not found")
    except ValueError as e:
        raise HTTPException(400, detail=str(e))


# ── Connectivity / model discovery ───────────────────────────────────────────


_ERR_MAX = 300  # cap error reason length so a verbose API body doesn't bloat the response


def _trim(msg: str) -> str:
    return msg if len(msg) <= _ERR_MAX else msg[:_ERR_MAX] + "…"


@router.post("/ping", response_model=PingResponse)
async def ping(req: PingRequest, provider=Depends(deps.get_llm_provider)) -> PingResponse:
    """Probe ad-hoc credentials. When `model` is given, verify that model is callable
    (real minimal completion); otherwise just probe connectivity. Returns ok=false (200)
    on any failure, with `error` set, so the UI can show 'failed' rather than throwing."""
    try:
        if req.model:
            ms = await provider.verify_model(req.style, req.api_key, req.base_url, model=req.model)
        else:
            ms = await provider.ping(req.style, req.api_key, req.base_url)
        return PingResponse(ok=True, latency_ms=ms)
    except Exception as e:
        return PingResponse(ok=False, latency_ms=0.0, error=_trim(str(e)))


@router.post("/{name}/ping", response_model=PingResponse)
async def ping_account(
    name: str, model: str | None = None,
    provider=Depends(deps.get_llm_provider),
) -> PingResponse:
    """Probe a registered account. When `model` is given, verify that model is callable
    (real minimal completion); otherwise just probe connectivity."""
    try:
        if model:
            ms = await provider.verify_model_for_account(name, model)
        else:
            ms = await provider.ping_account(name)
        return PingResponse(ok=True, latency_ms=ms)
    except KeyError:
        raise HTTPException(404, detail=f"Account '{name}' not found")
    except Exception as e:
        return PingResponse(ok=False, latency_ms=0.0, error=_trim(str(e)))


@router.post("/available-models", response_model=AvailableModelsResponse)
async def available_models(
    req: ListModelsRequest, provider=Depends(deps.get_llm_provider),
) -> AvailableModelsResponse:
    try:
        models = await provider.fetch_models(req.style, req.api_key, req.base_url)
    except Exception as e:
        raise HTTPException(400, detail=str(e))
    return AvailableModelsResponse(models=models)


@router.get("/{name}/available-models", response_model=AvailableModelsResponse)
async def available_models_of(
    name: str, provider=Depends(deps.get_llm_provider),
) -> AvailableModelsResponse:
    try:
        models = await provider.fetch_models_for_account(name)
    except KeyError:
        raise HTTPException(404, detail=f"Account '{name}' not found")
    except Exception as e:
        raise HTTPException(400, detail=str(e))
    return AvailableModelsResponse(models=models)

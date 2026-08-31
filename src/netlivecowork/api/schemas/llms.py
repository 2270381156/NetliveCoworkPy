from __future__ import annotations

from pydantic import BaseModel


class ModelConfigRequest(BaseModel):
    name: str
    context_limit: int | None = None
    output_reserve: int | None = None    # 输入侧输出预留；None → core 按窗口尺寸取默认
    output_ceiling: int | None = None    # 单次输出收紧上限；None → core 回退 context_limit


class ModelConfigResponse(BaseModel):
    name: str
    context_limit: int
    output_reserve: int | None = None
    output_ceiling: int | None = None


class RegisterAccountRequest(BaseModel):
    name: str
    style: str
    api_key: str
    base_url: str = ""
    models: list[ModelConfigRequest] = []
    default_model: str = ""
    timeout_sec: int | None = None


class AddModelRequest(BaseModel):
    model: str
    context_limit: int | None = None
    output_reserve: int | None = None
    output_ceiling: int | None = None


class SetDefaultModelRequest(BaseModel):
    model: str


class LLMAccountResponse(BaseModel):
    name: str
    style: str
    base_url: str
    models: list[ModelConfigResponse]
    default_model: str
    timeout_sec: int
    # 随包默认账号：界面可见（选择器显示、可选），但禁止在配置页删除/编辑。
    locked: bool = False


class PingRequest(BaseModel):
    style: str
    api_key: str
    base_url: str = ""
    model: str | None = None  # when set, ping verifies this model is callable (not just connectivity)


class PingResponse(BaseModel):
    ok: bool
    latency_ms: float
    error: str | None = None  # failure reason when ok=False (for the UI to surface)


class ListModelsRequest(BaseModel):
    style: str
    api_key: str
    base_url: str = ""


class AvailableModelsResponse(BaseModel):
    models: list[str]

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class RegisterStdioRequest(BaseModel):
    name: str = Field(..., description="MCP server 唯一标识名")
    command: str = Field(..., description="可执行文件，如 'uvx' 或 'npx'")
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    default_purposes: list[str] = Field(default_factory=lambda: ["act"])
    timeout_per_call_sec: int = Field(default=60, ge=1)
    connect_timeout_sec: int = Field(default=10, ge=1)


class RegisterHttpRequest(BaseModel):
    name: str = Field(..., description="MCP server 唯一标识名")
    url: str = Field(..., description="MCP server HTTP 端点")
    headers: dict[str, str] = Field(default_factory=dict)
    default_purposes: list[str] = Field(default_factory=lambda: ["act"])
    timeout_per_call_sec: int = Field(default=60, ge=1)
    connect_timeout_sec: int = Field(default=10, ge=1)
    trust_env: bool = Field(
        default=False,
        description="是否信任环境代理/证书（HTTP_PROXY/SSL_CERT_FILE 等）；默认 false＝直连",
    )


class MCPToolResponse(BaseModel):
    name: str
    description: str


class MCPServerResponse(BaseModel):
    name: str
    type: str
    status: str
    tool_count: int = 0
    tools: list[str] = Field(default_factory=list)  # 工具名数组
    command: Optional[str] = None
    args: Optional[list[str]] = None
    url: Optional[str] = None
    timeout_per_call_sec: int = 60
    connect_timeout_sec: int = 10
    trust_env: bool = False

"""MCP Server management routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from . import deps
from .schemas.mcp import (
    MCPServerResponse,
    RegisterHttpRequest,
    RegisterStdioRequest,
)
from netlivecowork.providers.capability.mcp.manager import MCPServerInfo

router = APIRouter(prefix="/mcp-servers", tags=["mcp"])


def _to_response(info: MCPServerInfo) -> MCPServerResponse:
    return MCPServerResponse(
        name=info.name,
        type=info.type,
        status=info.status,
        tool_count=info.tool_count,
        tools=[t.name for t in info.tools],
        command=info.command,
        args=info.args,
        url=info.url,
        timeout_per_call_sec=info.timeout_per_call_sec,
        connect_timeout_sec=info.connect_timeout_sec,
        trust_env=info.trust_env,
    )


@router.post("/stdio", response_model=MCPServerResponse, status_code=201)
def register_stdio(
    req: RegisterStdioRequest,
    manager=Depends(deps.get_mcp_manager),
) -> MCPServerResponse:
    from ctx_weft.providers.capability_mcp.provider import MCPServerConfig
    config = MCPServerConfig(
        name=req.name, transport="stdio",
        command=[req.command] + req.args, env=req.env,
        default_purposes=req.default_purposes,
        timeout_per_call_sec=req.timeout_per_call_sec,
        connect_timeout_sec=req.connect_timeout_sec,
    )
    try:
        return _to_response(manager.register(config))
    except ValueError as e:
        raise HTTPException(status_code=409, detail={"code": "MCP_ALREADY_EXISTS", "message": str(e)})


@router.post("/http", response_model=MCPServerResponse, status_code=201)
def register_http(
    req: RegisterHttpRequest,
    manager=Depends(deps.get_mcp_manager),
) -> MCPServerResponse:
    from ctx_weft.providers.capability_mcp.provider import MCPServerConfig
    config = MCPServerConfig(
        name=req.name, transport="http", url=req.url, headers=req.headers,
        default_purposes=req.default_purposes,
        timeout_per_call_sec=req.timeout_per_call_sec,
        connect_timeout_sec=req.connect_timeout_sec,
        trust_env=req.trust_env,
    )
    try:
        return _to_response(manager.register(config))
    except ValueError as e:
        raise HTTPException(status_code=409, detail={"code": "MCP_ALREADY_EXISTS", "message": str(e)})


@router.get("", response_model=list[MCPServerResponse])
def list_mcp_servers(manager=Depends(deps.get_mcp_manager)) -> list[MCPServerResponse]:
    return [_to_response(info) for info in manager.list_all_info()]


@router.get("/{name}", response_model=MCPServerResponse)
def get_mcp_server(name: str, manager=Depends(deps.get_mcp_manager)) -> MCPServerResponse:
    try:
        return _to_response(manager.get_info(name))
    except KeyError as e:
        raise HTTPException(status_code=404, detail={"code": "MCP_NOT_FOUND", "message": str(e)})


@router.delete("/{name}", status_code=204)
def delete_mcp_server(name: str, manager=Depends(deps.get_mcp_manager)) -> None:
    try:
        manager.deregister(name)
    except KeyError as e:
        raise HTTPException(status_code=404, detail={"code": "MCP_NOT_FOUND", "message": str(e)})


@router.post("/{name}/refresh", response_model=MCPServerResponse)
async def refresh_mcp_server(name: str, manager=Depends(deps.get_mcp_manager)) -> MCPServerResponse:
    try:
        return _to_response(await manager.refresh(name))
    except KeyError as e:
        raise HTTPException(status_code=404, detail={"code": "MCP_NOT_FOUND", "message": str(e)})

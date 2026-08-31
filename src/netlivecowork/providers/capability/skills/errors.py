"""Skill management errors + HTTP status mapping."""

from __future__ import annotations


class SkillError(Exception):
    """Domain error carrying a stable code and a human message."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


ERROR_STATUS: dict[str, int] = {
    "LOCAL_SKILL_NOT_FOUND": 404,
    "LOCAL_SKILL_INVALID_ID": 400,
    "LOCAL_SKILL_DELETE_FAILED": 500,
    "PULL_SERVER_NOT_CONFIGURED": 400,
    "PULL_SERVER_UNREACHABLE": 502,
    "PULL_SERVER_ERROR": 502,
    "SKILL_NAME_EXISTS": 409,          # 上传时市场已有同名 skill（前端本地化友好提示）
    "REMOTE_SKILL_NOT_FOUND": 404,
    "MYTHOS_UNREACHABLE": 502,
    "MYTHOS_ERROR": 502,
    "MYTHOS_SKILL_EMPTY": 422,
    "UNKNOWN_SOURCE": 400,
    "PULL_EXTRACT_FAILED": 500,
    "IMPORT_INVALID_ZIP": 400,
    "IMPORT_INVALID_YAML": 400,
    "IMPORT_MISSING_SKILL_MD": 400,
    "IMPORT_MISSING_NAME": 400,
    "IMPORT_MISSING_DESCRIPTION": 400,
    "IMPORT_EXTRACT_FAILED": 500,
}

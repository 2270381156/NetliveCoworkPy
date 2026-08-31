"""把一条 bash 命令分类为 ALLOW / CONFIRM / DENY（纯函数，无 I/O）。

复用 ctx_weft 的分段/取词逻辑（处理链式、VAR= 前缀、绝对路径、.exe 后缀），
对每段独立判定。判定优先级：危险 CONFIRM > 路径越界 CONFIRM > ALLOW。

已知限制（v1 accepted）：
  解释器包装命令（powershell / pwsh / cmd -c / bash -c / sh -c）会把内部命令词
  隐藏在字符串参数里，per-segment 分类只能看到包装词本身（如 powershell → ALLOW），
  无法感知内层动词。这是刻意接受的限制，原因：
    (a) bash_exec 工具描述已推荐用 powershell -Command "…" 执行 PowerShell 语法，
        若对包装词一刀切 CONFIRM 会让该功能失效；
    (b) 本环境处于内网隔离，内层网络命令即使绕过分类也实际失败；
    (c) 致命硬黑名单与 $(...) 块仍无条件生效，不受此限制影响。
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from enum import Enum

from ctx_weft.providers.capability_filesystem._bash_safety import (
    command_word,
    split_segments,
)


class Verdict(Enum):
    ALLOW = "allow"
    CONFIRM = "confirm"
    DENY = "deny"


@dataclass
class Decision:
    verdict: Verdict
    reason: str = ""                       # DENY 时回灌给 LLM 的说明（面向模型，非 UI）
    # CONFIRM 时命中的风险点：(命中的命令词, 风险代码)。命令词供前端显示；code 供前端取 i18n 文案。
    # 越界路径没有命令词 → ("", "outside_workspace")。
    hits: list[tuple[str, str]] = field(default_factory=list)


# 删除/移动 + 提权/系统配置 → 人工确认。key=命令词，value=风险「代码」（语言无关）。
# 前端据代码在 i18n 里取中英文文案（见 frontend i18n 的 warn.bash.* / ChatPanel）。
# 同义命令归到同一代码（如 rm 与 Remove-Item 都是 "delete"）→ 一条命令里出现多个同义词也只提示一次。
_DANGEROUS: dict[str, str] = {
    # 删除
    "rm": "delete", "rmdir": "delete", "del": "delete", "erase": "delete",
    "remove-item": "delete", "ri": "delete", "rd": "delete", "rdir": "delete",
    # 移动/重命名
    "mv": "move", "move": "move", "ren": "move", "rename": "move",
    "move-item": "move", "mi": "move", "rename-item": "move", "rni": "move",
    # 复制/清空（PowerShell）
    "copy-item": "copy", "cpi": "copy",
    "clear-content": "clear", "clc": "clear",
    # 提权
    "sudo": "privilege", "su": "privilege",
    # 权限/属主
    "chmod": "chmod", "chown": "chown", "icacls": "acl", "takeown": "takeown",
    "passwd": "passwd",
    # 系统配置
    "reg": "registry", "sc": "service", "net": "netconfig", "netsh": "network",
    "schtasks": "schedule", "crontab": "schedule", "at": "schedule",
    "setx": "env", "bcdedit": "boot",
}

# 越界（路径在工作区之外）的风险代码。
_OUTSIDE_WORKSPACE_CODE = "outside_workspace"

# 像绝对路径的 token：C:\..、C:/..、\Windows..(单反斜杠=当前盘根绝对路径)、\\share(UNC)、/usr/..。
# 注意用【单个】前导反斜杠：Windows 的 "\Windows\System32" 是盘根绝对路径（工作区外），
# 且 POSIX bash 里 "\/etc" 转义后即 "/etc"——两者都应判越界，故不能只认双反斜杠。
# 但单反斜杠 / 正斜杠后【紧跟双引号】的不算路径：那是深层嵌套命令（powershell/python -c ...）
# shlex 切词产出的【引号转义残渣】（如收尾的 \" 被切成 token \""），会被误当盘根绝对路径 →
# 误报越界（真实路径往往被引号裹着、根本没被当路径查，纯属被残渣误伤）。用否定环视只排除 "，
# 不误伤 \Windows、\$Recycle.Bin、\\server、/etc、/@dir 等真实路径（" 在 Windows 文件名里非法）。
_ABS_PATH = re.compile(r'^([A-Za-z]:[\\/]|\\(?!")|/(?!"))')

# Shell 重定向运算符前缀（如 >file、>>file、<file），可粘连在路径前面。
_REDIRECT_PREFIX = re.compile(r"^>{1,2}|^<")

# Windows 命令开关（如 cd /d、dir /s、del /q、cmd /c、/a:h），形如 /<单字母>[:值]。
# 这类 token 以 `/` 开头会被 _ABS_PATH 误判成 POSIX 绝对路径（如 /d → C:\d → 越界）→ 假触发确认。
# 真 POSIX 绝对路径（/etc、/usr/bin）组件名 ≥2 字符或含更多 `/`，不会匹配此式，仍按越界判定。
_WIN_SWITCH = re.compile(r"^/[A-Za-z](:.*)?$")


def _looks_outside_workspace(
    token: str, workspace: str | None, allowed_roots: tuple[str, ...] = (),
) -> bool:
    """token 是否指向 workspace（及额外合法根）之外（绝对路径或 .. 越界）。全无已知根时,任何绝对路径/.. 视为越界。

    allowed_roots：workspace 之外仍应视为「区内」的目录（如全应用共享 venv——它在工作区外，但
    pip/python 引用其绝对路径是合法操作，不该在半自动/人工审核里弹越界确认）。命中任一根即区内。
    """
    if _WIN_SWITCH.match(token):
        return False  # Windows 开关（/d /s /q /c ...），非路径
    if token.strip("/\\") == "":
        return False  # 仅由分隔符组成（裸 '/' 除法运算符、'\\' 等），不是真实路径
    has_parent = ".." in token.replace("\\", "/").split("/")
    is_abs = bool(_ABS_PATH.match(token))
    if not is_abs and not has_parent:
        return False
    # 容器集合：工作区 + 额外合法根。命中任一 → 区内；一个都不命中 → 越界。
    roots = ([workspace] if workspace is not None else []) + list(allowed_roots)
    if not roots:
        return True  # 无任何已知根 → 保守视为越界
    try:
        anchor = workspace if workspace is not None else roots[0]
        target = os.path.normcase(os.path.abspath(
            token if is_abs else os.path.join(anchor, token)))
    except (ValueError, OSError):
        return True  # target 本身非法 → 保守视为越界
    for r in roots:
        # 每个根独立判定：commonpath 对【不同盘符】会抛 ValueError（Win 上工作区在 D:、
        # 共享 venv 在 C: 很常见）。必须逐根 try，跨盘符的根跳过、继续看下一个，
        # 否则一个跨盘根就会中断整轮、令后面的合法根（venv）漏检 → 白名单静默失效。
        try:
            rr = os.path.normcase(os.path.abspath(r))
            if os.path.commonpath([rr, target]) == rr:
                return False
        except (ValueError, OSError):
            continue  # 该根跨盘符/非法 → 不算命中，看下一个根
    return True  # 一个根都没命中 → 越界


def is_outside_workspace(
    path: str, workspace: str | None, allowed_roots: tuple[str, ...] = (),
) -> bool:
    """Public: True if a single path argument resolves outside *workspace* (and *allowed_roots*).

    Relative paths anchor to the workspace (always inside); absolute paths and
    ``..`` traversal are checked for containment. *allowed_roots* are extra dirs
    (e.g. the shared venv) treated as inside. When no root is known, any absolute
    path / ``..`` is treated as outside (conservative)."""
    return _looks_outside_workspace(path, workspace, allowed_roots)


def _strip_quotes(tok: str) -> str:
    """去掉整体包裹的成对引号。shlex(posix=False) 为保留反斜杠不吃转义，会把引号原样留在 token 里
    （如 ``"/etc/passwd"``、``"C:\\Program Files\\x"``），导致 _ABS_PATH 匹配不到、越界检测失效。
    Windows 带空格的路径几乎都要加引号，故必须去掉外层引号再判定。"""
    if len(tok) >= 2 and tok[0] == tok[-1] and tok[0] in ("'", '"'):
        return tok[1:-1]
    return tok


def _path_tokens(segment: str) -> list[str]:
    """Return tokens from *segment*, stripping any leading redirect operator (>/>>/&lt;) and
    surrounding quotes so that redirect-glued / quoted paths like ``>C:\\Windows\\x`` or
    ``"/etc/passwd"`` are still checked as real paths."""
    try:
        import shlex
        raw = shlex.split(segment, posix=False)
    except ValueError:
        raw = segment.split()
    return [_strip_quotes(_REDIRECT_PREFIX.sub("", tok)) for tok in raw]


def classify(command: str, workspace: str | None, allowed_roots: tuple[str, ...] = ()) -> Decision:
    if not command.strip():
        return Decision(Verdict.ALLOW)
    hits: list[tuple[str, str]] = []  # (命令词, 风险代码)，按命令词保序去重
    seen: set[str] = set()
    outside = False
    for segment in split_segments(command):
        word = command_word(segment)
        if word and word in _DANGEROUS and word not in seen:
            seen.add(word)
            hits.append((word, _DANGEROUS[word]))
        for tok in _path_tokens(segment):
            if _looks_outside_workspace(tok, workspace, allowed_roots):
                outside = True
                break
    if outside:
        hits.append(("", _OUTSIDE_WORKSPACE_CODE))
    if hits:
        return Decision(Verdict.CONFIRM, hits=hits)
    return Decision(Verdict.ALLOW)

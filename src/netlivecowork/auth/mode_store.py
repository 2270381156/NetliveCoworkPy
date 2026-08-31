"""按 session 维护 bash 审核模式（semiauto/manual/strict-auto）。文件持久化，跨重启保留。

- semiauto   ：半自动——ALLOW 直接放行、CONFIRM 弹确认（只有风险命令打扰）。前端显示「半自动模式」。
- manual     ：人工审核——连 ALLOW 也强制确认（什么都过一遍）。前端显示「人工审核」。
- strict-auto：全自动——不打扰、不等人，准入层一律放行，边界全交给 OS 完整性
               （见《全自动模式安全设计》§4）。仅当 OS 边界就位时才应放开（§7）。前端显示「自动模式」。

隔离原则（关键）：模式是**每会话独立**的。落盘到 `<data>/bash_review_modes.json`：
    { "sessions": { "<session_id>": "<mode>" } }
  - 每个会话记住**自己**的模式，跨重启保留、互不影响；
  - 没设过的会话（含新会话、存量会话）→ 一律回落固定默认 **semiauto**（安全档），**不会**继承
    别的会话的选择。故某会话切到全自动，绝不影响其它会话——这就是"隔离"。

> 历史坑：早期版本让 `set()` 把全局默认也改成"最近一次选择"，导致某会话选了 strict-auto 后、
> 重启时所有未单独设过的会话都变全自动。已移除该粘性默认逻辑；旧 json 里残留的 `default` 字段
> 被忽略、下次保存时清掉。

`semiauto` 旧名为 `auto`，为消除与 strict-auto 的歧义已改名。
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Literal

logger = logging.getLogger(__name__)

BashReviewMode = Literal["semiauto", "manual", "strict-auto"]
_VALID = ("semiauto", "manual", "strict-auto")
_DEFAULT = "semiauto"   # 未设过的会话一律回落这个（固定，不随任何会话的选择变）


class BashReviewModeStore:
    def __init__(self, path: str | Path | None = None) -> None:
        self._path = Path(path) if path else None
        self._modes: dict[str, str] = {}
        self._load()

    # ── 持久化 ────────────────────────────────────────────────────────────────
    def _load(self) -> None:
        if not self._path or not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            # 只读每会话的模式；旧版的全局 "default" 字段一律忽略（那是导致跨会话串味的粘性默认）。
            self._modes = {
                k: v for k, v in (data.get("sessions") or {}).items() if v in _VALID
            }
        except Exception:
            logger.warning("bash 模式持久化文件读取失败，回落默认: %s", self._path, exc_info=True)

    def _save(self) -> None:
        if not self._path:
            return
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            payload = json.dumps({"sessions": self._modes}, ensure_ascii=False)
            tmp = self._path.with_suffix(self._path.suffix + ".tmp")
            tmp.write_text(payload, encoding="utf-8")
            tmp.replace(self._path)   # 原子替换，避免半写文件
        except Exception:
            logger.warning("bash 模式持久化写入失败: %s", self._path, exc_info=True)

    # ── 读写（每会话独立）──────────────────────────────────────────────────────
    def get(self, session_id: str) -> str:
        """该会话的模式；没记录过（含新会话/存量会话）→ 固定回落 semiauto，不继承别的会话。"""
        return self._modes.get(session_id, _DEFAULT)

    def set(self, session_id: str, mode: str) -> None:
        """只改这一个会话的模式并落盘，绝不动其它会话、也不改全局默认。"""
        if mode not in _VALID:
            raise ValueError(f"mode must be one of {_VALID}, got {mode!r}")
        self._modes[session_id] = mode
        self._save()

    def default(self) -> str:
        """新/未设会话的默认模式——固定 semiauto（不随任何会话的选择变）。"""
        return _DEFAULT

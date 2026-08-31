"""会话归属 —— **这条会话属于哪个 cowork**。

## 能力属于 cowork，不属于会话

会话只**表明身份**：像工牌不拥有门禁权限、是部门拥有，工牌只用来查你属于哪个部门。
归属已经在套件里声明过一次（`mcp.use` / `llm.allow`），**不再造第二套归属表** ——
造了就有两个真值源，而它们必然在某个分支上不一致。

## 为什么需要这张表

provider 被调用时手里**只有 `ctx.session_id`**：

    async def list(self, ctx: ProviderContext) -> list[Capability]
                        ↑ session_id / tenant_id / task_id …，没有 cowork

内核不认识 cowork（它只有"模板"），且内核构造 ctx 时 `extra` 恒为空字典、host 碰不到，
所以"谁属于谁"只能由我们自己记。

## 为什么是会话粒度

cowork 在建会话时随 `template_id` 定死、之后不变；而界面上的"当前 cowork"随时可切。
若按当前 cowork 取能力：

    用户在 A 下开了条会话跑长任务 → 切到 B 去干别的
      → 后台那条 A 会话下一轮取工具时拿到 B 的能力

**它会中途换一套能力，而用户什么都没做**，会话记录里写的还是 A（需求 G3）。

## ⚠ 正确性不依赖"每条创建路径都记得登记"

重启后从库里恢复的会话**没走过创建路径**。漏掉它们的表现是那些会话看得见全部能力，
**而且不报错**。所以查不到登记时会回查会话自己的模板 —— 登记因此退化成缓存：
快，但不是唯一来源。
"""
from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from pathlib import Path

from . import installed
from .manifest import Cowork, bare_id

logger = logging.getLogger(__name__)


class CoworkScope:
    """会话归属登记表 + 按归属回答"这个 cowork 拥有什么"。

    线程安全：会话创建走 API 线程、能力枚举走执行循环，两边都碰这张表。
    """

    def __init__(
        self,
        coworks_dir: Path,
        resolver: Callable[[str], str | None] | None = None,
    ) -> None:
        self._dir = Path(coworks_dir)
        self._lock = threading.RLock()
        self._by_session: dict[str, str] = {}
        self._suites: dict[str, Cowork] = {}
        self._resolver = resolver
        self.reload()

    # ── 套件 ──────────────────────────────────────────────────────────────────

    def reload(self) -> None:
        """重读已装套件。**安装/收回之后必须调**，否则能力判断停在旧快照上。"""
        with self._lock:
            self._suites = {c.id: c for c in installed.list_all(self._dir)}

    def installed_ids(self) -> frozenset[str]:
        with self._lock:
            return frozenset(self._suites)

    def suite(self, cowork_id: str | None) -> Cowork | None:
        """按 id 直接取。给"还没有会话、只知道是哪个 cowork"的场景用（如按 cowork 过滤账号）。"""
        if not cowork_id:
            return None
        with self._lock:
            return self._suites.get(bare_id(cowork_id))

    # ── 会话归属 ──────────────────────────────────────────────────────────────

    def bind(self, session_id: str, template_id: str | None) -> None:
        """登记这条会话属于哪个 cowork。模板标识带不带前缀都行。

        **认不出就不登记**（模板不在已装套件里，比如历史会话的母版模板）。
        "不登记"与"登记成某个 cowork"必须分开：前者是"不知道"，后者是"知道且是它"。
        混同的话，历史会话会莫名其妙地继承某个 cowork 的能力。
        """
        cid = bare_id(str(template_id or "")).strip()
        if not cid or not session_id:
            return
        with self._lock:
            if cid not in self._suites:
                logger.debug("cowork：会话 %s 的模板 %r 不在已装套件里，不登记", session_id, cid)
                return
            self._by_session[session_id] = cid

    def unbind(self, session_id: str) -> None:
        """**必须带注销**（需求 G4），会话结束时调。不注销的话这张表会随会话数无限长。"""
        with self._lock:
            self._by_session.pop(session_id, None)

    def set_resolver(self, resolver: Callable[[str], str | None] | None) -> None:
        """装配回查函数（会话注册表建好之后调）。"""
        with self._lock:
            self._resolver = resolver

    def cowork_of(self, session_id: str | None) -> Cowork | None:
        """这条会话属于哪个 cowork。查不到登记就回查会话自己的模板。"""
        if not session_id:
            return None
        with self._lock:
            cid = self._by_session.get(session_id)
            if cid is not None:
                return self._suites.get(cid)
            resolver, suites = self._resolver, self._suites

        if resolver is None:
            return None
        # ⚠ 回查在锁外做：resolver 会去读会话注册表，**持锁调用外部代码容易把两把锁绕成死锁**。
        try:
            raw = resolver(session_id)
        except Exception:
            logger.debug("cowork：回查会话 %s 的模板失败", session_id, exc_info=True)
            return None

        cid = bare_id(str(raw or "")).strip()
        if not cid or cid not in suites:
            return None
        with self._lock:
            self._by_session[session_id] = cid      # 缓存，下次不再回查
        return suites.get(cid)

    def cowork_id_of(self, session_id: str | None) -> str:
        """归属 id；不知道就是空串。**空串不表示"属于所有人"**（见 policy）。"""
        c = self.cowork_of(session_id)
        return c.id if c else ""

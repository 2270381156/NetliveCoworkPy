"""旧名兼容层：capability id ``fs:bash_exec`` → 更名后的 ``fs:shell``。

工具原名 ``bash_exec``，v0.4.23 在 ctx_weft 内核更名为 ``shell``（名字更诚实——实际跑
cmd.exe / /bin/sh，从不是 bash）。内核已彻底移除对旧名的任何感知；但存量数据仍写旧 id：

  - 暂停会话里 HITL 待放行项的 ``capability_id``；
  - AppData 里 SOUL.md / 授权登记。

这些在 resume 时按旧 id 派发与鉴权，故由「服务层外壳」在装配 runtime 时兜底：

  - 鉴权：``set_capability_authorizer(FS_BASH_EXEC, ...)``（见 cli.py）。
  - 派发：本模块的 provider 子类在 ``invoke`` 处把旧 id 归一到 ``fs:shell``。

新代码一律用 ``FsTool.SHELL``；旧 id 只应出现在存量数据与本兼容层。
"""

from __future__ import annotations

import dataclasses
from collections.abc import Callable
from typing import Any

from ctx_weft.protocols.context import ProviderContext
from ctx_weft.protocols.filesystem import FS_PROVIDER_NAME, FsTool
from ctx_weft.providers.capability_filesystem import FilesystemToolsProvider
from ctx_weft.providers.capability_filesystem._bash_safety import BASH_BLACKLIST

from netlivecowork.low_integrity.env import LowIntegrityLayout
from netlivecowork.low_integrity.low_shell import make_shell_invoker

# 旧 capability id（原 FsTool.BASH_EXEC；已从内核移除，改由服务层持有）。
FS_BASH_EXEC = f"{FS_PROVIDER_NAME}:bash_exec"


class BashExecAliasFilesystemProvider(FilesystemToolsProvider):
    """app 侧 fs provider 子类：① 旧名归一 ``fs:bash_exec`` → ``fs:shell``；② strict-auto
    会话的 低完整性边界执行（不动内核，全靠子类覆盖 ``_build_invokers`` 注入 shell 包装）。

    ① 内核只按更名后的 ``shell`` 注册与广告能力，存量数据里的旧 id 若直接派发会命中
       UNKNOWN_CAPABILITY，故 ``invoke`` 处把旧 id 归一。
    ② ``_build_invokers`` 把父类的 ``shell`` invoker 包一层：登记为低完整性的会话走 Low 令牌执行，
       其余原样委托父类 invoker（零行为差异）。低完整性登记表由 host 在会话绑定时按平台/模式填充。
    """

    def __init__(self, config=None) -> None:
        # 必须先于 super().__init__()——父类构造里就会调用 _build_invokers()，
        # 而包装用的 _resolve_layout 会惰性读这张表。
        self._low_integrity_layouts: dict[str, LowIntegrityLayout] = {}
        super().__init__(config)

    # ── 低完整性登记（host 接线用；strict-auto + Windows 会话在绑定时登记）────────────────
    def register_low_integrity(self, session_id: str, layout: LowIntegrityLayout) -> None:
        """把某会话标记为 低完整性边界会话（其 shell 走 Low 令牌）。目录标 Low 由 host 负责。"""
        self._low_integrity_layouts[session_id] = layout

    def deregister_low_integrity(self, session_id: str) -> None:
        self._low_integrity_layouts.pop(session_id, None)

    def deregister_session(self, session_id: str) -> None:
        # 会话结束（core 调用）：连带清掉低完整性登记 + 停掉 Office broker，避免残留进程抱着 Excel。
        self._low_integrity_layouts.pop(session_id, None)
        try:
            from netlivecowork.office_broker import manager as office_manager
            office_manager.stop_broker(session_id)
        except Exception:   # noqa: BLE001 — 收摊失败不该拖垮会话结束
            pass
        super().deregister_session(session_id)

    def _resolve_layout(self, session_id: str) -> LowIntegrityLayout | None:
        return self._low_integrity_layouts.get(session_id)

    def registered_workspace(self, session_id: str) -> str | None:
        """该 session 已登记的工作目录绝对路径（供低完整性接线用；未登记返回 None）。"""
        return self._workspaces.get(session_id)

    def _build_invokers(self) -> dict[str, Callable]:
        invokers = super()._build_invokers()
        kernel_shell = invokers.get(FsTool.SHELL.split(":")[-1])
        if kernel_shell is not None:
            invokers[FsTool.SHELL.split(":")[-1]] = make_shell_invoker(
                kernel_shell, self._resolve_layout,
            )
        return invokers

    async def list(self, ctx: ProviderContext):
        """在父类能力清单基础上，把 shell 工具描述里的「被拦命令」列表对齐成 app 真正生效的黑名单。

        内核 `_shell_description()` 把**内核默认** `BASH_BLACKLIST`（含 curl/wget/rm/sudo…）写进
        给模型看的描述，但本 app 执行期用的是覆盖后的 `bash_blacklist`（FATAL_ONLY，只含
        format/dd/shutdown…）。两者不一致会让模型「以为 curl 被拦、实测却能跑」。这里把描述里
        那串默认名单替换成实际名单——纯文字，不动任何拦截逻辑，只是让「说的」等于「做的」。
        """
        caps = await super().list(ctx)
        actual = self._cfg.bash_blacklist
        if actual is None:
            return caps  # 未覆盖执行期黑名单 → 描述用的内核默认就是实际执行的，本就一致
        kernel_str = ", ".join(sorted(BASH_BLACKLIST))
        app_str = ", ".join(sorted(actual))
        if kernel_str == app_str:
            return caps
        return [
            dataclasses.replace(c, description=c.description.replace(kernel_str, app_str))
            if c.description and kernel_str in c.description else c
            for c in caps
        ]

    def invoke(
        self,
        capability_id: str,
        arguments: dict[str, Any],
        ctx: ProviderContext,
    ):  # -> AsyncIterator[CapabilityEvent]
        if capability_id == FS_BASH_EXEC:
            capability_id = FsTool.SHELL
        return super().invoke(capability_id, arguments, ctx)

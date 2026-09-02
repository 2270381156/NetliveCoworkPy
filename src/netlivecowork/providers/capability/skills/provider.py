"""ReferencedSkillCapabilityProvider — 云端「引用式」skill 的三层实现。

与 LocalSkillCapabilityProvider（本地目录、永久存）并存、互不干扰：
  * Level 1 (list)：从引用库出，**mythos 按当前登录用户过滤**（skill 可见性因人而异）；
  * Level 2/3：用时才把 zip 下载解压到系统临时区（materialize），委托一个**临时**
    LocalSkillCapabilityProvider 执行读取/脚本，**用完即删**（激进删除、不长存）。

mythos 下载用**当前登录用户名**（防越权，非引用里的 owner）；owner 只用于列表过滤。
下载失败（离线等）→ 写日志 + 向 LLM 返回说明，不崩。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import shutil
import tempfile
from collections.abc import AsyncIterator, Callable
from pathlib import Path

from ctx_weft.protocols.capability import (
    Capability,
    CapabilityProviderInfo,
    SkillCapability,
    SkillCapabilityProvider,
    SkillDefinition,
    qualify,
)
from ctx_weft.protocols.context import ProviderContext
from ctx_weft.protocols.capability import CapabilityEvent  # noqa: F401  (type for bash_runner)
from ctx_weft.providers.capability_skill_local import LocalSkillCapabilityProvider

from . import current_user
from .adapters import registry as market_registry
from .errors import SkillError
from .services.market import SkillMarketService
from .runtime.materialize import sweep_session, temp_root
from .references.store import SkillReference, SkillReferenceStore
from .runtime.reporting import (
    capture_referenced_skill_reporting,
    discard_session_reporting,
)
from .runtime.zip_utils import extract_zip

logger = logging.getLogger(__name__)

PROVIDER_NAME = "cloud_skill"

# LLM 可见的工具名，与 core 侧同一口径（provider:tool → provider__tool）。
_DELEGATE_TASK_NAME = qualify("control:delegate_task")
_SKILL_READ_FILE_NAME = qualify("skill_executor:read_file")
_SKILL_LIST_FILES_NAME = qualify("skill_executor:list_files")
_SKILL_EXEC_SCRIPT_NAME = qualify("skill_executor:exec_script")


# composer 把它渲染成 "#### cloud_skill skills" 标题下的引子段。与 local_skill 的组描述
# （ctx_weft.providers.capability_skill_local.SKILL_PROVIDER_DESCRIPTION）同一口径、同样进
# prompt，故一并用英文；只多一句「用时才从云端取、用完即删」的自身语义。
SKILL_PROVIDER_DESCRIPTION = (
    "Skills referenced from the cloud market: fetched on demand when a task uses one, and "
    "removed afterwards. Skills are instruction bundles, not callable tools — never invoke a "
    f"skill name as a tool. To run one, delegate a task bound to it: {_DELEGATE_TASK_NAME}(..., "
    f"skill_name='{PROVIDER_NAME}__<name>'). The skill's instructions are then loaded into that "
    "task. Inside such a task, reach the skill's own files only through the skill_executor tools "
    f"— {_SKILL_READ_FILE_NAME}, {_SKILL_LIST_FILES_NAME}, {_SKILL_EXEC_SCRIPT_NAME}. Never read, "
    "search, or run skill files with the filesystem or shell tools: skill paths do not resolve "
    "from the session workspace."
)


class ReferencedSkillCapabilityProvider(SkillCapabilityProvider):
    name = PROVIDER_NAME
    description = SKILL_PROVIDER_DESCRIPTION

    def __init__(
        self,
        store: SkillReferenceStore,
        market: SkillMarketService,
        *,
        current_username_fn: Callable[[], str] = current_user.get_current_username,
        # 会话 → 一组归属标签。**本模块不认识 cowork**：它只拿到不透明标签，
        # 交给引用库做集合运算。翻译在 cowork 那一层，由装配的地方喂进来
        # （架构设计 §7：providers/ 不得 import cowork）。
        # 不给就是不过滤——去掉 cowork 这一层之后照常工作（D2）。
        owned_labels_fn: "Callable[[str | None], set[str] | None] | None" = None,
        script_timeout_sec: int = 60,
        idle_timeout_sec: float = 90,
        hard_cap_sec: float = 600,
        output_limit_chars: int = 65536,
        python_executable: str | None = None,
        bash_runner: "Callable[[str, ProviderContext], AsyncIterator[CapabilityEvent]] | None" = None,
    ) -> None:
        self._store = store
        self._market = market
        self._current_username = current_username_fn
        self._owned_labels_fn = owned_labels_fn
        self._script_timeout_sec = script_timeout_sec
        self._idle_timeout_sec = idle_timeout_sec
        self._hard_cap_sec = hard_cap_sec
        self._output_limit_chars = output_limit_chars
        self._python_executable = python_executable
        self._bash_runner = bash_runner

    # ── Level 1：list（按当前用户过滤"按人可见"的市场）───────────────────────────

    def _visible_refs(self, session_id: str | None = None) -> list[SkillReference]:
        """两道过滤：**按登录用户**，再**按会话归属**。

        "哪些市场按人可见"取自 registry 的静态表，不写死在这里、也不写死在引用库里，
        更不问活的市场服务——那样某家地址没配/造不出来时，名单会缺一家，那家的引用就被
        当成人人可见（把别人的 skill 露给当前用户）。

        第二道是 cowork 归属。**给不出归属时不过滤**：历史会话、母版会话、内部任务
        都属于这一类，收紧的话它们会突然少掉一批 skill，而那是静默的功能倒退。
        """
        refs = self._store.list_visible(
            self._current_username(), market_registry.per_user_sources()
        )
        owned = self._owned_labels(session_id)
        return refs if owned is None else self._store.list_owned(owned, base=refs)

    def _owned_labels(self, session_id: str | None) -> set[str] | None:
        """这条会话拥有哪些归属标签。`None` = 不设限。

        取不到（没装配、没有 cowork 这一层、这条会话没归属）一律不过滤——
        收紧的话历史会话会突然少掉一批 skill，而那是静默的功能倒退。
        """
        if not session_id or self._owned_labels_fn is None:
            return None
        try:
            return self._owned_labels_fn(session_id)
        except Exception:
            logger.debug("skills：取会话 %s 的归属失败，不过滤", session_id, exc_info=True)
            return None

    async def list(self, ctx: ProviderContext) -> list[Capability]:
        return [
            SkillCapability(
                id=f"{PROVIDER_NAME}:{r.name}",
                name=r.name,
                # 引用库允许 description 为 null（见 SkillReference / 存储格式），且 market
                # 推送会把空描述写成 None（market_service）。不 coalesce 会让 None 经
                # CapabilitySource 落成 ContextBlock.content=None，装配期 content_to_text 崩溃。
                # 与 api/skills.py 的列表路径口径一致（那边早已 `or ""`）。
                description=r.description or "",
                triggers=r.triggers,
                version=r.skill_version,
            )
            for r in self._visible_refs(getattr(ctx, "session_id", None))
        ]

    async def describe(self, ctx: ProviderContext) -> CapabilityProviderInfo:
        return CapabilityProviderInfo(
            name=self.name,
            capability_count=len(self._visible_refs(getattr(ctx, "session_id", None))),
            supports_streaming=False,
            supports_cancel=False,
            description=self.description,
        )

    def _resolve(self, skill_name: str, session_id: str | None = None) -> SkillReference | None:
        """按名字找一条引用。**Level 2/3 也走这里**，所以归属过滤同样生效。

        ⚠ 只拦 list 是不够的：按名字取内容/执行那条路不经过 list，
        而是走一张全局建一次、跨会话复用的索引——只拦 list 的话，
        A 会话先把索引建起来，B 会话就能按名字读到 A 那个 skill 的文件（需求 G9）。
        """
        for r in self._visible_refs(session_id):
            if r.name == skill_name:
                return r
        return None

    # ── materialize + 委托临时 LocalProvider ─────────────────────────────────────

    @contextlib.asynccontextmanager
    async def _borrow_local(
        self, ref: SkillReference, ctx: ProviderContext,
    ) -> AsyncIterator[LocalSkillCapabilityProvider]:
        """下载解压到 <tmp>/imc-rt/<session>/<random>/d/，yield 一个指向它的临时
        LocalSkillCapabilityProvider；退出即删该 <random>。下载/解压走线程池避免阻塞。"""
        username = (self._current_username() or "").strip()  # mythos 用当前登录用户
        session_id = ctx.session_id or "run"
        base = temp_root() / session_id

        def _prepare() -> Path:
            # market_scope 是路由凭据：这条引用从哪个市场页签来，就去那台服务器下载。
            zip_bytes = self._market.download_zip(
                ref.source, ref.remote_id, username,
                market_scope=ref.identity.market_scope,
            )
            base.mkdir(parents=True, exist_ok=True)
            work = Path(tempfile.mkdtemp(dir=base))
            extract_zip(zip_bytes, work / "d")   # 中性单子目录，避免路径含 "skill"
            # 云端 skill 仅在本次 materialize 期间存在。趁真实目录仍在时捕获是否
            # 自带 Datalink 上报，供 SkillReporter 按 session/task 精确消费；避免
            # 事后扫描已经删除的旧 resources/skills 目录。
            capture_referenced_skill_reporting(ctx, ref.name, work)
            return work

        def _cleanup(w: Path) -> None:
            shutil.rmtree(w, ignore_errors=True)
            # 顺手删掉已空的会话父目录，别留空壳（并发下非空则 rmdir 抛错 → 忽略）。
            with contextlib.suppress(OSError):
                base.rmdir()

        work = await asyncio.to_thread(_prepare)
        try:
            yield LocalSkillCapabilityProvider(
                work,
                script_timeout_sec=self._script_timeout_sec,
                idle_timeout_sec=self._idle_timeout_sec,
                hard_cap_sec=self._hard_cap_sec,
                output_limit_chars=self._output_limit_chars,
                python_executable=self._python_executable,
                bash_runner=self._bash_runner,
            )
        finally:
            await asyncio.to_thread(_cleanup, work)

    def _unavailable_msg(self, ref: SkillReference, err: Exception) -> str:
        reason = err.message if isinstance(err, SkillError) else str(err)
        logger.warning("云端 skill '%s'(%s) 加载失败：%s", ref.name, ref.source, reason)
        return (
            f"云端 skill「{ref.name}」当前无法加载（云端不可达或该 skill 已不可用）：{reason}。"
            "请稍后再试，或改用其它方式完成。"
        )

    def _exec_failed_msg(self, ref: SkillReference, script_path: str, err: Exception) -> str:
        """脚本执行失败（skill 已成功下载解压）——与「无法加载」区分开，并把真实报错
        （退出码 / stdout / stderr，如 python 未找到）原样透给 LLM，便于其判断与应对。"""
        reason = err.message if isinstance(err, SkillError) else str(err)
        logger.warning("云端 skill '%s' 脚本 '%s' 执行失败：%s", ref.name, script_path, reason)
        return f"云端 skill「{ref.name}」的脚本「{script_path}」执行失败：{reason}"

    # ── Level 2 / Level 3：materialize → 委托 → 删 ───────────────────────────────

    async def load_definition(
        self, skill_name: str, ctx: ProviderContext,
    ) -> SkillDefinition | None:
        ref = self._resolve(skill_name, getattr(ctx, "session_id", None))
        if ref is None:
            return None
        try:
            async with self._borrow_local(ref, ctx) as local:
                return await local.load_definition(skill_name, ctx)
        except Exception as e:
            return SkillDefinition(
                skill_id=f"{PROVIDER_NAME}:{skill_name}",
                skill_name=skill_name,
                instructions=self._unavailable_msg(ref, e),
            )

    async def list_files(
        self, skill_name: str, pattern: str, limit: int, ctx: ProviderContext,
    ) -> str:
        ref = self._resolve(skill_name, getattr(ctx, "session_id", None))
        if ref is None:
            raise KeyError(f"cloud skill '{skill_name}' not found")
        try:
            async with self._borrow_local(ref, ctx) as local:
                return await local.list_files(skill_name, pattern, limit, ctx)
        except Exception as e:
            return self._unavailable_msg(ref, e)

    async def load_resource(
        self, skill_name: str, resource_path: str, ctx: ProviderContext,
    ) -> str:
        ref = self._resolve(skill_name, getattr(ctx, "session_id", None))
        if ref is None:
            raise KeyError(f"cloud skill '{skill_name}' not found")
        try:
            async with self._borrow_local(ref, ctx) as local:
                return await local.load_resource(skill_name, resource_path, ctx)
        except Exception as e:
            return self._unavailable_msg(ref, e)

    async def exec_script(
        self, skill_name: str, script_path: str, args: str, ctx: ProviderContext,
    ) -> str:
        ref = self._resolve(skill_name, getattr(ctx, "session_id", None))
        if ref is None:
            raise KeyError(f"cloud skill '{skill_name}' not found")
        try:
            async with self._borrow_local(ref, ctx) as local:
                # 进到这里 = 下载解压成功（skill 已加载）。脚本本身跑失败属于「执行失败」，
                # 不是「无法加载」——分两层报，别把脚本报错甩锅给「云端不可达」。
                try:
                    return await local.exec_script(skill_name, script_path, args, ctx)
                except Exception as e:
                    return self._exec_failed_msg(ref, script_path, e)
        except Exception as e:
            return self._unavailable_msg(ref, e)

    # ── 会话结束清扫（兜底；每次操作已即时删该次目录）────────────────────────────
    def deregister_session(self, session_id: str) -> None:
        discard_session_reporting(session_id)
        sweep_session(session_id)

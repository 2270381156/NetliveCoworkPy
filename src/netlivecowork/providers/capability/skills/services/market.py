"""SkillMarketService —— 把几家技能市场合成一个目录。

这一层**不认识任何一家**。它拿到的是一组实现了 ``SkillMarketAdapter`` 的东西，只做四件
跟"哪一家"无关的事：

  * 合并：逐个问每家要目录，失败的那家记日志跳过（**其余几家必须照常显示**）
  * 打标：给每条加 ``source``（程序用，界面不展示）与 ``is_pulled``（= 已引用）
  * 派发：下载/上传按 ``source`` 找到对应 adapter，其余交给它
  * 引用：下载一次 → 解压临时目录抽元数据 → 写引用库 → 删临时文件

重构第 4 步之前，这里有三处 ``if source == MYTHOS`` 式的分支：只给 mythos 加缓存、
下载按两家分派、owner 只在 mythos 时填。前两处随缓存下沉与统一签名消失，第三处改成问
adapter 的 ``visibility``——**加第三家市场时，本文件一行都不用改**。
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from datetime import datetime, timezone

from ctx_weft.providers.capability_skill_local._parser import load_skill_md

from ..adapters import registry as market_registry
from ..adapters.base import (
    VISIBILITY_PER_USER,
    MarketContext,
    MarketItem,
    SkillMarketAdapter,
)
from ..errors import SkillError
from ..runtime.materialize import materialized
from ..references.store import SkillReference, SkillReferenceStore

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class SkillMarketService:
    def __init__(
        self,
        adapters: list[SkillMarketAdapter],
        store: SkillReferenceStore,
        *,
        download_retries: int = 2,
        download_retry_delay_sec: float = 1.0,
        scoped_adapters: Callable[[str], list[SkillMarketAdapter]] | None = None,
    ) -> None:
        #: 按名字索引。名字来自 adapter 自己（``adapter.name``），也是引用记录里的 source。
        #: 这一组是**部署级**的（读 env），对应界面上的"通用"页签。
        self._adapters: dict[str, SkillMarketAdapter] = {a.name: a for a in adapters}
        #: 按 cowork 造那个 cowork 自带的几家。**每次现造，不缓存**：权限收回后套件会被删掉，
        #: 缓存住等于让一个已经没权限的市场继续可访问，而且没有任何现象提示它还在。
        self._scoped = scoped_adapters
        self._store = store
        self._download_retries = max(0, download_retries)
        self._download_retry_delay_sec = max(0.0, download_retry_delay_sec)

    # ── Catalog ───────────────────────────────────────────────────────────────

    def catalog(self, username: str, cowork: str | None = None) -> list[dict]:
        """合并市场目录。``cowork=None`` = 通用页签（部署级那几家）；给了就只看那个 cowork 自带的。

        **一家失败不影响其余几家**：原先是"mythos 挂了还要显示 cowork"，现在这条规则对
        任意多家成立，不必为每一家写一段降级代码。

        指定的 cowork 没装 / 没配市场 → 空目录，不报错。权限收回时页签本来就消失了，
        再抛一次只是把"你没有这个权限"说成"系统故障"。
        """
        ctx = MarketContext(username=username)
        pulled = self._usable_keys(username, cowork)
        merged: list[dict] = []
        for name, adapter in self._adapters_for(cowork).items():
            merged.extend(self._tag(self._fetch(adapter, ctx), name, pulled))
        # 按时间降序；缺失时间排最后。各家的时间字段名不同，但归一后都叫 create_time。
        merged.sort(key=lambda it: it.get("create_time") or "", reverse=True)
        return merged

    def _adapters_for(self, cowork: str | None) -> dict[str, SkillMarketAdapter]:
        """这个页签背后是哪几家。"""
        cid = (cowork or "").strip()
        if not cid:
            return self._adapters
        if self._scoped is None:
            return {}
        return {a.name: a for a in self._scoped(cid)}

    def _fetch(self, adapter: SkillMarketAdapter, ctx: MarketContext) -> list[MarketItem]:
        """问一家要目录。失败 → 记日志返回空，让其余几家照常显示。"""
        try:
            return adapter.list_catalog(ctx)
        except SkillError as e:
            logger.warning("%s 市场拉取失败，跳过这一家：[%s] %s", adapter.name, e.code, e.message)
            return []
        except Exception:
            logger.warning("%s 市场拉取异常，跳过这一家", adapter.name, exc_info=True)
            return []

    def _usable_keys(self, username: str, cowork: str | None) -> set[str]:
        """这个页签下，哪些引用**真的能用**。用来算 `is_pulled`。

        ⚠ **不能只问"引用库里有没有这条 key"**（`is_referenced`）。那样算出来的
        `is_pulled` 会在**每一个** cowork 的页签上都是"已引用"，哪怕这条引用只归其中
        一个 cowork —— 于是市场页标着"已引用"，而那个 cowork 的会话里模型根本拿不到它。
        **界面说有、模型说没有**，这种不一致比少标一个难查得多（实测踩到）。

        两道过滤，与运行期 provider 用的是同两道（见 provider._visible_refs）：
          · 按登录用户 —— mythos 那类市场的 skill 因人而异
          · 按 cowork 归属 —— 只在 cowork 页签下过滤

        **通用页签不按归属过滤**：它不是某个 cowork 的上下文，标"已引用"在那里的含义是
        "你已经引过这条了"（再引一次会把归属放宽成通用），不是"通用范围内能用"。
        """
        refs = self._store.list_visible(username, market_registry.per_user_sources())
        cid = (cowork or "").strip()
        if cid:
            refs = self._store.list_owned({cid}, base=refs)
        return {r.key for r in refs}

    def _tag(self, items: list[MarketItem], source: str, pulled: set[str]) -> list[dict]:
        """MarketItem → 接口要的 dict，补上 source 与 is_pulled。

        这是**唯一**知道 source 从哪来的地方：它是 adapter 的名字，不是各家自报的字段。
        """
        return [
            {
                "id": it.id,
                "name": it.name,
                "description": it.description,
                "updater": it.updater,
                "create_time": it.create_time,
                "source": source,
                "is_pulled": f"{source}:{it.id}" in pulled,
            }
            for it in items
        ]

    # ── Download 分发（pull 与运行时 materialize 共用）─────────────────────────────

    def download_zip(
        self, source: str, remote_id: str, username: str, cowork: str | None = None
    ) -> bytes:
        """下载 skill zip（失败按指数退避重试，最多 download_retries 次）。
        总尝试次数 = download_retries + 1。

        ``cowork`` 指明这条是从哪个页签来的——同一个 ``source``（比如 mythos）在通用页签
        和某个 cowork 页签下指向的是**不同的服务器**，只按 source 找会下到另一家去。
        """
        adapter = self._require_adapter(source, cowork)
        ctx = MarketContext(username=username)
        attempts = self._download_retries + 1
        for i in range(attempts):
            try:
                return adapter.download_zip(remote_id, ctx)
            except SkillError as e:
                if i == attempts - 1:
                    logger.warning(
                        "云端 skill 下载失败，共尝试 %d 次仍失败(%s)：%s",
                        attempts, e.code, e.message,
                    )
                    raise
                delay = self._download_retry_delay_sec * (2 ** i)   # 指数退避
                logger.warning(
                    "云端 skill 下载失败(%s)，%.1fs 后重试(%d/%d)：%s",
                    e.code, delay, i + 1, self._download_retries, e.message,
                )
                time.sleep(delay)
        raise SkillError("UNKNOWN_SOURCE", f"未知的 skill 来源: '{source}'")  # 理论到不了

    def import_to_remote(
        self, source: str, data: bytes, filename: str, *, auth_header: str | None = None
    ) -> dict:
        """上传一个 skill 到指定市场。哪家支持由 adapter 自己说（不支持的抛 UNSUPPORTED）。"""
        adapter = self._require_adapter(source)
        return adapter.import_to_remote(
            data, filename, MarketContext(auth_header=auth_header or "")
        )

    def _require_adapter(self, source: str, cowork: str | None = None) -> SkillMarketAdapter:
        adapter = self._adapters_for(cowork).get(source)
        if adapter is None:
            raise SkillError("UNKNOWN_SOURCE", f"未知的 skill 来源: '{source}'")
        return adapter

    # ── 引用（原 pull）──────────────────────────────────────────────────────────

    def pull(
        self, source: str, remote_id: str, skill_name: str, username: str,
        cowork: str | None = None,
    ) -> dict:
        """「引用」一个市场 skill：下载一次 → 解压临时目录抽元数据 → 写引用库 → 删临时。

        不再解压到 skills_dir 长存；实际内容在运行时按需 materialize（见
        ReferencedSkillCapabilityProvider）。

        **归属由它从哪个页签引来决定**：某个 cowork 的页签 → 只给那个 cowork；通用页签
        → ``["*"]``，所有 cowork 都能用。用户不用再选一次——他点的那个页签已经表达了意图，
        再弹一个"给谁用"的框，等于让人对着两处描述同一件事。
        """
        cid = (cowork or "").strip()
        adapter = self._require_adapter(source, cid or None)
        zip_bytes = self.download_zip(source, remote_id, username, cid or None)
        # 下载一次，解压到临时目录抽取 Level 1 元数据，随后 materialized() 自动删。
        with materialized(zip_bytes, session_id="install") as work:
            try:
                meta, _ = load_skill_md(work)
            except Exception as e:
                raise SkillError("PULL_EXTRACT_FAILED", f"解析 SKILL.md 失败: {e}")

        name = meta.name or skill_name
        # owner 只对"按人可见"的市场有意义。原先写死 `if source == MYTHOS`——现在问 adapter，
        # 加第三家按人分的市场时本文件不用改。
        per_user = adapter.visibility == VISIBILITY_PER_USER
        ref = SkillReference(
            source=source,
            remote_id=str(remote_id),
            name=name,
            description=meta.description or None,
            triggers=list(meta.triggers or []),
            skill_version=getattr(meta, "version", None),
            owner=(username or None) if per_user else None,
            referenced_at=_now_iso(),
            labels=(cid,) if cid else ("*",),
        )
        self._store.add_reference(ref)
        return {"skill_id": ref.key, "name": name}

    def unreference(self, source: str, remote_id: str) -> None:
        """删除一条引用（市场页"卸载"）。"""
        self._store.remove_reference(source, remote_id)

    # ── 给上层用的元信息 ───────────────────────────────────────────────────────

    def per_user_sources(self) -> set[str]:
        """本实例手上这几家里，哪些是"按登录用户可见"的。

        **列表过滤别用这个** —— 用 ``adapters.registry.per_user_sources()``。差别在于
        本方法只认得"造出来了的"市场：某家地址没配时它不在这里，于是那家的引用会被当成
        人人可见，把别人的 skill 露给当前用户。而且这个对象本身在市场没配时可能压根构造
        不出来（真出过事：连本地 skill 列表都跟着 500）。

        留着它是给"确实只关心当前这组 adapter"的场合用的。
        """
        return {
            name for name, a in self._adapters.items()
            if a.visibility == VISIBILITY_PER_USER
        }

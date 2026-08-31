"""技能市场 adapter 的契约。

**这是整个重构的支点**，两条规矩写死在这里：

    家家不同的东西全在 adapter 里 —— 鉴权、翻页、字段改名、过滤规则、缓存
    领域逻辑一句都不许进来 —— 合并、去重、is_pulled、引用记录，那些是 market 层的事

立这一层是因为差异正在往上渗。现状里"这是不是 mythos"的判断散在 6 处：market 层 3 处
（只给 mythos 加缓存、下载按 source 分派、owner 只在 mythos 时填）、持久化层 1 处
（``references.store.list_visible`` 里 ``if ref.source == "mythos"``）、旧记录 1 处、
装配层 1 处。加第三家市场要改的不是一个文件而是这 6 处，**而且漏一处不报错**——
只是那家市场行为不对，要等用户发现。

本文件只定义契约，不含任何一家的实现，也还没有人使用它（见重构设计第 1 步）。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

from ..errors import SkillError

#: 可见性的两种取值。写成常量而不是散落的字符串字面量——拼错了会静默变成"人人可见"，
#: 那是个放宽权限的错，不该靠肉眼校对。
VISIBILITY_EVERYONE = "everyone"
VISIBILITY_PER_USER = "per_user"


@dataclass(frozen=True)
class MarketContext:
    """调一次市场需要的外部输入。**一个参数取代散落的 username。**

    现状是 cowork 的方法不带 username、mythos 的带，于是上层每次调用前都得先判断是哪家：

        if source == COWORK: self._cowork.download_zip(remote_id)
        if source == MYTHOS: self._mythos.download_zip(remote_id, username)

    签名统一之后，这段退化成一次字典取值 ``self._adapters[source].download_zip(rid, ctx)``。
    不需要的字段各家自己忽略——cowork 不看 username，这是它的事，不是调用方的事。
    """

    #: 当前登录用户名。mythos 用它鉴权并决定这个人能看见哪些 skill；cowork 忽略。
    username: str = ""
    #: 上传时带的鉴权头。目前只有 cowork 的上传用得到。
    auth_header: str = ""


@dataclass(frozen=True)
class MarketItem:
    """市场目录里的一条，**已归一**。

    五个字段是两家现在就已经对齐的形状（cowork 的 ``list_catalog`` 直接拼成这样，
    mythos 经 ``_normalise`` 转成这样）。契约把这件事从"两边碰巧一致"变成"必须一致"。

    **``source`` 和 ``is_pulled`` 不在这里**：前者由 market 层按 adapter 的名字填，
    后者要查引用库才知道。adapter 不认识引用库，也不该认识自己叫什么——它只管把
    这一家的数据翻译过来。
    """

    id: str
    name: str
    description: str | None = None
    updater: str | None = None
    create_time: str | None = None


class SkillMarketAdapter(ABC):
    """一家技能市场的接口方言。

    子类必须实现 ``list_catalog`` 与 ``download_zip``；``import_to_remote`` 与
    ``visibility`` 有默认值，只有需要的那家才覆盖。
    """

    #: 这家市场的名字。同时是引用记录里的 ``source`` 值，改它等于改用户数据的兼容性。
    name: str = ""

    #: 这家的 skill 是人人可见（``VISIBILITY_EVERYONE``）还是按登录用户可见
    #: （``VISIBILITY_PER_USER``）。它取代的是 ``references.store.list_visible`` 里那句
    #: ``if ref.source == "mythos"``——那句话让**持久化层知道了有几家市场、哪家按人过滤**。
    #:
    #: **写成类属性而不是实例方法，是因为它必须在"地址没配、adapter 造不出来"时也能读到。**
    #: 按不按人分是这类市场的固有性质，跟这个部署有没有配它的地址无关；而列表过滤在市场
    #: 不可用时**照样要正确**——真出过事：它一度只能从活的 market service 上问，于是某家
    #: 地址一空，连"已装 skill 列表"（含本地 skill）都跟着 500。见 registry.per_user_sources。
    visibility: str = VISIBILITY_EVERYONE

    # ── 必须实现 ──────────────────────────────────────────────────────────────

    @abstractmethod
    def list_catalog(self, ctx: MarketContext) -> list[MarketItem]:
        """取**全量**目录，已归一成 MarketItem。

        翻页、鉴权、字段改名、过滤（如 mythos 的 baseline）、缓存——全在各家自己的实现里
        解决。上层拿到的永远是一整份列表，**不需要知道它是一次取回还是翻了 7 页**。

        这一条直接消掉 market 层现有的三处分支：那三处存在的唯一理由，就是两家取数据的
        方式不同却让上层去适配。

        取不到时抛 SkillError；调用方决定是整个失败还是降级只显示另一家。
        """

    @abstractmethod
    def download_zip(self, remote_id: str, ctx: MarketContext) -> bytes:
        """下载一个 skill 的 zip 字节。

        校验与解包不在这里（那是 ``zip_utils`` 的事，两家共用）。adapter 只负责把字节
        取回来——包括为此需要的鉴权。
        """

    # ── 可选覆盖 ──────────────────────────────────────────────────────────────

    def import_to_remote(self, data: bytes, filename: str, ctx: MarketContext) -> dict:
        """上传一个 skill 到这家市场。

        默认抛 UNSUPPORTED：**只有 cowork 支持上传**，不必让 mythos 假装实现一个会失败的
        方法。让"不支持"成为契约里的一等公民，好过让调用方去猜哪家能传。
        """
        raise SkillError("UNSUPPORTED", f"{self.name or '该'} 市场不支持上传 skill")

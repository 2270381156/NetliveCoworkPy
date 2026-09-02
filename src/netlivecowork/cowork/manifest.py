"""套件清单的**运行期**模型 —— 只读已经装好的东西。

与构建期校验器是**两层，刻意不共用代码**（需求 A7）：

  * 构建期面向"改套件的人"：做完整校验、报错要具体、不通过不许出包；
  * 本模块面向"已经装上的东西"：**容忍缺字段而不是拒绝启动** —— 装都装上了才发现
    清单少个字段，此时拒绝启动的代价远大于按缺省值继续。

`default` 不是 cowork：它是模板继承的母版，**永远不出现在这里返回的任何清单里**
（需求 A8）。

—— 本模块的解析逻辑继承自 demo/experimental 的 `coworks.py`，两处有意不同：

  * **不带 `mcp.localOnly`**：那是云端跑不了 stdio 形态 MCP 才需要的标记，
    仅地端没有这个区分，留着会让人以为有两种部署形态。
  * **认 `llm.define`**：云端确实在清单里下发账号定义。曾经有意不读它，理由是
    NFR-4「套件不得携带明文凭据」——但下发的 `api_key` 本来就是 `enc:v1:` 密文，
    这个顾虑不成立。不读的后果是下发的账号根本不注册，而 `llm.allow` 里的名字指的
    就是它们，过滤后一个不剩 → 界面显示「没有可用模型」，真实原因却是账号从没装进来。
"""
from __future__ import annotations

from dataclasses import dataclass

MANIFEST_NAME = "cowork.json"

#: 母版目录名。它可能与套件装在同一个父目录下，但**永远不算一个 cowork**。
MASTER_ID = "default"

#: 没写展示次序的排最后，但仍然显示 —— 不显示的话用户会以为套件没装上。
DEFAULT_ORDER = 1_000_000


@dataclass(frozen=True)
class MCPServerDef:
    """套件 `mcp.define` 里的一项：一个 MCP server 的连接定义。

    `config` 就是 mcp.json 里那一条的原样形状（url/headers 等），交给下游去解 ——
    **刻意不在这里定义第二套字段**：两套形状迟早会漂移，而漂移的表现是
    "同一个 server 从套件下发就连不上、手工写进 mcp.json 就能连"。
    """

    name: str
    config: dict


@dataclass(frozen=True)
class LLMModelDef:
    """套件里一个模型的参数。字段名对齐本地账号库的 ModelConfig。"""

    model: str
    context_limit: int = 128_000
    output_reserve: int | None = None
    output_ceiling: int | None = None


@dataclass(frozen=True)
class LLMAccountDef:
    """套件自带的一个 LLM 账号。

    ⚠ **`api_key` 原样保留，不在这一层解密、也不在这一层校验。**
    下发的是 `enc:v1:` 密文；解密的活儿归 providers/llm/secret，那边对无前缀的明文
    也原样透传。在这里动它只会多出一处能把密钥读进内存的地方。

    ⚠ **绝不进日志**：`__repr__` 里把它抹掉。dataclass 默认的 repr 会把整个对象打出来，
    而 exc_info=True 的一条 warning 就足以把密钥写进日志文件（K7 / NFR-8）。
    """

    name: str
    style: str
    api_key: str
    base_url: str = ""
    default_model: str = ""
    timeout_sec: int = 120
    models: tuple[LLMModelDef, ...] = ()

    def __repr__(self) -> str:      # pragma: no cover - 只为不泄密
        return (f"LLMAccountDef(name={self.name!r}, style={self.style!r}, "
                f"base_url={self.base_url!r}, api_key=<redacted>, "
                f"models={[m.model for m in self.models]!r})")


@dataclass(frozen=True)
class SkillPreset:
    """套件 `skills.presets` 里的一项：预置引用的**完整 L1 元数据**。

    只存元数据、不碰内容：预置协调发生在启动/登录，那时不许访问网络，
    ZIP 在实际使用时才临时下载。市场作用域**不在这里声明** —— 由包含它的
    套件配置推导（见 scopes），声明值会与套件实际市场漂移。
    """

    source: str
    remote_id: str
    name: str
    description: str
    version: str = ""
    triggers: tuple[str, ...] = ()


#: skills.presets 的数量与元数据长度上限。运行期超限**跳过并记日志**；
#: 发布侧按同一套契约**严格拒绝**（发布服务不在本仓，接入时镜像这些常量）。
MAX_SKILL_PRESETS = 128
MAX_PRESET_SOURCE_LENGTH = 64
MAX_PRESET_REMOTE_ID_LENGTH = 256
MAX_PRESET_NAME_LENGTH = 200
MAX_PRESET_DESCRIPTION_LENGTH = 4_000
MAX_PRESET_VERSION_LENGTH = 128
MAX_PRESET_TRIGGERS = 64
MAX_PRESET_TRIGGER_LENGTH = 256


@dataclass(frozen=True)
class Cowork:
    """一个已装的 cowork。字段说明见需求附录 A。"""

    id: str
    version: str
    order: int
    display_name: str
    subtitle: str = ""
    accent: str = ""

    #: 套件自带的 logo **文件名**（`branding.logo`），相对套件根目录。空 = 没有，界面回落首字母。
    #:
    #: **只存文件名，图片本体是包里的一个文件**，不是 base64 塞进清单。理由同 A1 那条
    #: "提示词不进 json"：`/coworks` 是高频接口，每次列阵容都要解析这份清单，
    #: 而一张 logo 转成 base64 有几十 KB。
    #:
    #: ⚠ 这个值来自下发的清单，**会被拼进文件路径** —— 提供端点时必须挡路径穿越。
    logo_file: str = ""

    #: 这个 cowork **拥有**哪几个 MCP server（套件 `mcp.use`）。空 = 一个都不给。
    mcp_use: tuple[str, ...] = ()
    #: MCP server 的**连接定义**（套件 `mcp.define`）。`mcp_use` 只按名字决定可见性，
    #: 定义才带地址。平台已有的 server 只需 use，不必重复 define。
    mcp_define: tuple[MCPServerDef, ...] = ()

    #: 允许用哪些 LLM 账号（套件 `llm.allow`）。**空 = 不限制。**
    #:
    #: 与 `mcp_use` 的空语义**刻意相反**：MCP 是能力，"明确给了才有"；
    #: LLM 是资源选择，"没说就是都能用"。这条差异务必保留 ——
    #: 统一成一种的话，要么所有 cowork 都没模型可用，要么 MCP 权限形同虚设。
    llm_allow: tuple[str, ...] = ()

    #: 套件自带的 LLM 账号定义（`llm.define`）。**下发的账号在这里，不在本机配置里。**
    #:
    #: 不读它的后果不是"少个字段"：`llm.allow` 里的名字指的就是这里定义的账号，
    #: 不注册的话过滤后一个不剩 —— 界面显示「没有可用模型」，而真实原因是账号从没装进来。
    llm_define: tuple["LLMAccountDef", ...] = ()

    #: 这个 cowork 的默认账号 / 模型（套件 `llm.default`，附录 A「LLM·默认」）。
    #:
    #: **不解析它的后果**：`llm.allow` 里没有全局默认账号的 cowork 会**根本建不了会话**
    #: —— 用户不选模型时用的是全局默认，而那个默认过不了归属闸，直接 403。
    #: 空 = 没指定，此时回落到"允许列表里的第一个"。
    llm_default_account: str = ""
    llm_default_model: str = ""

    #: 这个 cowork 自己的 skill 市场地址（套件 `skills.pullServerUrl`）。空 = 没有独立市场。
    #: **地址随套件走，不进 .env**（需求 H1）。
    skill_market_url: str = ""
    #: 这个 cowork 的 mythos 形态市场（套件 `skills.mythosBaseUrl`）。空 = 没有。
    #: 与上一个是**两种接口**，不是"公共/个人"之分。
    skill_mythos_url: str = ""

    #: 预置的 skill 引用（套件 `skills.presets`）。空 = 没有预置。
    #: 启动/登录时由 ProfileSkillPresetReconciler 协调进引用库，见 references/presets。
    skill_presets: tuple["SkillPreset", ...] = ()

    @property
    def template_id(self) -> str:
        """交给内核时用的标识。**host 内部一律用裸 id**，只在这一处加前缀。

        转换点只有这一处，逆向在 `bare_id()`。两处各拼一次的后果实测过：
        校验时忘了剥前缀，四个 cowork 全被拒，而错误信息说的是"未安装或你没有权限"
        —— 一个前缀 bug 被伪装成了权限问题（需求 F3）。
        """
        return f"agent:{self.id}"


def bare_id(template_id: str) -> str:
    """`template_id` 的逆。给了裸 id 也照样返回裸 id（幂等）。"""
    value = (template_id or "").strip()
    return value[len("agent:"):] if value.startswith("agent:") else value

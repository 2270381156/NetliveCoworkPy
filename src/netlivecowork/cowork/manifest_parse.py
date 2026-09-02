"""套件清单的**解析** —— 把下发来的 json 变成 `manifest` 里的那几个结构。

与 `manifest.py` 分开，是因为两者读者不同：改字段的人看那边（结构一目了然），
处理下发兼容的人看这边（一堆"这个字段可能长两种样子"的容错）。合在一起的时候，
加一次 `llm.define` 就往结构文件里塞了 60 行辅助函数，结构本身反而被埋了。

**容忍缺字段，不拒绝启动**（需求 A7）：装都装上了才发现清单少个字段，
此时拒绝启动的代价远大于按缺省值继续。构建期那套严格校验是**另一份代码**，
面向"改套件的人"，报错要具体、不通过不许出包。
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from .manifest import (
    DEFAULT_ORDER,
    MAX_PRESET_DESCRIPTION_LENGTH,
    MAX_PRESET_NAME_LENGTH,
    MAX_PRESET_REMOTE_ID_LENGTH,
    MAX_PRESET_SOURCE_LENGTH,
    MAX_PRESET_TRIGGERS,
    MAX_PRESET_TRIGGER_LENGTH,
    MAX_PRESET_VERSION_LENGTH,
    MAX_SKILL_PRESETS,
    Cowork,
    LLMAccountDef,
    LLMModelDef,
    MANIFEST_NAME,
    MASTER_ID,
    MCPServerDef,
    SkillPreset,
)

logger = logging.getLogger(__name__)


def _str_tuple(v: object) -> tuple[str, ...]:
    """一串字符串。不是列表就当空；元素去空白、丢掉空的。"""
    if not isinstance(v, (list, tuple)):
        return ()
    return tuple(s.strip() for s in (str(x) for x in v) if s.strip())


def _mcp_defines(raw: object) -> tuple[MCPServerDef, ...]:
    """解析 `mcp.define`。**只做结构转换，不做校验** —— 校验是构建期的事（A6/A7）。"""
    if not isinstance(raw, dict):
        return ()
    out: list[MCPServerDef] = []
    for name, cfg in raw.items():
        name = str(name).strip()
        if name and isinstance(cfg, dict):
            out.append(MCPServerDef(name=name, config=dict(cfg)))
    return tuple(out)


#: 没写 `branding.logo` 时按约定找这几个。顺序即优先级。
#: 有约定就不必每个套件都写一行；写了 `branding.logo` 则以它为准。
LOGO_CANDIDATES = ("logo.svg", "logo.png", "logo.webp")


def _logo_file(branding: dict) -> str:
    """logo 的**文件名**。

    显式的 `branding.logo` 优先；没写就留空，由读取方按 `LOGO_CANDIDATES` 找。
    这里不碰文件系统 —— 解析清单是纯函数，装没装、文件在不在是另一层的事。

    ⚠ **只取基名**：这个值来自下发的清单，后面要拼进路径。`../../` 之类在这里就削掉，
    比留到端点那层再防更稳 —— 那层要是漏了，就是读任意文件。
    """
    import os

    raw = str(branding.get("logo") or "").strip().replace("\\", "/")
    name = os.path.basename(raw)
    return "" if name in ("", ".", "..") else name


def _llm_defines(raw: object) -> tuple[LLMAccountDef, ...]:
    """解析 `llm.define`。**坏的那一条跳过，不连累其余**（运行期容忍缺字段，A7）。

    没有 `api_key` 的条目直接丢弃：留着只会在注册时抛错，而那时启动已经进行到一半，
    错误信息也指不回"套件里那条定义不全"。
    """
    if not isinstance(raw, dict):
        return ()
    out: list[LLMAccountDef] = []
    for name, spec in raw.items():
        if not isinstance(spec, dict):
            continue
        nm = str(name or "").strip()
        style = str(spec.get("style") or "").strip()
        key = str(spec.get("api_key") or "").strip()
        if not (nm and style and key):
            logger.warning("cowork：llm.define 里 %r 字段不全（需 style + api_key），跳过", nm)
            continue
        models = tuple(
            LLMModelDef(
                model=str(m.get("model") or "").strip(),
                context_limit=_int(m.get("context_limit"), 128_000),
                output_reserve=_opt_int(m.get("output_reserve")),
                output_ceiling=_opt_int(m.get("output_ceiling")),
            )
            for m in (spec.get("models") or [])
            if isinstance(m, dict) and str(m.get("model") or "").strip()
        )
        default_model = str(spec.get("default_model") or "").strip()
        if not models and default_model:
            # 只给了默认模型没给模型表 —— 按它造一条，否则这个账号注册出来一个模型都没有。
            models = (LLMModelDef(model=default_model),)
        out.append(LLMAccountDef(
            name=nm, style=style, api_key=key,
            base_url=str(spec.get("base_url") or "").strip(),
            default_model=default_model or (models[0].model if models else ""),
            timeout_sec=_int(spec.get("timeout_sec"), 120),
            models=models,
        ))
    return tuple(out)


def _int(v: object, default: int) -> int:
    try:
        return int(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _bounded_text(item: dict, key: str, limit: int, *, required: bool = True) -> str | None:
    """取一个字符串字段。必填却缺失、或超过长度上限 → None，由调用方整条跳过。

    上限在这里挡而不是留给市场层：预置元数据会进引用库长期保存，
    一条超大 description 的代价是每次列引用都拖着它。
    """
    value = str(item.get(key) or "").strip()
    if (required and not value) or len(value) > limit:
        return None
    return value


def _skill_presets(raw: object) -> tuple[SkillPreset, ...]:
    """解析 `skills.presets`。**坏的那一条跳过，不连累其余**（运行期容忍，A7）。

    超过 `MAX_SKILL_PRESETS` 只处理前面的并记日志；重复的 `(source, remote_id)`
    只留第一条 —— 两条都留的话，协调器会把同一个身份加两遍绑定。
    """
    if not isinstance(raw, (list, tuple)):
        return ()
    if len(raw) > MAX_SKILL_PRESETS:
        logger.warning(
            "cowork：skills.presets 有 %d 项，超过上限 %d，只处理前 %d 项",
            len(raw), MAX_SKILL_PRESETS, MAX_SKILL_PRESETS,
        )
    out: list[SkillPreset] = []
    seen: set[tuple[str, str]] = set()
    for index, item in enumerate(raw[:MAX_SKILL_PRESETS]):
        if not isinstance(item, dict):
            logger.warning("cowork：skills.presets[%d] 不是对象，跳过", index)
            continue
        fields = (
            _bounded_text(item, "source", MAX_PRESET_SOURCE_LENGTH),
            _bounded_text(item, "remoteId", MAX_PRESET_REMOTE_ID_LENGTH),
            _bounded_text(item, "name", MAX_PRESET_NAME_LENGTH),
            _bounded_text(item, "description", MAX_PRESET_DESCRIPTION_LENGTH),
            _bounded_text(item, "version", MAX_PRESET_VERSION_LENGTH, required=False),
        )
        triggers = _str_tuple(item.get("triggers"))
        oversized = (
            len(triggers) > MAX_PRESET_TRIGGERS
            or any(len(t) > MAX_PRESET_TRIGGER_LENGTH for t in triggers)
        )
        if None in fields or oversized:
            logger.warning("cowork：skills.presets[%d] 字段缺失或超过长度上限，跳过", index)
            continue
        source, remote_id, name, description, version = fields  # type: ignore[misc]
        key = (source, remote_id)
        if key in seen:
            logger.warning("cowork：skills.presets[%d] 预置身份重复，跳过", index)
            continue
        seen.add(key)
        out.append(SkillPreset(
            source=source,
            remote_id=remote_id,
            name=name,
            description=description,
            version=version,
            triggers=triggers,
        ))
    return tuple(out)


def _opt_int(v: object) -> int | None:
    if v in (None, ""):
        return None
    try:
        return int(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _default_llm(llm: dict) -> dict[str, str]:
    """读 `llm.default`。**两种写法都认**：字符串 = 只给账号；对象 = 账号 + 模型。

    云端管理台两种都可能下发，只认一种的话另一种会被静默读成"没有默认"，
    表现是用户每次新建会话都得自己选模型 —— 没人会往清单解析上想。
    """
    d = llm.get("default")
    if isinstance(d, str):
        return {"account": d.strip(), "model": ""}
    if isinstance(d, dict):
        return {
            "account": str(d.get("account") or d.get("name") or "").strip(),
            "model": str(d.get("model") or "").strip(),
        }
    return {"account": "", "model": ""}


def parse(raw: object) -> Cowork | None:
    """一份清单 → 一个 Cowork。**认不出来就返回 None，不抛。**

    返回 None 的三种情形，都会被上层跳过而不是让整份清单变空：
    顶层不是对象 · 没有 id · id 就是母版名。
    """
    if not isinstance(raw, dict):
        return None

    cid = str(raw.get("id") or "").strip()
    if not cid or cid == MASTER_ID:
        return None

    branding = raw.get("branding") if isinstance(raw.get("branding"), dict) else {}
    mcp = raw.get("mcp") if isinstance(raw.get("mcp"), dict) else {}
    llm = raw.get("llm") if isinstance(raw.get("llm"), dict) else {}
    skills = raw.get("skills") if isinstance(raw.get("skills"), dict) else {}
    order = raw.get("order")

    return Cowork(
        id=cid,
        version=str(raw.get("version") or ""),
        # ⚠ bool 是 int 的子类：`order: true` 会被当成 1，成为悄悄排到最前的那个（需求 A6）。
        order=order if isinstance(order, int) and not isinstance(order, bool) else DEFAULT_ORDER,
        display_name=str(branding.get("displayName") or cid).strip(),
        subtitle=str(branding.get("subtitle") or "").strip(),
        logo_file=_logo_file(branding),
        accent=str(branding.get("accent") or "").strip(),
        mcp_use=_str_tuple(mcp.get("use")),
        mcp_define=_mcp_defines(mcp.get("define")),
        llm_allow=_str_tuple(llm.get("allow")),
        llm_define=_llm_defines(llm.get("define")),
        llm_default_account=_default_llm(llm).get("account", ""),
        llm_default_model=_default_llm(llm).get("model", ""),
        skill_market_url=str(skills.get("pullServerUrl") or "").strip(),
        skill_mythos_url=str(skills.get("mythosBaseUrl") or "").strip(),
        skill_presets=_skill_presets(skills.get("presets")),
    )


def read(manifest_path: Path) -> Cowork | None:
    """读一份清单文件。读不了/解析不了都返回 None 并记日志。

    **单个坏清单只丢它自己**：让一个坏文件把整份清单变空，用户看到的是"一个 cowork
    都没有"—— 而那与"没权限"长得一模一样，会把配置问题误报成权限问题（需求 I2）。
    """
    try:
        raw = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("cowork：读不了 %s：%s", manifest_path, e)
        return None
    item = parse(raw)
    if item is None:
        logger.warning("cowork：%s 不是一份可用的清单（缺 id 或顶层不是对象），跳过", manifest_path)
    return item

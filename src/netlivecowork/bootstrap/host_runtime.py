"""同步装配：读配置 → 建 provider → 建 runtime → 挂 authorizer。

**capability provider 只在这里注册**。以前 cli 装一遍、FastAPI 的 lifespan 又装一遍，
local_skill 和 topology 因此各有两个同名实例；而 registry 是 append 不去重、也不告警，
下游四个索引对同名 provider 的取舍口径还不一致（有的先注册赢、有的后注册赢），
"哪一份在干活"取决于问谁。收成一处之后这类问题不可能再无声发生。

留在 lifecycle 的只有真需要事件循环的那些（DB engine 绑 loop、watcher 要 running loop、
MCP 预连接是个 task），见 bootstrap/lifecycle.py。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# fs 的命令词黑名单收窄到"致命且无正当用途"这一档。日常危险命令（rm 等）交给
# SelectiveBashAuthorizer 按模式审核，不在这里一刀切。
FATAL_ONLY_BLACKLIST = frozenset({"format", "mkfs", "dd", "shutdown", "reboot", "halt", "poweroff"})


@dataclass
class HostRuntime:
    """装配结果。core 是 ctx_weft 的 runtime，其余是 host 侧的伴生物。"""
    core: Any                      # CtxWeftRuntime
    template_syncer: Any
    agent_template_provider: Any
    mcp_manager: Any
    db_url: str | None
    skills_dir: Path
    agents_dir: Path


def db_url_from(args) -> str:
    from netlivecowork.config import get_settings
    from netlivecowork.persistence.postgres import resolve_db_url
    raw = getattr(args, "db_url", None) or get_settings().database_url
    return resolve_db_url(raw)


def build_host_runtime(args) -> HostRuntime:
    """从 CLI 参数 + 环境装出 HostRuntime（同步，不碰 DB / 不碰事件循环）。

    副作用：把 NLC_PIP_* 映射成标准 PIP_*，使 bash/skill 子进程继承内网 pip 源。
    """
    from ctx_weft.core.runtime import CtxWeftRuntime, ProviderRegistry
    from ctx_weft.providers.memory_blackboard.in_memory import InMemoryMemoryProvider
    from ctx_weft.providers.agent_template_local import TemplateLoader
    from netlivecowork import paths
    from netlivecowork.config import get_settings, apply_pip_index_env
    from netlivecowork.providers.templates.store import TemplateStore
    from netlivecowork.providers.templates.syncer import TemplateSyncer

    cfg = get_settings()
    apply_pip_index_env(cfg)

    skills_dir = paths.skills_dir(getattr(args, "skills_dir", None))
    # ⚠ **模板从"已装套件"目录加载，不是出厂资源目录**（需求 F1）。
    #
    # 这是"装了哪几个既决定界面列什么、也决定实际能跑什么"的落点：出厂目录里那份是
    # 全量，从它加载的话，没授权的 cowork 照样建得出会话——权限就只剩展示了。
    #
    # 母版一起放进这个目录（见 _seed_master_template）：模板同步只扫一个目录，
    # 母版不在里面的话，facet 兜底与"建会话未指定模板"的回落都会落空。
    agents_dir = paths.coworks_dir()

    # 上次运行遗留的 Office broker：冻结态下它跑的是 app 自己的 exe，留着会锁住安装目录
    # （装新版报「无法停止 IPMaster-Cowork」）。只清父进程已经不在的，见 manager 里的说明。
    _reap_orphan_office_brokers()

    template_store = TemplateStore()      # 无 session_factory：先用内存模式
    template_loader = TemplateLoader()
    syncer = TemplateSyncer(template_store, template_loader)
    # store 的 session_factory 在 lifecycle 建完 DB 后注入，随即 sync

    providers = ProviderRegistry()
    providers.register_memory(InMemoryMemoryProvider())   # 有 DB 时由 lifecycle 换成 Postgres

    from netlivecowork.providers.templates.provider import DirAgentCapabilityProvider
    agent_provider = DirAgentCapabilityProvider(
        template_store, template_loader, default_template_id=cfg.default_template_id
    )
    providers.register_capability(agent_provider)

    enable_tools = getattr(args, "enable_tools", True)
    fs_provider = _register_fs_and_web(providers, cfg) if enable_tools else None

    # 应用内浏览器内容 tool（view_side_web_page）：读取前端 webview 当前页面。
    from netlivecowork.providers.capability.webview import WebviewCapabilityProvider
    providers.register_capability(WebviewCapabilityProvider())

    # cowork：先对账（装/删套件），再建策略——顺序反了的话策略会读到对账前的旧清单。
    _setup_cowork()

    _register_skills(providers, cfg, skills_dir, fs_provider)
    _register_topology(providers)

    runtime = CtxWeftRuntime(providers=providers, config=cfg.to_runtime_config())

    _register_llm(runtime)
    mcp_manager = _register_mcp(runtime)

    if fs_provider is not None:
        _wire_authorizers(runtime, providers, agent_provider, fs_provider)

    return HostRuntime(
        core=runtime,
        template_syncer=syncer,
        agent_template_provider=agent_provider,
        mcp_manager=mcp_manager,
        db_url=db_url_from(args),
        skills_dir=skills_dir,
        agents_dir=agents_dir,
    )


# ── 各组 provider ─────────────────────────────────────────────────────────────


def _register_fs_and_web(providers, cfg):
    from ctx_weft.providers.capability_filesystem import FilesystemConfig
    from netlivecowork.providers.capability.fs_bash_compat import BashExecAliasFilesystemProvider

    # 文件系统工具（bash/read/write/glob）自管 per-session workspace。
    # 用带旧名兼容的子类：把存量数据里的 fs:bash_exec 归一到 fs:shell（见 fs_bash_compat）。
    fs_provider = BashExecAliasFilesystemProvider(FilesystemConfig(
        bash_idle_timeout_sec=cfg.fs_bash_idle_timeout_sec,
        bash_hard_cap_sec=cfg.fs_bash_hard_cap_sec,
        bash_max_output_bytes=cfg.fs_bash_max_output_bytes,
        file_read_default_lines=cfg.fs_file_read_default_lines,
        file_read_max_bytes=cfg.fs_file_read_max_bytes,
        file_read_max_line_bytes=cfg.fs_file_read_max_line_bytes,
        file_read_count_max_bytes=cfg.fs_file_read_count_max_bytes,
        glob_max_results=cfg.fs_glob_max_results,
        bash_venv_python=cfg.fs_bash_venv_python,
        # 共享 venv 模式（打包态）：关掉每 workspace 自动建/注入 .venv——python 由 _run.py
        # 头插进 os.environ 的全应用共享 venv 统一提供。dev（fs_shared_venv_python=None）保持
        # 原行为（每 workspace 自动 venv）。
        bash_auto_venv=(cfg.fs_shared_venv_python is None),
        bash_blacklist=FATAL_ONLY_BLACKLIST,
    ))
    providers.register_capability(fs_provider)

    # Lightweight public-page fetching is an optional, isolated capability.
    # It deliberately bypasses HITL because reading a public page is a
    # read-only operation and must not prompt on first use.
    from ctx_weft.core.auth import AllowAllAuthorizer
    from netlivecowork.providers.capability.web import create_web_provider_from_env

    web_provider = create_web_provider_from_env()
    if web_provider is not None:
        providers.register_capability(web_provider, authorizer=AllowAllAuthorizer())
    return fs_provider


def _bash_runner_for(fs_provider):
    """skill 脚本的执行通道：交给 fs 的 shell 工具，而不是自己起进程。

    这条不是"顺手复用"：fs:shell 是工作区闸门、bash authorizer、以及自动模式下 Low 令牌
    与 Office broker 注入的**唯一**入口。绕过它的脚本等于没有边界（见 low_shell）。
    """
    if fs_provider is None:
        return None

    def _run(cmd, ctx, _fs=fs_provider):
        return _fs.invoke(f"{_fs.name}:shell", {"command": cmd}, ctx)
    return _run


def _register_skills(providers, cfg, skills_dir: Path, fs_provider) -> None:
    """本地 skill provider（用户自建，永久存）+ 云端引用 provider（用时下载、用完删）。

    顺带：清理临时物化目录的崩溃残留、把已装的市场 skill 一次性迁移为引用。
    """
    from ctx_weft.providers.capability_skill_local import LocalSkillCapabilityProvider
    from netlivecowork import paths
    from netlivecowork.providers.capability.skills.runtime import materialize
    # 长期功能与一次性迁移分开：前者每次启动都要跑，后者迁完就能整目录删（见 legacy/）。
    from netlivecowork.providers.capability.skills.references.defaults import (
        prune_null_references, seed_default_references,
    )
    from netlivecowork.providers.capability.skills.legacy import (
        SkillPullStore, migrate_pulled_to_references,
    )
    from netlivecowork.providers.capability.skills.references.store import SkillReferenceStore
    from netlivecowork.providers.capability.skills.provider import (
        ReferencedSkillCapabilityProvider,
    )

    # 1) 清崩溃残留的临时物化目录（<tmp>/imc-rt），随即把物化根标 Low（子目录继承）——
    #    这样云端 skill 每次物化不用再单独标，自动继承 Low（自动模式下 skill 能写 SKILL_DIR）。
    materialize.sweep_all()
    materialize.prepare_low_root()

    # 2) 本地 skill provider（用户自建，永久存）。
    if skills_dir.exists():
        local_skills = LocalSkillCapabilityProvider(
            skills_dir,
            idle_timeout_sec=cfg.skill_idle_timeout_sec,
            hard_cap_sec=cfg.skill_hard_cap_sec,
            output_limit_chars=cfg.skill_output_limit_chars,
            # 与 bash 共用同一套 python：打包态用全应用共享 venv 的 python（fs_shared_venv_python），
            # dev 态回退 fs_bash_venv_python（=None → skill 的 .py 仍用 PATH 上的 python）。
            # 注：脚本主要经 bash_runner 走 fs:shell（那边已头插共享 venv），此参数是直跑兜底。
            python_executable=cfg.fs_shared_venv_python or cfg.fs_bash_venv_python,
            bash_runner=_bash_runner_for(fs_provider),
        )
        # 按 cowork 归属过滤。**这一层不能省**：内核那个 provider 扫目录、有什么给什么，
        # 不包的话「给某个 skill 设归属」只写进了 local_skill_owners.json 和界面标签，
        # 运行时一点不生效 —— 设了等于没设，且没有任何现象提示（实测踩过）。
        wrapped = _cowork_local_skill_wrapper(local_skills)
        providers.register_capability(wrapped or local_skills)
        logger.info(
            "Skills: local provider loaded from %s%s",
            skills_dir, "" if wrapped else "（未做归属隔离）",
        )

        # 2b) 把本地 skill 目录标 Low（含已有文件 /T + 经继承 (OI)(CI) 覆盖未来导入的 skill），
        #     让自动模式下以 Low 运行的本地 skill 脚本能写自己的 SKILL_DIR。走 label_low_once：
        #     和共享 venv 共用同一"标一次"标记，不每次启动重标（skill 目录是 app 管的稳定路径）。
        #     仅 Windows+pywin32 生效；best-effort、不阻断启动。
        from netlivecowork.low_integrity.activation import label_low_once
        label_low_once(skills_dir, paths.data_dir())
    else:
        logger.warning("Skills: skills_dir '%s' not found", skills_dir)

    # 3) 迁移：已装的市场 skill → 引用（并删本地文件；用户自建的不动）。
    data_dir = paths.data_dir()
    ref_store = SkillReferenceStore(data_dir)
    try:
        n = migrate_pulled_to_references(SkillPullStore(data_dir), ref_store, skills_dir)
        if n:
            logger.info("Skills: migrated %d pulled market skill(s) to references", n)
    except Exception:
        logger.warning("Skills: migrate pulled→references failed", exc_info=True)

    # 3b) 回填随包默认引用（缺的补上、description 为空的填回）。
    try:
        n = seed_default_references(paths.bundled_default_references(), ref_store)
        if n:
            logger.info("Skills: seeded %d default cloud reference(s)", n)
    except Exception:
        logger.warning("Skills: seed default references failed", exc_info=True)

    # 3c) 清理 description 为空的坏引用（历史迁移/老构建遗留）。默认 6 个已在 3b 回填、不为空、
    #     不会被删；剩下的空 description 引用直接删掉，用户需要可从市场重新引用。
    try:
        n = prune_null_references(ref_store)
        if n:
            logger.info("Skills: pruned %d reference(s) with empty description", n)
    except Exception:
        logger.warning("Skills: prune null references failed", exc_info=True)

    # 4) 云端引用 provider —— 需要市场下载能力；市场未配置则跳过（引用仍在库里，
    #    但暂不可 materialize）。执行参数镜像本地 provider，保持行为一致。
    from netlivecowork.api import deps
    try:
        market = deps.get_skill_market_service()
    except Exception as e:
        logger.warning("Skills: 云端引用 provider 未启用（市场未配置）：%s", e)
        return
    providers.register_capability(ReferencedSkillCapabilityProvider(
        ref_store,
        market,
        idle_timeout_sec=cfg.skill_idle_timeout_sec,
        hard_cap_sec=cfg.skill_hard_cap_sec,
        output_limit_chars=cfg.skill_output_limit_chars,
        # 同本地 provider：打包态用共享 venv 的 python，dev 回退 fs_bash_venv_python。
        python_executable=cfg.fs_shared_venv_python or cfg.fs_bash_venv_python,
        # 会话 → 归属标签。**装配的地方喂进来**，provider 自己不认识 cowork
        # （架构设计 §7 的 import 规则）。
        owned_labels_fn=_cowork_owned_labels,
        # 和本地 skill 同一条执行通道。少了它，_borrow_local 建出来的临时 provider 就没有
        # bash_runner，exec_script 落到 core 的 _exec_direct：拿后端进程自己的环境直接起子进程，
        # 不过 fs:shell，也就没有 Low 令牌、没有工作区闸门、没有 Office broker。
        bash_runner=_bash_runner_for(fs_provider),
    ))
    logger.info("Skills: cloud (referenced) provider loaded")


def _register_topology(providers) -> None:
    from netlivecowork import paths
    topo_dir = paths.drawing_engine_dir()
    if not topo_dir.exists():
        return
    from netlivecowork.providers.capability.topology import TopologyCapabilityProvider, TopologyConfig
    node_exe = paths.drawing_engine_node_executable()
    providers.register_capability(TopologyCapabilityProvider(TopologyConfig(
        engine_dir=topo_dir, node_executable=node_exe,
    )))
    logger.info("Topology: capability provider loaded from %s (node=%s)", topo_dir, node_exe)


def _register_llm(runtime) -> None:
    from netlivecowork import paths
    from netlivecowork.config import get_settings
    from netlivecowork.providers.llm.account_store import LLMAccountStore
    from netlivecowork.providers.llm.llm_provider import LLMProvider

    cfg = get_settings()
    provider = LLMProvider(
        LLMAccountStore(),
        max_http_retries=cfg.llm_max_http_retries,
        ssl_verify=cfg.http_ssl_verify,
    )
    loaded = provider.load_from_store()
    provider.bootstrap_from_seed(paths.llm_accounts_seed_path())
    # cowork 套件自带的账号（清单 llm.define）。**顺序不能挪到前面**：
    # 本机账号（store）与出厂账号（seed）都先注册，这里才判得出"本机已有"——
    # 反过来的话下发的账号会先占住名字，用户自己配的那份反而进不来。
    #
    # ⚠ 也不能放进 _setup_cowork()：那时 runtime 正在建，去 deps 取 provider 会成环
    # （实测：get_llm_provider → get_runtime → 正在初始化的自己）。
    _register_cowork_llm_accounts(provider)
    runtime.providers.register_llm_provider(provider)
    if loaded:
        logger.info("LLMProvider: restored %d account(s)", loaded)


def _register_mcp(runtime):
    """注册 MCP。**这里是唯一同时认识 cowork 与具体 provider 的地方。**

    cowork 那一层提供一个包装器，manager 在注册前过一道；不给就原样注册
    （架构设计 D2：去掉 cowork 之后后端仍能跑，衍生品牌的单 agent 形态靠这条）。
    """
    from netlivecowork.api import deps
    from netlivecowork.providers.capability.mcp.manager import MCPProviderManager
    from netlivecowork.providers.capability.mcp.store import MCPServerStore

    manager = MCPProviderManager(MCPServerStore(), runtime.providers, wrap=_cowork_mcp_wrapper())
    manager.load_from_store()
    deps.set_mcp_manager(manager)
    return manager


def _reporting_labels_of(session_id: str):
    """会话 → 打点归属。与 _cowork_owned_labels 同源，**都只问 scope 一句话**。

    账号从当前登录用户取：桌面端是单用户进程，运行时没有前端请求可问。
    """
    from netlivecowork.cowork.runtime import get_scope
    from netlivecowork.providers.capability.skills import current_user
    from netlivecowork.reporting.labels import Labels

    scope = get_scope()
    cowork = scope.cowork_id_of(session_id) if scope is not None else ""
    return Labels(cowork=cowork, account=(current_user.get_current_username() or "").strip())


def _install_session_resolver() -> None:
    """装上"会话 → 它的模板"的回查。

    **这一步不是可选的收尾动作。** `bind_session` 只在**建会话**那条路径上被调，
    而重启后从库里恢复的会话根本没走过那条路径 —— 没有回查的话它们归属为空，
    于是能力一律不过滤：**那些会话看得见全部 skill 与 MCP，且不报错**。
    实测就是这么暴露的（重启后老会话里两个 cowork 都说自己有全部 skill）。

    回查读的是内存会话注册表，它在恢复流程里已经填好。**绝不抛** ——
    查不到就当"不知道归属"，回到不过滤，与没装回查时一样。
    """
    from netlivecowork.api.models import session as _sm
    from netlivecowork.cowork.runtime import get_scope

    def template_of(session_id: str) -> str | None:
        entry = _sm._sessions.get(session_id)
        return getattr(entry, "template_id", None) if entry is not None else None

    scope = get_scope()
    if scope is not None:
        scope.set_resolver(template_of)


def _cowork_owned_labels(session_id: str | None) -> set[str] | None:
    """这条会话拥有哪些 skill 归属标签。`None` = 不设限。

    翻译只有这一处：会话 → cowork id → 标签。**别处不许再算一遍** ——
    算两遍必然在某个分支上不一致，而现象是"这个 skill 时有时无"。
    """
    from netlivecowork.cowork.runtime import get_scope

    scope = get_scope()
    if scope is None:
        return None
    cid = scope.cowork_id_of(session_id)
    return {cid} if cid else None


def _seed_master_template(coworks_dir: Path) -> None:
    """把母版复制进套件目录（缺了才补）。

    母版**不是 cowork**（列清单时按名字排除），但模板加载要用它：
    facet 兜底与"建会话未指定模板"的回落都靠它。不放进来的话，
    历史会话与内部任务会集体跑不动，而原因完全指不到这里。
    """
    import shutil

    from netlivecowork import paths
    from netlivecowork.cowork.manifest import MASTER_ID

    src = paths.resources_dir() / "agents" / MASTER_ID
    dst = Path(coworks_dir) / MASTER_ID
    if not src.is_dir() or dst.exists():
        return
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src, dst)
        logger.info("cowork：母版模板已就位 %s", dst)
    except OSError:
        logger.warning("cowork：母版模板复制失败，历史会话可能跑不动", exc_info=True)


def _setup_cowork() -> None:
    """对账 + 建策略。**这一步失败不能挡住启动**（需求 C11/B12）。

    连不上云端、暂存目录里什么都没有、包全坏了——都只意味着"这次没装上"，
    应用照常打开、历史会话照常查看。真要对话时自然会失败，不需要再造一道门去拦。
    """
    from netlivecowork import paths
    from netlivecowork.cowork import runtime as cowork_runtime
    from netlivecowork.cowork.reconcile import reconcile

    _seed_master_template(paths.coworks_dir())

    reconciled = False
    try:
        reconcile(paths.cowork_staging_dir(), paths.coworks_dir())
        reconciled = True
    except Exception:
        logger.warning("cowork：对账失败，沿用已装的那些", exc_info=True)
    try:
        # ⚠ reconciled 决定"阵容算不算确知"：还没对账时不判只读，
        # 否则一次网络抖动会显示成"你的权限被收回了"（需求 I9）。
        cowork_runtime.setup(paths.coworks_dir(), reconciled=reconciled)
        _install_session_resolver()
    except Exception:
        logger.warning("cowork：策略装配失败，本次不做能力隔离", exc_info=True)

    # cowork 自带的技能市场。**只在这一处接** —— 市场层自己不认识 cowork（架构设计 §7）：
    # 那几个地址写在套件里（cowork.json 的 skills.*），属于权限，不属于部署配置。
    try:
        from netlivecowork.providers.capability.skills.adapters import registry as market_registry
        market_registry.install_cowork_markets(_cowork_markets)
    except Exception:
        logger.warning("cowork：市场页签接入失败，本次只有通用市场", exc_info=True)

    # 打点的归属来源。**只在这一处接** —— 打点侧自己不认识 cowork（架构设计 §7），
    # 而"这条会话属于谁"只能有一个来源：算两遍必然在某个分支上不一致，
    # 现象是"权限对了但账算错了"，反过来也可能，且两边都不报错。
    try:
        from netlivecowork.reporting import labels as reporting_labels
        reporting_labels.install_resolver(_reporting_labels_of)
    except Exception:
        logger.warning("打点：归属接入失败，本次上报无归属", exc_info=True)


def _cowork_local_skill_wrapper(inner):
    """给本地 skill provider 包上归属过滤；这个构建没有 cowork 这一层就返回 None。

    归属库（local_skill_owners.json）在 providers 那边，会话→标签的翻译在 cowork 那边，
    两头都由这里接起来 —— 包装器自己**既不认识 cowork 也不认识归属库**。
    """
    try:
        from netlivecowork import paths
        from netlivecowork.cowork.guards import CoworkScopedLocalSkillProvider
        from netlivecowork.providers.capability.skills.references.local_owners import (
            LocalSkillOwners,
        )

        owners = LocalSkillOwners(paths.data_dir())

        def labels_of(skill_name: str):
            """这条 skill 归谁。**要同时认目录名和 SKILL.md 里的 name。**

            归属是按 `skill_id` 存的，而 `skill_id` 是**目录名**
            （services/local.py: `"skill_id": skill_dir.name`）；
            运行时这里拿到的却是能力名，也就是 SKILL.md frontmatter 里的 `name`
            （`meta.name or skill_dir.name`）。两者不一致的 skill——目录叫 a、
            里面写 name: b——归属就永远对不上：用户在技能中心明明勾了，
            agent 那边查不到记录，当成"通用"或"没有"，而两边都不报错。

            先按拿到的名字查；查不到再反查一遍目录名。
            """
            got = owners.labels_of(skill_name)
            if got:
                return got
            try:
                from netlivecowork.api import deps

                svc = deps.get_local_skill_service()
                for item in svc.list_skills():
                    if item.get("name") == skill_name and item.get("skill_id") != skill_name:
                        return owners.labels_of(item["skill_id"])
            except Exception:
                pass
            return got

        return CoworkScopedLocalSkillProvider(
            inner,
            owned_labels_fn=_cowork_owned_labels,
            # 每次现查，不缓存：用户在技能中心改完归属，下一条消息就该按新归属走，
            # 而不是等重启。这份表很小，读一次是一次 json.loads。
            skill_labels_fn=labels_of,
        )
    except Exception:
        logger.warning("cowork：本地 skill 归属隔离装配失败，本次不隔离", exc_info=True)
        return None


def rebuild_cowork_llm_accounts() -> None:
    """对账之后重建套件账号。**给 `/coworks/recheck` 调**。

    不调的话：收回一个 cowork，它下发的账号还挂在后端，且带着可用的凭据 —— 而套件
    已经删了。重启才会干净（账号不落盘），但"要重启才对"本身就是个静默故障。
    需求 F5 说的"套件在运行期发生变化时一并重建"，这是漏掉的那一路。
    """
    try:
        from netlivecowork.api import deps

        _register_cowork_llm_accounts(deps.get_llm_provider())
    except Exception:
        logger.warning("cowork：对账后重建 LLM 账号失败", exc_info=True)


def _register_cowork_llm_accounts(provider) -> None:
    """把已装套件里 `llm.define` 定义的账号注册进 LLM provider。

    **先撤后装**，不是"只删被收回那一个"：一次对账可能同时装了新套件、改了别的版本，
    要逐个算差集就得再写一套判断，而那套判断与这里是两份代码，早晚在某个分支上不一致
    —— 表现是"某个账号该在却不在、或该没了却还在"，且不报错。全撤重装走的就是开机那条路，
    少一套代码就少一处会错的地方。

    ## 三条不能改的

    **① 不落盘**（`persist=False`）。这些账号属于 cowork，不属于用户 —— 套件被收回、
    重启之后它们就该没了。写进账号库的话，权限收回后账号还留着，而它带着可用的凭据：
    那是一次实打实的越权，且没有任何现象提示。与只读会话同一个道理：**推导，不写状态**。

    **② 锁定**（禁删禁改），与出厂账号同一处理。用户改了也留不住（下次启动按套件重来），
    给他一个能改却改不动的入口，比不给更糟。

    **③ 不解密、不打日志。** `api_key` 从清单里原样取出交给 provider，那边的
    `decrypt_key` 认 `enc:v1:` 密文、对明文原样透传。这里多解一次只会多一处
    能把密钥读进内存的地方；而任何一条 `exc_info=True` 的日志都可能把它写进文件（K7）。

    同名冲突时**本机已有的优先**：用户自己配的账号不该被下发覆盖掉。
    """
    from ctx_weft.providers.llm import LLMAccount, ModelConfig

    from netlivecowork.cowork.runtime import get_scope
    from netlivecowork.providers.llm.llm_provider import ORIGIN_SUITE

    # 先撤：留着的话，收回之后那个账号还在，且带着可用的凭据。
    provider.drop_accounts_of_origin(ORIGIN_SUITE)

    scope = get_scope()
    if scope is None:
        return

    registered = 0
    for cid in sorted(scope.installed_ids()):
        suite = scope.suite(cid)
        for d in getattr(suite, "llm_define", ()) or ():
            if provider.is_registered(d.name):
                # 本机已有同名 —— 用户自己配的那份优先，不覆盖。
                logger.info("cowork：LLM 账号 %r 本机已有，沿用本机的（%s 的定义跳过）", d.name, cid)
                continue
            try:
                provider.register_account(
                    LLMAccount(
                        name=d.name,
                        style=d.style,
                        api_key=_decrypted(d.api_key),
                        base_url=d.base_url,
                        models=[
                            ModelConfig(name=m.model, context_limit=m.context_limit,
                                        output_reserve=m.output_reserve,
                                        output_ceiling=m.output_ceiling)
                            for m in d.models
                        ],
                        default_model=d.default_model,
                        timeout_sec=d.timeout_sec,
                    ),
                    persist=False,          # ← 见 ①
                )
                provider.mark_origin(d.name, ORIGIN_SUITE)   # 受管 → 受 allow 约束、且锁定
                registered += 1
            except Exception:
                # 一个账号坏了不连累其余，也不连累启动。**日志里不带账号内容**，只带名字。
                logger.warning("cowork：注册 %s 的 LLM 账号 %r 失败", cid, d.name, exc_info=True)
    if registered:
        logger.info("cowork：注册了 %d 个套件自带的 LLM 账号", registered)


def _decrypted(raw: str) -> str:
    """`enc:v1:` → 明文；无前缀的原样透传。**失败时抛，不静默用密文当 key**。

    静默透传的现象是"模型调不通"，而错误来自服务端（401），完全指不回这里。
    """
    from netlivecowork.providers.llm.secret import decrypt_key

    return decrypt_key(raw)


def _cowork_markets():
    """有自己市场的已开通 cowork，供市场层开页签。

    display_name 一并给出：市场层拿到的是一个"页签"，让它再回头去查名字，就等于让它
    认识 cowork 了。

    **绝不抛** —— 页签少一个是"这个 cowork 没市场"，接口 500 是"技能市场坏了"，
    两者对用户是完全不同的事。
    """
    from netlivecowork.providers.capability.skills.adapters.registry import CoworkMarket
    from netlivecowork.cowork.runtime import get_policy, get_scope

    policy = get_policy()
    scope = get_scope()
    if policy is None or scope is None:
        return []
    out = []
    for cid, market_url, mythos_url in policy.market_scopes():
        suite = scope.suite(cid)
        out.append(CoworkMarket(
            cowork_id=cid,
            display_name=(getattr(suite, "display_name", "") or cid),
            pull_server_url=market_url,
            mythos_base_url=mythos_url,
        ))
    return out


def _cowork_mcp_wrapper():
    """按 cowork 归属过滤 MCP 的包装器；这个构建没有 cowork 这一层就返回 None。"""
    from netlivecowork.cowork.guards import CoworkScopedMCPProvider
    from netlivecowork.cowork.runtime import client_shipped_mcp_names, get_policy

    shipped = client_shipped_mcp_names()

    def wrap(provider, server_name: str):
        return CoworkScopedMCPProvider(
            provider,
            server_name,
            get_policy,
            # ⚠ 客户端自带的 MCP 不受套件声明约束（需求 G6）：它随包发布、
            # 云端管理台里根本不会列出它。拿套件声明去卡它 = 所有 cowork 都失去这个工具。
            suite_delivered=server_name not in shipped,
        )

    return wrap


def _reap_orphan_office_brokers() -> None:
    try:
        from netlivecowork.office_broker import manager as office_manager
        n = office_manager.reap_orphan_brokers()
        if n:
            logger.info("清掉 %d 个上次遗留的 Office broker", n)
    except Exception:
        logger.debug("清理遗留 Office broker 失败", exc_info=True)


# ── authorizer / 边界接线 ─────────────────────────────────────────────────────


def _wire_authorizers(runtime, providers, agent_provider, fs_provider) -> None:
    from ctx_weft.protocols.context import ProviderContext
    from ctx_weft.protocols.filesystem import FsTool, FS_PROVIDER_NAME
    from netlivecowork.api import deps
    from netlivecowork.auth.bash_authorizer import SelectiveBashAuthorizer
    from netlivecowork.auth.fs_write_authorizer import WorkspaceWriteAuthorizer
    from netlivecowork.auth.mode_store import BashReviewModeStore
    from netlivecowork.config import get_settings
    from netlivecowork.paths import data_dir
    from netlivecowork.providers.capability.fs_bash_compat import FS_BASH_EXEC

    mode_store = BashReviewModeStore(data_dir() / "bash_review_modes.json")
    deps.set_bash_review_modes(mode_store)

    # 低完整性边界：共享 venv / low_temp 的标 Low 已挪到【首次进 strict-auto 时】惰性执行
    # （见 activation.activate_low_integrity）——启动时无条件标会让从不用自动模式的用户也吃到
    # "venv 里的 python.exe 被标 Low → 所有模式下 python/pip 都降级成 Low 进程"这个坑。
    # 这里只做反向修复：把共享 venv 里的 .exe 还原成 Medium（存量安装 + pip 新装的 console
    # script 都要）。只在 Windows+pywin32 且该 venv 曾被标过时才动，否则 no-op。
    from netlivecowork.low_integrity.activation import sweep_shared_venv_executables
    sweep_shared_venv_executables(data_dir())

    # 关机/重启拦截的【根本】解法：启动即从进程令牌删除关机特权。所有 agent shell 子进程（任何模式，
    # 含 Low 令牌）都继承这个减权令牌，ctypes 直调 ExitWindowsEx/InitiateSystemShutdownEx 均因缺特权
    # 失败——不看命令字符串，补掉"关机写进 .py 文件/动态拼 API 名"绕过黑名单的漏洞。仅 Windows 生效。
    from netlivecowork.low_integrity import windows as _win
    _win.drop_shutdown_privileges()

    def _workspace_lookup(session_id: str, _fs=fs_provider) -> str | None:
        return _fs.workspace_for(ProviderContext(session_id=session_id))

    # 把工作目录查询交给 template provider：get_template 时据 session 把工作区写进 SOUL 系统提示，
    # 让模型主动知道工作区在哪（template provider 早于 fs provider 构造，故此处后置注入）。
    agent_provider.set_workspace_lookup(_workspace_lookup)

    # 共享 venv 在工作区外，但引用它（pip/python 绝对路径、写 site-packages）是合法操作，
    # 半自动/人工审核的越界路径检查应把它当作「合法根」排除，不弹越界确认。dev 态无共享 venv → ()。
    from netlivecowork.low_integrity.activation import _shared_venv_root
    _venv_root = _shared_venv_root()
    _allowed_roots: tuple[str, ...] = (str(_venv_root),) if _venv_root else ()

    # rewind：工作区文件检查点/回滚。回合边界订阅 EventBus 拍快照；只管文件、不动对话。
    cfg = get_settings()
    if cfg.rewind_enabled:
        from netlivecowork.rewind.manager import RewindManager
        _rewind = RewindManager(
            data_dir() / "checkpoints", _workspace_lookup,
            keep=cfg.rewind_keep, max_file_mb=cfg.rewind_max_file_mb,
        )
        runtime.event_bus.subscribe(None, _rewind.on_event)
        deps.set_rewind_manager(_rewind)

    bash_authz = SelectiveBashAuthorizer(
        hitl_manager=runtime.hitl_manager,
        mode_store=mode_store,
        workspace_lookup=_workspace_lookup,
        allowed_roots=_allowed_roots,
    )
    # 主 id 用更名后的 shell；旧 id bash_exec 一并注册，兜住暂停会话里仍带旧 capability_id
    # 的 HITL 待放行项（旧名兼容见 providers.capability.fs_bash_compat）。
    providers.set_capability_authorizer(FsTool.SHELL, bash_authz)
    providers.set_capability_authorizer(FS_BASH_EXEC, bash_authz)
    # write_file / edit_file 受工作目录约束：auto 越界硬拒绝、manual 越界人工确认。
    write_authz = WorkspaceWriteAuthorizer(
        hitl_manager=runtime.hitl_manager,
        mode_store=mode_store,
        workspace_lookup=_workspace_lookup,
        allowed_roots=_allowed_roots,
    )
    providers.set_capability_authorizer(FsTool.WRITE_FILE, write_authz)
    providers.set_capability_authorizer(f"{FS_PROVIDER_NAME}:edit_file", write_authz)

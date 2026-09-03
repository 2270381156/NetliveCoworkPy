"""集中配置：所有 .env/环境变量在此读取一次。

来源不变（.env / env var），但读取集中到 Settings。除 LLM 默认账号/模型
（由随包 JSON 种子 default_llm_accounts.json 经 bootstrap_from_seed 读）外，
所有配置由 host 读取，并在实例化时注入 core（RuntimeConfig / provider 构造参数）。

优先级：CLI 参数 > 环境变量(.env) > 此处默认值。

env keys（默认值见各字段）：
  NLC_RESOURCES_DIR / NLC_SKILLS_DIR / NLC_AGENTS_DIR / NLC_DATA_DIR
  NLC_DRAWING_ENGINE_DIR      （drawing-engine/ 目录；未设时 dev 态取仓库根同级目录，冻结态见 _run.py）
  NLC_DRAWING_ENGINE_NODE_EXECUTABLE （运行 drawing-engine/cli.js 的 node 可执行文件；未设时 dev 态假定 PATH 上有 node）
  NLC_WATCH_INTERVAL / NLC_LOG_LEVEL / NLC_LOG_FORMAT
  NLC_LOG_DIR / NLC_LOG_FILENAME / NLC_LOG_BACKUP_DAYS / NLC_CORE_LOG_LEVEL
  NLC_SNAPSHOT_EVERY_N_EVENTS / NLC_SNAPSHOT_KEEP
  DATABASE_URL
  NLC_HITL_TIMEOUT_SEC / NLC_HITL_MAX_RESOLVED
  NLC_TASK_MAX_CONCURRENT / NLC_TASK_MAX_RETRIES
  NLC_DEFAULT_TOKEN_BUDGET / NLC_DEFAULT_TASK_TIMEOUT_MS
  NLC_FS_BASH_TIMEOUT_SEC / NLC_FS_BASH_IDLE_TIMEOUT_SEC / NLC_FS_BASH_HARD_CAP_SEC / NLC_FS_BASH_MAX_OUTPUT_BYTES
  NLC_FS_FILE_READ_DEFAULT_LINES / NLC_FS_FILE_READ_MAX_BYTES / NLC_FS_FILE_READ_MAX_LINE_BYTES / NLC_FS_FILE_READ_COUNT_MAX_BYTES
  NLC_FS_GLOB_MAX_RESULTS / NLC_FS_BASH_VENV_PYTHON
  NLC_PIP_INDEX_URL / NLC_PIP_EXTRA_INDEX_URL / NLC_PIP_TRUSTED_HOST / NLC_PIP_TIMEOUT
  NLC_HTTP_TIMEOUT_SEC / NLC_HTTP_MAX_RESPONSE_BYTES
  NLC_MCP_MAX_RECONNECT_ATTEMPTS / NLC_MCP_RECONNECT_BASE_DELAY_SEC
  NLC_SKILL_IDLE_TIMEOUT_SEC / NLC_SKILL_HARD_CAP_SEC / NLC_SKILL_OUTPUT_LIMIT_CHARS
  NLC_SKILL_PULL_SERVER_URL    (cowork 市场地址，无默认值；未配则该市场不可用)
  NLC_SKILL_MYTHOS_BASE_URL    (mythos 市场地址，无默认值；未配则该市场不可用)
  NLC_LLM_MAX_HTTP_RETRIES
  NLC_LLM_SELF_HEAL_MAX_ATTEMPTS / NLC_LLM_SELF_HEAL_MAX_DURATION_SEC
  NLC_LLM_SELF_HEAL_BASE_DELAY_SEC / NLC_LLM_SELF_HEAL_MAX_INTERVAL_SEC
"""
from __future__ import annotations

import os
from dataclasses import dataclass


def _int(key: str, default: int) -> int:
    raw = os.environ.get(key)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _float(key: str, default: float) -> float:
    raw = os.environ.get(key)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _opt_int(key: str) -> int | None:
    raw = os.environ.get(key)
    if not raw:
        return None
    try:
        v = int(raw)
    except ValueError:
        return None
    return v if v > 0 else None


def _bool(key: str, default: bool) -> bool:
    raw = os.environ.get(key)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _str(key: str, default: str | None) -> str | None:
    raw = os.environ.get(key)
    return raw if raw else default


@dataclass(frozen=True)
class Settings:
    resources_dir: str | None
    skills_dir: str | None
    agents_dir: str | None
    data_dir: str | None
    #: 上一代 agent id（迁移来的历史会话归属它，如 ipmaster）。派生品牌/无历史时为 None。
    legacy_agent_id: str | None
    drawing_engine_dir: str | None
    drawing_engine_node_executable: str | None
    watch_interval: float
    log_level: str | None
    log_format: str
    log_dir: str | None
    log_filename: str
    log_backup_days: int
    core_log_level: str | None
    snapshot_every_n: int
    snapshot_keep: int
    rewind_enabled: bool           # 工作区文件检查点/回滚（rewind），默认开
    rewind_keep: int               # 每会话保留的检查点数（gc 丢更旧的 + 清孤儿 blob）
    rewind_max_file_mb: int        # 单文件超过多少 MB 就跳过（不纳入快照/回滚）
    database_url: str
    hitl_timeout_sec: int | None
    hitl_max_resolved: int
    task_max_concurrent: int
    task_max_retries: int
    default_token_budget: int
    default_task_timeout_ms: int
    fs_bash_timeout_sec: int
    fs_bash_idle_timeout_sec: int
    fs_bash_hard_cap_sec: int
    fs_bash_max_output_bytes: int
    fs_file_read_default_lines: int
    fs_file_read_max_bytes: int
    fs_file_read_max_line_bytes: int
    fs_file_read_count_max_bytes: int
    fs_glob_max_results: int
    # 工作区写操作的两道闸。上传单文件恒定受限；配额（0 = 不限）按**整个工作区根**算，
    # 地端默认不限——工作区就是用户自己机器上的目录，替他限额是越权。
    workspace_max_upload_bytes: int
    workspace_max_download_bytes: int
    workspace_quota_bytes: int
    spill_threshold: int
    spill_preview_chars: int
    fs_bash_venv_python: str | None
    # 全应用共享 venv 的 python（NLC_SHARED_VENV_PYTHON，仅打包态由 _run.py 注入）。
    # 设了 = 共享 venv 模式：bash + skill 统一走它、关掉每 workspace 自动 venv；dev 为 None。
    fs_shared_venv_python: str | None
    # dev 覆盖：LLM 默认账号种子文件路径。设了就用它（本地 gitignored 文件，便于开发测试、
    # 不动随包出厂模板）；未设 → 用随包 default_llm_accounts.json。相对路径按项目根解析。
    llm_accounts_seed_file: str | None
    pip_index_url: str | None
    pip_extra_index_url: str | None
    pip_trusted_host: str | None
    pip_timeout: str | None
    http_timeout_sec: int
    http_max_response_bytes: int
    mcp_max_reconnect_attempts: int
    mcp_reconnect_base_delay_sec: float
    skill_idle_timeout_sec: int
    skill_hard_cap_sec: int
    skill_output_limit_chars: int
    # 云端 skill 下载（引用式加载）重试：瞬时错误（网络不可达/服务端 5xx）时重试的次数
    # 上限，及指数退避的起始间隔（秒）；永久错误（404/空内容）不重试。
    skill_download_retries: int
    skill_download_retry_delay_sec: float
    llm_max_http_retries: int
    llm_self_heal_max_attempts: int
    llm_self_heal_max_duration_sec: float
    llm_self_heal_base_delay_sec: float
    llm_self_heal_max_interval_sec: float
    http_ssl_verify: bool
    # Skill 市场两个数据源的地址放一起管理：
    #   cowork —— 现有自建市场（无鉴权，列表全量返回）
    #   mythos —— IPmasterMythos（请求头带当前用户名，列表服务端分页）
    skill_pull_server_url: str | None
    skill_mythos_base_url: str | None
    default_template_id: str

    def to_runtime_config(self):
        from ctx_weft.core.config import RuntimeConfig
        return RuntimeConfig(
            hitl_timeout_sec=self.hitl_timeout_sec,
            hitl_max_resolved=self.hitl_max_resolved,
            task_max_concurrent=self.task_max_concurrent,
            task_max_retries=self.task_max_retries,
            default_token_budget=self.default_token_budget,
            default_task_timeout_ms=self.default_task_timeout_ms,
            llm_self_heal_max_attempts=self.llm_self_heal_max_attempts,
            llm_self_heal_max_duration_sec=self.llm_self_heal_max_duration_sec,
            llm_self_heal_base_delay_sec=self.llm_self_heal_base_delay_sec,
            llm_self_heal_max_interval_sec=self.llm_self_heal_max_interval_sec,
            spill_threshold=self.spill_threshold,
            spill_preview_chars=self.spill_preview_chars,
        )

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            resources_dir=_str("NLC_RESOURCES_DIR", None),
            skills_dir=_str("NLC_SKILLS_DIR", None),
            agents_dir=_str("NLC_AGENTS_DIR", None),
            data_dir=_str("NLC_DATA_DIR", None),
            legacy_agent_id=_str("NLC_LEGACY_AGENT_ID", None),
            drawing_engine_dir=_str("NLC_DRAWING_ENGINE_DIR", None),
            drawing_engine_node_executable=_str("NLC_DRAWING_ENGINE_NODE_EXECUTABLE", None),
            watch_interval=_float("NLC_WATCH_INTERVAL", 5.0),
            log_level=_str("NLC_LOG_LEVEL", None),
            log_format=_str("NLC_LOG_FORMAT", "text") or "text",
            log_dir=_str("NLC_LOG_DIR", None),
            log_filename=_str("NLC_LOG_FILENAME", "netlivecowork.log") or "netlivecowork.log",
            log_backup_days=_int("NLC_LOG_BACKUP_DAYS", 7),
            core_log_level=_str("NLC_CORE_LOG_LEVEL", None),
            snapshot_every_n=_int("NLC_SNAPSHOT_EVERY_N_EVENTS", 50),
            snapshot_keep=_int("NLC_SNAPSHOT_KEEP", 3),
            rewind_enabled=_bool("NLC_REWIND_ENABLED", True),
            rewind_keep=_int("NLC_REWIND_KEEP", 15),
            rewind_max_file_mb=_int("NLC_REWIND_MAX_FILE_MB", 100),
            database_url=_str("DATABASE_URL", "sqlite") or "sqlite",
            hitl_timeout_sec=_opt_int("NLC_HITL_TIMEOUT_SEC"),
            hitl_max_resolved=_int("NLC_HITL_MAX_RESOLVED", 1000),
            task_max_concurrent=_int("NLC_TASK_MAX_CONCURRENT", 1),
            task_max_retries=_int("NLC_TASK_MAX_RETRIES", 3),
            default_token_budget=_int("NLC_DEFAULT_TOKEN_BUDGET", 200_000),
            default_task_timeout_ms=_int("NLC_DEFAULT_TASK_TIMEOUT_MS", 60_000),
            fs_bash_timeout_sec=_int("NLC_FS_BASH_TIMEOUT_SEC", 30),
            fs_bash_idle_timeout_sec=_int("NLC_FS_BASH_IDLE_TIMEOUT_SEC", 30),
            fs_bash_hard_cap_sec=_int("NLC_FS_BASH_HARD_CAP_SEC", 3600),
            fs_bash_max_output_bytes=_int("NLC_FS_BASH_MAX_OUTPUT_BYTES", 50_000),
            fs_file_read_default_lines=_int("NLC_FS_FILE_READ_DEFAULT_LINES", 500),
            fs_file_read_max_bytes=_int("NLC_FS_FILE_READ_MAX_BYTES", 20_480),
            fs_file_read_max_line_bytes=_int("NLC_FS_FILE_READ_MAX_LINE_BYTES", 4096),
            fs_file_read_count_max_bytes=_int("NLC_FS_FILE_READ_COUNT_MAX_BYTES", 5_242_880),
            fs_glob_max_results=_int("NLC_FS_GLOB_MAX_RESULTS", 500),
            workspace_max_upload_bytes=_int("NLC_WORKSPACE_MAX_UPLOAD_BYTES", 100 * 1024 * 1024),
            workspace_max_download_bytes=_int("NLC_WORKSPACE_MAX_DOWNLOAD_BYTES", 500 * 1024 * 1024),
            workspace_quota_bytes=_int("NLC_WORKSPACE_QUOTA_BYTES", 0),
            spill_threshold=_int("NLC_SPILL_THRESHOLD", 4000),
            spill_preview_chars=_int("NLC_SPILL_PREVIEW_CHARS", 1000),
            fs_bash_venv_python=_str("NLC_FS_BASH_VENV_PYTHON", None),
            fs_shared_venv_python=_str("NLC_SHARED_VENV_PYTHON", None),
            llm_accounts_seed_file=_str("NLC_LLM_ACCOUNTS_FILE", None),
            pip_index_url=_str("NLC_PIP_INDEX_URL", None),
            pip_extra_index_url=_str("NLC_PIP_EXTRA_INDEX_URL", None),
            pip_trusted_host=_str("NLC_PIP_TRUSTED_HOST", None),
            pip_timeout=_str("NLC_PIP_TIMEOUT", None),
            http_timeout_sec=_int("NLC_HTTP_TIMEOUT_SEC", 30),
            http_max_response_bytes=_int("NLC_HTTP_MAX_RESPONSE_BYTES", 1_000_000),
            mcp_max_reconnect_attempts=_int("NLC_MCP_MAX_RECONNECT_ATTEMPTS", 3),
            mcp_reconnect_base_delay_sec=_float("NLC_MCP_RECONNECT_BASE_DELAY_SEC", 1.0),
            skill_idle_timeout_sec=_int("NLC_SKILL_IDLE_TIMEOUT_SEC", 90),
            skill_hard_cap_sec=_int("NLC_SKILL_HARD_CAP_SEC", 600),
            skill_output_limit_chars=_int("NLC_SKILL_OUTPUT_LIMIT_CHARS", 65536),
            skill_download_retries=_int("NLC_SKILL_DOWNLOAD_RETRIES", 2),
            skill_download_retry_delay_sec=_float("NLC_SKILL_DOWNLOAD_RETRY_DELAY_SEC", 1.0),
            llm_max_http_retries=_int("NLC_LLM_MAX_HTTP_RETRIES", 3),
            llm_self_heal_max_attempts=_int("NLC_LLM_SELF_HEAL_MAX_ATTEMPTS", 8),
            llm_self_heal_max_duration_sec=_float("NLC_LLM_SELF_HEAL_MAX_DURATION_SEC", 300.0),
            llm_self_heal_base_delay_sec=_float("NLC_LLM_SELF_HEAL_BASE_DELAY_SEC", 2.0),
            llm_self_heal_max_interval_sec=_float("NLC_LLM_SELF_HEAL_MAX_INTERVAL_SEC", 60.0),
            http_ssl_verify=_bool("NLC_HTTP_SSL_VERIFY", False),
            skill_pull_server_url=_str("NLC_SKILL_PULL_SERVER_URL", None),
            skill_mythos_base_url=_str("NLC_SKILL_MYTHOS_BASE_URL", None),
            default_template_id=_str("NLC_DEFAULT_TEMPLATE_ID", "default") or "default",
        )


_settings: "Settings | None" = None


def get_settings() -> "Settings":
    """懒加载单例；首次调用时读 env（.env 已在 cli.main 先行 load_dotenv）。"""
    global _settings
    if _settings is None:
        _settings = Settings.from_env()
    return _settings


def apply_pip_index_env(settings: "Settings") -> None:
    """把 NLC_PIP_* 映射成标准 PIP_* 写入 os.environ,使所有子进程(bash_exec / 经
    bash 的 skill)的 pip 走同一内网源。仅对已配置项赋值,未配置不动。幂等。"""
    mapping = {
        "PIP_INDEX_URL": settings.pip_index_url,
        "PIP_EXTRA_INDEX_URL": settings.pip_extra_index_url,
        "PIP_TRUSTED_HOST": settings.pip_trusted_host,
        "PIP_TIMEOUT": settings.pip_timeout,
    }
    for key, val in mapping.items():
        if val:
            os.environ[key] = val

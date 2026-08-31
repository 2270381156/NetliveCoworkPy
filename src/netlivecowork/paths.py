"""Centralized filesystem path resolution (shared by startup and deps)."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from netlivecowork.config import get_settings


def resources_dir() -> Path:
    s = get_settings()
    return Path(s.resources_dir) if s.resources_dir else Path(__file__).parents[2] / "resources"


def skills_dir(override: str | None = None) -> Path:
    raw = override or get_settings().skills_dir
    return Path(raw) if raw else resources_dir() / "skills"


def agents_dir() -> Path:
    raw = get_settings().agents_dir
    return Path(raw) if raw else resources_dir() / "agents"


def data_dir() -> Path:
    raw = get_settings().data_dir
    return Path(raw) if raw else Path(__file__).parents[2] / "data"


def is_frozen() -> bool:
    """这是打包后的构建吗（PyInstaller 冻结态）。

    **用它来区分"开发期便利"与"发布行为"**，而不是用环境变量：环境变量能被改，
    构建类型不能。套件验签的开发密钥就靠这一条挡在发布构建之外——
    做成运行期开关的话，那个开关迟早会留在发布版里（需求 D8）。
    """
    return bool(getattr(sys, "frozen", False))


def coworks_dir() -> Path:
    """已装 cowork 套件的目录。与 skills/ agents/ 并列（需求 E6）。

    可用 NLC_COWORKS_DIR 覆盖（测试与多实例并存时用）。
    """
    raw = os.getenv("NLC_COWORKS_DIR")
    return Path(raw) if raw else data_dir().parent / "coworks"


def cowork_staging_dir() -> Path:
    """主进程摆包的暂存目录。**它不是安装目录**——两者混用会让"已装"与"待装"分不开。"""
    raw = os.getenv("NLC_COWORK_PACKAGES_DIR")
    return Path(raw) if raw else data_dir() / "cowork-packages"


def bundled_default_references() -> Path:
    """随包"默认引用"文件（内置 skill 上传云端后的 cowork 引用）。
    冻结态打进 PyInstaller 包根（sys._MEIPASS）；dev 取 packaging/default_data/。"""
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "skill_references.default.json"  # type: ignore[attr-defined]
    return Path(__file__).parents[2] / "packaging" / "default_data" / "skill_references.default.json"


def bundled_default_llm_accounts() -> Path:
    """随包"默认 LLM 账号"出厂模板（扁平 JSON，字段同原 NLC_LLM_*）。入库、不放真实密钥。
    冻结态打进 PyInstaller 包根（sys._MEIPASS）；dev 取 packaging/default_data/。"""
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "default_llm_accounts.json"  # type: ignore[attr-defined]
    return Path(__file__).parents[2] / "packaging" / "default_data" / "default_llm_accounts.json"


def llm_accounts_seed_path() -> Path:
    """实际要加载的 LLM 默认账号种子。
    dev 覆盖：设了 NLC_LLM_ACCOUNTS_FILE → 用它（本地 gitignored 文件，放真实 key 做开发测试，
    不动入库的出厂模板）；相对路径按项目根解析。未设 → 用随包 default_llm_accounts.json。"""
    override = get_settings().llm_accounts_seed_file
    if override:
        p = Path(override)
        return p if p.is_absolute() else Path(__file__).parents[2] / p
    return bundled_default_llm_accounts()


def drawing_engine_dir() -> Path:
    """drawing-engine/ 目录（Node 拓扑布局 + DRC 引擎，cli.js/topo.js/drc.js）。
    dev 态取仓库根同级目录；冻结态由 _run.py 把 NLC_DRAWING_ENGINE_DIR 解析成
    exe 同级 resources/drawing-engine。不存在时调用方（cli.py / startup.py）应跳过
    注册 topology capability provider，而不是报错——不是每个部署都需要拓扑功能。"""
    raw = get_settings().drawing_engine_dir
    return Path(raw) if raw else Path(__file__).parents[2] / "drawing-engine"


def drawing_engine_node_executable() -> str:
    """运行 drawing-engine/cli.js 的 node 可执行文件。dev 态假定 PATH 上有 node；
    冻结态由 _run.py 解析成 exe 同级 node-runtime/node.exe（随包内置，见
    build_electron.ps1 的 Node runtime 打包步骤）。"""
    raw = get_settings().drawing_engine_node_executable
    return raw if raw else "node"

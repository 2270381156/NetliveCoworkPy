# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec — NetLIVE Cowork 桌面后端打包。

入口 _run.py（见项目根）。把 frontend-desktop/dist 内嵌为 frontend_dist，
由 _run.py 挂成 SPA。resources/ 与 .env.example 由 build_electron.ps1 在打包后
复制到 dist 目录（与 exe 同级），不在此 spec 内嵌。

用法：pyinstaller packaging/netlive-cowork.spec --noconfirm
产物：dist/<backendName>/<backendName>.exe（+ _internal/）—— 名字取自 branding
"""
import json
import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

# SPECPATH = packaging/；项目根上一级。
_ROOT = str(Path(SPECPATH).parent)

# 后端 exe / dist 目录名同源于 electron/branding.json —— electron/main.js 的
# getBackendExePath() 读同一份文件拼路径，改品牌只动 branding.json，两边不会漂。
_BRANDING = json.loads(
    (Path(_ROOT) / "electron" / "branding.json").read_text(encoding="utf-8")
)
_BACKEND_NAME = _BRANDING["backendName"]

a = Analysis(
    [os.path.join(_ROOT, "_run.py")],
    pathex=[_ROOT],
    binaries=[],
    datas=[
        # 桌面前端构建产物 → 运行时 sys._MEIPASS/frontend_dist
        (os.path.join(_ROOT, "frontend-desktop", "dist"), "frontend_dist"),
        # 默认引用（内置 skill 上传云端后的 cowork 引用）→ 运行时 sys._MEIPASS 根，
        # 首启合并进用户引用库（见 paths.bundled_default_references / seed_default_references）。
        (os.path.join(_ROOT, "packaging", "default_data", "skill_references.default.json"), "."),
        # 默认 LLM 账号种子（扁平 JSON，多 provider）→ 运行时 sys._MEIPASS 根，
        # 启动时经 bootstrap_from_seed 注册为可见但锁定的默认账号（见 paths.bundled_default_llm_accounts）。
        (os.path.join(_ROOT, "packaging", "default_data", "default_llm_accounts.json"), "."),
    ],
    hiddenimports=[
        # strict-auto（全自动）Low 完整性写入边界：low_integrity/windows.py 惰性 import 这些 pywin32
        # 子模块，PyInstaller 静态分析看不到 → 必须显式列，否则打包后 available()=False、边界失效。
        "win32api", "win32con", "win32event", "win32file", "win32job",
        "win32process", "win32security", "win32pipe", "ntsecuritycon", "pywintypes",
        # Office broker（自动模式下替 Low 会话代持 Office COM）：server.py 惰性 import 这两个，
        # 缺了就是 broker 起得来但 Dispatch 必失败。
        "pythoncom", "win32com", "win32com.client",
        # pywin32 自己还有一层【惰性】import，静态分析同样看不见，而且只在特定操作上才触发，
        # 所以 dev 态永远暴露不出来，一打包就崩：
        #   win32timezone —— COM 的 VT_DATE 转 datetime 时才 import。缺了它，读任何日期属性
        #     （Outlook 日程的 Start/End、文件的 LastModified…）都是 ModuleNotFoundError。
        #   win32com.client.makepy / genpy —— gencache.EnsureDispatch 在函数内才 import。
        #     缺了它，取类型库常量（ipmc_office.constants.olFolderCalendar 这种）必失败。
        # 用 collect_submodules 把 win32com 整个收进来，省得下次再被某个惰性 import 咬一口。
        "win32timezone",
        *collect_submodules("win32com"),
        # office_broker 的进程记账（procs.py / manager.py）全是函数内 import psutil。目前靠
        # ctx_weft 的 filesystem provider 顶层 import 才被带进包里——那是侥幸不是设计。它一旦
        # 不见，office_pids() 静默返回空集 → 每次 Dispatch 都判成"连的是用户自己开的 Office"
        # → 退出时不 Quit → 留下没有界面、锁着工作区文件的孤儿进程。显式列住。
        "psutil",
        # uvicorn 运行时按字符串动态导入这些子模块
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.loops.asyncio",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.protocols.websockets.websockets_impl",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        "uvicorn.lifespan.off",
        "anyio._backends._asyncio",
        "starlette.staticfiles",
        "starlette.middleware.cors",
        # pydantic v2 内部
        "pydantic.deprecated.class_validators",
        # 持久化：SQLite(开发默认) + Postgres(生产)
        "aiosqlite",
        "asyncpg",
        "sqlalchemy.dialects.sqlite.aiosqlite",
        "sqlalchemy.dialects.postgresql.asyncpg",
        # LLM / MCP / HTTP / 多部分表单 / 配置
        "anthropic",
        "openai",
        "mcp",
        "mcp.client",
        "mcp.client.stdio",
        "mcp.client.streamable_http",
        "mcp.types",
        "httpx",
        "httpx._transports.default",
        "requests",
        "bs4",
        "bs4.builder",
        "bs4.builder._htmlparser",
        "python_multipart",
        "multipart",
        "yaml",
        "dotenv",
        # skill 活性监测/可靠杀树
        "psutil",
    ]
    # core 以源码 wheel 交付；collect_submodules 兜底全收其子模块，冻进 PYZ 字节码
    # （app 侧不含 .py 源码——正是靠 PyInstaller 这层冻结保 IP）
    + collect_submodules("ctx_weft"),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "numpy", "scipy", "PIL"],
    noarchive=False,
    optimize=1,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name=_BACKEND_NAME,       # 同源 electron/branding.json，与 main.js getBackendExePath() 自动一致
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,            # 桌面无窗后端
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name=_BACKEND_NAME,
)

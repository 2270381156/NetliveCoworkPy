"""冻结态（PyInstaller）的进程级预置：修 std 流、解析 NLC_* 路径、备好共享 venv。

dev 不跑这里（`prepare()` 头一行就按 sys.frozen 返回）。所以这一段的 bug 只有真打包才暴露，
改动后必须实打实打一次包验。

Electron 契约（全部 NLC_ 前缀，见 docs/0.4.x-plan.md P1.2）：
  NLC_BACKEND_PORT / NLC_ENV_FILE / NLC_DATA_DIR / NLC_SKILLS_DIR / NLC_AGENTS_DIR
  NLC_DRAWING_ENGINE_DIR / NLC_DRAWING_ENGINE_NODE_EXECUTABLE（拓扑功能，随包可选）
"""

from __future__ import annotations

import os
import sys


def prepare() -> None:
    """冻结态初始化 + 加载 .env。dev 下只做后者。"""
    if not getattr(sys, "frozen", False):
        try:
            from dotenv import load_dotenv

            load_dotenv(override=False)
        except ImportError:
            pass
        return

    meipass = sys._MEIPASS  # type: ignore[attr-defined]
    exe_dir = os.path.dirname(sys.executable)

    # console=False 时 bootloader 将 stdout/stderr 设为 None；恢复到 Electron 管道，
    # 否则 uvicorn 日志格式化器调用 .isatty() 崩溃。
    import io

    def _fix_stream(fd: int):
        try:
            return io.TextIOWrapper(
                io.FileIO(fd, closefd=False),
                encoding="utf-8",
                errors="replace",
                line_buffering=True,
            )
        except Exception:
            return open(os.devnull, "w")

    if sys.stdout is None:
        sys.stdout = _fix_stream(1)
    if sys.stderr is None:
        sys.stderr = _fix_stream(2)

    # 加载 .env：优先 NLC_ENV_FILE（Electron 设为 AppData 路径），回退 exe 同级 .env
    try:
        from dotenv import load_dotenv

        env_file = os.environ.get("NLC_ENV_FILE") or os.path.join(exe_dir, ".env")
        load_dotenv(env_file, override=False)
    except ImportError:
        pass

    # 冻结模式下相对路径无法正确解析，未设/非绝对路径一律覆盖为 exe 同级绝对路径。
    def _resolve(key: str, frozen_abs: str) -> None:
        val = os.environ.get(key, "")
        if not val or not os.path.isabs(val):
            os.environ[key] = frozen_abs

    _resolve("NLC_DATA_DIR", os.path.join(exe_dir, "data"))
    _resolve("NLC_RESOURCES_DIR", os.path.join(exe_dir, "resources"))
    _resolve("NLC_SKILLS_DIR", os.path.join(exe_dir, "resources", "skills"))
    _resolve("NLC_AGENTS_DIR", os.path.join(exe_dir, "resources", "agents"))
    _resolve("NLC_DRAWING_ENGINE_DIR", os.path.join(exe_dir, "resources", "drawing-engine"))

    # 随包内置 Python + 全应用共享 venv：bash 脚本与 skill 脚本的所有 python/pip 命令统一
    # 走这套随包 venv，绝不落到用户本地 python。冻结态 sys.executable 是 app exe、无法 -m venv，
    # 必须用随包 python-runtime 建 venv。缺随包 → 硬退出（打包只允许随包 python，不静默降级）。
    bundled = os.environ.get("NLC_FS_BASH_VENV_PYTHON") or _bundled_venv_python(exe_dir)
    if not bundled or not os.path.isfile(bundled):
        print(
            f"[NetLIVE Cowork] FATAL: bundled python-runtime not found under {exe_dir}; "
            f"packaged app requires it. Aborting.",
            flush=True,
        )
        sys.exit(1)
    os.environ["NLC_FS_BASH_VENV_PYTHON"] = bundled
    _ensure_shared_venv(bundled)

    # NLC_LOG_DIR 不同于上面：未设时保持未设（仅 stdout→Electron 管道），不强开
    # 文件日志；但若用户给了相对路径，cwd 在 Electron 下不可预测，锚到 exe 同级。
    _log_dir = os.environ.get("NLC_LOG_DIR", "")
    if _log_dir and not os.path.isabs(_log_dir):
        os.environ["NLC_LOG_DIR"] = os.path.join(exe_dir, _log_dir)


    # 随包内置 Node（跑 drawing-engine/cli.js）：只有当 drawing-engine/ 真的随包出货了
    # 才检查——多数部署不带这个功能，drawing-engine 目录本来就不存在，没必要报警。
    # 目录存在但 node-runtime 缺失，才是真的打包配置错误。
    if not os.environ.get("NLC_DRAWING_ENGINE_NODE_EXECUTABLE"):
        topo_dir = os.environ.get("NLC_DRAWING_ENGINE_DIR", "")
        if topo_dir and os.path.isdir(topo_dir):
            bundled_node = _bundled_node_executable(exe_dir)
            if bundled_node:
                os.environ["NLC_DRAWING_ENGINE_NODE_EXECUTABLE"] = bundled_node
            else:
                print(
                    f"[NetLIVE Cowork] WARNING: drawing-engine/ shipped at {topo_dir} but "
                    f"bundled node-runtime not found under {exe_dir}; "
                    f"topology:observe_topology will fail",
                    flush=True,
                )


def _bundled_node_executable(exe_dir: str) -> str | None:
    """随包内置的 Node（跑 drawing-engine/cli.js）。约定放在 exe 同级
    ``node-runtime/node.exe``（由 build_electron.ps1 注入）。不存在返回 None。"""
    cand = os.path.join(exe_dir, "node-runtime", "node.exe")
    return cand if os.path.isfile(cand) else None


def _bundled_venv_python(exe_dir: str) -> str | None:
    """随包内置的 Python（用于创建共享 venv）。约定放在 exe 同级
    ``python-runtime/python.exe``（由 build_electron.ps1 注入）。不存在返回 None。"""
    cand = os.path.join(exe_dir, "python-runtime", "python.exe")
    return cand if os.path.isfile(cand) else None


def _venv_base_present(venv_dir: str) -> bool:
    """共享 venv 的【基础解释器】是否仍然存在。

    venv 的 ``Scripts\\python.exe`` 只是个重定向器，真正跑的解释器由 ``pyvenv.cfg`` 指定
    （3.11+ 写 ``executable = <base python.exe>``，同时保留 ``home = <base 目录>``）。产品改名 /
    换安装目录后（IPMaster-Cowork → NetLIVE Cowork，安装目录随之从 ...\\Programs\\IPMaster-Cowork
    变成 ...\\Programs\\NetLIVE Cowork），随 data 目录一起迁移过来的旧 venv 里这两项仍指向**旧安装
    位置**的 python-runtime——那目录已不存在，于是每个 python/pip 调用都被重定向器打回
    ``No Python at '...\\IPMaster-Cowork\\...\\python.exe'``。

    只看 ``Scripts\\python.exe`` 在不在（它在，是随 data 迁过来的）会误判成"就绪"并复用，坑正在这。
    这里读 pyvenv.cfg，确认 base 解释器真的还在；不在 → 视为悬空 venv，需重建/修复。
    读不到 / 解析不出 base 也当作不可用（正常 venv 一定有这些字段）。
    """
    cfg = os.path.join(venv_dir, "pyvenv.cfg")
    home = ""
    executable = ""
    try:
        with open(cfg, encoding="utf-8") as f:
            for line in f:
                key, sep, val = line.partition("=")
                if not sep:
                    continue
                k = key.strip().lower()
                if k == "executable":
                    executable = val.strip()
                elif k == "home":
                    home = val.strip()
    except OSError:
        return False
    # executable 直接指向 base 的 python.exe（更精确）；缺它就退回 home 目录 + python.exe。
    if executable:
        return os.path.isfile(executable)
    if home:
        return os.path.isfile(os.path.join(home, "python.exe"))
    return False


def _ensure_shared_venv(bundled_python: str) -> None:
    """打包态：确保「全应用共享 venv」存在于 ``<NLC_DATA_DIR>/venv``（用随包 python 建，
    复用其解释器/标准库；只有 site-packages 是自己的、可写、跨更新保留），并把它头插进
    ``os.environ``（PATH 前插 Scripts、设 VIRTUAL_ENV、删 PYTHONHOME）。

    于是本进程启动的所有子进程——bash shell 与 skill 脚本——的 ``python`` / ``pip`` 都命中
    这套共享 venv：既不碰用户本地 python（不受 command_is_python 启发式门控影响），也不再每个
    workspace 各建一个 ``.venv``（全应用只此一套）。venv 位置可用 NLC_SHARED_VENV_DIR 覆盖。
    建失败 → 硬退出（打包只允许随包 python）。"""
    import subprocess

    data_dir = os.environ.get("NLC_DATA_DIR") or os.path.join(
        os.path.dirname(sys.executable), "data"
    )
    venv_dir = os.environ.get("NLC_SHARED_VENV_DIR") or os.path.join(data_dir, "venv")
    scripts = os.path.join(venv_dir, "Scripts")   # Windows 布局（打包只在 Win）
    venv_py = os.path.join(scripts, "python.exe")

    # 需要（重）建 venv 的两种情形：
    #   1. 压根没有（首次启动） —— venv_py 不存在；
    #   2. 有，但 base 解释器已不在（产品改名/换目录后随 data 迁来的悬空 venv，见 _venv_base_present）。
    # 情形 2 直接对着**已存在**的 venv 目录重跑 `python -m venv`：它会用当前随包 runtime 重写
    # pyvenv.cfg 的 home/executable、刷新 Scripts 里的重定向器，修好路径——**且默认不清 site-packages**，
    # 用户/skill 之前 pip 装的包得以保留（--clear 才会清，这里不加）。
    missing = not os.path.isfile(venv_py)
    stale = (not missing) and (not _venv_base_present(venv_dir))
    if missing or stale:
        os.makedirs(data_dir, exist_ok=True)
        if stale:
            print(
                f"[NetLIVE Cowork] shared venv at {venv_dir} points to a missing base interpreter "
                f"(likely after product rename/move); rebuilding against {bundled_python} …",
                flush=True,
            )
        else:
            print(f"[NetLIVE Cowork] creating shared venv at {venv_dir} …", flush=True)
        try:
            subprocess.run(
                [bundled_python, "-m", "venv", venv_dir],
                check=True, capture_output=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),  # 无窗口应用别闪黑窗
            )
        except Exception as e:  # noqa: BLE001
            stderr = getattr(e, "stderr", b"") or b""
            if isinstance(stderr, bytes):
                stderr = stderr.decode("utf-8", "replace")
            print(f"[NetLIVE Cowork] FATAL: failed to create shared venv: {e} {stderr}", flush=True)
            sys.exit(1)
    if not os.path.isfile(venv_py):
        print("[NetLIVE Cowork] FATAL: shared venv python missing after creation", flush=True)
        sys.exit(1)

    # 头插进程环境 → 所有子进程继承，python/pip 命中共享 venv（用户本地摸不到）。
    existing = os.environ.get("PATH", "")
    os.environ["PATH"] = scripts + (os.pathsep + existing if existing else "")
    os.environ["VIRTUAL_ENV"] = venv_dir
    os.environ.pop("PYTHONHOME", None)
    os.environ["NLC_SHARED_VENV_PYTHON"] = venv_py
    print(f"[NetLIVE Cowork] shared venv active: {venv_py}", flush=True)

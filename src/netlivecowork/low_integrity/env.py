"""可写集 + 两组环境变量重定向（跨平台纯逻辑，可在任意平台测）。

《全自动安全设计》§5.3：Low 子进程能写的只有几处 —— 工作区、共享环境、一个 Low 临时目录。
程序写盘有两大去处，各用一组环境变量重定向到那个 Low 临时目录，这样不用逐个追 pip/npm/…：

  ① 草稿（临时）      TEMP / TMP / PYTHONPYCACHEPREFIX
  ② 持久（缓存/配置）  USERPROFILE / APPDATA / LOCALAPPDATA / HOME   （"假家"，收长尾的大杠杆）
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

# 草稿去处：读 TEMP/TMP 的程序（pip 构建、tempfile、编译器…）都被导向这里。
_TEMP_ENV_KEYS = ("TEMP", "TMP", "TMPDIR", "PYTHONPYCACHEPREFIX")
# 持久去处：把"家/AppData"指向 Low 目录，令 pip/npm/matplotlib/… 的缓存/配置也落进可写集。
_HOME_ENV_KEYS = ("USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME")


@dataclass(frozen=True)
class LowIntegrityLayout:
    """一个 strict-auto 会话的低完整性布局。

    - workspace ：会话工作区（用户选的目录），会话专属，绑定时标 Low。
    - shared_env：全应用共享 venv 根目录（打包态共享 venv 模式=`fs_shared_venv_python` 的 venv）。
                  dev 态每工作区自建 .venv（在工作区内、随工作区标 Low），此时 shared_env=None。
    - temp      ：一个 Low 临时目录（所有会话共用，像系统 %TEMP%）。
    共享 venv + temp 是跨会话共享的，启动时标一次即可（见 activation.label_global_writable_dirs）。
    """
    workspace: Path
    shared_env: Path | None
    temp: Path

    def writable_dirs(self) -> list[Path]:
        """需要标 Low、允许 Low 子进程写的目录集合（其余一律只读）。shared_env 为 None（dev）时跳过。"""
        dirs = [self.workspace]
        if self.shared_env is not None:
            dirs.append(self.shared_env)
        dirs.append(self.temp)
        return dirs


def redirect_env(base_env: dict, temp_dir: str) -> dict:
    """在 base_env 之上，把"草稿"和"持久"两组环境变量都指向 Low 临时目录。

    返回新 dict（不改入参）。这样 Low 子进程里跑的任何程序，写临时/写家目录缓存都落进
    可写集，避免因写默认位置（Medium 的系统 %TEMP% / 用户 AppData）被 OS 拒。
    """
    env = dict(base_env)
    for k in _TEMP_ENV_KEYS:
        env[k] = temp_dir
    for k in _HOME_ENV_KEYS:
        env[k] = temp_dir
    return env

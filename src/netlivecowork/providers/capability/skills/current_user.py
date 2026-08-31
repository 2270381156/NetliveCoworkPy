"""进程级「当前登录用户名」持有者（桌面端单用户模型）。

桌面端后端是"一个已登录用户"的进程。electron 登录/切换账号后调
``POST /api/v1/skills/current-user`` 设置当前用户名；运行时（agent 执行 skill，无
前端请求）由 mythos 相关逻辑从这里读当前用户，用于：
  * 引用列表按当前用户过滤（skill 可见性因人而异）；
  * mythos 下载带 ``x-gde-username``（用当前登录用户，防越权）。

线程安全：写少读多，用一把锁保护一个模块级字符串即可。
"""

from __future__ import annotations

import threading

_lock = threading.Lock()
_username = ""


def set_current_username(username: str | None) -> None:
    """由 POST /skills/current-user 调用（登录/切换账号时）。空/None 视为未登录。"""
    global _username
    with _lock:
        _username = (username or "").strip()


def get_current_username() -> str:
    """运行时读当前登录用户名；未设置返回空串（调用方按"用户名为空"优雅降级）。"""
    with _lock:
        return _username

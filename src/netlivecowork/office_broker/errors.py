"""把 broker 里出的岔子翻译成【一个原因一个码】的失败。

为什么单开一层：以前 `handle()` 一个 `except` 把所有异常都装进 `COM_ERROR`，消息是
`f"{type(e).__name__}: {e}"`。于是"没装 Office"、"Office 起不来"、"Excel 说文件找不到"、
"broker 自己抛了 KeyError" 全长一个样，而且 pywin32 的 com_error 被 str() 之后是个元组
`(-2147352567, '发生意外。', (0, 'Microsoft Excel', '抱歉，找不到 x.xlsx。', ...), None)`
——真正有用的那句话埋在 excepinfo 里。模型看不出该改代码、该换库、还是该告诉用户。

这里按 HRESULT 分流，每条消息只讲一件事 + 一句下一步。不确定的一律落回 COM_ERROR 并把
Office 的原话原样露出来——猜错原因比不猜更坏。
"""

from __future__ import annotations

import os
import traceback
from dataclasses import dataclass

# COM 的几个 HRESULT（按 32 位有符号写，pywin32 就是这么给的）。
REGDB_E_CLASSNOTREG = -2147221164        # 0x80040154 类未注册 = 本机没装
CO_E_CLASSSTRING = -2147221005           # 0x800401F3 无效的类字符串 = 同上（ProgID 查不到）
CO_E_SERVER_EXEC_FAILURE = -2146959355   # 0x80080005 服务器执行失败 = 装了但起不来
DISP_E_EXCEPTION = -2147352567           # 0x80020009 调用里出的错，真因在 excepinfo

_NOT_INSTALLED = (REGDB_E_CLASSNOTREG, CO_E_CLASSSTRING)

# ProgID 前缀 → 给人看的 app 名。取不到就用 ProgID 本身。
_APP_NAMES = {
    "excel": "Microsoft Excel", "word": "Microsoft Word",
    "powerpoint": "Microsoft PowerPoint", "outlook": "Microsoft Outlook",
    "access": "Microsoft Access", "publisher": "Microsoft Publisher",
    "visio": "Microsoft Visio", "msproject": "Microsoft Project",
    "onenote": "Microsoft OneNote",
}

# 没装 Office 时改用什么。和 app 一一对应，省得模型自己猜。
_FALLBACK_LIBS = {
    "excel": "openpyxl / pandas", "word": "python-docx",
    "powerpoint": "python-pptx", "visio": "vsdx",
}


@dataclass(frozen=True)
class Failure:
    code: str
    message: str

    def __str__(self) -> str:
        return self.message


def app_name(progid: str) -> str:
    key = (progid or "").strip().lower().split(".")[0]
    return _APP_NAMES.get(key, progid or "Office")


def _com_parts(e: BaseException) -> tuple | None:
    """com_error 的 (hresult, strerror, source, description, scode)；不是 COM 错则 None。

    按【鸭子类型】认，不 import pywintypes：这层要在非 Windows 上也能测。
    """
    if type(e).__name__ != "com_error":
        return None
    args = getattr(e, "args", ())
    if len(args) < 2 or not isinstance(args[0], int):
        return None
    hresult, strerror = args[0], args[1]
    source = description = None
    scode = None
    excepinfo = args[2] if len(args) > 2 else None
    if isinstance(excepinfo, (list, tuple)) and len(excepinfo) >= 6:
        source, description, scode = excepinfo[1], excepinfo[2], excepinfo[5]
    return hresult, strerror, source, description, scode


def _hex(hresult: int) -> str:
    return f"0x{hresult & 0xFFFFFFFF:08X}"


def classify_exception(e: BaseException, progid: str = "") -> Failure:
    """把一个异常翻成 (码, 一句人话)。"""
    parts = _com_parts(e)
    if parts is None:
        # broker 自己的 bug（KeyError/AttributeError…）。别冒充 COM 错，否则模型会跑去查
        # Office 装没装，而真正该看的是这条调用本身。
        return Failure("BROKER_ERROR", f"broker 内部错误 {type(e).__name__}: {e}")
    hresult, strerror, source, description, scode = parts
    app = app_name(progid)
    if hresult in _NOT_INSTALLED:
        lib = _FALLBACK_LIBS.get((progid or "").strip().lower().split(".")[0])
        alt = f"请改用纯文件库（{lib}）" if lib else "请改用纯文件库"
        return Failure("OFFICE_NOT_INSTALLED",
                       f"本机没有安装 {app}（COM 类未注册，{_hex(hresult)}）。"
                       f"重试、换写法都没有用。{alt}，或者把「本机缺 {app}」告诉用户。")
    if hresult == CO_E_SERVER_EXEC_FAILURE or "服务器执行失败" in str(strerror):
        return Failure("OFFICE_LAUNCH_FAILED",
                       f"{app} 装着，但这次起不来（服务器执行失败，{_hex(hresult)}）。"
                       f"常见原因：它正卡在弹窗/修复流程里，或被本机策略拦下。"
                       f"可以请用户手动打开一次 {app} 再重试。")
    # 其余：Office 自己报的业务错（文件找不到、参数不对、格式不支持…）。它的原话最有用，
    # 原样露出来，别在后面追加任何"可能没装 Office / 注意工作区"之类的猜测。
    who = source or app
    what = description or strerror or "未提供描述"
    shown = scode if isinstance(scode, int) and scode not in (0, DISP_E_EXCEPTION) else hresult
    return Failure("COM_ERROR", f"{who} 报错：{what}（HRESULT {_hex(shown)}）")


def trace_tail(e: BaseException, frames: int = 3) -> str:
    """异常栈的最后几帧，一行一帧。

    只给 BROKER_ERROR 用。broker 跑在另一个进程里、日志落在使用者的机器上，出了内部 bug 时
    "IndexError: list index out of range" 这一句什么都定位不到；把栈尾带回 agent 的报错里，
    看一眼就知道崩在哪。Office 自报的业务错不带——那是它的原话，栈只会盖住重点。
    """
    try:
        tb = traceback.extract_tb(e.__traceback__)[-frames:]
    except Exception:      # noqa: BLE001 — 诊断用的东西绝不能自己再抛
        return ""
    out = []
    for fr in tb:
        d = os.path.basename(os.path.dirname(fr.filename))
        out.append(f"  ↳ {d}/{os.path.basename(fr.filename)}:{fr.lineno} in {fr.name}")
    return "\n".join(out)

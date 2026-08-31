"""投递给 agent 的客户端桩（会被原样写成 `ipmc_office.py`，放进 Low 会话的 PYTHONPATH）。

**必须自包含**：它跑在 agent 的 Low 子进程里，那边用的是共享 venv，装不到 netlivecowork，
所以帧格式在这里重写一遍，不 import 本仓任何东西。改协议时两边一起改（见 protocol.py）。

设计上最别扭的一点是 **COM 里属性和方法不分家**：`wb.Name` 是属性、`wb.SaveAs(p)` 是方法，
而在客户端拿到 `wb.X` 的那一刻还不知道是哪种。所以 `__getattr__` 返回一个"待定成员"
`_Member`：被调用就当方法（发 call），被当值用（打印/比较/再取属性）就当属性（发 get）。
"""

STUB_SOURCE = r'''
r"""ipmc_office —— 自动模式下的 Office 自动化入口（用法同 win32com.client）。

    import ipmc_office
    xl = ipmc_office.Dispatch("Excel.Application")
    wb = xl.Workbooks.Open(r"D:\ws\in.xlsx")
    wb.Sheets(1).Range("A1").Value = "hi"
    wb.SaveAs(r"D:\ws\out.xlsx"); wb.Close(False); xl.Quit()

自动模式下 agent 进程是低完整性的，DCOM 会让 Excel/Word 跟着降级、连临时文件都写不了，所以
真正的 COM 对象由应用侧的 broker 进程持有，这里只是代理。能力与 win32com 一致，唯一差别是
**只能写工作区里的文件**（工作区外的可以读，会被只读打开），也不能让 Office 执行宏。
写越界会直接报错，那不是 Office 的问题。
"""

import base64
import datetime
import decimal
import json
import os
import struct

__all__ = ["Dispatch", "OfficeBrokerError", "ping"]

_HEADER = struct.Struct(">I")
_ENV_PIPE = "NLC_OFFICE_PIPE"


class OfficeBrokerError(RuntimeError):
    """broker 拒绝了这次调用，或 Office 自己报错；message 里是原因。"""


# 结构性异常要保住【类型】过管道，不能一律 OfficeBrokerError：
#   IndexError    —— COM 集合没有 __iter__，`for x in 集合` 走旧式序列协议，Python 靠捕获
#                    IndexError 结束循环；换成别的异常，所有遍历都从"正常结束"变成"崩了"。
#   AttributeError—— hasattr / getattr(o, x, 默认值) 靠它，糊掉的话 hasattr 永远为真。
_ERROR_TYPES = {"INDEX_ERROR": IndexError, "ATTRIBUTE_ERROR": AttributeError,
                "KEY_ERROR": KeyError}


class _Conn:
    _inst = None

    def __init__(self):
        name = os.environ.get(_ENV_PIPE)
        if not name:
            raise OfficeBrokerError(
                "当前会话没有 Office broker（只有 Windows 上的自动模式才有）。"
                "半自动/人工模式下请直接用 win32com.client。")
        try:
            self._f = open("\\\\.\\pipe\\" + name, "r+b", buffering=0)
        except OSError as e:
            raise OfficeBrokerError("连不上 Office broker：%s" % e)

    @classmethod
    def get(cls):
        if cls._inst is None:
            cls._inst = _Conn()
        return cls._inst

    def _read_exactly(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self._f.read(n - len(buf))
            if not chunk:
                raise OfficeBrokerError("Office broker 连接已断开")
            buf += chunk
        return buf

    def call(self, msg):
        body = json.dumps(msg, ensure_ascii=False, default=str).encode("utf-8")
        self._f.write(_HEADER.pack(len(body)) + body)
        (n,) = _HEADER.unpack(self._read_exactly(_HEADER.size))
        rsp = json.loads(self._read_exactly(n).decode("utf-8")) if n else {}
        if not rsp.get("ok"):
            code = rsp.get("code", "?")
            message = rsp.get("message", "")
            exc = _ERROR_TYPES.get(code)
            if exc is not None:
                raise exc(message)
            raise OfficeBrokerError("[%s] %s" % (code, message))
        return rsp.get("value")


def _decode_special(x):
    """带类型标记的值 → python 值。认不出的标记原样返回（协议版本不齐时退化，不整条失败）。"""
    raw = x["__v__"]
    kind = x.get("__t__")
    try:
        if kind == "dt":
            return datetime.datetime.fromisoformat(raw)
        if kind == "d":
            return datetime.date.fromisoformat(raw)
        if kind == "t":
            return datetime.time.fromisoformat(raw)
        if kind == "b64":
            return base64.b64decode(raw)
        if kind == "dec":
            return decimal.Decimal(raw)
    except Exception:
        return raw
    return raw


def _unwrap(v):
    if isinstance(v, dict) and "__ref__" in v:
        return _Proxy(v["__ref__"])
    if isinstance(v, dict) and "__v__" in v:
        inner = _decode_special(v) if "__t__" in v else v["__v__"]
        return [_unwrap(x) for x in inner] if isinstance(inner, list) else inner
    if isinstance(v, list):
        return [_unwrap(x) for x in v]      # 元组套元组的 Range.Value，里面可能有日期
    return v


def _wrap(v):
    if isinstance(v, _Proxy):
        return {"__ref__": object.__getattribute__(v, "_ref")}
    if isinstance(v, _Member):
        return _wrap(v._resolve())
    if isinstance(v, datetime.datetime):
        return {"__v__": v.isoformat(), "__t__": "dt"}
    if isinstance(v, datetime.date):
        return {"__v__": v.isoformat(), "__t__": "d"}
    if isinstance(v, datetime.time):
        return {"__v__": v.isoformat(), "__t__": "t"}
    if isinstance(v, (bytes, bytearray)):
        return {"__v__": base64.b64encode(bytes(v)).decode("ascii"), "__t__": "b64"}
    if isinstance(v, decimal.Decimal):
        return {"__v__": str(v), "__t__": "dec"}
    if isinstance(v, (list, tuple)):
        return {"__v__": [_wrap(x) for x in v]}
    return {"__v__": v}


def _pack_args(args, kwargs):
    return [_wrap(a) for a in args], dict((k, _wrap(v)) for k, v in kwargs.items())


class _Member(object):
    """`obj.X` 的待定结果：调用它=方法，别的用法=属性（用时才真去取）。"""

    def __init__(self, ref, name):
        object.__setattr__(self, "_ref", ref)
        object.__setattr__(self, "_name", name)
        object.__setattr__(self, "_cached", _MISSING)

    def __call__(self, *args, **kwargs):
        a, kw = _pack_args(args, kwargs)
        return _unwrap(_Conn.get().call({
            "op": "call", "ref": object.__getattribute__(self, "_ref"),
            "name": object.__getattribute__(self, "_name"), "args": a, "kwargs": kw}))

    def _resolve(self):
        c = object.__getattribute__(self, "_cached")
        if c is _MISSING:
            c = _unwrap(_Conn.get().call({
                "op": "get", "ref": object.__getattribute__(self, "_ref"),
                "name": object.__getattribute__(self, "_name")}))
            object.__setattr__(self, "_cached", c)
        return c

    # 下面这些"被当值用"的入口一律先求值再委托
    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._resolve(), name)

    def __setattr__(self, name, value):
        setattr(self._resolve(), name, value)

    def __getitem__(self, key):
        return self._resolve()[key]

    def __iter__(self):
        return iter(self._resolve())

    def __str__(self):
        return str(self._resolve())

    def __repr__(self):
        return repr(self._resolve())

    def __int__(self):
        return int(self._resolve())

    def __float__(self):
        return float(self._resolve())

    def __bool__(self):
        return bool(self._resolve())

    def __eq__(self, other):
        return self._resolve() == other

    def __ne__(self, other):
        return self._resolve() != other

    def __hash__(self):
        return hash(self._resolve())

    # 比较 / 格式化 / 长度 / 算术：日期排序（appt.Start >= today）、f"{x:%H:%M}"、len(...)、
    # 日期加减都要走这些入口。缺一个就是一个 TypeError，而半自动那边同样的脚本跑得好好的。
    def __lt__(self, other):
        return self._resolve() < other

    def __le__(self, other):
        return self._resolve() <= other

    def __gt__(self, other):
        return self._resolve() > other

    def __ge__(self, other):
        return self._resolve() >= other

    def __format__(self, spec):
        return format(self._resolve(), spec)

    def __len__(self):
        return len(self._resolve())

    def __contains__(self, item):
        return item in self._resolve()

    def __add__(self, other):
        return self._resolve() + other

    def __radd__(self, other):
        return other + self._resolve()

    def __sub__(self, other):
        return self._resolve() - other

    def __rsub__(self, other):
        return other - self._resolve()

    def __mul__(self, other):
        return self._resolve() * other

    def __rmul__(self, other):
        return other * self._resolve()

    def __index__(self):
        return int(self._resolve())


class _MISSING_TYPE(object):
    pass


_MISSING = _MISSING_TYPE()


class _Proxy(object):
    """broker 那侧一个 COM 对象的代理。"""

    def __init__(self, ref):
        object.__setattr__(self, "_ref", ref)

    def __getattr__(self, name):
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)
        return _Member(object.__getattribute__(self, "_ref"), name)

    def __setattr__(self, name, value):
        _Conn.get().call({"op": "set", "ref": object.__getattribute__(self, "_ref"),
                          "name": name, "value": _wrap(value)})

    def __call__(self, *args, **kwargs):
        a, kw = _pack_args(args, kwargs)
        return _unwrap(_Conn.get().call({
            "op": "call", "ref": object.__getattribute__(self, "_ref"),
            "name": "", "args": a, "kwargs": kw}))

    def __getitem__(self, key):
        return _unwrap(_Conn.get().call({
            "op": "item", "ref": object.__getattribute__(self, "_ref"), "key": _wrap(key)}))

    def __len__(self):
        """len(集合) → .Count。没有 Count 的对象抛 TypeError，与普通 python 对象一致。"""
        try:
            return int(self.Count)
        except (AttributeError, OfficeBrokerError):
            raise TypeError("这个 Office 对象没有 Count，不能用 len()")

    def __repr__(self):
        return "<ipmc_office 代理 #%d>" % object.__getattribute__(self, "_ref")


_last_progid = ["Excel.Application"]


def Dispatch(progid):
    """等价于 win32com.client.Dispatch，只是对象活在 broker 进程里。"""
    _last_progid[0] = progid
    return _unwrap(_Conn.get().call({"op": "dispatch", "progid": progid}))


DispatchEx = Dispatch


def EnsureDispatch(progid):
    """gencache.EnsureDispatch 的等价物：早绑定在代理这边没有意义，直接给同一个代理对象。"""
    return Dispatch(progid)


def ping():
    return _unwrap(_Conn.get().call({"op": "ping"}))


class _Constants(object):
    """`win32com.client.constants.xlUp` 这类常量：值在 broker 那边按类型库取，取到就缓存。"""

    def __init__(self):
        object.__setattr__(self, "_cache", {})

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        cache = object.__getattribute__(self, "_cache")
        if name not in cache:
            cache[name] = _unwrap(_Conn.get().call({
                "op": "const", "progid": _last_progid[0], "name": name}))
        return cache[name]


constants = _Constants()


class _GenCache(object):
    EnsureDispatch = staticmethod(EnsureDispatch)

    @staticmethod
    def EnsureModule(*_a, **_kw):
        return None


gencache = _GenCache()


def CastTo(obj, _iface, *_a):
    """早绑定转换在代理这边没有对应物；对象模型是晚绑定的，原样返回即可。"""
    return obj


def install_win32com_shim():
    """把 `win32com.client` 换成本模块的影子，使 agent 侧【完全无需改代码】。

    只有会话里真有 broker（环境变量在）时才装：半自动/人工模式下进程是 Medium，Office 本来
    就能用，绝不能去动真的 win32com。由同目录的 sitecustomize.py 在解释器启动时调用。
    """
    import sys
    import types

    if not os.environ.get(_ENV_PIPE):
        return False
    shadow = types.ModuleType("win32com.client")
    for k in ("Dispatch", "DispatchEx", "EnsureDispatch", "CastTo", "constants",
              "gencache", "OfficeBrokerError"):
        setattr(shadow, k, globals()[k])
    shadow.__doc__ = (
        "自动模式下的 win32com.client 影子模块：COM 对象由应用侧的 broker 进程代持，"
        "因为低完整性进程起不了 Office。用法不变，但只能【写】工作区内的文件（工作区外的可以读，会被只读打开），不能执行宏。")
    try:
        parent = __import__("win32com")          # 真包在就用真的当父模块，别影响它的其它子模块
    except Exception:
        parent = types.ModuleType("win32com")
        parent.__path__ = []
        sys.modules["win32com"] = parent
    parent.client = shadow
    sys.modules["win32com.client"] = shadow
    sys.modules["win32com.client.gencache"] = gencache
    return True
'''


SITECUSTOMIZE_SOURCE = r'''
"""解释器启动钩子：自动模式下把 `win32com.client` 换成 broker 代理，agent 无需改任何代码。

Python 启动时会自动 import 名为 sitecustomize 的模块；本目录被 host 放进了 PYTHONPATH，
所以这个文件会在 agent 脚本之前跑到。只在会话真有 Office broker 时生效，别的情况完全 no-op。

若 sys.path 里还有别的 sitecustomize（同名只会命中第一个），这里会把它们补跑一遍，避免
喧宾夺主。整体包在 try 里：这个钩子出任何问题都不该让 agent 的脚本起不来。
"""

def _chain_other_sitecustomize():
    import os
    import sys
    here = os.path.dirname(os.path.abspath(__file__))
    for entry in sys.path:
        try:
            if not entry or os.path.abspath(entry) == here:
                continue
            cand = os.path.join(entry, "sitecustomize.py")
            if os.path.isfile(cand):
                with open(cand, "rb") as f:
                    exec(compile(f.read(), cand, "exec"), {"__name__": "sitecustomize"})
                break
        except Exception:
            pass


try:
    import ipmc_office as _o
    _o.install_win32com_shim()
except Exception:
    pass

try:
    _chain_other_sitecustomize()
except Exception:
    pass
'''


def write_stub(target_dir) -> str:
    """把桩写成 `<target_dir>/ipmc_office.py`，返回该目录（供加进 PYTHONPATH）。

    落在 low_temp 下：那里已经标了 Low、Low 子进程能读，且不依赖打包形态（PyInstaller 冻结后
    包内文件路径不稳，直接写出来最省事）。每次覆盖写，随版本更新。
    """
    from pathlib import Path

    d = Path(target_dir)
    d.mkdir(parents=True, exist_ok=True)
    (d / "ipmc_office.py").write_text(STUB_SOURCE, encoding="utf-8")
    (d / "sitecustomize.py").write_text(SITECUSTOMIZE_SOURCE, encoding="utf-8")
    return str(d)

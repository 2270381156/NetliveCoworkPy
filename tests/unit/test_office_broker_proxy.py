"""broker ↔ 客户端桩之间的【语义保真】：过一趟管道之后，脚本看到的东西要和直连 win32com 一样。

这组测试全是被真实事故逼出来的：全自动（走 broker）读不了 Outlook 日历，半自动（直连
win32com）却好好的。根因是管道两侧把 python 语义弄丢了——
  ① `for x in COM集合` 靠捕获 IndexError 结束循环，而 IndexError 过管道变成了通用错误；
  ② datetime 被 str() 掉，脚本拿到字符串，`.strftime()` / `>= today` 全废。
所以这里锁的不是"能不能调通"，而是"类型和异常有没有原样过去"。
"""

from __future__ import annotations

import base64
import datetime
import decimal

from netlivecowork.office_broker import protocol as P
from netlivecowork.office_broker.client_stub import STUB_SOURCE
from netlivecowork.office_broker.policy import Gate
from netlivecowork.office_broker.server import Broker


def _load_stub(responder):
    """把桩当模块跑起来，_Conn 换成直接调 responder 的假连接（不起管道、不碰 COM）。"""
    ns: dict = {}
    exec(compile(STUB_SOURCE, "ipmc_office", "exec"), ns)   # noqa: S102 — 桩就是要按源码跑

    class _FakeConn:
        def call(self, msg):
            rsp = responder(msg)
            if not rsp.get("ok"):
                code, message = rsp.get("code", "?"), rsp.get("message", "")
                exc = ns["_ERROR_TYPES"].get(code)
                if exc is not None:
                    raise exc(message)
                raise ns["OfficeBrokerError"]("[%s] %s" % (code, message))
            return rsp.get("value")

    ns["_Conn"].get = staticmethod(lambda: _FakeConn())
    return ns


# ── 值编码：特殊类型带着类型过管道 ─────────────────────────────────


def test_special_values_survive_the_pipe() -> None:
    for v in (datetime.datetime(2026, 8, 26, 9, 30), datetime.date(2026, 8, 26),
              datetime.time(9, 30), b"\x89PNG", decimal.Decimal("3.14")):
        enc = P.encode_special(v)
        assert enc is not None and "__t__" in enc, v
        assert P.decode_special(enc) == v, v


def test_broker_encodes_dates_with_their_type() -> None:
    """以前是 str(v) 兜底：半自动拿 datetime、全自动拿字符串，静默走两条路。"""
    b = Broker(Gate(workspace=r"D:\ws"))
    enc = b._encode(datetime.datetime(2026, 8, 26, 9, 30))
    assert enc == {"__v__": "2026-08-26T09:30:00", "__t__": "dt"}
    # 整片单元格取回来是元组套元组，里面的日期同样不能变字符串
    nested = b._encode([[datetime.date(2026, 8, 26), "x"], [1, None]])
    assert nested["__v__"][0][0] == {"__v__": "2026-08-26", "__t__": "d"}


def test_client_restores_dates_including_nested() -> None:
    nested = [[P.val("2026-08-26T09:30:00", "dt"), "x"]]
    ns = _load_stub(lambda msg: P.ok({"value": P.val(nested)}))
    got = ns["_unwrap"](ns["_Conn"].get().call({"op": "get"}))
    assert got[0][0] == datetime.datetime(2026, 8, 26, 9, 30)
    assert got[0][1] == "x"


def test_client_sends_dates_with_their_type() -> None:
    """反向也要保真：agent 把 datetime 赋给 appt.Start，不能变成字符串。"""
    ns = _load_stub(lambda msg: P.ok({"value": P.val(None)}))
    assert ns["_wrap"](datetime.datetime(2026, 8, 26, 9, 30)) == {
        "__v__": "2026-08-26T09:30:00", "__t__": "dt"}
    assert ns["_wrap"](b"\x00\x01") == {"__v__": base64.b64encode(b"\x00\x01").decode(), "__t__": "b64"}


def test_broker_decodes_typed_args() -> None:
    b = Broker(Gate(workspace=r"D:\ws"))
    assert b._decode_arg({"__v__": "2026-08-26T09:30:00", "__t__": "dt"}) == \
        datetime.datetime(2026, 8, 26, 9, 30)


def test_unknown_kind_degrades_instead_of_failing() -> None:
    """协议两侧版本不齐时退化成原始值，别让整条调用崩掉。"""
    assert P.decode_special({"__v__": "x", "__t__": "从未见过"}) == "x"


# ── 结构性异常：保住类型 ───────────────────────────────────────────


def test_iterating_a_collection_terminates() -> None:
    """真实事故：`for appt in items:` 在全自动下不是正常结束，而是抛 OfficeBrokerError。

    COM 集合没有 __iter__，走的是旧式序列协议——Python 只认 IndexError 作为"到头了"。
    """
    items = ["a", "b", "c"]

    def responder(msg):
        if msg["op"] == "get":            # list() 会先问长度；这个集合没有 Count
            return P.err("ATTRIBUTE_ERROR", msg.get("name", ""))
        i = msg["key"]["__v__"]
        try:
            return P.ok({"value": P.val(items[i])})
        except IndexError as e:
            return P.err("INDEX_ERROR", str(e))

    ns = _load_stub(responder)
    assert list(ns["_Proxy"](1)) == items          # 不抛、且真的遍历完


def test_broker_marks_end_of_sequence() -> None:
    b = Broker(Gate(workspace=r"D:\ws"))
    ref = b.table.put(["only-one"])
    assert b.handle({"op": "item", "ref": ref, "key": P.val(0)})["ok"] is True
    r = b.handle({"op": "item", "ref": ref, "key": P.val(9)})
    assert r["code"] == "INDEX_ERROR"


def test_missing_member_stays_an_attribute_error() -> None:
    """hasattr / getattr(o, x, 默认值) 靠 AttributeError；糊掉的话 hasattr 永远为真。"""
    class Bare:
        pass

    b = Broker(Gate(workspace=r"D:\ws"))
    ref = b.table.put(Bare())
    assert b.handle({"op": "get", "ref": ref, "name": "Nope"})["code"] == "ATTRIBUTE_ERROR"

    ns = _load_stub(lambda msg: P.err("ATTRIBUTE_ERROR", "Nope"))
    assert hasattr(ns["_Proxy"](1).Nope, "anything") is False


def test_our_own_index_bug_is_not_disguised_as_end_of_sequence() -> None:
    """只在真正碰 COM 的那一句上捕获。broker 自己抛的 IndexError 必须仍是内部错误，
    否则一个真 bug 会被伪装成"迭代到头"，静默吞掉。"""
    def boom(_self, _msg):
        raise IndexError("我们自己的 bug")

    b = Broker(Gate(workspace=r"D:\ws"))
    b._OPS = {"boom": boom}
    assert b.handle({"op": "boom"})["code"] == "BROKER_ERROR"


# ── 待定成员：被当值用的那些入口 ───────────────────────────────────


def test_member_supports_comparison_and_formatting() -> None:
    """日期排序、f-string 带格式串、len()——半自动那边天经地义，代理这边缺一个就是 TypeError。"""
    start = datetime.datetime(2026, 8, 26, 9, 30)
    ns = _load_stub(lambda msg: P.ok({"value": P.val(start.isoformat(), "dt")}))
    m = ns["_Proxy"](1).Start
    assert m >= datetime.datetime(2026, 8, 26, 0, 0)
    assert m < datetime.datetime(2026, 8, 27, 0, 0)
    assert "{:%H:%M}".format(m) == "09:30"
    assert m + datetime.timedelta(hours=1) == start + datetime.timedelta(hours=1)
    assert sorted([m, datetime.datetime(2026, 1, 1)])[0] == datetime.datetime(2026, 1, 1)


def test_member_len_and_contains() -> None:
    ns = _load_stub(lambda msg: P.ok({"value": P.val("会议纪要")}))
    m = ns["_Proxy"](1).Subject
    assert len(m) == 4
    assert "纪要" in m


def test_proxy_len_uses_count() -> None:
    """len(集合) → .Count。脚本习惯写 len()，别让它 TypeError。"""
    def responder(msg):
        if msg["op"] == "get" and msg["name"] == "Count":
            return P.ok({"value": P.val(7)})
        return P.err("ATTRIBUTE_ERROR", msg.get("name", ""))

    ns = _load_stub(responder)
    assert len(ns["_Proxy"](1)) == 7


def test_proxy_len_without_count_is_a_type_error() -> None:
    ns = _load_stub(lambda msg: P.err("ATTRIBUTE_ERROR", "Count"))
    try:
        len(ns["_Proxy"](1))
    except TypeError:
        pass
    else:
        raise AssertionError("没有 Count 的对象应当抛 TypeError")


# ── 打包态才会暴露的惰性 import ────────────────────────────────────


def test_spec_pins_the_lazily_imported_modules() -> None:
    """这些 import 只在特定操作上触发，dev 态永远不报错，一打包就崩。

    win32timezone：读日期属性时才 import（Outlook 日程的 Start 就栽在这）。
    win32com 子模块：gencache.EnsureDispatch 在函数内 import makepy/genpy，取常量要用。
    psutil：office_broker 全是函数内 import，目前只靠 ctx_weft 顶层引用侥幸被打进包。
    """
    from pathlib import Path

    spec = Path(__file__).resolve().parents[2] / "packaging" / "netlive-cowork.spec"
    text = spec.read_text(encoding="utf-8")
    assert '"win32timezone"' in text
    assert 'collect_submodules("win32com")' in text
    assert '"psutil"' in text

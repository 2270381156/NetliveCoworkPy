"""Office broker 闸门：自动模式下 Office 能用，但只能写工作区、不能执行宏。

背景：DCOM 用调用方的完整性级别启动进程外 COM 服务器，所以 Low 会话里的 Excel 起不来，
COM 必须由边界外的 Medium broker 代持。边界因此不再由 OS 兜底，全靠这里的闸门，所以这组
测试是整个方案的安全底线。跨平台可跑（纯字符串逻辑）。
"""

from __future__ import annotations

from netlivecowork.office_broker.policy import (
    Gate,
    apply_read_only,
    check_call,
    check_value,
    looks_like_path,
    member_denied,
    path_arg_outside,
    progid_allowed,
    resolve_path_args,
)

WS = r"D:\work\ws"
GATE = Gate(workspace=WS, allowed_roots=())


def test_progid_allowlist_covers_whole_office_family() -> None:
    for progid in ("Excel.Application", "Word.Application", "PowerPoint.Application",
                   "Outlook.Application", "Access.Application", "Publisher.Application",
                   "Visio.Application", "Visio.InvisibleApp", "MSProject.Application",
                   "OneNote.Application"):
        assert progid_allowed(progid) is True, progid
    assert progid_allowed("excel.application.16") is True     # 带版本号
    # 这条通道存在的理由是 Office；别顺手把整个 COM 面开出去
    assert progid_allowed("WScript.Shell") is False
    assert progid_allowed("Shell.Application") is False
    assert progid_allowed("MSXML2.XMLHTTP") is False
    assert progid_allowed("Scripting.FileSystemObject") is False
    # 前缀匹配只认整段（`.` 分隔），别把"名字以白名单项开头"的别家 ProgID 放进来
    assert progid_allowed("Excel.ApplicationEvil") is False
    assert progid_allowed("") is False


def test_office_images_cover_every_allowed_progid() -> None:
    """白名单里每个 app 都得能被记账收尸，否则"放行"就等于"留孤儿进程"。

    映像名表是 broker 自收和 host 兜底收共用的一份（procs.OFFICE_IMAGES），漏一个就是一个
    没有界面、一直抱着工作区文件锁的孤儿进程。
    """
    from netlivecowork.office_broker.policy import ALLOWED_PROGID_PREFIXES
    from netlivecowork.office_broker.procs import OFFICE_IMAGES

    expect = {"excel": "excel.exe", "word": "winword.exe", "powerpoint": "powerpnt.exe",
              "outlook": "outlook.exe", "access": "msaccess.exe", "publisher": "mspub.exe",
              "visio": "visio.exe", "msproject": "winproj.exe", "onenote": "onenote.exe"}
    # Visio 的两个 ProgID 共用一个 exe，故按 app 名去重
    assert {p.split(".")[0] for p in ALLOWED_PROGID_PREFIXES} == set(expect), \
        "白名单动了就得同步映像名表"
    assert set(expect.values()) == set(OFFICE_IMAGES)


def test_cross_app_code_execution_members_denied() -> None:
    """三件套之外的 app 各有自己的"执行代码"入口，一并封死。"""
    for name in ("ExecuteLine",           # Visio：直接跑一行 VBA，和 Run 等价
                 "Addons", "Addon",       # Visio 加载项（对应 Excel 的 AddIns）
                 "RunMacro"):             # Access/Project 的 DoCmd.RunMacro
        assert member_denied(name) is True, name


def test_non_office_extensions_still_recognised_as_paths() -> None:
    """新放行的 app 有自己的后缀，别让 `SaveAs("x.vsdx")` 漏出工作区判定。"""
    for name in ("a.vsdx", "a.mpp", "a.pub", "a.one", "a.accdb", "a.mdb", "a.msg", "a.oft"):
        assert looks_like_path(name) is True, name
    assert check_value(r"C:\Users\Public\evil.vsdx", GATE) is not None
    assert resolve_path_args("SaveAs", ["out.vsdx"], GATE)[0] == WS + r"\out.vsdx"
    # Outlook 存附件是正当用法，只该被路径闸门管，不该被当成危险成员封掉
    assert member_denied("SaveAsFile") is False
    assert resolve_path_args("SaveAsFile", ["att.pdf"], GATE)[0] == WS + r"\att.pdf"


def test_macro_and_addin_members_denied() -> None:
    # 闸门只管路径，管不住"让 Excel 跑 VBA 去写任意文件"，故这些必须直接封死
    for name in ("Run", "run", "ExecuteExcel4Macro", "VBE", "RegisterXLL", "AddIns", "Shell",
                 "SendKeys", "OnTime", "OnKey", "DDEInitiate", "DDEExecute"):
        assert member_denied(name) is True, name
    for name in ("SaveAs", "Open", "Range", "Value"):
        assert member_denied(name) is False, name


def test_absolute_path_outside_workspace_denied() -> None:
    assert check_value(r"C:\Users\Public\evil.xlsx", GATE) is not None
    assert check_value(r"\\server\share\evil.xlsx", GATE) is not None      # UNC
    assert check_value(WS + r"\ok.xlsx", GATE) is None


def test_env_var_expansion_cannot_bypass() -> None:
    # 不展开 %VAR% 的话，%APPDATA%\evil.xlsm 看起来是相对路径，就绕过了工作区判定
    assert check_value(r"%APPDATA%\evil.xlsm", GATE) is not None


def test_traversal_denied_anywhere_in_args() -> None:
    assert check_value(WS + r"\..\up.xlsx", GATE) is not None
    assert check_call("SaveAs", [WS + r"\sub\..\..\up.xlsx"], {}, GATE) is not None


def test_plain_text_args_not_mistaken_for_paths() -> None:
    # 单元格值/公式不能被闸门误伤（更不能被改写，那会直接损坏数据）
    assert check_value("=SUM(A1:A2)", GATE) is None
    assert check_value("hello world", GATE) is None
    assert looks_like_path("hello world") is False


def test_relative_path_anchored_to_workspace() -> None:
    # 裸相对名会落到 Office 的"默认文件位置"（我的文档），是真实越界，必须锚回工作区
    out = resolve_path_args("SaveAs", ["out.xlsx"], GATE)
    assert out[0] == WS + r"\out.xlsx"
    # 非路径参数不动
    assert resolve_path_args("SaveAs", ["=SUM(A1:A2)"], GATE)[0] == "=SUM(A1:A2)"
    # 已是绝对路径的不动（交给 check_value 判越界）
    assert resolve_path_args("SaveAs", [r"C:\x\y.xlsx"], GATE)[0] == r"C:\x\y.xlsx"


def test_nested_args_are_walked() -> None:
    # 路径可能藏在数组/字典参数里（ExportAsFixedFormat 这类多参方法）
    assert check_call("ExportAsFixedFormat", [0, [r"C:\Users\Public\x.pdf"]], {}, GATE) is not None
    assert check_call("Whatever", [], {"Filename": r"C:\Users\Public\x.pdf"}, GATE) is not None


def test_unknown_member_still_gated_by_absolute_path_rule() -> None:
    # 成员映射漏登记不该等于漏一个洞：绝对路径那条规则对所有成员生效
    assert check_call("SomeUndocumentedExport", [r"C:\Users\Public\x.xlsx"], {}, GATE) is not None


# ── 读放开 / 写限区内 ──────────────────────────────────────────────
# 闸门对【读】和【写】不再一视同仁：读成员的路径位允许工作区外的绝对路径，其余一切照旧。


def test_outside_read_is_allowed_on_read_members() -> None:
    """读全放开：Open 一个区外文件不再被拒。"""
    assert check_call("Open", [r"C:\data\report.xlsx"], {}, GATE) is None
    assert check_call("Open", [], {"FileName": r"C:\data\report.docx"}, GATE) is None
    assert check_call("FileOpen", [r"D:\plans\p.mpp"], {}, GATE) is None


def test_outside_write_is_still_denied() -> None:
    """写只在工作区内：放开读不能顺手把写也放开。"""
    for name in ("SaveAs", "SaveCopyAs", "Publish", "SaveAsFile", "ExportAsFixedFormat"):
        assert check_call(name, [r"C:\Users\Public\evil.xlsx"], {}, GATE) is not None, name
    assert check_call("ExportAsFixedFormat", [0, r"C:\Users\Public\x.pdf"], {}, GATE) is not None


def test_read_members_without_a_read_only_story_stay_denied() -> None:
    """会造出"绑死区外路径又能 Save"的对象、API 又没有只读参数的，维持现状拒掉。"""
    for name in ("OpenText", "OpenCurrentDatabase", "OpenHierarchy", "OpenDatabase"):
        assert check_call(name, [r"C:\data\x.csv"], {}, GATE) is not None, name


def test_read_exemption_covers_only_the_path_slot() -> None:
    """豁免只作用在登记的路径位上，别的参数照旧判 —— 否则区外路径换个位置就混过去了。"""
    assert check_call("Open", [WS + r"\ok.xlsx", r"C:\Users\Public\evil.xlsx"], {}, GATE) is not None
    assert check_call("Open", [r"C:\data\ok.xlsx"], {"AddToRecentFiles": r"C:\x\y.xlsx"},
                      GATE) is not None


def test_traversal_allowed_only_on_the_exempt_slot() -> None:
    assert check_call("Open", [WS + r"\..\up.xlsx"], {}, GATE) is None          # 读，放行
    assert check_call("SaveAs", [WS + r"\..\up.xlsx"], {}, GATE) is not None    # 写，仍拒
    assert check_call("Open", [WS + r"\ok.xlsx", r"..\evil"], {}, GATE) is not None


def test_unknown_member_gets_no_exemption() -> None:
    """漏登记的成员一律按写对待（失败方向朝关着的一边）。"""
    assert check_call("SomeUndocumentedOpen", [r"C:\data\x.xlsx"], {}, GATE) is not None


def test_outside_open_is_forced_read_only() -> None:
    """区外文件只读打开：Save() 就地写回那条路由 Office 自己挡下来。"""
    assert path_arg_outside("Open", [r"C:\data\x.xlsx"], {}, GATE) is True
    args, kwargs, err = apply_read_only("Open", [r"C:\data\x.xlsx"], {})
    assert err is None
    assert args == [r"C:\data\x.xlsx"]
    assert kwargs == {"ReadOnly": True}
    # 调用方自己写了 ReadOnly=False 也覆盖掉
    _, kwargs, err = apply_read_only("Open", [r"C:\data\x.xlsx"], {"ReadOnly": False})
    assert err is None and kwargs["ReadOnly"] is True


def test_inside_workspace_open_is_not_touched() -> None:
    """区内照常可写，别把工作区里的文件也变成只读。"""
    assert path_arg_outside("Open", [WS + r"\ok.xlsx"], {}, GATE) is False
    assert path_arg_outside("Open", ["ok.xlsx"], {}, GATE) is False   # 相对路径已锚回工作区


def test_visio_openex_gets_read_only_flag() -> None:
    """Visio 的 OpenEx 没有 ReadOnly 参数，只读靠 flags 里的 visOpenRO(2) 位。"""
    args, kwargs, err = apply_read_only("OpenEx", [r"C:\data\x.vsdx", 8], {})
    assert err is None and args[1] == 8 | 2
    args, kwargs, err = apply_read_only("OpenEx", [r"C:\data\x.vsdx"], {})
    assert err is None and kwargs["Flags"] == 2


def test_read_only_injection_refuses_ambiguous_positionals() -> None:
    """ReadOnly 的位置随 app 不同（Excel/Word 是第 3 位、PPT 是第 2 位），位置参数一多就分不清
    该覆盖哪个。分不清就拒，让调用方改用命名参数——不能猜着写。"""
    _, _, err = apply_read_only("Open", [r"C:\data\x.xlsx", 0, False], {})
    assert err is not None


def test_ingest_members_read_outside_without_read_only() -> None:
    """只把内容读进来、不产生能 Save 的绑定对象，放行即可，不用（也没法）注只读。"""
    for name in ("Insert", "InsertFile", "LoadFromFile", "CreateItemFromTemplate"):
        assert check_call(name, [r"C:\pics\logo.png"], {}, GATE) is None, name
    args, kwargs, err = apply_read_only("Insert", [r"C:\pics\logo.png"], {})
    assert (args, kwargs, err) == ([r"C:\pics\logo.png"], {}, None)


def test_every_read_member_has_a_registered_path_slot() -> None:
    """豁免靠 PATH_PARAM_INDEX 定位路径位；漏登记 = 该成员拿不到豁免（拒，不是漏洞），
    但那属于配置事故，这里直接锁死两张表对齐。"""
    from netlivecowork.office_broker.policy import (
        PATH_PARAM_INDEX,
        READ_INGEST_MEMBERS,
        READ_OPEN_MEMBERS,
    )

    for name in set(READ_OPEN_MEMBERS) | set(READ_INGEST_MEMBERS):
        assert name in PATH_PARAM_INDEX, name


def test_no_workspace_means_deny_all_paths() -> None:
    bare = Gate(workspace=None)
    assert check_value(r"C:\anything\x.xlsx", bare) is not None


def test_stub_and_sitecustomize_are_written(tmp_path) -> None:
    """桩要同时投两个文件：ipmc_office.py（代理）+ sitecustomize.py（透明接管的入口）。

    少了 sitecustomize，agent 就得改写法用 ipmc_office；有了它，`import win32com.client`
    原样可用。这里只验投递与内容要点，真实拦截在 Windows 端到端里验。
    """
    from netlivecowork.office_broker.client_stub import write_stub

    d = write_stub(tmp_path / "client")
    stub = (tmp_path / "client" / "ipmc_office.py").read_text(encoding="utf-8")
    site = (tmp_path / "client" / "sitecustomize.py").read_text(encoding="utf-8")
    assert d == str(tmp_path / "client")
    assert "def install_win32com_shim" in stub
    assert "install_win32com_shim" in site
    # 影子模块只能在真有 broker 时装：否则半自动/人工模式会被误接管
    assert "_ENV_PIPE" in stub and "NLC_OFFICE_PIPE" in stub


def test_stub_is_self_contained() -> None:
    """桩跑在 agent 的共享 venv 里，那边没有 netlivecowork，不能 import 本仓任何东西。"""
    from netlivecowork.office_broker.client_stub import STUB_SOURCE

    assert "netlivecowork" not in STUB_SOURCE


def test_reap_orphan_office_ignores_non_office_pids(tmp_path) -> None:
    """收尸只认【映像名确实是 Office】的进程。

    PID 会被系统复用：pid 文件里的号码在 broker 崩溃后可能已经属于别的程序，照着号码就杀会误伤。
    这里把当前 python 进程的 pid 写进去，它必须毫发无伤。
    """
    import os

    from netlivecowork.office_broker.manager import _reap_orphan_office

    f = tmp_path / "pids.txt"
    f.write_text(str(os.getpid()), encoding="utf-8")
    assert _reap_orphan_office(str(f)) == 0
    assert os.getpid() > 0   # 还活着（真被杀了这行也跑不到）


def test_detect_started_polls_for_late_process() -> None:
    """Dispatch 返回后进程可能才出现（实测 Publisher），只拍一张快照会漏记成孤儿。"""
    from netlivecowork.office_broker import procs, server

    calls = {"n": 0}

    def fake_pids():
        calls["n"] += 1
        return {1, 2} if calls["n"] < 3 else {1, 2, 99}   # 第三次才看见新进程

    orig = procs.office_pids
    procs.office_pids = fake_pids
    try:
        assert server._detect_started({1, 2}, timeout=5, step=0.01) == {99}
        assert calls["n"] == 3
    finally:
        procs.office_pids = orig


def test_detect_started_gives_up_so_attaching_stays_fast() -> None:
    """没有新进程 = 连上了用户自己开着的 Office。等到超时就返回空，不能一直等。"""
    from netlivecowork.office_broker import procs, server

    orig = procs.office_pids
    procs.office_pids = lambda: {1, 2}
    try:
        assert server._detect_started({1, 2}, timeout=0.05, step=0.01) == set()
    finally:
        procs.office_pids = orig


def test_reap_orphan_office_tolerates_missing_or_garbage_file(tmp_path) -> None:
    # 收尸在会话结束路径上，文件不在/内容坏了都只能安静跳过，不能抛
    from netlivecowork.office_broker.manager import _reap_orphan_office

    assert _reap_orphan_office(str(tmp_path / "nope.txt")) == 0
    bad = tmp_path / "bad.txt"
    bad.write_text("not a pid\n\x00", encoding="utf-8")
    assert _reap_orphan_office(str(bad)) == 0


def test_powerpoint_alerts_use_enum_not_boolean() -> None:
    """PPT 的 DisplayAlerts 是枚举不是布尔，写 False 会被强制成 2(ppAlertsAll)，与本意相反。

    实测三件套：Excel 是布尔（False 即可）、Word 是 WdAlertLevel（False→0=wdAlertsNone，正好对）、
    PPT 是 PpAlertLevel（ppAlertsNone=1），必须显式写 1，否则弹框会把 broker 卡死。
    这里只锁住"源码里对 PPT 走的是 1 而不是 False"这个事实，真值读回在 Windows 端到端里验。
    """
    import inspect

    from netlivecowork.office_broker.server import Broker

    src = inspect.getsource(Broker._harden)
    assert 'if p.startswith("powerpoint"):' in src
    assert "app.DisplayAlerts = 1" in src
    # Visio 压根没有 DisplayAlerts，走 AlertResponse=1(IDOK) 自动应答
    assert "app.AlertResponse = 1" in src


def test_broker_argv_carries_parent_pid() -> None:
    """broker 必须知道父进程是谁，否则 host 一退它就成孤儿。

    冻结态下 broker 跑的是 app 自己的 exe，孤儿会一直锁着安装目录，装新版报「无法停止
    IPMaster-Cowork」。第一道防线是 host 侧的 kill-on-close Job，这个参数是它建不起来时的兜底。
    """
    import os

    from netlivecowork.office_broker.manager import _broker_argv

    argv = _broker_argv("pipe-x", r"D:\ws", (), r"D:\pids.txt")
    assert "--parent-pid" in argv
    assert argv[argv.index("--parent-pid") + 1] == str(os.getpid())


def test_stop_all_clears_every_session() -> None:
    """app 关闭时要把所有会话的 broker 都收掉，漏一个就锁着安装目录。"""
    from netlivecowork.office_broker import manager

    stopped = []
    orig_stop, orig_brokers = manager.stop_broker, dict(manager._brokers)
    manager.stop_broker = stopped.append
    manager._brokers.update({"s1": object(), "s2": object()})   # type: ignore[dict-item]
    try:
        manager.stop_all()
    finally:
        manager.stop_broker = orig_stop
        manager._brokers.clear()
        manager._brokers.update(orig_brokers)
    assert sorted(stopped) == ["s1", "s2"]

# ── 报错分类：一个原因一个码 ─────────────────────────────────────
# 以前所有异常都糊成一个 COM_ERROR、所有 Office 失败都贴同一段提示，模型分不清"没装 Office"、
# "写到了工作区外"和"Excel 自己报错"。下面这组锁住"一条报错只对应一个原因"。


class com_error(Exception):        # noqa: N801 — 名字要和 pywin32 的一模一样
    """冒充 pywin32 的 com_error（类名 + args 四元组），好让这组测试跨平台可跑。"""


def _com(hresult, strerror="", excepinfo=None):
    return com_error(hresult, strerror, excepinfo, None)


def test_missing_office_is_its_own_code() -> None:
    """类未注册 = 本机没装这个 app。重试没用，不能和"权限/边界"混为一谈。"""
    from netlivecowork.office_broker.errors import classify_exception

    for hr in (-2147221164, -2147221005):     # REGDB_E_CLASSNOTREG / CO_E_CLASSSTRING
        f = classify_exception(_com(hr, "无效的类字符串"), progid="Excel.Application")
        assert f.code == "OFFICE_NOT_INSTALLED", hr
        assert "Excel" in f.message
        assert "工作区" not in f.message      # 与边界无关，别提
        assert "broker" not in f.message      # 与代理无关，别提


def test_office_launch_failure_is_its_own_code() -> None:
    """装了但起不来（服务器执行失败），和"没装"是两回事，给的下一步也不一样。"""
    from netlivecowork.office_broker.errors import classify_exception

    f = classify_exception(_com(-2146959355, "服务器执行失败"), progid="Word.Application")
    assert f.code == "OFFICE_LAUNCH_FAILED"
    assert "Word" in f.message


def test_office_own_error_keeps_its_own_words() -> None:
    """Office 自报的业务错（文件不存在、参数不对…）原话要露出来，不能再吐一坨元组。"""
    from netlivecowork.office_broker.errors import classify_exception

    excepinfo = (0, "Microsoft Excel", "抱歉，找不到 x.xlsx。", "xlmain11.chm", 0, -2146827284)
    f = classify_exception(_com(-2147352567, "发生意外。", excepinfo))
    assert f.code == "COM_ERROR"
    assert "Microsoft Excel" in f.message
    assert "抱歉，找不到 x.xlsx。" in f.message
    assert "0x800A03EC" in f.message          # 真正的 scode，不是 DISP_E_EXCEPTION
    # 不该顺带教育模型"可能没装 Office"或"只能写工作区内"
    assert "没有安装" not in f.message and "工作区" not in f.message


def test_broker_side_bug_is_not_labelled_as_com() -> None:
    """broker 自己的 Python 异常别冒充 COM 错——那会让模型去查 Office 装没装。"""
    from netlivecowork.office_broker.errors import classify_exception

    f = classify_exception(KeyError("ref 42"))
    assert f.code == "BROKER_ERROR"
    assert "KeyError" in f.message


def test_each_denial_reason_has_its_own_code() -> None:
    """闸门的四种拒绝各有各的码和各自的下一步，别共用一个 CALL_DENIED。"""
    assert check_call("SaveAs", [r"C:\Users\Public\evil.xlsx"], {}, GATE).code == "WRITE_OUTSIDE_WORKSPACE"
    assert check_call("SaveAs", [WS + r"\..\up.xlsx"], {}, GATE).code == "PATH_TRAVERSAL"
    assert check_call("Run", ["Macro1"], {}, GATE).code == "MEMBER_DENIED"
    assert check_call("OpenText", [r"C:\data\x.csv"], {}, GATE).code == "READ_NOT_READ_ONLY_CAPABLE"
    _, _, deny = apply_read_only("Open", [r"C:\data\x.xlsx", 0, False], {})
    assert deny.code == "READONLY_AMBIGUOUS"


def test_write_denial_talks_only_about_writing() -> None:
    """越界写的消息只讲越界写：工作区在哪、往哪写。别把读规则、Office 装没装塞进来。"""
    d = check_call("SaveAs", [r"C:\Users\Public\evil.xlsx"], {}, GATE)
    assert WS in d.message
    assert "没有安装" not in d.message and "broker" not in d.message


def test_unsafe_read_denial_says_why_and_how() -> None:
    """档 3 的读被拒不是"越界写"，消息得说清是"这个 API 没法只读打开"，并给出可行的下一步。"""
    d = check_call("OpenText", [r"C:\data\x.csv"], {}, GATE)
    assert "只读" in d.message
    assert "复制" in d.message          # 下一步：先把文件复制进工作区


def test_denial_still_reads_as_text() -> None:
    """Denial 会被拼进消息串，str() 得是那句人话，不能是 dataclass 的 repr。"""
    d = check_call("SaveAs", [r"C:\Users\Public\evil.xlsx"], {}, GATE)
    assert str(d) == d.message


def test_shell_hints_are_mutually_exclusive() -> None:
    """一条报错只该被贴【一条】提示：以前只要文本里有 com_error 就贴"可能没装 Office+写边界"整段。"""
    from netlivecowork.low_integrity import low_shell as L

    hints = (L._NO_BROKER_HINT, L._NOT_INSTALLED_HINT, L._OFFICE_WRITE_HINT,
             L._BOUNDARY_HINT, L._PRIVILEGE_HINT)
    cases = {
        "[OFFICE_NOT_INSTALLED] 本机没有安装 Microsoft Excel": L._NOT_INSTALLED_HINT,
        "OfficeBrokerError: 连不上 Office broker：…": L._NO_BROKER_HINT,
        "[WRITE_OUTSIDE_WORKSPACE] 路径在工作区外，不能写": L._OFFICE_WRITE_HINT,
        "PermissionError: [Errno 13] Permission denied: 'C:/x'": L._BOUNDARY_HINT,
        "OSError: 所需的特权没有被客户持有": L._PRIVILEGE_HINT,
    }
    for text, expect in cases.items():
        got = L.failure_hint(text)
        assert got is expect, text
        assert sum(h in (got or "") for h in hints) == 1, text


def test_office_own_error_gets_no_hint() -> None:
    """Excel 说"找不到文件"就是找不到文件，别再追加边界/安装说明把模型带偏。"""
    from netlivecowork.low_integrity import low_shell as L

    assert L.failure_hint("[COM_ERROR] Microsoft Excel 报错：抱歉，找不到 x.xlsx。") is None

def test_internal_error_carries_a_stack_tail() -> None:
    """broker 自己的 bug 必须带栈回来。

    真事：全自动下报了句 `broker 内部错误 IndexError: list index out of range` 就没了——
    没有栈、没有 op、没有成员名，日志又在别人的机器上，只能靠猜。已分类的 Office 错不需要栈
    （原话已经说清），这一条只给内部异常。
    """
    from netlivecowork.office_broker.errors import trace_tail

    try:
        [][3]
    except IndexError as e:
        tail = trace_tail(e, frames=3)
    assert "test_office_broker_policy" in tail
    assert "test_internal_error_carries_a_stack_tail" in tail
    assert 1 <= len(tail.splitlines()) <= 3


def test_broker_reports_where_it_broke() -> None:
    """内部异常回给 agent 的消息里要有 op、成员名和栈尾。"""
    from netlivecowork.office_broker.server import Broker

    b = Broker(Gate(workspace=WS))
    r = b.handle({"op": "item", "ref": 999, "name": "Cells", "key": 1})   # 对象表里没有 999
    assert r["ok"] is False
    assert r["code"] == "BROKER_ERROR"
    assert "op=item" in r["message"] and "Cells" in r["message"]
    assert "↳" in r["message"]


def test_classified_office_error_stays_one_line() -> None:
    """Office 自报的业务错不带栈：栈是 broker 的实现细节，对 agent 没用，只会盖住原话。"""
    from netlivecowork.office_broker.server import Broker

    def boom(_self, _msg):
        raise _com(-2147352567, "发生意外。",
                   (0, "Microsoft Excel", "抱歉，找不到 x.xlsx。", "", 0, -2146827284))

    b = Broker(Gate(workspace=WS))
    b._OPS = {"boom": boom}
    r = b.handle({"op": "boom"})
    assert r["code"] == "COM_ERROR"
    assert "抱歉，找不到 x.xlsx。" in r["message"]
    assert "↳" not in r["message"]


"""Office broker 的闸门：ProgID 白名单 + 危险成员封禁 + 参数级路径校验。纯逻辑，跨平台可测。

**为什么闸门按【参数】而不是按【成员】做**：Office 对象模型太大，枚举"哪些方法带路径"
（Open/SaveAs/SaveCopyAs/ExportAsFixedFormat/Publish/Attachments.Add/…）必然漏，漏一个成员名
就等于漏一个越界写的洞。所以主判据是"任何参数里出现的**绝对路径**都必须落在工作区内"，成员名
映射只用来额外处理【相对路径】这一种它判不了的情况。

三道叠一起（缺一不可）：
  ① 绝对路径（含 UNC、含 %VAR% 展开后）不在工作区 → 拒。管住所有成员，包括没登记过的。
  ② 任何字符串参数里出现 `..` + 分隔符 → 拒。堵目录穿越。
  ③ 已知带路径的成员，其路径位参数按工作区解析成绝对路径再判 ①。管住 `SaveAs("x.xlsx")`
     这种裸相对名——它会落到 Office 自己的"默认文件位置"（我的文档），是真实的越界。
     ③ 之外还有一层兜底：broker 起 Excel/Word 时把默认文件位置改成工作区（见 server.py）。

**读放开、写限区内**：边界要管的是"往哪写"，读一份桌面上的报表是正当需求。所以 ① 对【读成员的
路径位】豁免（READ_OPEN_MEMBERS / READ_INGEST_MEMBERS），其余一切照旧——包括没登记过的成员，
漏登记只会少一条读路子，不会多一个越界写的洞。

豁免只落在【该成员登记的那一个路径位】上，不是整个调用放行：否则 `Open(区内路径, …, 区外路径)`
换个参数位置就混过去了。

放开读会新开一个洞：`Open(区外文件)` 之后无参 `Save()` 就地写回，那条调用没有路径参数，按参数判
的闸门看不见它。堵法是 apply_read_only()——区外的读一律**只读打开**，Save() 由 Office 自己报错。
没有只读参数可注的读成员（OpenText / OpenCurrentDatabase / OpenHierarchy）就不进读名单，维持拒。

刻意**不改写**普通字符串参数：单元格值、公式里都可能有 `/`，误判成路径去改写会直接损坏数据。
只有 ③ 里"已登记成员的已登记位置"才做工作区解析。
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

from netlivecowork.auth.bash_policy import is_outside_workspace

# 允许 Dispatch 的 ProgID（小写前缀匹配，覆盖 Excel.Application.16 这种带版本号的写法）。
# 放整个 Office 家族，但**只有** Office：这条通道存在的理由就是 Office，别顺手把整个 COM 面
# 开出去（WScript.Shell / Shell.Application / MSXML 那些一放就等于给了任意执行）。
ALLOWED_PROGID_PREFIXES = (
    "excel.application",
    "word.application",
    "powerpoint.application",
    "outlook.application",
    "access.application",
    "publisher.application",
    "visio.application",
    "visio.invisibleapp",      # 无界面的 Visio，自动化场景下比 Visio.Application 更合适
    "msproject.application",
    "onenote.application",
)

# 危险成员：让 Office 自己执行代码 / 装加载项 / 敲键盘的入口。闸门只管【路径】，管不住
# "让 Excel 跑一段 VBA 去写任意文件"，所以这些必须直接封死，否则前面三道全是摆设。
DENIED_MEMBERS = frozenset({
    "run",                    # Application.Run：跑宏
    "executeexcel4macro",     # 老式宏引擎，能调 API
    "vbe", "vbproject", "vbprojects",   # 直接改 VBA 工程
    "registerxll",            # 装 XLL（原生代码）
    "addins", "addins2",      # 装/启用加载项（XLSTART 同类风险）
    "shell",                  # Application.Shell：起任意进程
    "sendkeys", "onkey", "ontime",      # 键盘注入 / 定时回调
    "macrooptions", "macrocontainer",
    "executeline",            # Visio：直接执行一行 VBA，和 Run 等价的洞
    "addons", "addon",        # Visio 加载项（Addon.Run），对应 Excel 的 AddIns
    "runmacro",               # Access/Project 的 DoCmd.RunMacro
    # DDE：DDEInitiate 能把另一个程序拉起来（经典的 Office 代码执行面）。本机实测是被 Office
    # 默认策略挡住的（返回错误值而非真起进程），但那是【策略】不是【机制】，企业机器上未必关，
    # 而 agent 的 Office 自动化没有任何正当理由用 DDE，直接封掉。
    "ddeinitiate", "ddeexecute", "ddepoke", "ddeterminate",
})

# 已知带路径的成员 → 路径在第几个位置参数（0 基）。只用于把【相对路径】按工作区解析，
# 不是安全判据本身（判据是上面的 ①②）。少登记一个只是相对路径少一层解析，不会开洞。
PATH_PARAM_INDEX: dict[str, int] = {
    "open": 0, "opentext": 0, "openxml": 0, "opendatabase": 0,
    "saveas": 0, "savecopyas": 0, "saveas2": 0,
    "exportasfixedformat": 1,   # (Type, Filename, ...)
    "publish": 0, "saveasxmldata": 0,
    "insert": 0, "insertfile": 0, "add": 0,   # Pictures.Insert / Documents.Add(模板)
    "loadfromfile": 0, "savepicture": 0,
    # 三件套之外的成员：
    "openex": 0, "addex": 0,                  # Visio Documents.OpenEx / AddEx
    "opencurrentdatabase": 0, "newcurrentdatabase": 0,   # Access
    "fileopen": 0, "fileopenex": 0, "filesaveas": 0,   # Project 的命令式 API
    "openhierarchy": 0,                       # OneNote
    "saveasfile": 0,                          # Outlook Attachment.SaveAsFile（存附件到工作区）
    "createitemfromtemplate": 0,              # Outlook .oft 模板
}

# ── 读成员：路径位可以指向工作区外 ──────────────────────────────────
# 档 1：会产生一个【绑定到该路径、且能被无参 Save() 就地写回】的对象。放行的同时必须强制只读打开，
# 否则等于把写也放开了。值 = 注入只读的方式：
#   "readonly_kw"  API 有 ReadOnly 命名参数（Excel/Word/PPT 的 Workbooks/Documents/
#                  Presentations.Open、Project 的 FileOpen）。
#   "visio_flags"  Visio 的 OpenEx 没有 ReadOnly，只读是 flags 里的 visOpenRO(2) 位。
# 注：Visio 的**普通** Documents.Open 两样都没有，注 ReadOnly 会被 COM 拒（named argument not
# found）——报错不是漏洞，那条路自然走不通，agent 改用 OpenEx 即可。
READ_OPEN_MEMBERS: dict[str, str] = {
    "open": "readonly_kw",
    "fileopen": "readonly_kw",
    "openex": "visio_flags",
}

# 档 2：只把外部文件的内容读进来（插图、套模板新建、加附件），不产生绑定到该路径、能 Save 回去的
# 对象。放行即可，没有只读可注，也不需要。
READ_INGEST_MEMBERS = frozenset({
    "insert", "insertfile", "loadfromfile", "add", "addex", "createitemfromtemplate",
})

# 档 3：也是读，但 API 没有只读打开的选项，而它产出的对象绑定到该路径、能被无参 Save() 写回。
# 放开就等于放开写，所以维持"只能开工作区内"，但要单独给一个码说清原因（见 _unsafe_outside_read）。
READ_NO_READONLY = frozenset({
    "opentext", "opencurrentdatabase", "openhierarchy", "opendatabase", "openxml",
})

VISIO_OPEN_RO = 2          # visOpenRO
VISIO_FLAGS_INDEX = 1      # OpenEx(fileName, flags)

# 读成员的路径也可能是命名参数传的（`Open(FileName=…)`），这几个键与位置路径位同等豁免。
_PATH_KWARGS = frozenset({"filename", "name", "path", "template", "source"})

# "这串东西像不像路径"：带盘符、UNC、含分隔符、或常见文档后缀。宁可多判（多判只会多走一次
# 工作区校验），不可少判。
_DRIVE = re.compile(r"^[a-zA-Z]:[\\/]")
_UNC = re.compile(r"^\\\\[^\\]")
_DOC_EXT = re.compile(
    r"\.(xls[xmb]?|xltx?|csv|doc[xm]?|dot[xm]?|ppt[xm]?|pot[xm]?|pps[xm]?|pdf|txt|xml|json"
    r"|vsd[xm]?|vst[xm]?|vss[xm]?|mpp|mpt|pub|one|onepkg|accd[bet]|mdb|msg|oft|rtf|htm|html)$",
    re.I,
)
# `..` 目录穿越：前后任意一侧带分隔符都算（`..\x`、`x/../y`、单独一个 `..`）。
_TRAVERSAL = re.compile(r"(^|[\\/])\.\.([\\/]|$)")


@dataclass(frozen=True)
class Denial:
    """一次拒绝：一个【码】+ 一句只讲这一件事的人话。

    分码是为了让 agent 分得清"写到了工作区外"、"路径里有 ..";"这个成员被禁"、"这个读入口没法
    只读打开"——它们的下一步各不相同，糊成一个 CALL_DENIED 等于什么都没说。
    """
    code: str
    message: str

    def __str__(self) -> str:
        return self.message


@dataclass(frozen=True)
class Gate:
    """一次会话的闸门配置。workspace 为 None 时一切带路径的参数都拒（保守）。"""
    workspace: str | None
    allowed_roots: tuple[str, ...] = ()


def progid_allowed(progid: str) -> bool:
    p = (progid or "").strip().lower()
    return any(p == a or p.startswith(a + ".") for a in ALLOWED_PROGID_PREFIXES)


def member_denied(name: str) -> bool:
    return (name or "").strip().lower() in DENIED_MEMBERS


def looks_like_path(s: str) -> bool:
    if not s or len(s) > 4096:
        return False
    if _DRIVE.match(s) or _UNC.match(s):
        return True
    if "\\" in s or "/" in s:
        return True
    return bool(_DOC_EXT.search(s))


def _expand(s: str) -> str:
    """展开 %VAR% / ~，否则 `%APPDATA%\\evil.xlsm` 这种能绕过工作区判定。"""
    try:
        return os.path.expanduser(os.path.expandvars(s))
    except Exception:
        return s


def check_value(value: str, gate: Gate) -> Denial | None:
    """单个字符串参数是否放行。返回拒绝原因，None=放行。"""
    if _TRAVERSAL.search(value):
        return Denial("PATH_TRAVERSAL",
                      f"参数里有 `..` 目录穿越：{value}。请把它写成不含 `..` 的路径再调一次。")
    if not looks_like_path(value):
        return None
    expanded = _expand(value)
    if not (_DRIVE.match(expanded) or _UNC.match(expanded)):
        return None   # 相对路径：交给 PATH_PARAM_INDEX 那层解析，这里不猜（可能只是普通文本）
    if is_outside_workspace(expanded, gate.workspace, gate.allowed_roots):
        return Denial("WRITE_OUTSIDE_WORKSPACE",
                      f"这次写入的目标在工作区外：{value}。自动模式下写入只能落在工作区内："
                      f"{gate.workspace}。请改成工作区内的路径再调一次。")
    return None


def _walk_strings(obj):
    """递归取出参数里的所有字符串（args 可能是 list/tuple/dict 嵌套）。"""
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, (list, tuple)):
        for x in obj:
            yield from _walk_strings(x)
    elif isinstance(obj, dict):
        for x in obj.values():
            yield from _walk_strings(x)


def resolve_path_args(name: str, args: list, gate: Gate) -> list:
    """把已知带路径成员的相对路径按【工作区】解析成绝对路径。

    不这么做的话 `SaveAs("out.xlsx")` 会落到 Office 的默认文件位置（我的文档），是实打实的
    越界写，而 ① 那条按绝对路径判的规则看不见它。
    """
    idx = PATH_PARAM_INDEX.get((name or "").lower())
    if idx is None or gate.workspace is None or idx >= len(args):
        return args
    v = args[idx]
    if not isinstance(v, str) or not looks_like_path(v):
        return args
    expanded = _expand(v)
    if _DRIVE.match(expanded) or _UNC.match(expanded):
        return args   # 已是绝对路径，交给 check_value 判
    out = list(args)
    out[idx] = os.path.normpath(os.path.join(gate.workspace, expanded))
    return out


def read_exempt_index(name: str) -> int | None:
    """读成员的路径位下标（该位允许指向工作区外）。非读成员 / 没登记路径位 → None。"""
    lname = (name or "").strip().lower()
    if lname not in READ_OPEN_MEMBERS and lname not in READ_INGEST_MEMBERS:
        return None
    return PATH_PARAM_INDEX.get(lname)


def _path_arg(name: str, args: list, kwargs: dict) -> str | None:
    """取读成员这次调用的路径实参（位置或命名）。"""
    idx = read_exempt_index(name)
    if idx is not None and idx < len(args) and isinstance(args[idx], str):
        return args[idx]
    if idx is None:
        return None
    for k, v in kwargs.items():
        if k.strip().lower() in _PATH_KWARGS and isinstance(v, str):
            return v
    return None


def path_arg_outside(name: str, args: list, kwargs: dict, gate: Gate) -> bool:
    """这次【读】调用的路径实参是否落在工作区外——是的话就得只读打开。

    相对路径不算：它已经被 resolve_path_args 锚回工作区了。
    """
    v = _path_arg(name, args, kwargs)
    if not v:
        return False
    expanded = _expand(v)
    if not (_DRIVE.match(expanded) or _UNC.match(expanded)):
        return False
    return is_outside_workspace(expanded, gate.workspace, gate.allowed_roots)


def apply_read_only(name: str, args: list, kwargs: dict) -> tuple[list, dict, Denial | None]:
    """给"读区外文件"的调用注入只读打开。返回 (args, kwargs, 拒绝原因)。

    只在 path_arg_outside() 为真时调用。档 2（ingest）原样返回：那些成员不产生能 Save 的绑定。
    """
    mode = READ_OPEN_MEMBERS.get((name or "").strip().lower())
    if mode is None:
        return args, kwargs, None
    if mode == "visio_flags":
        raw = args[VISIO_FLAGS_INDEX] if len(args) > VISIO_FLAGS_INDEX else kwargs.get("Flags", 0)
        try:
            flags = int(raw or 0)
        except (TypeError, ValueError):
            flags = 0
        flags |= VISIO_OPEN_RO
        if len(args) > VISIO_FLAGS_INDEX:
            out = list(args)
            out[VISIO_FLAGS_INDEX] = flags
            return out, kwargs, None
        return args, {**kwargs, "Flags": flags}, None
    # readonly_kw：ReadOnly 的【位置】随 app 而异（Excel/Word 的 Open 在第 3 位、PPT 在第 2 位），
    # 晚绑定下分不清手里这个是谁的 Open，所以位置参数一多就没法确定该覆盖哪个——猜着写会把别的
    # 参数改坏。分不清就拒，让调用方改用命名参数。
    if len(args) > 1:
        return args, kwargs, Denial("READONLY_AMBIGUOUS",
            f"工作区外的文件只能只读打开，而 {name} 的 ReadOnly 参数位置随 Office 应用而异"
            f"（Excel/Word 在第 3 位、PowerPoint 在第 2 位），位置参数多于一个时无法确定该覆盖哪个。"
            f"请只用一个位置参数传文件名、其余写成命名参数，如 Open(path, UpdateLinks=0)。")
    kw = {k: v for k, v in kwargs.items() if k.strip().lower() != "readonly"}
    kw["ReadOnly"] = True
    return args, kw, None


def _unsafe_outside_read(name: str, args: list, kwargs: dict, gate: Gate) -> Denial | None:
    """档 3：是读，但这个 API 没有只读打开的选项，所以工作区外的文件不能从这里打开。

    单独分一个码，因为它既不是"越界写"也不是"成员被禁"，下一步也不一样：先把文件复制进工作区。
    """
    lname = (name or "").strip().lower()
    if lname not in READ_NO_READONLY:
        return None
    idx = PATH_PARAM_INDEX.get(lname)
    v = args[idx] if idx is not None and idx < len(args) and isinstance(args[idx], str) else None
    if v is None:
        for k, val in kwargs.items():
            if k.strip().lower() in _PATH_KWARGS and isinstance(val, str):
                v = val
                break
    if not v:
        return None
    expanded = _expand(v)
    if not (_DRIVE.match(expanded) or _UNC.match(expanded)):
        return None
    if not is_outside_workspace(expanded, gate.workspace, gate.allowed_roots):
        return None
    return Denial("READ_NOT_READ_ONLY_CAPABLE",
                  f"{name} 打开的对象会绑定到 {v} 并且能被无参 Save() 就地写回，而这个 API "
                  f"没有只读打开的选项，所以它只能开工作区内的文件。请先把这份文件复制进工作区"
                  f"（{gate.workspace}）再打开。")


def denial_for_member(name: str) -> Denial:
    """危险成员的拒绝。单独一个函数，好让属性读写（op_get/op_set）和调用共用同一句话。"""
    return Denial("MEMBER_DENIED",
                  f"成员 {name} 在自动模式下被禁用：它能让 Office 自己执行代码或加载外部模块，"
                  f"会绕过写入边界。请改用对象模型直接读写单元格/文档内容。")


def check_call(name: str, args: list, kwargs: dict, gate: Gate) -> Denial | None:
    """一次成员调用是否放行。返回 Denial（带码），None=放行。"""
    if member_denied(name):
        return denial_for_member(name)
    unsafe = _unsafe_outside_read(name, args, kwargs, gate)
    if unsafe:
        return unsafe
    exempt_idx = read_exempt_index(name)
    exempt_kw = _PATH_KWARGS if exempt_idx is not None else frozenset()
    for i, a in enumerate(args):
        if i == exempt_idx:
            continue          # 读成员的路径位：区外也放行
        for s in _walk_strings(a):
            err = check_value(s, gate)
            if err:
                return err
    for k, v in kwargs.items():
        if k.strip().lower() in exempt_kw:
            continue
        for s in _walk_strings(v):
            err = check_value(s, gate)
            if err:
                return err
    return None

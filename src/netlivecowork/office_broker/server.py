"""Office broker 服务端：跑在 **Medium** 子进程里，替 Low 会话持有并驱动 Office COM 对象。

为什么必须是独立的 Medium 进程：DCOM 用【调用方的完整性级别】启动进程外 COM 服务器，Low 会话
里 Dispatch 出来的 EXCEL.EXE 自己也是 Low，连临时文件都写不了（实测 `Workbooks.Add()` 即失败，
报错还伪装成"内存或磁盘空间不足"）。把 COM 调用挪到 Medium 这一侧，Excel 才起得来。

边界靠 policy.py 的闸门守：agent 能驱动 Office，但 Office 只能写工作区。

用法（由 manager.py 拉起）：
    python -m netlivecowork.office_broker.server --pipe <name> --workspace <dir> [--allow <dir>]
单线程、串行、STA：COM 本来就不支持在别的线程随便调，串行也让闸门的判定不用考虑竞态。
"""

from __future__ import annotations

import argparse
import logging
import sys

from netlivecowork.office_broker import pipe as pipe_mod
from netlivecowork.office_broker import procs
from netlivecowork.office_broker import protocol as P
from netlivecowork.office_broker.errors import app_name, classify_exception, trace_tail
from netlivecowork.office_broker.policy import (
    Gate,
    apply_read_only,
    check_call,
    check_value,
    denial_for_member,
    member_denied,
    path_arg_outside,
    progid_allowed,
    resolve_path_args,
)

logger = logging.getLogger("ipmc.office_broker")


def _detect_started(before: set[int], timeout: float = 1.5, step: float = 0.25) -> set[int]:
    """Dispatch 之后新出现的 Office 进程。要**轮询**，不能只看一次。

    实测 Publisher：`Dispatch` 已经返回、COM 调用也能用了，MSPUB.EXE 才出现在进程表里，
    紧挨着拍的那一张快照是空的。漏记一个的后果不是小事——它不算"我们拉起来的"，退出时就不收，
    于是留下一个没有界面、一直抱着工作区文件锁的孤儿进程。宁可多等一秒。

    反过来也不能等太久：等的时间越长，越可能把【用户自己在这期间打开的 Office】误记成我们的，
    那会在会话结束时把人家的文档一起关掉。一有新进程就立刻返回，所以正常情况根本等不满。
    """
    import time

    deadline = time.monotonic() + timeout
    while True:
        started = procs.office_pids() - before
        if started or time.monotonic() >= deadline:
            return started
        time.sleep(step)


class _ObjectTable:
    """id → COM 对象。客户端持代理，代理销毁时发 release；进程退出时整体丢弃。"""

    def __init__(self) -> None:
        self._items: dict[int, object] = {}
        self._next = 1

    def put(self, obj) -> int:
        i = self._next
        self._next += 1
        self._items[i] = obj
        return i

    def get(self, i: int):
        if i not in self._items:
            raise KeyError(f"对象 {i} 不存在（可能已释放）")
        return self._items[i]

    def drop(self, i: int) -> None:
        self._items.pop(i, None)

    def clear(self) -> None:
        self._items.clear()


class Broker:
    def __init__(self, gate: Gate, pid_file: str | None = None) -> None:
        self.gate = gate
        self.table = _ObjectTable()
        self._const_ready: set[str] = set()   # 已 EnsureDispatch 过、常量可取的 ProgID
        self._dispatched: set[str] = set()    # 本会话 Dispatch 过的 ProgID（常量回退用）
        self._owned_pids: set[int] = set()    # 由本 broker 拉起的 Office 进程
        self._owned_apps: list = []           # 同上，对象形式（只 Quit 这些）
        self._pid_file = pid_file

    # ── 值编解码 ────────────────────────────────────────────────────────
    def _is_com(self, v) -> bool:
        # pywin32 的 IDispatch 包装：CDispatch / PyIDispatch。用鸭子判定，避免 import 细节。
        return hasattr(v, "_oleobj_") or type(v).__name__ in ("PyIDispatch", "CDispatch")

    def _encode(self, v):
        if self._is_com(v):
            return P.ref(self.table.put(v))
        if isinstance(v, (str, int, float, bool)) or v is None:
            return P.val(v)
        if isinstance(v, (list, tuple)):
            return P.val([self._encode_plain(x) for x in v])
        special = P.encode_special(v)      # datetime / bytes / Decimal 带类型过管道
        if special is not None:
            return special
        return P.val(str(v))   # 认不出的类型（PyTime 等）只能退化成字符串

    def _encode_plain(self, v):
        """嵌套在数组里的值（Range.Value 是元组套元组，里面常有日期）。

        特殊类型在这里也要带类型标记：整片单元格取回来时日期同样不能变成字符串，客户端的
        _unwrap 会递归还原。
        """
        if isinstance(v, (str, int, float, bool)) or v is None:
            return v
        if isinstance(v, (list, tuple)):
            return [self._encode_plain(x) for x in v]
        special = P.encode_special(v)
        if special is not None:
            return special
        return str(v)

    def _decode_arg(self, a):
        """客户端传来的实参。数组要递归——agent 可能传一片带日期的二维数组进来。"""
        if P.is_ref(a):
            return self.table.get(a["__ref__"])
        if P.is_val(a):
            v = P.decode_special(a) if "__t__" in a else a["__v__"]
            return [self._decode_arg(x) for x in v] if isinstance(v, list) else v
        if isinstance(a, list):
            return [self._decode_arg(x) for x in a]
        return a

    # ── 各 op ───────────────────────────────────────────────────────────
    def op_dispatch(self, msg: dict) -> dict:
        progid = msg.get("progid", "")
        if not progid_allowed(progid):
            return P.err("PROGID_DENIED",
                         f"自动模式下只允许 Office 自动化，{progid!r} 不在白名单里。")
        import win32com.client
        before = procs.office_pids()
        try:
            app = win32com.client.Dispatch(progid)
        except Exception as e:  # noqa: BLE001 — 分类后回给 agent：没装 / 起不来 / 别的
            f = classify_exception(e, progid=progid)
            logger.info("Dispatch %s 失败：[%s] %s", progid, f.code, f.message)
            return P.err(f.code, f.message)
        self._dispatched.add(progid)
        if self._account(before, progid):
            self._owned_apps.append(app)   # 是我们拉起来的，退出时负责 Quit
        self._harden(app, progid)
        return P.ok({"value": self._encode(app)})

    def _account(self, before: set[int], progid: str) -> bool:
        """把这次新起的 Office 进程记进账本，返回"是不是我们拉起来的"。"""
        started = _detect_started(before)
        if not started:
            # 没有新进程 = 连上了**用户自己开着的** Office（Excel 是单实例应用）。绝不能去 Quit 它，
            # 那会把用户没保存的文档一起关掉。
            logger.info("连接到已在运行的 %s（非本进程拉起），退出时不会 Quit 它", progid)
            return False
        self._owned_pids |= started
        self._write_pid_file()
        return True

    def _write_pid_file(self) -> None:
        """把自己拉起的 Office PID 落盘，供 host 在 broker 被强杀后收尸。"""
        if not self._pid_file:
            return
        try:
            with open(self._pid_file, "w", encoding="utf-8") as f:
                f.write("\n".join(str(p) for p in sorted(self._owned_pids)))
        except Exception:
            logger.debug("写 pid 文件失败", exc_info=True)

    def _harden(self, app, progid: str) -> None:
        """起 Office 后立刻收紧：禁宏 + 把默认文件位置指到工作区。

        默认文件位置这条很关键：裸相对名（`SaveAs("out.xlsx")`）会落到 Office 自己的"我的文档"，
        闸门的绝对路径判据看不见它。改掉之后这类调用自然落在工作区内。
        """
        p = progid.lower()
        # 别弹模态框把 broker 卡死。各家语义不一样，实测过：
        #   Excel   DisplayAlerts 是布尔，False 即可；
        #   Word    是 WdAlertLevel，False→0=wdAlertsNone，正好对；
        #   PPT     是 PpAlertLevel，ppAlertsNone=1 / ppAlertsAll=2，写 False 会被强制成 2，
        #           也就是【打开全部弹窗】，与本意相反，必须显式写 1；
        #   Visio   压根没有 DisplayAlerts，用 AlertResponse=1(IDOK) 自动应答；
        #   Access  用 DoCmd.SetWarnings False；
        #   Outlook/OneNote 两样都没有，异常吞掉即可。
        try:
            if p.startswith("powerpoint"):
                app.DisplayAlerts = 1
            elif p.startswith("visio"):
                app.AlertResponse = 1
            else:
                app.DisplayAlerts = False
        except Exception:
            logger.debug("设 DisplayAlerts 失败（%s）", progid, exc_info=True)
        if p.startswith("access"):
            try:
                app.DoCmd.SetWarnings(False)
            except Exception:
                logger.debug("设 Access SetWarnings 失败", exc_info=True)
        try:
            app.AutomationSecurity = 3    # msoAutomationSecurityForceDisable：打开文档一律禁宏
        except Exception:
            logger.debug("设 AutomationSecurity 失败（%s）", progid, exc_info=True)
        if self.gate.workspace:
            try:
                if p.startswith("excel"):
                    app.DefaultFilePath = self.gate.workspace
                elif p.startswith("word"):
                    # 参数化属性，晚绑定下不能写成 DefaultFilePath(0, path)（那是 TypeError）；
                    # pywin32 为这类属性生成的 setter 是 Set<Name>。0=wdDocumentsPath。
                    app.Options.SetDefaultFilePath(0, self.gate.workspace)
                elif p.startswith("visio"):
                    app.DrawingsPath = self.gate.workspace
                elif p.startswith("access"):
                    app.SetOption("Default Database Directory", self.gate.workspace)
            except Exception:
                logger.debug("设默认文件位置失败（%s）", progid, exc_info=True)

    def op_get(self, msg: dict) -> dict:
        name = msg.get("name", "")
        if member_denied(name):
            return P.err("MEMBER_DENIED", denial_for_member(name).message)
        obj = self.table.get(msg["ref"])
        try:
            v = getattr(obj, name)
        except AttributeError as e:
            # 成员不存在是【结构性】信号，不是故障：hasattr()/getattr(o, x, 默认值) 都靠它。
            # 糊成 broker 错误的话，客户端那侧 hasattr 永远为真。保码回去，桩还原成 AttributeError。
            return P.err("ATTRIBUTE_ERROR", str(e) or name)
        return P.ok({"value": self._encode(v)})

    def op_set(self, msg: dict) -> dict:
        name = msg.get("name", "")
        if member_denied(name):
            return P.err("MEMBER_DENIED", denial_for_member(name).message)
        value = self._decode_arg(msg.get("value"))
        if isinstance(value, str):
            # 赋值也可能是写路径（如 SaveAs 之外的 .FullName 类属性），同样过闸门。
            deny = check_value(value, self.gate)
            if deny:
                return P.err(deny.code, deny.message)
        setattr(self.table.get(msg["ref"]), name, value)
        return P.ok({"value": P.val(None)})

    def op_call(self, msg: dict) -> dict:
        name = msg.get("name", "")
        raw_args = [self._decode_arg(a) for a in msg.get("args", [])]
        kwargs = {k: self._decode_arg(v) for k, v in (msg.get("kwargs") or {}).items()}
        args = resolve_path_args(name, raw_args, self.gate)   # 相对路径先锚到工作区
        deny = check_call(name, args, kwargs, self.gate)
        if deny:
            return P.err(deny.code, deny.message)
        if path_arg_outside(name, args, kwargs, self.gate):
            # 读区外文件是放行的，但必须只读打开：否则拿到手的对象一个无参 Save() 就写回去了，
            # 那条调用没有路径参数，闸门看不见（见 policy 的模块注释）。
            args, kwargs, deny = apply_read_only(name, args, kwargs)
            if deny:
                return P.err(deny.code, deny.message)
        obj = self.table.get(msg["ref"])
        target = obj if not name else getattr(obj, name)
        return P.ok({"value": self._encode(target(*args, **kwargs))})

    def op_item(self, msg: dict) -> dict:
        key = self._decode_arg(msg.get("key"))
        obj = self.table.get(msg["ref"])      # 这句的 KeyError 是我们自己的错，不该被下面吞掉
        try:
            v = obj[key]
        except IndexError as e:
            # **迭代到头的信号，不是错误**：COM 集合没有 __iter__，`for x in 集合` 走的是旧式
            # 序列协议——Python 靠捕获 IndexError 结束循环。以前这里糊成通用错误，桩抛
            # OfficeBrokerError，for 不认，于是所有遍历 COM 集合的脚本在全自动下都炸。
            return P.err("INDEX_ERROR", str(e) or "index out of range")
        except KeyError as e:
            return P.err("KEY_ERROR", str(e))
        return P.ok({"value": self._encode(v)})

    def op_release(self, msg: dict) -> dict:
        self.table.drop(msg["ref"])
        return P.ok({"value": P.val(None)})

    def op_const(self, msg: dict) -> dict:
        """取类型库常量（`win32com.client.constants.xlUp` 这种）。

        常量得靠早绑定生成的模块才有，所以这里 EnsureDispatch 一次把它填出来。agent 那侧只拿到
        一个 int，不涉及对象，也就不需要过闸门。
        """
        progid = msg.get("progid", "")
        if not progid_allowed(progid):
            return P.err("PROGID_DENIED", f"{progid!r} 不在白名单里。")
        import win32com.client
        name = msg.get("name", "")
        self._ensure_const(progid)
        try:
            return P.ok({"value": P.val(getattr(win32com.client.constants, name))})
        except AttributeError:
            pass
        # 客户端只记得【最近一次 Dispatch 的 progid】，而常量可能来自本会话里另一个 app
        # （先开 Word 再问 xlUp）。win32com.client.constants 是所有已加载类型库的合并命名空间，
        # 所以把本会话 Dispatch 过的都填一遍再取。
        for other in list(self._dispatched):
            if other == progid:
                continue
            self._ensure_const(other)
            try:
                return P.ok({"value": P.val(getattr(win32com.client.constants, name))})
            except AttributeError:
                continue
        return P.err("CONST_NOT_FOUND",
                     f"常量 {name} 在已打开的 Office 类型库（{', '.join(sorted(self._dispatched)) or '无'}）"
                     f"里找不到。请确认拼写，或先 Dispatch 对应的 app。")

    def _ensure_const(self, progid: str) -> None:
        """把 progid 的类型库常量灌进 win32com.client.constants（早绑定生成一次即可）。"""
        if progid in self._const_ready:
            return
        import win32com.client
        # EnsureDispatch 会**再拉起一个** Office 进程（实测 Visio：取一次常量就多一个 VISIO.EXE），
        # 不记账就是一个收不掉的孤儿。走和 Dispatch 同一套记账。
        before = procs.office_pids()
        try:
            win32com.client.gencache.EnsureDispatch(progid)
        except Exception:
            logger.debug("EnsureDispatch %s 失败", progid, exc_info=True)
        else:
            self._account(before, progid)
        self._const_ready.add(progid)

    def op_ping(self, _msg: dict) -> dict:
        return P.ok({"value": P.val("pong")})

    _OPS = {
        "dispatch": op_dispatch, "get": op_get, "set": op_set, "call": op_call,
        "item": op_item, "release": op_release, "ping": op_ping, "const": op_const,
    }

    def handle(self, msg: dict) -> dict:
        op = msg.get("op")
        fn = self._OPS.get(op)
        if fn is None:
            return P.err("BAD_OP", f"未知操作 {op!r}")
        try:
            return fn(self, msg)
        except Exception as e:  # noqa: BLE001 — 报错回给 agent，它需要看见
            # 分类而不是一律 COM_ERROR：Office 自报的业务错、broker 自己的 bug、没装 Office，
            # 三者的下一步完全不同（见 errors.py）。
            f = classify_exception(e, progid=next(iter(self._dispatched), ""))
            where = f"op={op}" + (f", 成员={msg.get('name')}" if msg.get("name") else "")
            if f.code == "BROKER_ERROR":
                # 内部 bug：日志落完整 traceback，回给 agent 的消息带上 op/成员/栈尾。broker 在
                # 另一个进程里、日志在使用者的机器上，光一句异常消息定位不到任何东西。
                logger.exception("broker 内部错误（%s）", where)
                tail = trace_tail(e)
                return P.err(f.code, f"{f.message}（{where}）" + (f"\n{tail}" if tail else ""))
            logger.info("op %s 失败（%s）：[%s] %s", op, where, f.code, f.message)
            return P.err(f.code, f.message)

    def shutdown(self) -> None:
        """退出前收摊：只 Quit【自己拉起的】Office，再兜底杀掉仍活着的那些。

        只 Quit 自己拉起的这条很重要：Excel 是单实例应用，Dispatch 可能连上用户自己开着的那个，
        对它调 Quit 会把用户未保存的文档一起关掉。
        """
        # 必须在 Quit/kill 之前取：父进程一没，父子关系也就查不到了。
        # 实测 Publisher 会再拉一个 MSPUB.EXE 子进程，只收账本里那个的话子进程会留下来。
        self._owned_pids |= procs.office_descendants(self._owned_pids)
        self._write_pid_file()
        for app in self._owned_apps:
            try:
                app.Quit()
            except Exception:
                logger.debug("Quit 失败", exc_info=True)
        self.table.clear()
        self._owned_apps.clear()
        # Quit 是异步的，且文档有改动时可能被挡住（DisplayAlerts 已关，通常不会）。给一小段时间，
        # 仍活着就强杀——它已经没有界面，留着只会锁文件。
        try:
            import time

            import psutil
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                alive = [p for p in self._owned_pids if psutil.pid_exists(p)]
                if not alive:
                    break
                time.sleep(0.2)
            for pid in self._owned_pids:
                try:
                    proc = psutil.Process(pid)
                    if procs.is_office(proc.name()):
                        proc.kill()
                        logger.info("强杀未退出的 Office 进程 pid=%s", pid)
                except Exception:
                    continue
        except Exception:
            logger.debug("清理 Office 进程失败", exc_info=True)
        self._owned_pids.clear()
        self._write_pid_file()


def _watch_parent(parent_pid: int, broker: "Broker") -> None:
    """父进程（host 后端）一没就把自己也收掉。

    第一道防线是 host 那边的 kill-on-close Job（见 manager._ensure_job），这里是它建不起来时的
    兜底。少了这两层，host 一退我们就成孤儿：本进程在冻结态跑的是 app 自己的 exe，会一直锁着
    安装目录，装新版报「无法停止 IPMaster-Cowork」；抱着的 Office 也跟着留下。

    认 PID **加上出生时间**：PID 会被系统复用，只看号码会把"父进程早死了、号码被别人占了"
    误判成父进程还活着，那就永远不退。
    """
    import os as _os
    import threading
    import time

    try:
        import psutil
        born = psutil.Process(parent_pid).create_time()
    except Exception:
        logger.debug("拿不到父进程信息，看门狗不启用", exc_info=True)
        return

    def loop() -> None:
        while True:
            time.sleep(3)
            try:
                alive = psutil.Process(parent_pid).create_time() == born
            except Exception:
                alive = False
            if alive:
                continue
            logger.info("父进程 %s 已退出，broker 自行收摊", parent_pid)
            try:
                broker.shutdown()
            except Exception:
                logger.debug("收摊失败", exc_info=True)
            _os._exit(0)      # 主线程正卡在管道读上，只能硬退

    threading.Thread(target=loop, daemon=True, name="ipmc-parent-watch").start()


def serve(pipe_name: str, gate: Gate, pid_file: str | None = None,
          parent_pid: int | None = None) -> int:
    import pythoncom

    pythoncom.CoInitialize()
    broker = Broker(gate, pid_file=pid_file)
    if parent_pid:
        _watch_parent(parent_pid, broker)
    handle = pipe_mod.create_server_pipe(pipe_name)
    logger.info("broker 就绪：pipe=%s workspace=%s", pipe_name, gate.workspace)
    try:
        # 外层循环：agent 的每条 shell 命令都是一个新进程、一个新客户端。断开后回到等待，
        # **对象表不清空**，Excel 保持热着——否则每条命令都要重启一次 Office（好几秒）。
        while True:
            pipe_mod.wait_for_client(handle)
            read_exactly, write_all = pipe_mod.make_io(handle)
            stop = False
            while True:
                msg = P.read_frame(read_exactly)
                if msg is None:
                    break                     # 本次客户端断开，等下一个
                if msg.get("op") == "quit":
                    write_all(P.encode(P.ok({"value": P.val("bye")})))
                    stop = True
                    break
                write_all(P.encode(broker.handle(msg)))
            pipe_mod.disconnect_client(handle)
            if stop:
                break
    finally:
        broker.shutdown()
        try:
            import win32file
            win32file.CloseHandle(handle)
        except Exception:
            logger.debug("关管道失败", exc_info=True)
        pythoncom.CoUninitialize()
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="ipmc-office-broker")
    ap.add_argument("--pipe", required=True)
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--allow", action="append", default=[])
    ap.add_argument("--pid-file", default=None,
                    help="把本 broker 拉起的 Office PID 写到这里，供 host 在强杀后收尸")
    ap.add_argument("--parent-pid", type=int, default=None,
                    help="host 后端的 PID；它一退，broker 自己收摊（Job 之外的兜底）")
    ap.add_argument("--log-level", default="INFO")
    a = ap.parse_args(argv)
    logging.basicConfig(level=a.log_level, format="%(asctime)s %(levelname)s %(message)s")
    return serve(a.pipe, Gate(workspace=a.workspace, allowed_roots=tuple(a.allow)),
                 pid_file=a.pid_file, parent_pid=a.parent_pid)


if __name__ == "__main__":
    sys.exit(main())

"""reporting/spool 与现有实现**等价** —— 这是能安全切换的前提。

新队列不是"另写一个"，是把两处现有实现（`observability/events.emit` 的写、
`api/spool` 的取/确认）收成一份。所以测试的重点不是"新代码自洽"，而是
**同样的输入下产出与旧的一模一样**——否则切换那一刻主进程就读不到了，且不报错。
"""
from __future__ import annotations

import json

import pytest

from netlivecowork.reporting import spool


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("NLC_DATA_DIR", str(tmp_path))
    import netlivecowork.config as cfgmod
    cfgmod._settings = None
    yield tmp_path
    cfgmod._settings = None


F = "test-spool.jsonl"


def _lines(tmp_path):
    return (tmp_path / F).read_text(encoding="utf-8").splitlines()


# ── 写出来的形状 ──────────────────────────────────────────────────────────────

def test_written_shape_matches_the_historical_one(data_dir):
    """``{event_type, ts, **字段}``，一行一个 JSON。

    主进程按这个形状解析，**改了它那边就读不到**，而两边不是一起发布的。
    """
    spool.append(F, "token_usage", {"input_tokens": 3, "llm_model": "x"})
    rows = _lines(data_dir)
    assert len(rows) == 1
    obj = json.loads(rows[0])
    assert obj["event_type"] == "token_usage"
    assert obj["input_tokens"] == 3 and obj["llm_model"] == "x"
    assert isinstance(obj["ts"], str) and obj["ts"]


def test_matches_the_old_emit_byte_for_byte_except_ts(data_dir):
    """与旧实现 `observability.events.emit` 的产物逐字段一致（ts 除外）。

    切换时直接拿旧实现比对过（提交 4aa3935），旧实现随后删除，
    所以这里钉住**当时比对出来的那个形状**。改它等于改发给云端的数据形状。
    """
    fields = {"session_id": "desktop:s1:2", "input_tokens": 5, "output_tokens": 7,
              "llm_account": "DS", "llm_model": "deepseek", "中文": "值"}
    spool.append(F, "token_usage", fields)

    new = json.loads(_lines(data_dir)[0])
    new.pop("ts")
    assert new == {"event_type": "token_usage", **fields}


def test_non_ascii_is_not_escaped(data_dir):
    """中文不转义——旧实现用的是 ensure_ascii=False，转义了字节就不一致。"""
    spool.append(F, "x", {"name": "拓扑绘图"})
    assert "拓扑绘图" in _lines(data_dir)[0]


def test_unserialisable_value_does_not_lose_the_row(data_dir):
    """带不可序列化的值时退化成字符串，而不是整行丢掉。"""
    class Weird:
        def __str__(self) -> str:
            return "weird!"

    assert spool.append(F, "x", {"v": Weird()}) is True
    assert json.loads(_lines(data_dir)[0])["v"] == "weird!"


def test_append_never_raises(monkeypatch):
    """**打点绝不能影响业务。** 目录不可写时返回 False，不抛。"""
    monkeypatch.setattr(spool, "_data_dir", lambda: (_ for _ in ()).throw(OSError("boom")))
    assert spool.append(F, "x", {}) is False


# ── 取走与确认 ────────────────────────────────────────────────────────────────

def test_claim_then_ack_removes_exactly_that_batch(data_dir):
    spool.append(F, "a", {})
    spool.append(F, "b", {})

    claimed = spool.claim(F)
    assert [e["event_type"] for e in claimed["events"]] == ["a", "b"]
    # 确认之前批次仍在磁盘上 —— 这正是它比"取走即删"强的地方
    assert (data_dir / (F + ".draining")).exists()

    assert spool.ack(F, claimed["claimId"]) is True
    assert not (data_dir / (F + ".draining")).exists()


def test_ack_is_idempotent(data_dir):
    spool.append(F, "a", {})
    c = spool.claim(F)
    assert spool.ack(F, c["claimId"]) is True
    assert spool.ack(F, c["claimId"]) is True, "重复确认不该报错"


def test_ack_with_wrong_id_refuses(data_dir):
    """对不上就拒绝——那批不是调用方拿到的那批，删掉等于丢数。"""
    spool.append(F, "a", {})
    spool.claim(F)
    assert spool.ack(F, "deadbeef") is False
    assert (data_dir / (F + ".draining")).exists(), "拒绝之后批次必须还在"


def test_claim_again_before_ack_returns_the_same_batch(data_dir):
    """没确认就再取，拿到的还是同一批（调用方崩溃重来的情形）。"""
    spool.append(F, "a", {})
    first = spool.claim(F)
    second = spool.claim(F)
    assert first["claimId"] == second["claimId"]
    assert first["events"] == second["events"]


def test_appends_during_a_claim_go_to_the_next_batch(data_dir):
    """取走期间的新数据落进下一批，不会混进这一批，也不会丢。"""
    spool.append(F, "a", {})
    claimed = spool.claim(F)
    spool.append(F, "b", {})                      # 落到 rename 后新建的同名文件

    assert [e["event_type"] for e in claimed["events"]] == ["a"]
    spool.ack(F, claimed["claimId"])
    assert [e["event_type"] for e in spool.claim(F)["events"]] == ["b"]


def test_empty_spool_claims_nothing(data_dir):
    assert spool.claim(F) == {"claimId": None, "events": []}


# ── 坏数据 ────────────────────────────────────────────────────────────────────

def test_a_broken_line_does_not_take_the_batch_down(data_dir):
    """一行写坏（磁盘满、进程被半行杀掉）不该连累同批的其它行——那才是真丢数。"""
    spool.append(F, "a", {})
    with open(data_dir / F, "a", encoding="utf-8") as f:
        f.write('{"event_type": "half\n')          # 断掉的一行
    spool.append(F, "b", {})

    assert [e["event_type"] for e in spool.claim(F)["events"]] == ["a", "b"]


def test_non_object_lines_are_skipped(data_dir):
    """一行是合法 JSON 但不是对象（比如一个数字）时跳过，不让它冒充一条记录。"""
    with open(data_dir / F, "a", encoding="utf-8") as f:
        f.write("42\n")
    spool.append(F, "a", {})
    assert [e["event_type"] for e in spool.claim(F)["events"]] == ["a"]


# ── 与旧读法等价 ──────────────────────────────────────────────────────────────

def test_api_layer_delegates_instead_of_keeping_its_own_copy(data_dir):
    """接口层不许再有第二份队列实现。

    曾经它有一份完整的取走/确认/解析，与这里并存。**两份的失效方式很难查**：
    一边改了另一边没改，表现是"主进程偶尔取不到数据"，而两边各自的测试都是绿的。
    """
    from netlivecowork.api import spool as api_spool

    spool.append(F, "a", {})
    claimed = api_spool.claim_spool_file(F)
    assert [e["event_type"] for e in claimed["events"]] == ["a"]
    assert api_spool.ack_spool_claim(F, claimed["claimId"]) is True
    assert not hasattr(api_spool, "_parse_spool_bytes"), "接口层不该再自己解析"


def test_drain_takes_and_deletes(data_dir):
    """旧的取走即删仍要能用——装着旧主进程的机器还在调它。"""
    spool.append(F, "a", {})
    assert [e["event_type"] for e in spool.drain(F)] == ["a"]
    assert spool.drain(F) == []


# ── 锁 ────────────────────────────────────────────────────────────────────────

def test_the_lock_lives_with_the_queue_and_nowhere_else():
    """**全进程只能有一把锁。**

    两把的失效方式是偶发的半行 JSON：追加与"重命名接管"不互斥时，取走的那批里会有
    写了一半的行。量小时几乎撞不到，上线后才出现。

    锁与队列在同一个模块里，别处不许再定义一把——用测试钉住，不靠约定。
    """
    import threading

    from netlivecowork.api import spool as api_spool

    assert isinstance(spool.spool_lock(), type(threading.RLock()))
    assert not hasattr(api_spool, "_spool_lock"), "接口层不该再持有一把锁"

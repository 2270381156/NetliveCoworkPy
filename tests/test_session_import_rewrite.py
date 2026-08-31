"""id 重映射：列与 JSON 一致重写，sse 自增 id 丢弃。"""
import json

from netlivecowork.observability.session_import import (
    _build_id_map, _rewrite_rows,
)


def _sample():
    return {
        "sessions": [{"id": "s1", "root_agent_id": "ag1", "config_json": '{"template_id": "tpl"}'}],
        "tasks": [{"id": "t1", "session_id": "s1", "assigned_agent_id": "ag1",
                   "creator_agent_id": "ag1", "outputs_json": "null"}],
        "events": [{"id": "e1", "run_id": "r1", "session_id": "s1", "task_id": "t1",
                    "agent_id": "ag1", "causation_id": None,
                    "payload_json": json.dumps({"task_id": "t1", "note": "hi"}),
                    "metadata_json": "{}"}],
        "memory_events": [], "memory_subscriptions": [],
        "session_sse_events": [{"id": 7, "session_id": "s1",
                                "event_json": json.dumps({"type": "task_created",
                                                          "task": {"id": "t1", "session_id": "s1"}})}],
        "snapshots": [{"id": "snp1", "session_id": "s1", "last_event_id": "e1",
                       "state_blob_json": "{}"}],
    }


def test_build_id_map_covers_all_ids():
    m = _build_id_map(_sample())
    for old in ("s1", "ag1", "t1", "r1", "snp1"):
        assert m[old].startswith("imp_")
    # 事件 id 保序重映射为 evt_ 前缀（0fbad8d：与续跑追加的新事件同前缀可比、时间轴衔接）
    assert m["e1"].startswith("evt_")
    # 自增整数 id 不进 map
    assert 7 not in m


def test_rewrite_columns_and_json_consistent():
    c = _sample()
    m = _build_id_map(c)
    _rewrite_rows(c, m)
    # 列重写
    assert c["sessions"][0]["id"] == m["s1"]
    assert c["tasks"][0]["session_id"] == m["s1"]
    assert c["events"][0]["task_id"] == m["t1"]
    # JSON 内嵌 id 重写、与 tasks 表 id 一致
    ev = json.loads(c["session_sse_events"][0]["event_json"])
    assert ev["task"]["id"] == m["t1"] == c["tasks"][0]["id"]
    pl = json.loads(c["events"][0]["payload_json"])
    assert pl["task_id"] == m["t1"]
    assert pl["note"] == "hi"  # 非 id 文本不动
    # sse 自增主键丢弃
    assert "id" not in c["session_sse_events"][0]
    # None / 非 JSON 安全
    assert c["events"][0]["causation_id"] is None

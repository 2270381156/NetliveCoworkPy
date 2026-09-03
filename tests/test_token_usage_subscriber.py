"""token 用量的**映射**：一次用量 → 一条运营记录该长什么样。

产出侧（真的落进主进程要读的那个文件、与切换前逐字段一致）在
`test_reporting_subscribers_equivalence.py`。这里只钉映射本身。
"""
from netlivecowork.observability import token_usage_subscriber as subscriber


def test_report_token_usage_does_not_emit_legacy_project_or_task_fields(monkeypatch) -> None:
    """字段集必须**恰好**是这几个。

    多一个字段的后果不是报错：主进程按字段名把内容转给云端，多出来的会一路传到对端，
    而对端字段是有约定的。历史上的 project_id / task_id 就是这么被去掉的，别让它们回来。
    """
    recorded: list[tuple[str, dict, dict]] = []
    monkeypatch.setattr(
        subscriber,
        "record",
        lambda kind, payload, **kw: recorded.append((kind, payload, kw)),
    )
    monkeypatch.setattr(subscriber, "_notify", lambda: None)

    subscriber.report_token_usage(
        session_id="session-1",
        turn_seq=2,
        prompt_tokens=12,
        completion_tokens=3,
        llm_account="account-a",
        llm_model="model-a",
    )

    assert len(recorded) == 1
    kind, payload, kw = recorded[0]
    assert kind == "token_usage"
    assert payload == {
        "session_id": "desktop:session-1:2",
        "cowork": "",
        "input_tokens": 12,
        "output_tokens": 3,
        "llm_account": "account-a",
        "llm_model": "model-a",
    }
    assert "project_id" not in payload
    assert "task_id" not in payload
    # 出口与文件名不再由这一层决定，已挪进路由表（reporting/defaults.py）
    assert "spool_file" not in payload


def test_raw_session_id_goes_to_the_label_lookup_not_the_payload(monkeypatch) -> None:
    """载荷里的 session_id 是**拼出来的上报标识**，归属查的是**原始会话 id**。

    两者混用的话，等 cowork 那块接上时会拿着 `desktop:xxx:3` 去查归属表，永远查不到——
    而查不到只是归属为空，不报错，最后表现为"这批数据没有归属"。
    """
    recorded: list[tuple[str, dict, dict]] = []
    monkeypatch.setattr(
        subscriber,
        "record",
        lambda kind, payload, **kw: recorded.append((kind, payload, kw)),
    )
    monkeypatch.setattr(subscriber, "_notify", lambda: None)

    subscriber.report_token_usage(
        session_id="session-1", turn_seq=2, prompt_tokens=1, completion_tokens=1,
        llm_account="a", llm_model="m",
    )

    _, payload, kw = recorded[0]
    assert payload["session_id"] == "desktop:session-1:2"
    assert kw["session_id"] == "session-1"

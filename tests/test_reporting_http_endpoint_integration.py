"""真实生产路径：订阅者写 → **主进程走 HTTP 端点来取**。

前面那些等价测试是"写进去、再用新模块读出来"，而生产上读的是另一头：
Electron 调 `/internal/token-usage-spool/claim`，那个端点用的是 `api/spool.py` 里的实现。

**两边现在是两份实现**（第 3、4 步才会收敛），所以"新写的东西旧端点读得到"这件事
必须单独验——它是整条链路真正的接缝，而断了不报错：主进程只会拿到空批次，
表现为"用量不涨"，没人会立刻联想到是打点改动。
"""
from __future__ import annotations

import pytest

from netlivecowork.api import spool as api_spool
from netlivecowork.reporting import defaults, record as rec, sinks


@pytest.fixture(autouse=True)
def clean(tmp_path, monkeypatch):
    monkeypatch.setenv("NLC_DATA_DIR", str(tmp_path))
    import netlivecowork.config as cfgmod
    cfgmod._settings = None
    sinks.reset()
    rec.reset()
    yield tmp_path
    sinks.reset()
    rec.reset()
    cfgmod._settings = None


def _report_one(**kw):
    from netlivecowork.observability.token_usage_subscriber import report_token_usage
    defaults_kw = dict(session_id="s1", turn_seq=1, prompt_tokens=3,
                       completion_tokens=4, llm_account="DS", llm_model="m")
    report_token_usage(**{**defaults_kw, **kw})


def test_the_http_claim_endpoint_sees_what_the_subscriber_wrote(clean):
    """整条链路：订阅者 → 路由 → 出口 → 文件 → HTTP 端点。"""
    _report_one()

    claimed = api_spool.claim_token_usage_spool()
    assert claimed["claimId"] is not None
    assert len(claimed["events"]) == 1
    ev = claimed["events"][0]
    assert ev["event_type"] == "token_usage"
    assert ev["session_id"] == "desktop:s1:1"
    assert ev["input_tokens"] == 3 and ev["output_tokens"] == 4


def test_ack_through_the_http_endpoint_clears_the_batch(clean):
    _report_one()
    claimed = api_spool.claim_token_usage_spool()
    assert api_spool.ack_token_usage_spool(claimed["claimId"]) == {"acked": True}
    assert api_spool.claim_token_usage_spool()["events"] == []


def test_ack_with_a_stale_id_is_refused(clean):
    """对不上就 409。删掉不属于这次的批次等于丢数。"""
    from fastapi import HTTPException

    _report_one()
    api_spool.claim_token_usage_spool()
    with pytest.raises(HTTPException) as e:
        api_spool.ack_token_usage_spool("deadbeef")
    assert e.value.status_code == 409


def test_the_legacy_drain_endpoint_also_still_works(clean):
    """装着旧主进程的机器走的是取走即删那条，不能因为这次改动断掉。"""
    _report_one()
    events = api_spool.drain_token_usage_spool()
    assert [e["event_type"] for e in events] == ["token_usage"]
    assert api_spool.drain_token_usage_spool() == []


def test_several_reports_come_back_in_order(clean):
    for i in range(3):
        _report_one(turn_seq=i, prompt_tokens=i + 1)
    events = api_spool.claim_token_usage_spool()["events"]
    assert [e["input_tokens"] for e in events] == [1, 2, 3]


def test_a_report_written_during_a_claim_lands_in_the_next_batch(clean):
    """取走期间产生的新用量不会丢，也不会混进已取走的那批。"""
    _report_one(turn_seq=1)
    first = api_spool.claim_token_usage_spool()
    _report_one(turn_seq=2)

    assert [e["session_id"] for e in first["events"]] == ["desktop:s1:1"]
    api_spool.ack_token_usage_spool(first["claimId"])
    assert [e["session_id"] for e in api_spool.claim_token_usage_spool()["events"]] \
        == ["desktop:s1:2"]

"""Durable claim/ack hand-off for desktop token-usage batches."""

from __future__ import annotations

import json

from netlivecowork.api import spool
from netlivecowork.reporting import spool as _queue


SPOOL = "token-usage-spool.jsonl"


def _write(path, *session_ids: str) -> None:
    records = [
        {"session_id": value, "ts": "2026-07-13T08:00:01Z"}
        for value in session_ids
    ]
    path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")


def test_claim_keeps_batch_until_matching_ack(tmp_path, monkeypatch):
    monkeypatch.setattr(_queue, "_data_dir", lambda: tmp_path)
    source = tmp_path / SPOOL
    draining = tmp_path / f"{SPOOL}.draining"
    _write(source, "old-1", "old-2")

    claim = spool.claim_spool_file(SPOOL)

    assert [event["session_id"] for event in claim["events"]] == ["old-1", "old-2"]
    assert claim["claimId"]
    assert not source.exists()
    assert draining.exists()
    assert spool.ack_spool_claim(SPOOL, "wrong-claim") is False
    assert draining.exists()
    assert spool.ack_spool_claim(SPOOL, claim["claimId"]) is True
    assert not draining.exists()
    assert spool.ack_spool_claim(SPOOL, claim["claimId"]) is True


def test_unacked_claim_is_stable_and_new_appends_wait_for_next_claim(tmp_path, monkeypatch):
    monkeypatch.setattr(_queue, "_data_dir", lambda: tmp_path)
    source = tmp_path / SPOOL
    _write(source, "first")

    first = spool.claim_spool_file(SPOOL)
    _write(source, "second")  # append after rename belongs to the next batch
    replay = spool.claim_spool_file(SPOOL)

    assert replay == first
    assert source.exists()
    assert spool.ack_spool_claim(SPOOL, first["claimId"]) is True

    second = spool.claim_spool_file(SPOOL)
    assert [event["session_id"] for event in second["events"]] == ["second"]
    assert second["claimId"] != first["claimId"]


def test_legacy_destructive_drain_still_works(tmp_path, monkeypatch):
    monkeypatch.setattr(_queue, "_data_dir", lambda: tmp_path)
    source = tmp_path / SPOOL
    _write(source, "legacy")

    assert [event["session_id"] for event in spool.drain_spool_file(SPOOL)] == ["legacy"]
    assert not source.exists()
    assert not (tmp_path / f"{SPOOL}.draining").exists()

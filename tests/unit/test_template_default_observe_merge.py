"""resolver：无 observe facet 的模板经 merge_default_facets 借 default 的 observe（ROLE）。"""
from __future__ import annotations

from types import SimpleNamespace

from ctx_weft.providers.agent_template_local import (
    merge_default_facets, DEFAULT_MERGE_PURPOSES,
)


def _facet(t): return SimpleNamespace(text=t, style="")


def test_observe_in_default_merge_purposes():
    assert "observe" in DEFAULT_MERGE_PURPOSES


def test_merge_fills_missing_observe_from_default():
    tpl = SimpleNamespace(id="planner", identity={"act": _facet("PLANNER-SOUL")})
    default = SimpleNamespace(id="default", identity={
        "act": _facet("D-SOUL"), "observe": _facet("D-ROLE"),
        "compact": _facet("D-COMPACT"), "recognize_intent": _facet("D-META")})
    merge_default_facets(tpl, default, DEFAULT_MERGE_PURPOSES)
    assert tpl.identity["observe"].text == "D-ROLE"


def test_merge_does_not_override_existing_observe():
    tpl = SimpleNamespace(id="x", identity={"act": _facet("S"), "observe": _facet("OWN-ROLE")})
    default = SimpleNamespace(id="default", identity={"observe": _facet("D-ROLE")})
    merge_default_facets(tpl, default, DEFAULT_MERGE_PURPOSES)
    assert tpl.identity["observe"].text == "OWN-ROLE"

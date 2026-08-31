from ctx_weft.providers.agent_template_local import TemplateLoader


def _soul(d):
    (d / "SOUL.md").write_text("---\nname: x\nversion: 1.0.0\n---\nact soul", encoding="utf-8")


def test_loads_compact_and_metadata_facets(tmp_path):
    d = tmp_path / "agt"
    d.mkdir()
    _soul(d)
    (d / "COMPACT.md").write_text("compact persona", encoding="utf-8")
    (d / "METADATA.md").write_text("metadata persona", encoding="utf-8")

    t = TemplateLoader().load(d)

    assert t.identity["act"].text == "act soul"
    assert t.identity["compact"].text == "compact persona"
    assert t.identity["recognize_intent"].text == "metadata persona"


def test_missing_facet_files_yield_no_facet(tmp_path):
    d = tmp_path / "agt"
    d.mkdir()
    _soul(d)

    t = TemplateLoader().load(d)

    assert "compact" not in t.identity
    assert "recognize_intent" not in t.identity


def test_facet_file_with_frontmatter_uses_body_only(tmp_path):
    d = tmp_path / "agt"
    d.mkdir()
    _soul(d)
    (d / "COMPACT.md").write_text("---\nfoo: bar\n---\njust the body", encoding="utf-8")

    t = TemplateLoader().load(d)

    assert t.identity["compact"].text == "just the body"


def test_default_template_dir_has_compact_and_metadata_facets():
    from pathlib import Path
    default_dir = Path(__file__).resolve().parents[1] / "resources" / "agents" / "default"
    t = TemplateLoader().load(default_dir)
    assert t.identity["compact"].text.strip()
    assert t.identity["recognize_intent"].text.strip()

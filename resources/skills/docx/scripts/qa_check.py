#!/usr/bin/env python3
"""Programmatic QA for a .docx — no LibreOffice required.

Function: content + structure sanity checks (leftover placeholders, heading
          styles, table shapes & empty cells, image count). Task-specific
          checks (is the *expected* content present?) are passed via --expect.
Usage:    python scripts/qa_check.py <file.docx> [--expect "substring" ...]
Output:   a human-readable report; exits non-zero if blocking issues are found
          (leftover placeholders, or any --expect string missing).
"""
import argparse
import re
import sys

from docx import Document

BLOCKING = re.compile(r"(?i)(x{4,}|lorem|ipsum|\btodo\b|\btbd\b|click to edit|placeholder)")
BRACKET = re.compile(r"\[[^\]]{1,40}\]")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("docx")
    ap.add_argument("--expect", action="append", default=[])
    args = ap.parse_args()

    doc = Document(args.docx)
    parts = [p.text for p in doc.paragraphs]
    for tbl in doc.tables:
        for row in tbl.rows:
            parts.append(" | ".join(c.text for c in row.cells))
    text = "\n".join(parts)

    issues, warns = [], []

    headings = [p.text for p in doc.paragraphs if p.style.name.startswith("Heading")]
    print(f"paragraphs: {len(doc.paragraphs)}  tables: {len(doc.tables)}  inline images: {len(doc.inline_shapes)}")
    print(f"headings ({len(headings)}): {headings}")

    if not headings:
        warns.append("no Heading-styled paragraphs found (a TOC won't pick anything up)")

    # content-width allowance = widest section's printable width (page minus L/R margins)
    sections = doc.sections
    content_w = max((s.page_width - s.left_margin - s.right_margin) for s in sections) if sections else None

    for i, tbl in enumerate(doc.tables):
        empties = [(r, c) for r, row in enumerate(tbl.rows)
                   for c, cell in enumerate(row.cells) if not cell.text.strip()]
        print(f"table {i}: {len(tbl.rows)}x{len(tbl.columns)}" + (f"  empty cells: {empties}" if empties else ""))
        if empties:
            warns.append(f"table {i} has empty cells: {empties}")
        # weak layout checks: autofit on (renders inconsistently), and width overflow
        if tbl.autofit:
            warns.append(f"table {i}: autofit is on — set table.autofit=False (+ explicit column/cell widths) for consistent rendering")
        widths = [col.width for col in tbl.columns]
        if all(w is not None for w in widths) and content_w is not None and sum(widths) > content_w * 1.02:
            warns.append(f"table {i}: total column width {sum(widths) / 914400:.2f}in exceeds page content width {content_w / 914400:.2f}in (table may overflow the page)")

    # weak font-size sanity: flag explicitly-set run sizes that are unreadable or absurd
    runs = [r for p in doc.paragraphs for r in p.runs]
    for tbl in doc.tables:
        for row in tbl.rows:
            for cell in row.cells:
                for p in cell.paragraphs:
                    runs.extend(p.runs)
    bad_sizes = sorted({round(r.font.size.pt, 1) for r in runs
                        if r.font.size is not None and (r.font.size.pt < 5 or r.font.size.pt > 100)})
    if bad_sizes:
        warns.append(f"unusual font size(s) in pt: {bad_sizes} — <5pt is unreadable, >100pt is likely a mistake; verify")

    blocking_hits = sorted(set(m.group(0) for m in BLOCKING.finditer(text)))
    if blocking_hits:
        issues.append(f"leftover placeholder text: {blocking_hits}")
    bracket_hits = sorted(set(BRACKET.findall(text)))
    if bracket_hits:
        warns.append(f"bracketed text (possible placeholders, verify): {bracket_hits[:10]}")

    for exp in args.expect:
        if exp not in text:
            issues.append(f"expected text not found: {exp!r}")

    for w in warns:
        print("WARN:", w)
    for it in issues:
        print("FAIL:", it)
    print("RESULT:", "FAIL" if issues else "PASS")
    sys.exit(1 if issues else 0)


if __name__ == "__main__":
    main()

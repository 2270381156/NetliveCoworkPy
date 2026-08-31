#!/usr/bin/env python3
"""Programmatic QA for a PDF — no LibreOffice required.

Function: structural/content sanity checks on a PDF (page count, extractable
          text, leftover placeholders, empty pages). Task-specific checks
          (is the *expected* content present?) are passed via --expect.
Usage:    python scripts/qa_check.py <file.pdf> [--expect "substring" ...]
Output:   a human-readable report; exits non-zero if blocking issues are found
          (leftover placeholders, or any --expect string missing).
"""
import argparse
import re
import sys

from pypdf import PdfReader

BLOCKING = re.compile(r"(?i)(x{4,}|lorem|ipsum|\btodo\b|\btbd\b|click to edit|placeholder|this .{0,20}(page|slide).{0,20}layout)")
BRACKET = re.compile(r"\[[^\]]{1,40}\]")


def layout_check(path):
    """Geometric overflow check: flag characters that fall outside the page box
    (text cut off / running off the page). Pure Python via pdfplumber.
    Returns a list of warning strings, or None if pdfplumber isn't installed.
    """
    try:
        import pdfplumber
    except ImportError:
        return None
    warns = []
    with pdfplumber.open(path) as pdf:
        for pi, page in enumerate(pdf.pages, 1):
            w, h = page.width, page.height
            off = [c for c in page.chars
                   if c["x0"] < -1 or c["x1"] > w + 1 or c["top"] < -1 or c["bottom"] > h + 1]
            if off:
                sample = "".join(c["text"] for c in off[:20]).strip()
                warns.append(f"page {pi}: {len(off)} char(s) fall outside the page box "
                             f"(text cut off / off-page) e.g. {sample!r}")
    return warns


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--expect", action="append", default=[], help="substring that must appear (repeatable)")
    args = ap.parse_args()

    reader = PdfReader(args.pdf)
    pages = reader.pages
    full = []
    empty_pages = []
    for i, p in enumerate(pages, 1):
        t = p.extract_text() or ""
        full.append(t)
        if not t.strip():
            empty_pages.append(i)
    text = "\n".join(full)

    issues, warns = [], []
    print(f"pages: {len(pages)}")
    print(f"extracted chars: {len(text)}")

    if empty_pages:
        warns.append(f"pages with no extractable text (scanned or empty?): {empty_pages}")

    blocking_hits = sorted(set(m.group(0) for m in BLOCKING.finditer(text)))
    if blocking_hits:
        issues.append(f"leftover placeholder text: {blocking_hits}")
    bracket_hits = sorted(set(BRACKET.findall(text)))
    if bracket_hits:
        warns.append(f"bracketed text (possible placeholders, verify): {bracket_hits[:10]}")

    for exp in args.expect:
        if exp not in text:
            issues.append(f"expected text not found: {exp!r}")

    layout = layout_check(args.pdf)
    if layout is None:
        print("NOTE: install pdfplumber for the off-page/overflow layout check (pip install pdfplumber)")
    else:
        warns.extend(layout)

    for w in warns:
        print("WARN:", w)
    for it in issues:
        print("FAIL:", it)

    print("RESULT:", "FAIL" if issues else "PASS")
    sys.exit(1 if issues else 0)


if __name__ == "__main__":
    main()

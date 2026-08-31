#!/usr/bin/env python3
"""Programmatic QA for a .pptx — no LibreOffice required.

Function: content + structure sanity checks per slide (leftover placeholders,
          whether each slide has a visual element, empty text boxes, very long
          text that may overflow). Task-specific checks (is the *expected*
          content present?) are passed via --expect.
Usage:    python scripts/qa_check.py <file.pptx> [--expect "substring" ...]
Output:   a human-readable report; exits non-zero if blocking issues are found
          (leftover placeholders, or any --expect string missing).
"""
import argparse
import re
import sys

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

BLOCKING = re.compile(r"(?i)(x{4,}|lorem|ipsum|\btodo\b|\btbd\b|click to edit|placeholder|this .{0,20}(slide|layout))")
VISUAL = {MSO_SHAPE_TYPE.PICTURE, MSO_SHAPE_TYPE.AUTO_SHAPE, MSO_SHAPE_TYPE.CHART,
          MSO_SHAPE_TYPE.TABLE, MSO_SHAPE_TYPE.GROUP, MSO_SHAPE_TYPE.FREEFORM}


def _bbox(s):
    if None in (s.left, s.top, s.width, s.height):
        return None
    return (s.left, s.top, s.left + s.width, s.top + s.height)


def _overlap(a, b):
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pptx")
    ap.add_argument("--expect", action="append", default=[])
    args = ap.parse_args()

    prs = Presentation(args.pptx)
    slides = list(prs.slides)
    SW, SH = prs.slide_width, prs.slide_height
    tol = int(0.01 * SW)  # ~1% slack before calling something off-slide
    print(f"slides: {len(slides)}")

    all_text = []
    issues, warns = [], []
    for i, slide in enumerate(slides, 1):
        texts = [s.text_frame.text for s in slide.shapes if s.has_text_frame and s.text_frame.text.strip()]
        for s in slide.shapes:               # tables/charts aren't text_frames — pull their text too
            if getattr(s, "has_table", False):
                texts += [c.text for row in s.table.rows for c in row.cells if c.text.strip()]
            elif getattr(s, "has_chart", False) and s.chart.has_title:
                texts.append(s.chart.chart_title.text_frame.text)
        all_text.extend(texts)
        visuals = [s for s in slide.shapes if s.shape_type in VISUAL]
        empty = [s.shape_id for s in slide.shapes
                 if s.shape_type == MSO_SHAPE_TYPE.TEXT_BOX and not s.text_frame.text.strip()]
        overflow = [t[:25] for t in texts if len(t) > 350]
        # geometric checks (pure Python via absolute coords)
        offslide, tboxes = [], []
        for s in slide.shapes:
            bb = _bbox(s)
            if bb is None:
                continue
            beyond = bb[0] < -tol or bb[1] < -tol or bb[2] > SW + tol or bb[3] > SH + tol
            full_bleed = (min(bb[2], SW) - max(bb[0], 0) >= 0.95 * SW
                          and min(bb[3], SH) - max(bb[1], 0) >= 0.95 * SH)
            if beyond and not full_bleed:
                offslide.append(s.shape_id)
            if s.shape_type == MSO_SHAPE_TYPE.TEXT_BOX and s.has_text_frame and s.text_frame.text.strip():
                tboxes.append((s.shape_id, bb))
        collisions = [(tboxes[a][0], tboxes[b][0])
                      for a in range(len(tboxes)) for b in range(a + 1, len(tboxes))
                      if _overlap(tboxes[a][1], tboxes[b][1])]
        print(f"slide {i}: text={len(texts)} visuals={len(visuals)} empty_text={empty} "
              f"maybe_overflow={overflow} off_slide={offslide} text_collisions={collisions}")
        if not visuals:
            warns.append(f"slide {i} has no visual element (text-only — design guidance wants a visual)")
        if empty:
            warns.append(f"slide {i} has empty text boxes: {empty}")
        if overflow:
            warns.append(f"slide {i} has very long text (check for overflow): {overflow}")
        if offslide:
            warns.append(f"slide {i}: shape(s) {offslide} extend past the slide edge (cut off?)")
        if collisions:
            warns.append(f"slide {i}: overlapping text boxes {collisions} (collision?)")

    text = "\n".join(all_text)
    blocking_hits = sorted(set(m.group(0) for m in BLOCKING.finditer(text)))
    if blocking_hits:
        issues.append(f"leftover placeholder text: {blocking_hits}")
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

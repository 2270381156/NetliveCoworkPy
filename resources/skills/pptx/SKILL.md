---
name: pptx
description: "Use this skill when the user needs to create, edit, or understand the content of a PowerPoint presentation (.pptx): building a deck from scratch or from a template; adding, removing, reordering, or restyling slides; working with layouts, speaker notes, or comments; extracting text or structure from a deck; QA-checking a deck you just produced. Do NOT use this skill for operations that do not require understanding or changing slide content: converting a deck to PDF or images, renaming, copying, moving, or inspecting the file are one-line shell operations - do them directly and stop. In particular, 'save this deck as PDF' is a format conversion, not a presentation task: run `soffice --headless --convert-to pdf <file>` and you are done; do not open the deck, review its content, or touch its images."
license: Proprietary. LICENSE.txt has complete terms
---

# PPTX Skill

## Before you go further: is this a content task?

If the request is pure **format conversion** or **file management**, this skill is the wrong
tool. Run the one-liner, report the output path, and stop.

| Request | Do this, then stop |
|---------|--------------------|
| Save / export the deck as PDF | `python scripts/office/soffice.py --headless --convert-to pdf presentation.pptx` |
| Export slides as images | The PDF command above, then `pdftoppm -jpeg -r 150 presentation.pdf slide` |
| Rename / copy / move / inspect the file | Plain shell commands |

For these, do **not** extract the text, do **not** run QA, and do **not** touch images, themes,
or layouts. The user asked for the same deck in a different container — any change to its
content is a defect, not an improvement.

Everything below (including the QA workflow) applies **only** to decks you created or edited in
this session.

---

## Quick Reference

| Task | Guide |
|------|-------|
| Read/analyze content | `python -m markitdown presentation.pptx` |
| Edit or create from template | Read [editing.md](editing.md) |
| Create from scratch | Read [creating.md](creating.md) |

---

## Reading Content

```bash
# Text extraction
python -m markitdown presentation.pptx

# Text overview (pure Python — no external tools)
python -m markitdown presentation.pptx

# Visual overview (optional — needs LibreOffice + Poppler)
python scripts/thumbnail.py presentation.pptx

# Raw XML
python scripts/office/unpack.py presentation.pptx unpacked/
```

---

## Editing Workflow

**Read [editing.md](editing.md) for full details.**

1. Analyze template with `thumbnail.py`
2. Unpack → manipulate slides → edit content → clean → pack

---

## Creating from Scratch

**Read [creating.md](creating.md) for full details.**

Use when no template or reference presentation is available.

For decks with many slides, build them in batches (reopen → add slides → save) instead of one giant script — see **"Large Decks — Build Slides in Batches"** in creating.md.

---

## Design Ideas

**Don't create boring slides.** Plain bullets on a white background won't impress anyone. Consider ideas from this list for each slide.

### Before Starting

- **Pick a bold, content-informed color palette**: The palette should feel designed for THIS topic. If swapping your colors into a completely different presentation would still "work," you haven't made specific enough choices.
- **Dominance over equality**: One color should dominate (60-70% visual weight), with 1-2 supporting tones and one sharp accent. Never give all colors equal weight.
- **Dark/light contrast**: Dark backgrounds for title + conclusion slides, light for content ("sandwich" structure). Or commit to dark throughout for a premium feel.
- **Commit to a visual motif**: Pick ONE distinctive element and repeat it — rounded image frames, icons in colored circles, thick single-side borders. Carry it across every slide.

### Color Palettes

Choose colors that match your topic — don't default to generic blue. Use these palettes as inspiration:

| Theme | Primary | Secondary | Accent |
|-------|---------|-----------|--------|
| **Midnight Executive** | `1E2761` (navy) | `CADCFC` (ice blue) | `FFFFFF` (white) |
| **Forest & Moss** | `2C5F2D` (forest) | `97BC62` (moss) | `F5F5F5` (cream) |
| **Coral Energy** | `F96167` (coral) | `F9E795` (gold) | `2F3C7E` (navy) |
| **Warm Terracotta** | `B85042` (terracotta) | `E7E8D1` (sand) | `A7BEAE` (sage) |
| **Ocean Gradient** | `065A82` (deep blue) | `1C7293` (teal) | `21295C` (midnight) |
| **Charcoal Minimal** | `36454F` (charcoal) | `F2F2F2` (off-white) | `212121` (black) |
| **Teal Trust** | `028090` (teal) | `00A896` (seafoam) | `02C39A` (mint) |
| **Berry & Cream** | `6D2E46` (berry) | `A26769` (dusty rose) | `ECE2D0` (cream) |
| **Sage Calm** | `84B59F` (sage) | `69A297` (eucalyptus) | `50808E` (slate) |
| **Cherry Bold** | `990011` (cherry) | `FCF6F5` (off-white) | `2F3C7E` (navy) |

### For Each Slide

**Every slide needs a visual element** — image, chart, icon, or shape. Text-only slides are forgettable.

> **Source visuals offline.** This environment has **no internet access** — do not search the web or
> download images (no `requests`/`urllib`/`curl`/`wget`). Use only image files the user supplied.
> When none are available, build the visual locally: charts (`add_chart`), shapes/diagrams
> (`add_shape`), icons (rasterized SVG via `cairosvg`, drawn shapes, or emoji glyphs), and
> solid- or gradient-color backgrounds you generate with Pillow. See [creating.md](creating.md).

**Layout options:**
- Two-column (text left, illustration on right)
- Icon + text rows (icon in colored circle, bold header, description below)
- 2x2 or 2x3 grid (image on one side, grid of content blocks on other)
- Half-bleed image (full left or right side) with content overlay

**Data display:**
- Large stat callouts (big numbers 60-72pt with small labels below)
- Comparison columns (before/after, pros/cons, side-by-side options)
- Timeline or process flow (numbered steps, arrows)

**Visual polish:**
- Icons in small colored circles next to section headers
- Italic accent text for key stats or taglines

### Typography

**Choose an interesting font pairing** — don't default to Arial. Pick a header font with personality and pair it with a clean body font.

| Header Font | Body Font |
|-------------|-----------|
| Georgia | Calibri |
| Arial Black | Arial |
| Calibri | Calibri Light |
| Cambria | Calibri |
| Trebuchet MS | Calibri |
| Impact | Arial |
| Palatino | Garamond |
| Consolas | Calibri |

| Element | Size |
|---------|------|
| Slide title | 36-44pt bold |
| Section header | 20-24pt bold |
| Body text | 14-16pt |
| Captions | 10-12pt muted |

### Spacing

- 0.5" minimum margins
- 0.3-0.5" between content blocks
- Leave breathing room—don't fill every inch

### Avoid (Common Mistakes)

- **Don't repeat the same layout** — vary columns, cards, and callouts across slides
- **Don't center body text** — left-align paragraphs and lists; center only titles
- **Don't skimp on size contrast** — titles need 36pt+ to stand out from 14-16pt body
- **Don't default to blue** — pick colors that reflect the specific topic
- **Don't mix spacing randomly** — choose 0.3" or 0.5" gaps and use consistently
- **Don't style one slide and leave the rest plain** — commit fully or keep it simple throughout
- **Don't create text-only slides** — add images, icons, charts, or visual elements; avoid plain title + bullets
- **Don't forget text box padding** — when aligning lines or shapes with text edges, set `margin: 0` on the text box or offset the shape to account for padding
- **Don't use low-contrast elements** — icons AND text need strong contrast against the background; avoid light text on light backgrounds or dark text on dark backgrounds
- **NEVER use accent lines under titles** — these are a hallmark of AI-generated slides; use whitespace or background color instead

---

## QA (Required)

**Assume there are problems. Your job is to find them.** Approach QA as a bug hunt, not a confirmation step. The required checks below are **programmatic and need no LibreOffice**; a rendered visual pass is an optional bonus on top, never a dependency.

**Fastest path — run the bundled QA script** (does the programmatic checks below in one shot, no LibreOffice):

```bash
python scripts/qa_check.py output.pptx --expect "a value you put in"
```

It reports per-slide text/visual counts and flags text-only slides, empty text boxes, possible overflow, leftover placeholders (including inside tables), and — using the shapes' absolute coordinates — **elements that run off the slide edge and overlapping text boxes**. It exits non-zero on blocking problems (placeholders, or any `--expect` string missing); the geometric findings are advisory WARNs.

**The script is not the whole QA.** It only covers generic, mechanical checks — it cannot tell whether the *content is correct*. A `PASS` is necessary, not sufficient. You must still verify the task-specific things yourself: that each slide has the intended content, the deck covers every required point in the right order, and the design matches the ask. The subsections below explain the checks and how to verify by hand.

### Content QA

Extract every slide's text and read it back — check for missing content, typos, wrong order. Use whichever extractor is installed:

```bash
python -m markitdown output.pptx        # needs the pptx extra: pip install "markitdown[pptx]"
```

If markitdown (with the pptx extra) isn't available, extract with python-pptx — no extra dependencies:

```python
from pptx import Presentation
prs = Presentation("output.pptx")
for i, slide in enumerate(prs.slides, 1):
    print(f"--- slide {i} ---")
    for shp in slide.shapes:
        if shp.has_text_frame and shp.text_frame.text.strip():
            print(shp.text_frame.text)
        elif getattr(shp, "has_table", False):              # tables aren't text frames
            for row in shp.table.rows:
                print(" | ".join(c.text for c in row.cells))
```

Scan the extracted text for leftover placeholders (`xxxx`, `lorem`, `ipsum`, `click to edit`, `this … layout`). **Don't pipe an extractor straight to grep with errors silenced (`2>/dev/null`)** — if it fails, grep sees nothing and the deck looks "clean" when it wasn't; confirm you actually got the slide text first.

### Structural QA

Check the deck's structure with python-pptx — no rendering required:

```python
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
VISUAL = {MSO_SHAPE_TYPE.PICTURE, MSO_SHAPE_TYPE.AUTO_SHAPE, MSO_SHAPE_TYPE.CHART,
          MSO_SHAPE_TYPE.TABLE, MSO_SHAPE_TYPE.GROUP, MSO_SHAPE_TYPE.FREEFORM}
prs = Presentation("output.pptx")
print("slides:", len(prs.slides))
for i, slide in enumerate(prs.slides, 1):
    texts   = [s.text_frame.text for s in slide.shapes if s.has_text_frame and s.text_frame.text.strip()]
    visuals = [s for s in slide.shapes if s.shape_type in VISUAL]
    empty   = [s.shape_id for s in slide.shapes if s.has_text_frame and not s.text_frame.text.strip()]
    overflow = [t[:25] for t in texts if len(t) > 350]      # very long → likely overflow, check it
    print(f"slide {i}: text={len(texts)} visuals={len(visuals)} empty_text={empty} maybe_overflow={overflow}")
```

Confirm: the slide count is right; **every content slide has a visual element** (the design guidance requires it — flag `visuals=0` slides as text-only); no empty text boxes were left behind; and look at any `maybe_overflow` block. python-pptx can't measure pixel layout, so treat long text and tight boxes as *candidates* to inspect, not proof.

### Optional visual pass — never required

Programmatic checks can't see pixel-level problems (overlap, true overflow, low contrast). If (and only if) LibreOffice and Poppler are installed, you *may* render slides to images and have a subagent with fresh eyes inspect them — but QA must pass on the programmatic checks above without it. To render, see [Converting to Images](#converting-to-images), then use this prompt:

```
Visually inspect these slides. Assume there are issues — find them.

Look for:
- Overlapping elements (text through shapes, lines through words, stacked elements)
- Text overflow or cut off at edges/box boundaries
- Decorative lines positioned for single-line text but title wrapped to two lines
- Source citations or footers colliding with content above
- Elements too close (< 0.3" gaps) or cards/sections nearly touching
- Uneven gaps (large empty area in one place, cramped in another)
- Insufficient margin from slide edges (< 0.5")
- Columns or similar elements not aligned consistently
- Low-contrast text or icons against the background
- Text boxes too narrow causing excessive wrapping
- Leftover placeholder content

For each slide, list issues or areas of concern, even if minor.

Read and analyze these images:
1. /path/to/slide-01.jpg (Expected: [brief description])
2. /path/to/slide-02.jpg (Expected: [brief description])

Report ALL issues found, including minor ones.
```

### Verification Loop

1. Generate → content QA → structural QA (→ optional render + inspect if those tools are present)
2. **List issues found** (if none, look again more critically)
3. Fix issues
4. **Re-run the checks** — one fix often creates another problem
5. Repeat until a full pass reveals no new issues

**Do not declare success until you've completed at least one fix-and-verify cycle.**

---

## Converting to Images (optional — requires LibreOffice)

Used only for the *optional* visual pass in QA; not required for QA to pass. Convert presentations to individual slide images for visual inspection:

```bash
python scripts/office/soffice.py --headless --convert-to pdf output.pptx
pdftoppm -jpeg -r 150 output.pdf slide
```

This creates `slide-01.jpg`, `slide-02.jpg`, etc.

To re-render specific slides after fixes:

```bash
pdftoppm -jpeg -r 150 -f N -l N output.pdf slide-fixed
```

---

## Dependencies

- `pip install python-pptx` - creating from scratch (pulls in **lxml**, always available)
- `pip install "markitdown[pptx]"` - text extraction
- `pip install Pillow` - thumbnail grids
- **defusedxml** - *optional hardening*; the bundled unpack/pack/clean/thumbnail scripts prefer it but **fall back to the stdlib `xml.dom.minidom` when it isn't installed**, so nothing hard-requires it.
- LibreOffice (`soffice`) - PDF conversion (auto-configured for sandboxed environments via `scripts/office/soffice.py`)
- Poppler (`pdftoppm`) - PDF to images

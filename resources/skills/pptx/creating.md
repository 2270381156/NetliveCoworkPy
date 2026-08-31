# python-pptx Tutorial (Creating from Scratch)

Use **python-pptx** to build presentations programmatically. Install: `pip install python-pptx`

## Setup & Basic Structure

```python
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor

prs = Presentation()
prs.slide_width = Inches(13.333)   # 16:9 widescreen
prs.slide_height = Inches(7.5)

# Layout index 6 is the blank layout in the default template
slide = prs.slides.add_slide(prs.slide_layouts[6])

box = slide.shapes.add_textbox(Inches(0.5), Inches(0.5), Inches(9), Inches(1))
tf = box.text_frame
tf.text = "Hello World!"
run = tf.paragraphs[0].runs[0]
run.font.size = Pt(36)
run.font.color.rgb = RGBColor(0x36, 0x36, 0x36)

prs.save("Presentation.pptx")
```

**Key concepts:**
- All positions/sizes use `Inches(...)`, `Pt(...)`, `Emu(...)`, or `Cm(...)` from `pptx.util` — never raw numbers.
- Colors use `RGBColor(r, g, b)` with integers (e.g. `RGBColor(0xFF, 0x00, 0x00)`), **never** strings like `"#FF0000"`.
- A `text_frame` has `paragraphs`; each paragraph has `runs`; formatting lives on the run's `.font`.
- Use `prs.slide_layouts[6]` (blank) when building everything yourself.

---

## Large Decks — Build Slides in Batches (分批写代码)

For a deck with many slides, **don't emit one massive script that builds every slide at once** — it's easy to truncate or break, and one error loses the whole run. Build the deck incrementally across several small script runs:

1. **First batch** creates the presentation, sets `slide_width` / `slide_height` (one-time), adds the first few slides, and saves.
2. **Each later batch reopens the saved deck, adds the next slides, and saves back to the same path:**
   ```python
   from pptx import Presentation
   from pptx.util import Inches, Pt
   from pptx.dml.color import RGBColor

   prs = Presentation("deck.pptx")            # reopen what the previous batch saved — NOT a fresh Presentation()
   slide = prs.slides.add_slide(prs.slide_layouts[6])
   # ... build the next few slides ...
   prs.save("deck.pptx")                       # save back to the same file
   ```
3. Repeat until all slides exist, then run QA once on the final deck (or per batch as you go).

Rules for batching:
- **Set the slide size once, in the first batch** — it persists in the saved file; don't set it again.
- **Same filename every batch, always reopen it.** Never start a new `Presentation()` mid-way — that throws away every earlier slide.
- `add_slide` appends to the end, so build slides in order.
- Rough trigger: split when a single build script would exceed 300 lines. Small decks don't need this.

---

## Layout Dimensions

The default template is 4:3 (10" × 7.5"). Set the size explicitly for other aspect ratios (coordinates in inches):

| Aspect | Code | Size |
|--------|------|------|
| 16:9 widescreen | `prs.slide_width = Inches(13.333); prs.slide_height = Inches(7.5)` | 13.333" × 7.5" |
| 16:9 compact | `Inches(10)` × `Inches(5.625)` | 10" × 5.625" |
| 16:10 | `Inches(10)` × `Inches(6.25)` | 10" × 6.25" |
| 4:3 (default) | `Inches(10)` × `Inches(7.5)` | 10" × 7.5" |

---

## Text & Formatting

```python
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR

box = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(8), Inches(2))
tf = box.text_frame
tf.word_wrap = True

p = tf.paragraphs[0]
p.alignment = PP_ALIGN.CENTER
run = p.add_run()
run.text = "Simple Text"
run.font.name = "Arial"
run.font.size = Pt(24)
run.font.bold = True
run.font.color.rgb = RGBColor(0x36, 0x36, 0x36)

# Vertical centering of the whole text box
tf.vertical_anchor = MSO_ANCHOR.MIDDLE

# Rich text: multiple runs in one paragraph
p2 = tf.add_paragraph()
r_bold = p2.add_run(); r_bold.text = "Bold "; r_bold.font.bold = True
r_ital = p2.add_run(); r_ital.text = "Italic "; r_ital.font.italic = True

# Multi-line text: each line is its own paragraph
for line in ["Line 1", "Line 2", "Line 3"]:
    para = tf.add_paragraph()
    para.add_run().text = line
```

**Text box internal margins** (padding). Set to 0 when aligning text precisely with shapes/icons:

```python
tf.margin_left = 0
tf.margin_right = 0
tf.margin_top = 0
tf.margin_bottom = 0
```

**Character spacing** is not exposed by the high-level API; set it via XML on the run:

```python
from pptx.oxml.ns import qn
run.font._rPr.set("spc", "600")   # 600 = 6pt of extra spacing (units of 1/100 pt)
```

---

## Lists & Bullets

python-pptx has no high-level bullet API. Two reliable approaches:

**1. Use a content placeholder** (from a layout that has one) — bullets are automatic, and `paragraph.level` (0–8) controls indent:

```python
slide = prs.slides.add_slide(prs.slide_layouts[1])  # Title and Content
body = slide.placeholders[1].text_frame
body.text = "First item"               # first bullet
p = body.add_paragraph(); p.text = "Second item"
p = body.add_paragraph(); p.text = "Sub-item"; p.level = 1
```

**2. Add bullets to a plain text box via XML** with this helper:

```python
from pptx.oxml.ns import qn

def add_bullet(paragraph, char="•", color=None):
    """Turn a paragraph into a bulleted item."""
    pPr = paragraph._p.get_or_add_pPr()
    # buFont improves rendering across viewers
    buFont = pPr.makeelement(qn('a:buFont'), {'typeface': 'Arial'})
    buChar = pPr.makeelement(qn('a:buChar'), {'char': char})
    pPr.append(buFont)
    pPr.append(buChar)

p = tf.add_paragraph(); p.add_run().text = "First item";  add_bullet(p)
p = tf.add_paragraph(); p.add_run().text = "Second item"; add_bullet(p)
```

- **Never** type a literal `"• "` into the text — that creates double bullets. Use the bullet machinery above.
- For numbered lists, use `a:buAutoNum` instead of `a:buChar`:
  `pPr.makeelement(qn('a:buAutoNum'), {'type': 'arabicPeriod'})`.

---

## Shapes

```python
from pptx.enum.shapes import MSO_SHAPE

# Rectangle with fill and outline
shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0.5), Inches(0.8), Inches(1.5), Inches(3.0))
shape.fill.solid()
shape.fill.fore_color.rgb = RGBColor(0xFF, 0x00, 0x00)
shape.line.color.rgb = RGBColor(0x00, 0x00, 0x00)
shape.line.width = Pt(2)
shape.shadow.inherit = False   # disable the default theme shadow

# Oval (no fill outline)
oval = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(4), Inches(1), Inches(2), Inches(2))
oval.fill.solid(); oval.fill.fore_color.rgb = RGBColor(0x00, 0x00, 0xFF)
oval.line.fill.background()     # no outline

# Line connector
line = slide.shapes.add_connector(2, Inches(1), Inches(3), Inches(6), Inches(3))  # 2 = straight
line.line.color.rgb = RGBColor(0xFF, 0x00, 0x00)
line.line.width = Pt(3)

# Rounded rectangle (adjustments[0] controls corner radius, 0.0–0.5)
rr = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(1), Inches(1), Inches(3), Inches(2))
rr.fill.solid(); rr.fill.fore_color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
rr.adjustments[0] = 0.1
```

### Fill transparency

python-pptx has no transparency property; add an `<a:alpha>` element to the fill color:

```python
from pptx.oxml.ns import qn

def set_fill_alpha(shape, percent):
    """percent = opacity 0–100 (50 = half transparent)."""
    shape.fill.solid()
    srgb = shape.fill.fore_color._xFill.find(qn('a:srgbClr'))
    alpha = srgb.makeelement(qn('a:alpha'), {'val': str(int(percent * 1000))})
    srgb.append(alpha)

set_fill_alpha(shape, 50)   # call AFTER setting fore_color.rgb
```

### Shadows

`shape.shadow` only exposes `.inherit`. To add a custom outer shadow, insert an `<a:effectLst>` via XML:

```python
from pptx.oxml.ns import qn

def add_outer_shadow(shape, blur_pt=6, dist_pt=2, direction=135, alpha=85):
    spPr = shape._element.spPr
    effectLst = spPr.makeelement(qn('a:effectLst'), {})
    shdw = spPr.makeelement(qn('a:outerShdw'), {
        'blurRad': str(Pt(blur_pt)),      # EMU
        'dist':    str(Pt(dist_pt)),      # EMU, must be >= 0
        'dir':     str(direction * 60000) # 1/60000 degree; 135 = bottom-right
    })
    clr = shdw.makeelement(qn('a:srgbClr'), {'val': '000000'})
    a = clr.makeelement(qn('a:alpha'), {'val': str(alpha * 1000)})
    clr.append(a); shdw.append(clr); effectLst.append(shdw)
    spPr.append(effectLst)
```

**Note**: Gradient fills are awkward; use a gradient background image instead (see Images / Backgrounds).

---

## Images

> **Offline only — never download images.** `add_picture` reads a local file path or an
> in-memory buffer; python-pptx never fetches from a URL. Do **not** write `requests`/`urllib`/
> `curl` code to pull images off the web — the environment has no network access and it will hang
> or fail. Use only images the user provided. If you have none, create the visual locally instead:
> a chart, shapes, an icon (see Icons), or a solid/gradient background (see Backgrounds). A clean
> text + shape + chart slide beats a slide that waited on a download that never arrives.

```python
# From a file path — give width and/or height
slide.shapes.add_picture("images/chart.png", Inches(1), Inches(1), width=Inches(5), height=Inches(3))

# Preserve aspect ratio: pass only one dimension
slide.shapes.add_picture("images/logo.png", Inches(1), Inches(1), height=Inches(1.5))

# From an in-memory buffer (e.g. a generated chart)
import io
buf = io.BytesIO(png_bytes)
slide.shapes.add_picture(buf, Inches(1), Inches(1), width=Inches(4))
```

### Calculate dimensions (preserve aspect ratio manually)

```python
orig_w, orig_h, max_h = 1978, 923, 3.0          # inches
calc_w = max_h * (orig_w / orig_h)
center_x = (prs.slide_width.inches - calc_w) / 2
slide.shapes.add_picture("image.png", Inches(center_x), Inches(1.2),
                         width=Inches(calc_w), height=Inches(max_h))
```

### Crop

```python
pic = slide.shapes.add_picture("image.png", Inches(1), Inches(1), Inches(4), Inches(3))
pic.crop_left = 0.1     # fractions 0.0–1.0
pic.crop_right = 0.1
```

**Supported formats**: PNG, JPG, GIF, BMP, TIFF. (SVG is not supported by python-pptx — rasterize to PNG first.)

---

## Icons

There is no Python equivalent of react-icons built in. Use one of these Python-only approaches:

1. **Rasterize SVG icons to PNG**, then `add_picture`. If `cairosvg` is available:
   ```python
   import cairosvg, io
   png = cairosvg.svg2png(url="icons/check.svg", output_width=256, output_height=256)
   slide.shapes.add_picture(io.BytesIO(png), Inches(1), Inches(1), Inches(0.5), Inches(0.5))
   ```
   Install: `pip install cairosvg`. Recolor by editing the SVG's `fill` attribute before rasterizing.

2. **Draw simple icons with shapes** — an icon in a colored circle is just an `OVAL` plus a glyph/letter `text_frame` on top. This needs no extra dependencies.

3. **Use Unicode/emoji glyphs** in a text run (e.g. "✓", "→", "★") with a font that includes them. Simple and dependency-free, but rendering depends on installed fonts.

Use source 256px or larger for crisp rasterized icons; the display size is set by `width`/`height` in inches.

---

## Slide Backgrounds

```python
# Solid color
fill = slide.background.fill
fill.solid()
fill.fore_color.rgb = RGBColor(0xF1, 0xF1, 0xF1)

# Full-bleed background image: add a picture covering the whole slide,
# then send it to the back of the z-order. (Use a LOCAL file — never a URL.)
pic = slide.shapes.add_picture("bg.jpg", 0, 0, width=prs.slide_width, height=prs.slide_height)
slide.shapes._spTree.remove(pic._element)
slide.shapes._spTree.insert(2, pic._element)   # index 2 = first shape slot (after nvGrpSpPr, grpSpPr)
```

**Generate a gradient background locally** (no download) with Pillow, then use it as above:

```python
from PIL import Image
w, h = 1920, 1080
top, bottom = (0x1E, 0x27, 0x61), (0x06, 0x5A, 0x82)   # navy -> deep blue
img = Image.new("RGB", (w, h))
px = img.load()
for y in range(h):
    t = y / (h - 1)
    px_row = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    for x in range(w):
        px[x, y] = px_row
img.save("bg.png")
```

---

## Tables

```python
rows, cols = 2, 2
shape = slide.shapes.add_table(rows, cols, Inches(1), Inches(1), Inches(8), Inches(2))
table = shape.table

table.cell(0, 0).text = "Header 1"
table.cell(0, 1).text = "Header 2"
table.cell(1, 0).text = "Cell 1"
table.cell(1, 1).text = "Cell 2"

# Header styling
hdr = table.cell(0, 0)
hdr.fill.solid(); hdr.fill.fore_color.rgb = RGBColor(0x66, 0x99, 0xCC)
run = hdr.text_frame.paragraphs[0].runs[0]
run.font.bold = True; run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)

# Column widths and row heights
table.columns[0].width = Inches(4)
table.columns[1].width = Inches(4)
table.rows[0].height = Inches(0.5)

# Merge cells (e.g. a full-width row)
table.cell(1, 0).merge(table.cell(1, 1))
table.cell(1, 0).text = "Merged"
```

---

## Charts

```python
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION, XL_LABEL_POSITION

# Bar / column chart
data = CategoryChartData()
data.categories = ["Q1", "Q2", "Q3", "Q4"]
data.add_series("Sales", (4500, 5500, 6200, 7100))
gframe = slide.shapes.add_chart(
    XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(0.5), Inches(0.6), Inches(6), Inches(3), data)
chart = gframe.chart
chart.has_title = True
chart.chart_title.text_frame.text = "Quarterly Sales"

# Line chart
data = CategoryChartData()
data.categories = ["Jan", "Feb", "Mar"]
data.add_series("Temp", (32, 35, 42))
slide.shapes.add_chart(XL_CHART_TYPE.LINE, Inches(0.5), Inches(4), Inches(6), Inches(3), data)

# Pie chart
data = CategoryChartData()
data.categories = ["A", "B", "Other"]
data.add_series("Share", (35, 45, 20))
gframe = slide.shapes.add_chart(XL_CHART_TYPE.PIE, Inches(7), Inches(1), Inches(5), Inches(4), data)
gframe.chart.plots[0].has_data_labels = True
gframe.chart.plots[0].data_labels.show_percentage = True
```

### Better-Looking Charts

Default charts look dated. Apply these for a cleaner appearance:

```python
chart = gframe.chart

# Custom series colors (match your palette)
from pptx.dml.color import RGBColor
for i, point_color in enumerate([RGBColor(0x0D,0x94,0x88), RGBColor(0x14,0xB8,0xA6)]):
    chart.series[i].format.fill.solid()
    chart.series[i].format.fill.fore_color.rgb = point_color

# Data labels
plot = chart.plots[0]
plot.has_data_labels = True
plot.data_labels.position = XL_LABEL_POSITION.OUTSIDE_END
plot.data_labels.font.size = Pt(10)
plot.data_labels.font.color.rgb = RGBColor(0x1E, 0x29, 0x3B)

# Legend (hide for single series)
chart.has_legend = False
# ...or position it: chart.has_legend = True; chart.legend.position = XL_LEGEND_POSITION.RIGHT

# Muted axis labels
chart.category_axis.tick_labels.font.color.rgb = RGBColor(0x64, 0x74, 0x8B)
chart.value_axis.tick_labels.font.color.rgb = RGBColor(0x64, 0x74, 0x8B)
```

**Key chart types**: `COLUMN_CLUSTERED`, `BAR_CLUSTERED`, `LINE`, `LINE_MARKERS`, `PIE`, `DOUGHNUT`, `XY_SCATTER`, `BUBBLE`, `RADAR`.

---

## Slide Masters & Layouts

The default template ships with masters/layouts. Pick a layout by index and fill its placeholders:

```python
slide = prs.slides.add_slide(prs.slide_layouts[0])   # Title Slide
slide.shapes.title.text = "My Title"
slide.placeholders[1].text = "Subtitle"
```

Common default layout indexes: `0` Title, `1` Title+Content, `5` Title Only, `6` Blank.

To inspect available placeholders on a layout:

```python
for ph in slide.placeholders:
    print(ph.placeholder_format.idx, ph.placeholder_format.type, ph.name)
```

For fully custom masters, start from a designed template `.pptx` and `Presentation("template.pptx")` instead of building masters by hand (see [editing.md](editing.md)).

---

## Common Pitfalls

⚠️ These cause errors, corruption, or bad output.

1. **Colors are `RGBColor(r, g, b)` integers, never strings.**
   ```python
   run.font.color.rgb = RGBColor(0xFF, 0x00, 0x00)   # ✅
   run.font.color.rgb = "#FF0000"                    # ❌ TypeError
   ```

2. **All measurements need a unit helper.** `Inches`, `Pt`, `Cm`, `Emu`. Passing a bare number is interpreted as EMU (1/914400 inch) and produces microscopic output.

3. **Set text on a run, not by concatenating.** Adding `"• "` manually creates double bullets — use the bullet helper.

4. **Each line is its own paragraph.** There is no `\n` line-break inside a run; call `text_frame.add_paragraph()` per line.

5. **A new paragraph has no runs.** `paragraph.runs[0]` raises `IndexError` until you `add_run()` (or set `paragraph.text`, which creates one run).

6. **Disable the inherited shadow** with `shape.shadow.inherit = False` when you don't want the theme's default drop shadow.

7. **Apply transparency AFTER setting the fill color** — `fill.solid()` and `fore_color.rgb` must exist before you append `<a:alpha>`.

8. **`add_picture` with both width and height ignores aspect ratio.** Pass only one dimension to preserve proportions, or compute both yourself.

---

## Quick Reference

- **Imports**: `from pptx import Presentation`; `from pptx.util import Inches, Pt`; `from pptx.dml.color import RGBColor`; `from pptx.enum.shapes import MSO_SHAPE`; `from pptx.enum.text import PP_ALIGN, MSO_ANCHOR`; `from pptx.chart.data import CategoryChartData`; `from pptx.enum.chart import XL_CHART_TYPE`
- **Shapes**: `MSO_SHAPE.RECTANGLE`, `OVAL`, `ROUNDED_RECTANGLE`; lines via `add_connector`
- **Charts**: `XL_CHART_TYPE.COLUMN_CLUSTERED`, `BAR_CLUSTERED`, `LINE`, `PIE`, `DOUGHNUT`, `XY_SCATTER`, `BUBBLE`, `RADAR`
- **Alignment**: `PP_ALIGN.LEFT/CENTER/RIGHT`; vertical `MSO_ANCHOR.TOP/MIDDLE/BOTTOM`
- **Blank layout**: `prs.slide_layouts[6]`
- **Save**: `prs.save("out.pptx")`

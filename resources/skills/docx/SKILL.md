---
name: docx
description: "Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files). Triggers include: any mention of 'Word doc', 'word document', '.docx', or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads. Also use when extracting or reorganizing content from .docx files, inserting or replacing images in documents, performing find-and-replace in Word files, working with tracked changes or comments, or converting content into a polished Word document. If the user asks for a 'report', 'memo', 'letter', 'template', or similar deliverable as a Word or .docx file, use this skill. Do NOT use for PDFs, spreadsheets, Google Docs, or general coding tasks unrelated to document generation."
license: Proprietary. LICENSE.txt has complete terms
---

# DOCX creation, editing, and analysis

## Overview

A .docx file is a ZIP archive containing XML files.

## Quick Reference

| Task | Approach |
|------|----------|
| Read/analyze content | `python-docx` / `markitdown` (pure Python); unpack for raw XML |
| Create new document | Use `python-docx` - see Creating New Documents below |
| Edit existing document | Unpack → edit XML → repack - see Editing Existing Documents below |
| Verify your output | Content + visual QA - see QA (Required) below |

### Reading Content

Extract text with **python-docx** — pure Python, no external tools:

```python
from docx import Document
doc = Document("document.docx")
print("\n".join(p.text for p in doc.paragraphs))
for t in doc.tables:
    for row in t.rows:
        print(" | ".join(c.text for c in row.cells))
```

Or `python -m markitdown document.docx` (needs `pip install "markitdown[docx]"`).

```bash
# Raw XML access (for editing)
python scripts/office/unpack.py document.docx unpacked/
```

*Optional:* for a tracked-changes-aware view, `pandoc --track-changes=all document.docx -o output.md` (only if pandoc is installed).

### Accepting Tracked Changes (pure Python, no LibreOffice)

Produce a clean document with all tracked changes accepted — insertions kept, deletions removed, formatting changes applied, deleted paragraph marks merged:

```bash
python scripts/accept_changes.py input.docx output.docx
```

### Converting .doc to .docx (requires LibreOffice)

Legacy binary `.doc` has no pure-Python reader. If LibreOffice is installed:

```bash
python scripts/office/soffice.py --headless --convert-to docx document.doc
```

**If LibreOffice isn't available**, ask the user to open the file in Word (or Google Docs) and save it as `.docx` first — everything else here operates on `.docx` only.

### Converting to Images (optional — requires LibreOffice + Poppler)

Only for an optional visual look; not needed for any core operation or for QA. If both tools are installed:

```bash
python scripts/office/soffice.py --headless --convert-to pdf document.docx
pdftoppm -jpeg -r 150 document.pdf page
```

---

## Creating New Documents

Generate .docx files with **python-docx**, then validate. Install: `pip install python-docx`

### Setup
```python
from docx import Document
from docx.shared import Pt, Inches, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()
doc.add_paragraph("Hello world")
doc.save("doc.docx")
```

`Document()` starts from python-docx's built-in template (already US-Letter-ish defaults vary by platform — set page size explicitly, see below). Pass a path to start from your own template: `Document("template.docx")`.

### Large or Long Documents — Generate in Batches (分批写代码)

When the document is long (many sections, a big report, dozens of tables), **do not emit one giant script that builds the whole thing at once.** A single huge script is easy to truncate or get wrong, and one error loses everything. Build the file incrementally across several small script runs:

1. **First batch** creates the document, does all one-time setup (page size, styles, header/footer, the TOC field — see below), adds the first chunk of content, and saves.
2. **Each later batch reopens the saved file, appends the next chunk, and saves back to the same path:**
   ```python
   from docx import Document
   doc = Document("report.docx")      # reopen what the previous batch saved — NOT a fresh Document()
   doc.add_heading("Section 5", level=1)
   doc.add_paragraph("...")           # add_* always appends to the end of the body
   doc.save("report.docx")            # save back to the same file
   ```
3. Repeat until every section is written, then run QA once on the final file (or per batch as you go).

Rules for batching:
- **One-time setup only in the first batch** (page size, styles, header/footer, TOC field). It persists in the saved file — don't repeat it, or later batches will duplicate/override it.
- **Same filename every batch, always reopen it.** Never start a fresh `Document()` mid-way — that discards all earlier batches.
- `add_paragraph` / `add_heading` / `add_table` append at the end, so write sections in order, front to back. (A TOC field added in batch 1 still captures every later heading — Word refreshes it on open.)
- Rough trigger: split when a single build script would run past ~150–200 lines, or the report is more than ~10 sections/pages. Short documents don't need this.

### Validation
After creating the file, validate it. If validation fails, unpack, fix the XML, and repack.
```bash
python scripts/office/validate.py doc.docx
```

### Page Size

```python
from docx.shared import Inches

section = doc.sections[0]
# CRITICAL: set page size explicitly for consistent results
section.page_width = Inches(8.5)     # US Letter
section.page_height = Inches(11)
section.left_margin = Inches(1)
section.right_margin = Inches(1)
section.top_margin = Inches(1)
section.bottom_margin = Inches(1)
```

**Common page sizes:**

| Paper | Width | Height | Content Width (1" margins) |
|-------|-------|--------|---------------------------|
| US Letter | 8.5" | 11" | 6.5" |
| A4 | 8.27" | 11.69" | 6.27" |

**Landscape orientation:** swap width/height and set the orientation flag:
```python
from docx.enum.section import WD_ORIENT
section.orientation = WD_ORIENT.LANDSCAPE
section.page_width, section.page_height = Inches(11), Inches(8.5)  # set explicitly; setting orientation alone does NOT swap dimensions
```

### Styles (Override Built-in Headings)

Use Arial as the default font (universally supported). Keep titles black for readability.

```python
from docx.shared import Pt, RGBColor

# Default document font
normal = doc.styles['Normal']
normal.font.name = 'Arial'
normal.font.size = Pt(12)

# Override built-in heading styles (edit, don't recreate — the IDs must stay 'Heading 1' etc.)
h1 = doc.styles['Heading 1']
h1.font.name = 'Arial'; h1.font.size = Pt(16); h1.font.bold = True
h1.font.color.rgb = RGBColor(0x00, 0x00, 0x00)
h1.paragraph_format.space_before = Pt(12); h1.paragraph_format.space_after = Pt(12)

h2 = doc.styles['Heading 2']
h2.font.name = 'Arial'; h2.font.size = Pt(14); h2.font.bold = True

# Headings created this way carry the outline level needed for a TOC
doc.add_heading("Title", level=1)
```

`add_heading(text, level=N)` applies the built-in `Heading N` style (which has the `outlineLevel` a TOC requires). Don't fake headings with bold body text.

### Lists (NEVER use unicode bullets)

```python
# ✅ CORRECT - use the built-in list styles
doc.add_paragraph("First bullet",  style='List Bullet')
doc.add_paragraph("Second bullet", style='List Bullet')
doc.add_paragraph("First numbered",  style='List Number')
doc.add_paragraph("Second numbered", style='List Number')

# Nested levels: 'List Bullet 2', 'List Bullet 3', 'List Number 2', ...
doc.add_paragraph("Sub-item", style='List Bullet 2')

# ❌ WRONG - never type bullet characters yourself
doc.add_paragraph("• Item")          # BAD: creates literal bullets, no list semantics
```

To restart or continue numbering precisely you must manipulate `w:numbering` XML; for most documents the built-in styles are sufficient.

### Tables

**CRITICAL: Tables need explicit widths** — set `autofit = False`, the table's column widths, AND each cell's width. Without all three, tables render inconsistently across platforms.

```python
from docx.shared import Inches, Pt
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

table = doc.add_table(rows=2, cols=2)
table.style = 'Table Grid'          # gives all cells single borders
table.alignment = WD_TABLE_ALIGNMENT.CENTER
table.autofit = False               # CRITICAL: required for fixed widths

col_w = Inches(3.25)
for col in table.columns:
    col.width = col_w
for row in table.rows:
    for cell in row.cells:
        cell.width = col_w          # CRITICAL: also set on every cell

table.rows[0].cells[0].text = "Header"
table.rows[1].cells[0].text = "Cell"

# Cell background shading (use 'clear' fill, never a solid black default)
def shade_cell(cell, hex_fill):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:fill'), hex_fill)
    tcPr.append(shd)

shade_cell(table.rows[0].cells[0], "D5E8F0")
```

**Width rules:**
- Set `table.autofit = False`, column widths, AND cell widths — all three.
- Table width = sum of column widths = content width (page width minus left+right margins). For US Letter with 1" margins that's 6.5".
- Cell padding is internal; it does not add to cell width.
- **Never use tables as horizontal rules/dividers** — cells have a minimum height and render as empty boxes. Use a paragraph bottom border instead:
  ```python
  p = doc.add_paragraph()
  pPr = p._p.get_or_add_pPr(); pbdr = OxmlElement('w:pBdr')
  bottom = OxmlElement('w:bottom')
  for k, v in {'w:val':'single','w:sz':'6','w:space':'1','w:color':'2E75B6'}.items():
      bottom.set(qn(k), v)
  pbdr.append(bottom); pPr.append(pbdr)
  ```

### Images

> **Use local images only — never download.** `add_picture` takes a local file path or file-like
> object; it does not fetch URLs. The environment has no internet access, so do not write
> `requests`/`urllib`/`curl` code to pull images from the web. Use images the user provided, or
> generate them locally (e.g. a chart rendered to PNG with matplotlib/Pillow).

```python
from docx.shared import Inches

# Inline image (pass one dimension to preserve aspect ratio)
doc.add_picture("image.png", width=Inches(2))

# To control placement, add to a paragraph run
p = doc.add_paragraph()
run = p.add_run()
run.add_picture("image.png", width=Inches(2), height=Inches(1.5))
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
```

### Page Breaks

```python
doc.add_page_break()

# Or break before a specific paragraph
p = doc.add_paragraph("New page")
p.paragraph_format.page_break_before = True
```

### Hyperlinks

python-docx has no high-level hyperlink API; use this helper:

```python
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

def add_hyperlink(paragraph, url, text):
    part = paragraph.part
    r_id = part.relate_to(
        url, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
        is_external=True)
    hyperlink = OxmlElement('w:hyperlink'); hyperlink.set(qn('r:id'), r_id)
    run = OxmlElement('w:r'); rPr = OxmlElement('w:rPr')
    style = OxmlElement('w:rStyle'); style.set(qn('w:val'), 'Hyperlink'); rPr.append(style)
    run.append(rPr)
    t = OxmlElement('w:t'); t.text = text; run.append(t)
    hyperlink.append(run); paragraph._p.append(hyperlink)

p = doc.add_paragraph()
add_hyperlink(p, "https://example.com", "Click here")
```

For internal links (bookmarks + `w:hyperlink w:anchor=...`), edit the XML via the unpack/pack workflow.

### Footnotes

python-docx does not expose footnotes through its API. To add real footnotes, create the document body with python-docx, then use the **Editing Existing Documents** unpack → edit XML → pack workflow below (add `word/footnotes.xml`, the relationship, and `<w:footnoteReference>` runs). For simple sourcing, inline parenthetical citations are often sufficient.

### Tab Stops

```python
from docx.shared import Inches
from docx.enum.text import WD_TAB_ALIGNMENT, WD_TAB_LEADER

# Right-align text on the same line (e.g., date opposite a title)
p = doc.add_paragraph()
p.paragraph_format.tab_stops.add_tab_stop(Inches(6.5), WD_TAB_ALIGNMENT.RIGHT)
p.add_run("Company Name\tJanuary 2025")

# Dot leader (e.g., TOC-style line)
p = doc.add_paragraph()
p.paragraph_format.tab_stops.add_tab_stop(Inches(6.5), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)
p.add_run("Introduction\t3")
```

### Multi-Column Layouts

Column layout lives on the section's `w:cols` element:

```python
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

def set_columns(section, num, space_twips=720):   # 720 twips = 0.5"
    sectPr = section._sectPr
    cols = sectPr.find(qn('w:cols'))
    if cols is None:
        cols = OxmlElement('w:cols'); sectPr.append(cols)
    cols.set(qn('w:num'), str(num))
    cols.set(qn('w:space'), str(space_twips))

set_columns(doc.sections[0], 2)
```

To start a new section (e.g., to switch column counts mid-document), use `doc.add_section()` and configure its `w:cols`.

### Table of Contents

A TOC is a Word field that the user refreshes on open. Insert the field via XML:

```python
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

def add_toc(doc):
    p = doc.add_paragraph()
    run = p.add_run()
    begin = OxmlElement('w:fldChar'); begin.set(qn('w:fldCharType'), 'begin')
    instr = OxmlElement('w:instrText'); instr.set(qn('xml:space'), 'preserve')
    instr.text = r'TOC \o "1-3" \h \z \u'
    sep = OxmlElement('w:fldChar'); sep.set(qn('w:fldCharType'), 'separate')
    end = OxmlElement('w:fldChar'); end.set(qn('w:fldCharType'), 'end')
    for el in (begin, instr, sep, end):
        run._r.append(el)

add_toc(doc)
```

Headings must use the built-in `Heading 1/2/3` styles (via `add_heading`) for the TOC to pick them up.

### Headers/Footers (with page numbers)

```python
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

def add_field(paragraph, instruction):
    run = paragraph.add_run()
    begin = OxmlElement('w:fldChar'); begin.set(qn('w:fldCharType'), 'begin')
    instr = OxmlElement('w:instrText'); instr.set(qn('xml:space'), 'preserve'); instr.text = instruction
    end = OxmlElement('w:fldChar'); end.set(qn('w:fldCharType'), 'end')
    for el in (begin, instr, end):
        run._r.append(el)

section = doc.sections[0]
header = section.header
header.paragraphs[0].text = "Header text"

footer = section.footer
fp = footer.paragraphs[0]
fp.add_run("Page ")
add_field(fp, "PAGE")            # current page number
fp.add_run(" of ")
add_field(fp, "NUMPAGES")        # total pages
```

### Critical Rules for python-docx

- **Set page size explicitly** — defaults vary; set US Letter (8.5" × 11") for US documents.
- **Landscape: set orientation AND swap dimensions** — `WD_ORIENT.LANDSCAPE` alone does not change page_width/page_height.
- **Never embed `\n` in a run** — use separate `add_paragraph()` calls (or `run.add_break()` for a soft line break).
- **Never type unicode bullets** — use `style='List Bullet'` / `'List Number'`.
- **Images**: use `add_picture`; pass a single dimension to preserve aspect ratio.
- **Tables need fixed widths** — `autofit = False` plus column widths plus cell widths, all matching.
- **Table width = sum of column widths** — make them add up to the content width exactly.
- **Use `w:shd` with `val='clear'`** for cell shading — never a solid fill that turns cells black.
- **Never use tables as dividers** — use a paragraph bottom border instead.
- **TOC requires built-in heading styles** — use `add_heading`, not custom-styled paragraphs.
- **Override built-in styles in place** — edit `doc.styles['Heading 1']`; don't invent new style IDs for headings you want in the TOC.
- **Colors are `RGBColor(r, g, b)` integers** — e.g. `RGBColor(0x2E, 0x75, 0xB6)`, never `"#2E75B6"`.

---

## Editing Existing Documents

**Follow all 3 steps in order.**

### Step 1: Unpack
```bash
python scripts/office/unpack.py document.docx unpacked/
```
Extracts XML, pretty-prints, merges adjacent runs, and converts smart quotes to XML entities (`&#x201C;` etc.) so they survive editing. Use `--merge-runs false` to skip run merging.

### Step 2: Edit XML

Edit files in `unpacked/word/`. See XML Reference below for patterns.

**Use "Assistant" as the author** for tracked changes and comments, unless the user explicitly requests use of a different name.

**Use the Edit tool directly for string replacement. Do not write Python scripts.** Scripts introduce unnecessary complexity. The Edit tool shows exactly what is being replaced.

**CRITICAL: Use smart quotes for new content.** When adding text with apostrophes or quotes, use XML entities to produce smart quotes:
```xml
<!-- Use these entities for professional typography -->
<w:t>Here&#x2019;s a quote: &#x201C;Hello&#x201D;</w:t>
```
| Entity | Character |
|--------|-----------|
| `&#x2018;` | ‘ (left single) |
| `&#x2019;` | ’ (right single / apostrophe) |
| `&#x201C;` | “ (left double) |
| `&#x201D;` | ” (right double) |

**Adding comments:** Use `comment.py` to handle boilerplate across multiple XML files (text must be pre-escaped XML):
```bash
python scripts/comment.py unpacked/ 0 "Comment text with &amp; and &#x2019;"
python scripts/comment.py unpacked/ 1 "Reply text" --parent 0  # reply to comment 0
python scripts/comment.py unpacked/ 0 "Text" --author "Custom Author"  # custom author name
```
Then add markers to document.xml (see Comments in XML Reference).

### Step 3: Pack
```bash
python scripts/office/pack.py unpacked/ output.docx --original document.docx
```
Validates with auto-repair, condenses XML, and creates DOCX. Use `--validate false` to skip.

**Auto-repair will fix:**
- `durableId` >= 0x7FFFFFFF (regenerates valid ID)
- Missing `xml:space="preserve"` on `<w:t>` with whitespace

**Auto-repair won't fix:**
- Malformed XML, invalid element nesting, missing relationships, schema violations

### Common Pitfalls

- **Replace entire `<w:r>` elements**: When adding tracked changes, replace the whole `<w:r>...</w:r>` block with `<w:del>...<w:ins>...` as siblings. Don't inject tracked change tags inside a run.
- **Preserve `<w:rPr>` formatting**: Copy the original run's `<w:rPr>` block into your tracked change runs to maintain bold, font size, etc.

---

## XML Reference

### Schema Compliance

- **Element order in `<w:pPr>`**: `<w:pStyle>`, `<w:numPr>`, `<w:spacing>`, `<w:ind>`, `<w:jc>`, `<w:rPr>` last
- **Whitespace**: Add `xml:space="preserve"` to `<w:t>` with leading/trailing spaces
- **RSIDs**: Must be 8-digit hex (e.g., `00AB1234`)

### Tracked Changes

**Insertion:**
```xml
<w:ins w:id="1" w:author="Assistant" w:date="2025-01-01T00:00:00Z">
  <w:r><w:t>inserted text</w:t></w:r>
</w:ins>
```

**Deletion:**
```xml
<w:del w:id="2" w:author="Assistant" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>deleted text</w:delText></w:r>
</w:del>
```

**Inside `<w:del>`**: Use `<w:delText>` instead of `<w:t>`, and `<w:delInstrText>` instead of `<w:instrText>`.

**Minimal edits** - only mark what changes:
```xml
<!-- Change "30 days" to "60 days" -->
<w:r><w:t>The term is </w:t></w:r>
<w:del w:id="1" w:author="Assistant" w:date="...">
  <w:r><w:delText>30</w:delText></w:r>
</w:del>
<w:ins w:id="2" w:author="Assistant" w:date="...">
  <w:r><w:t>60</w:t></w:r>
</w:ins>
<w:r><w:t> days.</w:t></w:r>
```

**Deleting entire paragraphs/list items** - when removing ALL content from a paragraph, also mark the paragraph mark as deleted so it merges with the next paragraph. Add `<w:del/>` inside `<w:pPr><w:rPr>`:
```xml
<w:p>
  <w:pPr>
    <w:numPr>...</w:numPr>  <!-- list numbering if present -->
    <w:rPr>
      <w:del w:id="1" w:author="Assistant" w:date="2025-01-01T00:00:00Z"/>
    </w:rPr>
  </w:pPr>
  <w:del w:id="2" w:author="Assistant" w:date="2025-01-01T00:00:00Z">
    <w:r><w:delText>Entire paragraph content being deleted...</w:delText></w:r>
  </w:del>
</w:p>
```
Without the `<w:del/>` in `<w:pPr><w:rPr>`, accepting changes leaves an empty paragraph/list item.

**Rejecting another author's insertion** - nest deletion inside their insertion:
```xml
<w:ins w:author="Jane" w:id="5">
  <w:del w:author="Assistant" w:id="10">
    <w:r><w:delText>their inserted text</w:delText></w:r>
  </w:del>
</w:ins>
```

**Restoring another author's deletion** - add insertion after (don't modify their deletion):
```xml
<w:del w:author="Jane" w:id="5">
  <w:r><w:delText>deleted text</w:delText></w:r>
</w:del>
<w:ins w:author="Assistant" w:id="10">
  <w:r><w:t>deleted text</w:t></w:r>
</w:ins>
```

### Comments

After running `comment.py` (see Step 2), add markers to document.xml. For replies, use `--parent` flag and nest markers inside the parent's.

**CRITICAL: `<w:commentRangeStart>` and `<w:commentRangeEnd>` are siblings of `<w:r>`, never inside `<w:r>`.**

```xml
<!-- Comment markers are direct children of w:p, never inside w:r -->
<w:commentRangeStart w:id="0"/>
<w:del w:id="1" w:author="Assistant" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>deleted</w:delText></w:r>
</w:del>
<w:r><w:t> more text</w:t></w:r>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>

<!-- Comment 0 with reply 1 nested inside -->
<w:commentRangeStart w:id="0"/>
  <w:commentRangeStart w:id="1"/>
  <w:r><w:t>text</w:t></w:r>
  <w:commentRangeEnd w:id="1"/>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="1"/></w:r>
```

### Images

1. Add image file to `word/media/`
2. Add relationship to `word/_rels/document.xml.rels`:
```xml
<Relationship Id="rId5" Type=".../image" Target="media/image1.png"/>
```
3. Add content type to `[Content_Types].xml`:
```xml
<Default Extension="png" ContentType="image/png"/>
```
4. Reference in document.xml:
```xml
<w:drawing>
  <wp:inline>
    <wp:extent cx="914400" cy="914400"/>  <!-- EMUs: 914400 = 1 inch -->
    <a:graphic>
      <a:graphicData uri=".../picture">
        <pic:pic>
          <pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill>
        </pic:pic>
      </a:graphicData>
    </a:graphic>
  </wp:inline>
</w:drawing>
```

---

## QA (Required)

**Assume there are problems and hunt for them.** A .docx can pack and validate cleanly yet still render wrong — a table that collapses to empty boxes, a heading that didn't take the style, leftover placeholder text, a TOC that points nowhere. Verify before delivering.

**Fastest path — run the bundled QA script** (does the programmatic checks below in one shot, no LibreOffice):

```bash
python scripts/qa_check.py output.docx --expect "a value you put in"
```

It reports headings/styles, table shapes & empty cells, and image count, flags leftover placeholders, and runs weak layout checks — tables with **autofit on** or whose **column widths overflow the page content width**, and **absurd font sizes** (<5pt or >100pt) — as advisory WARNs. It exits non-zero on blocking problems (placeholders, or any `--expect` string missing). (docx is reflowable, so true rendering overflow still needs the optional visual pass or a human; these are coarse pre-checks.)

**The script is not the whole QA.** It only covers generic, mechanical checks — it cannot tell whether the *content is correct*. A `PASS` is necessary, not sufficient. You must still verify the task-specific things yourself: that the intended sections/headings and table contents are present and accurate, the document actually says what it should, and the formatting matches the request. The subsections below explain the checks and how to verify by hand.

### Content QA

Extract the document's text and read it back — check for missing content and wrong order. Use whichever extractor is installed:

```bash
pandoc output.docx -o output.md            # if pandoc is available
python -m markitdown output.docx           # needs the docx extra: pip install "markitdown[docx]"
```

If neither is installed, extract with python-docx (no extra dependencies — always works):

```python
from docx import Document
doc = Document("output.docx")
parts = [p.text for p in doc.paragraphs]
for tbl in doc.tables:
    for row in tbl.rows:
        parts.append(" | ".join(c.text for c in row.cells))
print("\n".join(parts))
```

Then scan the extracted text for leftover placeholders (`xxxx`, `lorem`, `ipsum`, `TODO`, `[...]`). If any turn up, fix them before declaring success.

**Don't pipe an extractor straight to grep with its errors silenced (e.g. `... 2>/dev/null | grep`)** — if the extractor fails (missing dependency, bad file), grep sees nothing and the document looks "clean" when it wasn't. Confirm the extraction actually produced the document's text first.

### Structural QA

Valid XML doesn't mean the document is right — a table can collapse, a heading can fail to take its style (breaking the TOC), or content can go missing. Check structure **programmatically with python-docx** — no LibreOffice, no rendering required:

```python
from docx import Document
doc = Document("output.docx")

# Headings actually carry a Heading style (required for the TOC to pick them up)
print("headings:", [p.text for p in doc.paragraphs if p.style.name.startswith("Heading")])

# Tables have the expected shape and no empty cells where content belongs
for i, t in enumerate(doc.tables):
    print(f"table {i}: {len(t.rows)}x{len(t.columns)}")
    empty = [(r, c) for r, row in enumerate(t.rows)
             for c, cell in enumerate(row.cells) if not cell.text.strip()]
    if empty:
        print("  empty cells:", empty)

print("inline images:", len(doc.inline_shapes))
```

Confirm: the intended headings exist and are styled (not faked with bold body text), each table has the right rows/cols with cells filled, and any expected images are present.

**Optional visual pass — never required.** Only if LibreOffice and Poppler happen to be installed, you *may* also render to images for a human/subagent look. QA must pass on the programmatic checks above without it:

```bash
# optional, only if these tools are present
python scripts/office/soffice.py --headless --convert-to pdf output.docx && pdftoppm -jpeg -r 150 output.pdf page
```

### Verification loop

1. Build → validate (`python scripts/office/validate.py output.docx`) → content QA → structural QA
2. List the issues found (if none, look harder)
3. Fix → re-run the checks
4. Repeat until a clean pass reveals nothing new

Don't declare success until you've completed at least one fix-and-verify cycle.

---

## Dependencies

**Core — pure Python, no external tools (these cover the whole normal workflow):**
- **python-docx** — `pip install python-docx` (create, read, structural QA). Pulls in **lxml**, so lxml is always available too.
- **markitdown** — `pip install "markitdown[docx]"` (text extraction; python-docx is a fallback)

**Optional hardening (bundled scripts degrade gracefully without it):**
- **defusedxml** — the unpack/pack/validate/comment scripts prefer it for XML parsing, but **fall back to the stdlib `xml.dom.minidom` automatically when it isn't installed**, so nothing here hard-requires it. If you write your own XML-parsing code, do the same: `try: import defusedxml.minidom` / `except ModuleNotFoundError: import xml.dom.minidom` — never `xml.etree.ElementTree` (it corrupts namespaces).

**Optional — only for the operations explicitly marked "requires LibreOffice":**
- **LibreOffice** (`soffice`) — legacy `.doc → .docx` conversion, and rendering to PDF/images for an optional visual pass. Not needed for create, edit, validate, QA, or accepting tracked changes.
- **Poppler** (`pdftoppm`) — PDF → images, for that same optional visual pass.
- **pandoc** — optional tracked-changes-aware text view.

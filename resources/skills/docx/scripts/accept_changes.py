#!/usr/bin/env python3
"""Accept all tracked changes in a .docx file — pure Python, no LibreOffice.

Function: a .docx is a zip of XML. This reads each part that can carry tracked
          changes and accepts every change directly in the XML:
            - insertions (w:ins, w:moveTo)            -> kept (wrapper unwrapped)
            - deletions  (w:del, w:moveFrom)          -> removed (content dropped)
            - range markers (w:*RangeStart/End)       -> removed
            - formatting changes (w:rPrChange, etc.)  -> removed (new formatting kept)
            - deleted paragraph marks (w:pPr/w:rPr/w:del) -> paragraph merged with the next
          then writes a clean .docx with no tracked-change markup.
Usage:    python scripts/accept_changes.py <input.docx> <output.docx>
"""
import sys
import zipfile
from pathlib import Path

import lxml.etree as ET

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def w(tag: str) -> str:
    return f"{{{W}}}{tag}"


# Elements whose entire subtree is dropped (the deleted / moved-from content).
DROP_SUBTREE = (w("del"), w("moveFrom"))
# Empty range markers — just remove them.
DROP_MARKERS = (
    w("moveFromRangeStart"), w("moveFromRangeEnd"),
    w("moveToRangeStart"), w("moveToRangeEnd"),
    w("customXmlInsRangeStart"), w("customXmlInsRangeEnd"),
    w("customXmlDelRangeStart"), w("customXmlDelRangeEnd"),
)
# Wrappers around kept content — unwrap (promote children, drop wrapper).
UNWRAP = (w("ins"), w("moveTo"))
# Formatting-change records — removing them accepts the new formatting.
DROP_PRCHANGE = (
    w("rPrChange"), w("pPrChange"), w("tblPrChange"), w("trPrChange"),
    w("tcPrChange"), w("sectPrChange"), w("tblGridChange"), w("numberingChange"),
)


def _remove(el):
    parent = el.getparent()
    if parent is not None:
        parent.remove(el)


def accept_tree(root) -> None:
    # 1) merge paragraphs whose paragraph mark was deleted. Do this FIRST, while the
    #    empty <w:del/> marker in w:pPr/w:rPr still exists (step 2 would wipe it).
    for p in list(root.iter(w("p"))):
        pPr = p.find(w("pPr"))
        rPr = pPr.find(w("rPr")) if pPr is not None else None
        delmark = rPr.find(w("del")) if rPr is not None else None
        if delmark is None:
            continue
        rPr.remove(delmark)
        nxt = p.getnext()
        while nxt is not None and nxt.tag != w("p"):
            nxt = nxt.getnext()
        if nxt is None:
            continue  # last paragraph in its container — nothing to merge into
        nxt_pPr = nxt.find(w("pPr"))
        insert_at = 0 if nxt_pPr is None else list(nxt).index(nxt_pPr) + 1
        moving = [c for c in list(p) if c.tag != w("pPr")]
        for c in reversed(moving):
            nxt.insert(insert_at, c)
        _remove(p)
    # 2) drop deletions / moved-from content (whole subtree)
    for tag in DROP_SUBTREE:
        for el in root.findall(f".//{tag}"):
            _remove(el)
    # 3) drop empty range markers
    for tag in DROP_MARKERS:
        for el in root.findall(f".//{tag}"):
            _remove(el)
    # 4) unwrap insertions / moves (keep their children); loop handles nesting
    while True:
        targets = []
        for tag in UNWRAP:
            targets.extend(root.findall(f".//{tag}"))
        if not targets:
            break
        for el in targets:
            parent = el.getparent()
            if parent is None:
                continue
            idx = list(parent).index(el)
            for child in reversed(list(el)):
                parent.insert(idx, child)
            parent.remove(el)
    # 5) drop formatting-change records (accept the new formatting)
    for tag in DROP_PRCHANGE:
        for el in root.findall(f".//{tag}"):
            _remove(el)


def _is_tracked_part(name: str) -> bool:
    return (
        name == "word/document.xml"
        or name.startswith("word/header")
        or name.startswith("word/footer")
        or name in ("word/footnotes.xml", "word/endnotes.xml")
    )


def accept_changes(input_file: str, output_file: str) -> str:
    inp, outp = Path(input_file), Path(output_file)
    if not inp.exists():
        return f"Error: Input file not found: {input_file}"
    if inp.suffix.lower() != ".docx":
        return f"Error: Input file is not a DOCX file: {input_file}"

    outp.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(inp) as zin, zipfile.ZipFile(outp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if _is_tracked_part(item.filename):
                root = ET.fromstring(data)
                accept_tree(root)
                data = ET.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
            zout.writestr(item, data)
    return f"Successfully accepted all tracked changes: {input_file} -> {output_file}"


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Accept all tracked changes in a DOCX file (pure Python, no LibreOffice)")
    parser.add_argument("input_file", help="Input DOCX file with tracked changes")
    parser.add_argument("output_file", help="Output DOCX file (clean, no tracked changes)")
    args = parser.parse_args()

    message = accept_changes(args.input_file, args.output_file)
    print(message)
    if message.startswith("Error"):
        sys.exit(1)

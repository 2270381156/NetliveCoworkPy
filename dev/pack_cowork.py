"""把一个 cowork 目录打成套件包（**开发工具**）。

真下发是云端做的，这个脚本只为本地验证："假装云端发了这几个下来"。

    python dev/pack_cowork.py <源目录> <输出目录> [--sign]

源目录里要有 `cowork.json` 与四个 facet。产出的 zip 摆进假云端目录
（`NLC_COWORK_PACKAGES_DIR`），后端启动时按同一段安装代码装下去——
**开发态与真下发共用那段代码**，区别只是 zip 从哪来。
"""
from __future__ import annotations

import argparse
import json
import sys
import zipfile
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

FACETS = ("SOUL.md", "ROLE.md", "METADATA.md", "COMPACT.md")


def build_bytes(src: Path, *, sign: bool = True) -> bytes:
    """打成 zip 并返回字节。**假 substrate 现打现发时用这个** —— 它不落盘。

    与 `build()` 共用同一段：mock 发的必须是**真签名**的包，否则后端验签那关会拒
    （需求 D5），整套打桩就只能验到"下载失败"，验不到"装上了"。
    """
    manifest = json.loads((src / "cowork.json").read_text(encoding="utf-8"))
    cid = manifest["id"]

    missing = [f for f in FACETS if not (src / f).is_file()]
    if missing:
        raise SystemExit(f"{src} 缺 facet：{missing}（四个必须自带，见需求 A5）")

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(src.rglob("*")):
            if f.is_file():
                zf.writestr(f"{cid}/{f.relative_to(src).as_posix()}", f.read_bytes())
    data = buf.getvalue()

    if sign:
        from netlivecowork.cowork import signature
        data = signature.attach_signature(data)
    return data


def build(src: Path, out_dir: Path, *, sign: bool = True) -> Path:
    manifest = json.loads((src / "cowork.json").read_text(encoding="utf-8"))
    cid, version = manifest["id"], str(manifest["version"])
    data = build_bytes(src, sign=sign)

    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{cid}-{version}.zip"
    out.write_bytes(data)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("src", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--no-sign", action="store_true",
                    help="不签名（用来验证未签名的包会被拒）")
    a = ap.parse_args()
    p = build(a.src, a.out, sign=not a.no_sign)
    print(f"  {p}  ({p.stat().st_size} 字节)")


if __name__ == "__main__":
    main()

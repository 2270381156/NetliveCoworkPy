"""
Thin helper for running LibreOffice (soffice) headless — only when it is available.

This is used ONLY for the *optional* operations that genuinely need LibreOffice
(legacy .doc -> .docx conversion, rendering to PDF/images for an optional visual
pass). The entire core docx workflow — create, edit XML, validate, QA, accept
tracked changes — is pure Python and does NOT need this. If soffice is not
installed, those optional operations are simply unavailable; nothing else breaks.

Usage:
    from office.soffice import run_soffice, get_soffice_env
    result = run_soffice(["--headless", "--convert-to", "pdf", "input.docx"])
"""

import os
import subprocess


def get_soffice_env() -> dict:
    env = os.environ.copy()
    env["SAL_USE_VCLPLUGIN"] = "svp"  # headless rendering backend
    return env


def run_soffice(args: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(["soffice"] + args, env=get_soffice_env(), **kwargs)


if __name__ == "__main__":
    import sys

    result = run_soffice(sys.argv[1:])
    sys.exit(result.returncode)

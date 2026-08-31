#!/usr/bin/env python3
"""Lint a skill's structure — catch the ways a careless edit corrupts a skill.

Function: check the invariants every valid skill must keep, so a weak model
          editing it can't silently break it — bloated/extra metadata fields,
          a description written like a manual, broken `---` fences, a bad name,
          a missing body, a stray skill.yaml, or dangling file references.
Usage:    python scripts/check_skill.py <skill-dir | path/to/SKILL.md>
Output:   a report; exits non-zero if any hard rule (FAIL) is violated.
"""
import re
import sys
from pathlib import Path

# The only fields metadata should normally carry. Anything else usually means
# body content leaked into the frontmatter.
ALLOWED_FIELDS = {"name", "description", "license", "allowed-tools", "compatibility", "version"}


def _report(fails, warns):
    for w in warns:
        print("WARN:", w)
    for f in fails:
        print("FAIL:", f)
    print("RESULT:", "FAIL" if fails else "PASS")
    sys.exit(1 if fails else 0)


def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/check_skill.py <skill-dir | SKILL.md>", file=sys.stderr)
        sys.exit(2)
    target = Path(sys.argv[1])
    skill_md = target / "SKILL.md" if target.is_dir() else target
    skill_dir = skill_md.parent
    fails, warns = [], []

    if not skill_md.exists():
        print(f"FAIL: no SKILL.md found at {skill_md}")
        print("RESULT: FAIL")
        sys.exit(1)

    lines = skill_md.read_text(encoding="utf-8").splitlines()

    # 1) frontmatter fences must be intact
    if not lines or lines[0].strip() != "---":
        fails.append("SKILL.md must start with a '---' frontmatter fence on line 1")
        _report(fails, warns)
    close = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if close is None:
        fails.append("frontmatter is not closed with a second '---' (broken YAML fence — metadata and body are fused)")
        _report(fails, warns)

    fm_lines = lines[1:close]
    body = "\n".join(lines[close + 1:]).strip()

    # 2) parse top-level frontmatter fields (allowing multi-line values)
    fields, cur = {}, None
    for ln in fm_lines:
        m = re.match(r"^([A-Za-z][\w-]*):\s?(.*)$", ln)
        if m:
            cur = m.group(1)
            fields[cur] = m.group(2)
        elif cur and (ln.startswith(" ") or ln.startswith("\t")):
            fields[cur] += "\n" + ln.strip()
    keys = set(fields)

    if "name" not in fields:
        fails.append("frontmatter missing required field: name")
    if "description" not in fields:
        fails.append("frontmatter missing required field: description")

    extra = keys - ALLOWED_FIELDS
    if extra:
        fails.append(f"frontmatter has non-standard field(s): {sorted(extra)} — metadata may ONLY be "
                     f"name + description (plus optionally {sorted(ALLOWED_FIELDS - {'name', 'description'})}). "
                     f"Move anything else into the body or references/.")

    name = fields.get("name", "").strip().strip("\"'")
    if name and not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", name):
        fails.append(f"name must be lowercase-with-hyphens (no spaces/caps/underscores): got {name!r}")
    if name and skill_dir.name and name != skill_dir.name:
        warns.append(f"name ({name!r}) does not match the folder name ({skill_dir.name!r})")

    desc = fields.get("description", "").strip().strip("\"'")
    if not desc:
        fails.append("description is empty — it must say, in one short line, WHEN to use the skill")
    else:
        # A long description is fine (detailed triggering). What's NOT fine is BODY content
        # (steps/rules/code) leaking into the metadata — detect that by shape, not length.
        # code fences / markdown headings almost never belong in a description -> hard FAIL
        if "```" in desc or re.search(r"(^|\n)#{1,6}\s", desc):
            fails.append("description contains code/headings — it must be plain 'when to trigger' prose; "
                         "move that content into the body or references/")
        # softer signals that steps/rules leaked in -> WARN
        bloat = []
        if re.search(r"第\s*[一二三四五六七八九十0-9]+\s*步", desc):
            bloat.append("步骤(第N步)")
        if desc.count("\n") > 4:
            bloat.append("多行段落")
        if len(desc) > 1500:
            bloat.append(f"极长({len(desc)}字符)")
        if bloat:
            warns.append(f"description 里疑似夹带了正文内容（{', '.join(bloat)}）——它只该是'何时触发'的说明，"
                         f"把步骤/规则移到正文或 references/")

    # 3) body must actually exist
    if len(body) < 30:
        fails.append("SKILL.md has almost no body after the frontmatter — the instructions are missing")

    # 4) metadata must live in the frontmatter, not a separate file
    for stray in ("skill.yaml", "skill.yml", "metadata.yaml", "metadata.yml"):
        if (skill_dir / stray).exists():
            warns.append(f"found {stray} — metadata belongs in SKILL.md frontmatter, not a separate file")

    # 5) referenced bundled files should exist
    for ref in sorted(set(re.findall(r"(?:references|scripts|templates|assets|examples|evals)/[\w./-]+\.\w+", body))):
        if "xxx" in ref.lower() or "README" in ref:   # placeholder / conditional mention, not a real reference
            continue
        if not (skill_dir / ref).exists():
            warns.append(f"SKILL.md references a file that doesn't exist: {ref}")

    # 6) an interactive skill (uses ask_user in its body) must declare an interactive-type task
    #    in its description — the harness reads the task type from there. The "use ask_user"
    #    how-to is runtime behavior and belongs in the body, NOT the description.
    if "ask_user" in body and "interactive" not in fields.get("description", ""):
        warns.append("this skill uses ask_user in its body (it is interactive) but its description does not "
                     "declare an interactive-type task — add to the description: 使用此 skill 时创建一个 interactive 类型的任务 "
                     "(the 'use ask_user' how-to stays in the body, not the description)")

    _report(fails, warns)


if __name__ == "__main__":
    main()

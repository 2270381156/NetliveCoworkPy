# Host Skill Management API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add host REST endpoints for local skill CRUD + remote-marketplace pull, backing the already-complete desktop Skills UI.

**Architecture:** A new `providers/capability/skills/` package (sibling of `capability/mcp/`) holds a `SkillError` type, zip utilities (reusing core's SKILL.md parser), a `SkillPullStore`, a `LocalSkillService`, and a `SkillPullService`. A new `api/skills.py` router exposes them under `/api/v1/skills`, wired via `api/deps.py` singletons. Path resolution is centralized in a new `loomex_host/paths.py` shared by startup and deps.

**Tech Stack:** Python, FastAPI, httpx, pytest. Reuses `loomex_core.providers.capability_skill_local._parser`.

---

### Task 1: Centralize path resolution in `loomex_host/paths.py`

**Files:**
- Create: `src/loomex_host/paths.py`
- Modify: `src/loomex_host/api/startup.py:36-48` and call sites `197-199`
- Test: existing suite acts as regression guard

- [ ] **Step 1: Create the shared paths module**

Create `src/loomex_host/paths.py`:

```python
"""Centralized filesystem path resolution (shared by startup and deps)."""

from __future__ import annotations

from pathlib import Path

from loomex_host.config import get_settings


def resources_dir() -> Path:
    s = get_settings()
    return Path(s.resources_dir) if s.resources_dir else Path(__file__).parents[2] / "resources"


def skills_dir(override: str | None = None) -> Path:
    raw = override or get_settings().skills_dir
    return Path(raw) if raw else resources_dir() / "skills"


def agents_dir() -> Path:
    raw = get_settings().agents_dir
    return Path(raw) if raw else resources_dir() / "agents"


def data_dir() -> Path:
    raw = get_settings().data_dir
    return Path(raw) if raw else resources_dir()
```

- [ ] **Step 2: Point startup.py at the shared module**

In `src/loomex_host/api/startup.py`, replace the three local helpers (lines 36-48) with imports. Change the import block near line 16 to add:

```python
from loomex_host import paths
```

Delete the `_resources_dir`, `_resolve_skills_dir`, `_resolve_agents_dir` function definitions (lines 36-48). Then update `run_startup` body (lines 197-199) from:

```python
    resources = _resources_dir()
    skills_dir = _resolve_skills_dir(resources, skills_dir_override)
    agents_dir = _resolve_agents_dir(resources)
```

to:

```python
    skills_dir = paths.skills_dir(skills_dir_override)
    agents_dir = paths.agents_dir()
```

(Note: `skills_dir` / `agents_dir` remain local variables used later in the function — only their derivation changes. The `resources` variable is no longer needed.)

- [ ] **Step 3: Run the full suite to verify no regression**

Run: `python -m pytest tests/ -q`
Expected: PASS (same as before this task).

- [ ] **Step 4: Commit**

```bash
git add src/loomex_host/paths.py src/loomex_host/api/startup.py
git commit -m "refactor(host): centralize path resolution in paths.py"
```

---

### Task 2: `SkillError` and error-status map

**Files:**
- Create: `src/loomex_host/providers/capability/skills/__init__.py` (empty)
- Create: `src/loomex_host/providers/capability/skills/errors.py`
- Test: covered indirectly by later tasks (no standalone test — pure data)

- [ ] **Step 1: Create the package marker**

Create empty `src/loomex_host/providers/capability/skills/__init__.py` (zero bytes).

- [ ] **Step 2: Create errors.py**

Create `src/loomex_host/providers/capability/skills/errors.py`:

```python
"""Skill management errors + HTTP status mapping."""

from __future__ import annotations


class SkillError(Exception):
    """Domain error carrying a stable code and a human message."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


ERROR_STATUS: dict[str, int] = {
    "LOCAL_SKILL_NOT_FOUND": 404,
    "LOCAL_SKILL_INVALID_ID": 400,
    "LOCAL_SKILL_DELETE_FAILED": 500,
    "PULL_SERVER_NOT_CONFIGURED": 400,
    "PULL_SERVER_UNREACHABLE": 502,
    "PULL_SERVER_ERROR": 502,
    "REMOTE_SKILL_NOT_FOUND": 404,
    "PULL_EXTRACT_FAILED": 500,
    "IMPORT_INVALID_ZIP": 400,
    "IMPORT_MISSING_SKILL_MD": 400,
    "IMPORT_MISSING_NAME": 400,
    "IMPORT_MISSING_DESCRIPTION": 400,
    "IMPORT_EXTRACT_FAILED": 500,
}
```

- [ ] **Step 3: Commit**

```bash
git add src/loomex_host/providers/capability/skills/__init__.py src/loomex_host/providers/capability/skills/errors.py
git commit -m "feat(host): SkillError + error-status map for skills"
```

---

### Task 3: zip utilities (reuse core parser)

**Files:**
- Create: `src/loomex_host/providers/capability/skills/zip_utils.py`
- Test: `tests/test_skills_zip_utils.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_skills_zip_utils.py`:

```python
"""zip_utils: folder slug, skill-zip validation, single-root extraction."""
from __future__ import annotations

import io
import zipfile

import pytest

from loomex_host.providers.capability.skills.errors import SkillError
from loomex_host.providers.capability.skills import zip_utils


def _zip(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


_GOOD_MD = "---\nname: My Skill\ndescription: does things\nversion: 2.0\n---\nbody"


def test_sanitize_folder():
    assert zip_utils.sanitize_folder("My Skill!") == "my-skill"
    assert zip_utils.sanitize_folder("  ") == "skill"


def test_validate_ok_with_single_root():
    name, desc = zip_utils.validate_skill_zip(_zip({"my-skill/SKILL.md": _GOOD_MD}))
    assert name == "My Skill"
    assert desc == "does things"


def test_validate_not_a_zip():
    with pytest.raises(SkillError) as e:
        zip_utils.validate_skill_zip(b"not a zip")
    assert e.value.code == "IMPORT_INVALID_ZIP"


def test_validate_missing_skill_md():
    with pytest.raises(SkillError) as e:
        zip_utils.validate_skill_zip(_zip({"readme.txt": "hi"}))
    assert e.value.code == "IMPORT_MISSING_SKILL_MD"


def test_validate_missing_name():
    md = "---\ndescription: only desc\n---\nbody"
    with pytest.raises(SkillError) as e:
        zip_utils.validate_skill_zip(_zip({"SKILL.md": md}))
    assert e.value.code == "IMPORT_MISSING_NAME"


def test_extract_flattens_single_root(tmp_path):
    data = _zip({"my-skill/SKILL.md": _GOOD_MD, "my-skill/scripts/run.py": "print(1)"})
    dest = tmp_path / "out"
    zip_utils.extract_zip(data, dest)
    assert (dest / "SKILL.md").read_text(encoding="utf-8") == _GOOD_MD
    assert (dest / "scripts" / "run.py").exists()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_skills_zip_utils.py -q`
Expected: FAIL with `ModuleNotFoundError: ...skills.zip_utils`

- [ ] **Step 3: Implement zip_utils.py**

Create `src/loomex_host/providers/capability/skills/zip_utils.py`:

```python
"""ZIP helpers: validate a skill zip and extract it (single-root flattening)."""

from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path

from loomex_core.providers.capability_skill_local._parser import parse_skill_md

from .errors import SkillError


def sanitize_folder(name: str) -> str:
    slug = name.lower().strip()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    return slug.strip("-") or "skill"


def _find_skill_md(names: list[str]) -> str | None:
    top_level = {n.split("/")[0] for n in names}
    single_root = len(top_level) == 1 and all(
        n.startswith(next(iter(top_level)) + "/") for n in names
    )
    candidate = f"{next(iter(top_level))}/SKILL.md" if single_root else "SKILL.md"
    return candidate if candidate in names else None


def validate_skill_zip(data: bytes) -> tuple[str, str]:
    """Validate the zip, return (name, description). Raises SkillError on failure."""
    if not zipfile.is_zipfile(io.BytesIO(data)):
        raise SkillError("IMPORT_INVALID_ZIP", "上传的文件不是有效的 ZIP 包")

    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
        if not names:
            raise SkillError("IMPORT_INVALID_ZIP", "ZIP 包为空")
        skill_md_path = _find_skill_md(names)
        if skill_md_path is None:
            raise SkillError("IMPORT_MISSING_SKILL_MD", "ZIP 包中未找到 SKILL.md")
        try:
            content = zf.read(skill_md_path).decode("utf-8")
        except Exception as e:
            raise SkillError("IMPORT_INVALID_ZIP", f"无法读取 SKILL.md: {e}")

    meta, _ = parse_skill_md(content)
    if not meta.name:
        raise SkillError("IMPORT_MISSING_NAME", "SKILL.md frontmatter 缺少 name 字段")
    if not meta.description:
        raise SkillError("IMPORT_MISSING_DESCRIPTION", "SKILL.md frontmatter 缺少 description 字段")
    return meta.name, meta.description


def extract_zip(data: bytes, dest_dir: Path) -> None:
    """Extract zip into dest_dir; if it has a single top-level dir, flatten it."""
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
        if not names:
            raise SkillError("IMPORT_INVALID_ZIP", "ZIP 包为空")
        top_level = {n.split("/")[0] for n in names}
        single_root = len(top_level) == 1 and all(
            n.startswith(next(iter(top_level)) + "/") for n in names
        )
        root_prefix = (next(iter(top_level)) + "/") if single_root else ""

        dest_dir = Path(dest_dir)
        dest_dir.mkdir(parents=True, exist_ok=True)
        for member in zf.infolist():
            rel_path = member.filename
            if root_prefix:
                if not rel_path.startswith(root_prefix):
                    continue
                rel_path = rel_path[len(root_prefix):]
            if not rel_path:
                continue
            target = dest_dir / rel_path
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(zf.read(member.filename))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_skills_zip_utils.py -q`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
git add src/loomex_host/providers/capability/skills/zip_utils.py tests/test_skills_zip_utils.py
git commit -m "feat(host): skill zip_utils reusing core SKILL.md parser"
```

---

### Task 4: `SkillPullStore`

**Files:**
- Create: `src/loomex_host/providers/capability/skills/store.py`
- Test: `tests/test_skills_pull_store.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_skills_pull_store.py`:

```python
"""SkillPullStore: pulled-map persistence + reverse delete by folder."""
from __future__ import annotations

from loomex_host.providers.capability.skills.store import SkillPullStore


def test_record_and_map(tmp_path):
    s = SkillPullStore(tmp_path)
    s.record_pulled("r1", "folder-a")
    s.record_pulled("r2", "folder-b")
    assert s.get_pulled_map() == {"r1": "folder-a", "r2": "folder-b"}
    assert (tmp_path / "skill_pull_config.json").exists()


def test_remove_by_folder(tmp_path):
    s = SkillPullStore(tmp_path)
    s.record_pulled("r1", "folder-a")
    s.record_pulled("r2", "folder-a")
    s.record_pulled("r3", "folder-b")
    s.remove_pulled_by_folder("folder-a")
    assert s.get_pulled_map() == {"r3": "folder-b"}


def test_empty_when_missing(tmp_path):
    s = SkillPullStore(tmp_path)
    assert s.get_pulled_map() == {}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_skills_pull_store.py -q`
Expected: FAIL with `ModuleNotFoundError: ...skills.store`

- [ ] **Step 3: Implement store.py**

Create `src/loomex_host/providers/capability/skills/store.py`:

```python
"""SkillPullStore — records remote_id -> local_folder for pulled skills.

Layout: <data_dir>/skill_pull_config.json
Format: {"pulled": {"<remote_id>": "<local_folder>", ...}}
"""

from __future__ import annotations

import json
from pathlib import Path


class SkillPullStore:
    def __init__(self, data_dir: Path) -> None:
        self._dir = Path(data_dir)

    def _path(self) -> Path:
        return self._dir / "skill_pull_config.json"

    def _load(self) -> dict:
        path = self._path()
        if not path.exists():
            return {"pulled": {}}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {"pulled": {}}
        data.setdefault("pulled", {})
        return data

    def _save(self, data: dict) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        tmp = self._path().with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self._path())

    def record_pulled(self, remote_id: str, local_folder: str) -> None:
        data = self._load()
        data["pulled"][remote_id] = local_folder
        self._save(data)

    def remove_pulled_by_folder(self, local_folder: str) -> None:
        data = self._load()
        to_delete = [k for k, v in data["pulled"].items() if v == local_folder]
        if not to_delete:
            return
        for k in to_delete:
            del data["pulled"][k]
        self._save(data)

    def get_pulled_map(self) -> dict[str, str]:
        return self._load()["pulled"]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_skills_pull_store.py -q`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add src/loomex_host/providers/capability/skills/store.py tests/test_skills_pull_store.py
git commit -m "feat(host): SkillPullStore for pulled-skill mapping"
```

---

### Task 5: `LocalSkillService`

**Files:**
- Create: `src/loomex_host/providers/capability/skills/local_service.py`
- Test: `tests/test_skills_local_service.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_skills_local_service.py`:

```python
"""LocalSkillService: import -> list -> delete roundtrip + guards."""
from __future__ import annotations

import io
import zipfile

import pytest

from loomex_host.providers.capability.skills.errors import SkillError
from loomex_host.providers.capability.skills.local_service import LocalSkillService
from loomex_host.providers.capability.skills.store import SkillPullStore


def _zip(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


_MD = (
    "---\nname: My Skill\ndescription: does things\nversion: 2.0\n"
    "triggers:\n  - foo\n  - bar\n---\nbody"
)


@pytest.fixture
def svc(tmp_path):
    skills = tmp_path / "skills"
    skills.mkdir()
    return LocalSkillService(skills_dir=skills, pull_store=SkillPullStore(tmp_path / "data"))


def test_import_then_list(svc):
    meta = svc.import_skill(_zip({"my-skill/SKILL.md": _MD}))
    assert meta["skill_id"] == "my-skill"
    assert meta["name"] == "My Skill"
    listing = svc.list_skills()
    assert len(listing) == 1
    assert listing[0]["skill_id"] == "my-skill"
    assert listing[0]["version"] == "2.0"
    assert listing[0]["triggers"] == ["foo", "bar"]


def test_delete(svc):
    svc.import_skill(_zip({"my-skill/SKILL.md": _MD}))
    svc.delete_skill("my-skill")
    assert svc.list_skills() == []


def test_delete_not_found(svc):
    with pytest.raises(SkillError) as e:
        svc.delete_skill("nope")
    assert e.value.code == "LOCAL_SKILL_NOT_FOUND"


def test_delete_path_traversal(svc):
    with pytest.raises(SkillError) as e:
        svc.delete_skill("../evil")
    assert e.value.code == "LOCAL_SKILL_INVALID_ID"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_skills_local_service.py -q`
Expected: FAIL with `ModuleNotFoundError: ...skills.local_service`

- [ ] **Step 3: Implement local_service.py**

Create `src/loomex_host/providers/capability/skills/local_service.py`:

```python
"""LocalSkillService — list/delete/import skills under skills_dir."""

from __future__ import annotations

import shutil
from pathlib import Path

from loomex_core.providers.capability_skill_local._parser import load_skill_md

from .errors import SkillError
from .store import SkillPullStore
from .zip_utils import extract_zip, sanitize_folder, validate_skill_zip


class LocalSkillService:
    def __init__(self, skills_dir: Path, pull_store: SkillPullStore) -> None:
        self._skills_dir = Path(skills_dir)
        self._pull_store = pull_store

    def list_skills(self) -> list[dict]:
        result: list[dict] = []
        if not self._skills_dir.exists():
            return result
        for skill_dir in sorted(self._skills_dir.iterdir()):
            if not skill_dir.is_dir() or not (skill_dir / "SKILL.md").exists():
                continue
            try:
                meta, _ = load_skill_md(skill_dir)
            except Exception:
                continue
            result.append({
                "skill_id": skill_dir.name,
                "name": meta.name or skill_dir.name,
                "description": meta.description,
                "version": meta.version,
                "triggers": meta.triggers,
            })
        return result

    def delete_skill(self, skill_id: str) -> None:
        if not skill_id or "/" in skill_id or "\\" in skill_id or skill_id in (".", ".."):
            raise SkillError("LOCAL_SKILL_INVALID_ID", f"Invalid skill_id: '{skill_id}'")

        skill_dir = (self._skills_dir / skill_id).resolve()
        try:
            skill_dir.relative_to(self._skills_dir.resolve())
        except ValueError:
            raise SkillError("LOCAL_SKILL_INVALID_ID", f"Invalid skill_id: '{skill_id}'")

        if not skill_dir.exists() or not (skill_dir / "SKILL.md").exists():
            raise SkillError("LOCAL_SKILL_NOT_FOUND", f"Skill '{skill_id}' not found")

        try:
            shutil.rmtree(skill_dir)
        except Exception as e:
            raise SkillError("LOCAL_SKILL_DELETE_FAILED", f"Failed to delete skill '{skill_id}': {e}")

        self._pull_store.remove_pulled_by_folder(skill_id)

    def import_skill(self, data: bytes) -> dict:
        name, _ = validate_skill_zip(data)
        folder_name = sanitize_folder(name)
        dest_dir = self._skills_dir / folder_name
        try:
            extract_zip(data, dest_dir)
        except SkillError:
            raise
        except Exception as e:
            raise SkillError("IMPORT_EXTRACT_FAILED", f"解压失败: {e}")
        meta, _ = load_skill_md(dest_dir)
        return {
            "skill_id": folder_name,
            "name": meta.name or folder_name,
            "description": meta.description,
            "version": meta.version,
            "triggers": meta.triggers,
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_skills_local_service.py -q`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add src/loomex_host/providers/capability/skills/local_service.py tests/test_skills_local_service.py
git commit -m "feat(host): LocalSkillService (list/delete/import)"
```

---

### Task 6: `SkillPullService`

**Files:**
- Create: `src/loomex_host/providers/capability/skills/pull_service.py`
- Test: `tests/test_skills_pull_service.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_skills_pull_service.py`:

```python
"""SkillPullService: remote catalog merge, pull extraction, config guard."""
from __future__ import annotations

import io
import zipfile

import httpx
import pytest

from loomex_host.providers.capability.skills.errors import SkillError
from loomex_host.providers.capability.skills.pull_service import SkillPullService
from loomex_host.providers.capability.skills.store import SkillPullStore


_MD = "---\nname: Remote Skill\ndescription: d\n---\nbody"


def _zip_bytes() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("remote-skill/SKILL.md", _MD)
    return buf.getvalue()


class _FakeClient:
    """Minimal httpx.Client stand-in driven by a routes dict."""

    def __init__(self, routes):
        self._routes = routes

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get(self, url, headers=None):
        return self._routes[("GET", url)]

    def post(self, url, files=None):
        return self._routes[("POST", url)]


def _resp(status=200, json_body=None, content=b"", url="http://x"):
    request = httpx.Request("GET", url)
    return httpx.Response(status, json=json_body, content=content if json_body is None else None, request=request)


def _svc(tmp_path, server="http://srv/api"):
    return SkillPullService(
        server_url=server,
        skills_dir=tmp_path / "skills",
        store=SkillPullStore(tmp_path / "data"),
    )


def test_list_remote_merges_is_pulled(tmp_path, monkeypatch):
    store = SkillPullStore(tmp_path / "data")
    store.record_pulled("r1", "remote-skill")
    svc = SkillPullService(server_url="http://srv/api", skills_dir=tmp_path / "skills", store=store)

    routes = {("GET", "http://srv/api/skills"): _resp(
        200, json_body=[
            {"id": "r1", "name": "A", "description": "da", "domain": "x", "createTime": "t"},
            {"id": "r2", "name": "B"},
        ],
    )}
    monkeypatch.setattr(httpx, "Client", lambda **kw: _FakeClient(routes))

    items = svc.list_remote()
    by_id = {i["id"]: i for i in items}
    assert by_id["r1"]["is_pulled"] is True
    assert by_id["r1"]["create_time"] == "t"
    assert by_id["r2"]["is_pulled"] is False
    assert by_id["r2"]["description"] is None


def test_pull_writes_and_records(tmp_path, monkeypatch):
    svc = _svc(tmp_path)
    routes = {("GET", "http://srv/api/skills/r9/export"): _resp(200, content=_zip_bytes())}
    monkeypatch.setattr(httpx, "Client", lambda **kw: _FakeClient(routes))

    out = svc.pull_skill("r9", "Remote Skill")
    assert out == {"skill_id": "remote-skill", "name": "Remote Skill"}
    assert (tmp_path / "skills" / "remote-skill" / "SKILL.md").exists()
    assert SkillPullStore(tmp_path / "data").get_pulled_map() == {"r9": "remote-skill"}


def test_not_configured(tmp_path):
    svc = _svc(tmp_path, server="")
    with pytest.raises(SkillError) as e:
        svc.list_remote()
    assert e.value.code == "PULL_SERVER_NOT_CONFIGURED"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_skills_pull_service.py -q`
Expected: FAIL with `ModuleNotFoundError: ...skills.pull_service`

- [ ] **Step 3: Implement pull_service.py**

Create `src/loomex_host/providers/capability/skills/pull_service.py`:

```python
"""SkillPullService — pull skills from a remote marketplace server."""

from __future__ import annotations

from pathlib import Path

import httpx

from .errors import SkillError
from .store import SkillPullStore
from .zip_utils import extract_zip, sanitize_folder

_TIMEOUT = 30
_HEADERS = {"Accept": "application/json"}


class SkillPullService:
    def __init__(self, server_url: str, skills_dir: Path, store: SkillPullStore) -> None:
        self._server_url = (server_url or "").rstrip("/")
        self._skills_dir = Path(skills_dir)
        self._store = store

    def _require_url(self) -> str:
        if not self._server_url:
            raise SkillError("PULL_SERVER_NOT_CONFIGURED", "远端 Skill 服务器 URL 未配置")
        return self._server_url

    def list_remote(self) -> list[dict]:
        url = self._require_url()
        try:
            with httpx.Client(trust_env=False, timeout=_TIMEOUT) as client:
                resp = client.get(f"{url}/skills", headers=_HEADERS)
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise SkillError("PULL_SERVER_ERROR", f"远端服务器返回 {e.response.status_code}：{e.response.text[:500]}")
        except SkillError:
            raise
        except Exception as e:
            raise SkillError("PULL_SERVER_UNREACHABLE", f"无法连接远端服务器: {e}")

        pulled_map = self._store.get_pulled_map()
        return [
            {
                "id": item["id"],
                "name": item["name"],
                "description": item.get("description"),
                "domain": item.get("domain"),
                "create_time": item.get("createTime"),
                "is_pulled": item["id"] in pulled_map,
            }
            for item in resp.json()
        ]

    def pull_skill(self, remote_id: str, skill_name: str) -> dict:
        url = self._require_url()
        try:
            with httpx.Client(trust_env=False, timeout=_TIMEOUT) as client:
                resp = client.get(
                    f"{url}/skills/{remote_id}/export",
                    headers={**_HEADERS, "Accept": "application/zip,application/octet-stream,*/*"},
                )
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                raise SkillError("REMOTE_SKILL_NOT_FOUND", f"远端 skill '{remote_id}' 不存在")
            raise SkillError("PULL_SERVER_ERROR", f"远端服务器返回 {e.response.status_code}：{e.response.text[:500]}")
        except SkillError:
            raise
        except Exception as e:
            raise SkillError("PULL_SERVER_UNREACHABLE", f"无法连接远端服务器: {e}")

        try:
            folder_name = sanitize_folder(skill_name)
            extract_zip(resp.content, self._skills_dir / folder_name)
        except SkillError:
            raise
        except Exception as e:
            raise SkillError("PULL_EXTRACT_FAILED", f"解压失败: {e}")

        self._store.record_pulled(remote_id, folder_name)
        return {"skill_id": folder_name, "name": skill_name}

    def import_to_remote(self, data: bytes, filename: str) -> dict:
        url = self._require_url()
        try:
            with httpx.Client(trust_env=False, timeout=_TIMEOUT) as client:
                resp = client.post(
                    f"{url}/skills/import",
                    files={"file": (filename, data, "application/zip")},
                )
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise SkillError("PULL_SERVER_ERROR", f"远端服务器返回 {e.response.status_code}：{e.response.text[:500]}")
        except SkillError:
            raise
        except Exception as e:
            raise SkillError("PULL_SERVER_UNREACHABLE", f"无法连接远端服务器: {e}")

        item = resp.json()
        return {"skill_id": item.get("id", ""), "name": item.get("name", "")}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_skills_pull_service.py -q`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add src/loomex_host/providers/capability/skills/pull_service.py tests/test_skills_pull_service.py
git commit -m "feat(host): SkillPullService (remote catalog/pull/import)"
```

---

### Task 7: API schemas

**Files:**
- Create: `src/loomex_host/api/schemas/skills.py`
- Test: none standalone (exercised by Task 9)

- [ ] **Step 1: Create schemas/skills.py**

Create `src/loomex_host/api/schemas/skills.py`:

```python
"""Skill management response models (match frontend-desktop/src/api/skills.ts)."""

from __future__ import annotations

from pydantic import BaseModel


class LocalSkillResponse(BaseModel):
    skill_id: str
    name: str
    description: str
    version: str
    triggers: list[str]


class RemoteCatalogItem(BaseModel):
    id: str
    name: str
    description: str | None
    domain: str | None
    create_time: str | None
    is_pulled: bool


class PullSkillResponse(BaseModel):
    skill_id: str
    name: str
```

- [ ] **Step 2: Commit**

```bash
git add src/loomex_host/api/schemas/skills.py
git commit -m "feat(host): skill API response schemas"
```

---

### Task 8: config + deps wiring

**Files:**
- Modify: `src/loomex_host/config.py:96` (field) and `:140` (from_env); docstring `:21`
- Modify: `src/loomex_host/api/deps.py`
- Test: `tests/test_host_config.py` (extend)

- [ ] **Step 1: Write the failing config test**

Append to `tests/test_host_config.py`:

```python
def test_skill_pull_server_url_default_and_override(monkeypatch):
    from loomex_host.config import Settings

    monkeypatch.delenv("LoomeX_SKILL_PULL_SERVER_URL", raising=False)
    assert Settings.from_env().skill_pull_server_url == "http://10.25.228.203:8080/api"

    monkeypatch.setenv("LoomeX_SKILL_PULL_SERVER_URL", "http://example.com/api")
    assert Settings.from_env().skill_pull_server_url == "http://example.com/api"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_host_config.py::test_skill_pull_server_url_default_and_override -q`
Expected: FAIL with `TypeError` (unexpected/missing field) or `AttributeError`

- [ ] **Step 3: Add the config field**

In `src/loomex_host/config.py`, add the dataclass field after line 96 (`llm_max_http_retries: int`):

```python
    skill_pull_server_url: str
```

In `from_env` (after the `llm_max_http_retries=...` line, before the closing `)`), add:

```python
            skill_pull_server_url=_str(
                "LoomeX_SKILL_PULL_SERVER_URL", "http://10.25.228.203:8080/api"
            ) or "http://10.25.228.203:8080/api",
```

In the module docstring env list (near line 21, after the `LoomeX_SKILL_SCRIPT_TIMEOUT_SEC / LoomeX_SKILL_OUTPUT_LIMIT_CHARS` line), add:

```
  LoomeX_SKILL_PULL_SERVER_URL
```

- [ ] **Step 4: Run config test to verify it passes**

Run: `python -m pytest tests/test_host_config.py -q`
Expected: PASS

- [ ] **Step 5: Add deps singletons**

In `src/loomex_host/api/deps.py`, add near the top imports (after `from fastapi import HTTPException`):

```python
from functools import lru_cache

from loomex_host import paths
from loomex_host.config import get_settings
from loomex_host.providers.capability.skills.local_service import LocalSkillService
from loomex_host.providers.capability.skills.pull_service import SkillPullService
from loomex_host.providers.capability.skills.store import SkillPullStore
```

At the end of the file add:

```python
# ── Skill management services ─────────────────────────────────────────────────

@lru_cache
def get_local_skill_service() -> LocalSkillService:
    return LocalSkillService(
        skills_dir=paths.skills_dir(),
        pull_store=SkillPullStore(paths.data_dir()),
    )


@lru_cache
def get_skill_pull_service() -> SkillPullService:
    return SkillPullService(
        server_url=get_settings().skill_pull_server_url,
        skills_dir=paths.skills_dir(),
        store=SkillPullStore(paths.data_dir()),
    )
```

- [ ] **Step 6: Run config test + import check**

Run: `python -m pytest tests/test_host_config.py -q && python -c "from loomex_host.api import deps; print('ok')"`
Expected: PASS then `ok`

- [ ] **Step 7: Commit**

```bash
git add src/loomex_host/config.py src/loomex_host/api/deps.py tests/test_host_config.py
git commit -m "feat(host): config skill_pull_server_url + deps skill singletons"
```

---

### Task 9: API router + app wiring

**Files:**
- Create: `src/loomex_host/api/skills.py`
- Modify: `src/loomex_host/api/main.py:58-64` (import + include_router)
- Test: `tests/test_skills_routes.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_skills_routes.py`:

```python
"""Route layer: error-code -> HTTP status mapping + list happy path."""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from loomex_host.api import skills as skills_api
from loomex_host.providers.capability.skills.errors import SkillError


class _FakeLocal:
    def __init__(self, listing=None, raises=None):
        self._listing = listing or []
        self._raises = raises

    def list_skills(self):
        return self._listing

    def delete_skill(self, skill_id):
        if self._raises:
            raise self._raises


def test_list_maps_to_response():
    svc = _FakeLocal(listing=[{
        "skill_id": "a", "name": "A", "description": "d", "version": "1.0", "triggers": ["t"],
    }])
    out = skills_api.list_local_skills(service=svc)
    assert out[0].skill_id == "a"
    assert out[0].triggers == ["t"]


def test_delete_not_found_maps_to_404():
    svc = _FakeLocal(raises=SkillError("LOCAL_SKILL_NOT_FOUND", "nope"))
    with pytest.raises(HTTPException) as e:
        skills_api.delete_local_skill("x", service=svc)
    assert e.value.status_code == 404
    assert e.value.detail["code"] == "LOCAL_SKILL_NOT_FOUND"


def test_delete_invalid_id_maps_to_400():
    svc = _FakeLocal(raises=SkillError("LOCAL_SKILL_INVALID_ID", "bad"))
    with pytest.raises(HTTPException) as e:
        skills_api.delete_local_skill("../x", service=svc)
    assert e.value.status_code == 400
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_skills_routes.py -q`
Expected: FAIL with `ModuleNotFoundError: loomex_host.api.skills`

- [ ] **Step 3: Implement the router**

Create `src/loomex_host/api/skills.py`:

```python
"""Skill management routes (local CRUD + remote marketplace pull)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from . import deps
from .schemas.skills import LocalSkillResponse, PullSkillResponse, RemoteCatalogItem
from loomex_host.providers.capability.skills.errors import ERROR_STATUS, SkillError

router = APIRouter(prefix="/skills", tags=["skills"])


def _http(e: SkillError) -> HTTPException:
    return HTTPException(
        status_code=ERROR_STATUS.get(e.code, 400),
        detail={"code": e.code, "message": e.message},
    )


# ── Local skills ──────────────────────────────────────────────────────────────

@router.post("/import", response_model=LocalSkillResponse)
async def import_local_skill(
    file: UploadFile = File(...),
    service=Depends(deps.get_local_skill_service),
) -> LocalSkillResponse:
    data = await file.read()
    try:
        return LocalSkillResponse(**service.import_skill(data))
    except SkillError as e:
        raise _http(e)


@router.get("", response_model=list[LocalSkillResponse])
def list_local_skills(
    service=Depends(deps.get_local_skill_service),
) -> list[LocalSkillResponse]:
    return [LocalSkillResponse(**item) for item in service.list_skills()]


@router.delete("/{skill_id}", status_code=204)
def delete_local_skill(
    skill_id: str,
    service=Depends(deps.get_local_skill_service),
) -> None:
    try:
        service.delete_skill(skill_id)
    except SkillError as e:
        raise _http(e)


# ── Remote marketplace (these MUST be registered before /{skill_id}) ──────────

@router.post("/pull-server/import", response_model=PullSkillResponse)
async def import_remote_skill(
    file: UploadFile = File(...),
    service=Depends(deps.get_skill_pull_service),
) -> PullSkillResponse:
    data = await file.read()
    try:
        return PullSkillResponse(**service.import_to_remote(data, file.filename or "skill.zip"))
    except SkillError as e:
        raise _http(e)


@router.get("/pull-server/catalog", response_model=list[RemoteCatalogItem])
def list_remote_catalog(
    service=Depends(deps.get_skill_pull_service),
) -> list[RemoteCatalogItem]:
    try:
        return [RemoteCatalogItem(**item) for item in service.list_remote()]
    except SkillError as e:
        raise _http(e)


@router.post("/pull-server/catalog/{remote_id}/pull", response_model=PullSkillResponse)
def pull_skill(
    remote_id: str,
    body: dict,
    service=Depends(deps.get_skill_pull_service),
) -> PullSkillResponse:
    skill_name = (body.get("name") or "").strip()
    if not skill_name:
        raise HTTPException(status_code=400, detail={"code": "MISSING_NAME", "message": "name 不能为空"})
    try:
        return PullSkillResponse(**service.pull_skill(remote_id, skill_name))
    except SkillError as e:
        raise _http(e)
```

Note: `list_local_skills` / `delete_local_skill` accept `service` as a parameter (defaulting to the `Depends`), so the unit test can pass a fake directly. FastAPI still injects the dependency at request time.

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_skills_routes.py -q`
Expected: PASS (3 passed)

- [ ] **Step 5: Wire the router into the app**

In `src/loomex_host/api/main.py`, add to the import block (after line 58 `from loomex_host.api.workspace import router as workspace_router`):

```python
    from loomex_host.api.skills import router as skills_router
```

And after line 64 (`app.include_router(workspace_router, prefix="/api/v1")`), add:

```python
    app.include_router(skills_router, prefix="/api/v1")
```

- [ ] **Step 6: Verify the router exposes the expected paths**

Run:
```bash
python -c "from loomex_host.api.skills import router; print(sorted(r.path for r in router.routes))"
```
Expected: `['/skills', '/skills/import', '/skills/pull-server/catalog', '/skills/pull-server/catalog/{remote_id}/pull', '/skills/pull-server/import', '/skills/{skill_id}']` (router prefix `/skills`; the app adds `/api/v1`).

- [ ] **Step 7: Commit**

```bash
git add src/loomex_host/api/skills.py src/loomex_host/api/main.py tests/test_skills_routes.py
git commit -m "feat(host): skills API router wired into app"
```

---

### Task 10: Full suite + final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite**

Run: `python -m pytest tests/ -q`
Expected: PASS (all green, including the new skill tests and pre-existing tests).

- [ ] **Step 2: Sanity-check the route table + that main wires the prefix**

Run:
```bash
python -c "from loomex_host.api.skills import router; print('\n'.join(sorted(f'{sorted(r.methods)} {r.path}' for r in router.routes)))" && grep -n "skills_router" src/loomex_host/api/main.py
```
Expected: GET/POST/DELETE across the six skill paths matching `frontend-desktop/src/api/skills.ts`, and two `skills_router` lines in main.py (import + include_router with prefix `/api/v1`).

- [ ] **Step 3: Commit (if any uncommitted verification fixups)**

```bash
git add -A && git commit -m "test(host): full suite green for skill management API" || echo "nothing to commit"
```

---

## Self-Review Notes

- **Spec coverage:** all 6 endpoints (Task 9), schemas (Task 7), `SkillError`+status map (Task 2), zip utils reusing core parser (Task 3), `SkillPullStore` (Task 4), `LocalSkillService` (Task 5), `SkillPullService` (Task 6), config field (Task 8), deps singletons (Task 8), main wiring (Task 9), centralized paths (Task 1), tests (Tasks 3-6, 8, 9). Watcher-based cache refresh needs no code (noted in spec).
- **Type consistency:** `LocalSkillService(skills_dir=, pull_store=)`, `SkillPullService(server_url=, skills_dir=, store=)`, `SkillPullStore(data_dir)`, `parse_skill_md`/`load_skill_md` return `(SkillFileMetadata, body)` with `.name/.description/.version/.triggers` — used consistently. `SkillError(code, message)` with `.code/.message` throughout.
- **No placeholders:** every code step is complete and runnable.

# Host Skill Management API — Design

Date: 2026-06-13
Status: Approved (pending spec review)

## Problem

The desktop frontend (`frontend-desktop`) already ships a complete Skills UI —
`SkillsPage.tsx` / `SkillsDialog.tsx` components, the `api/skills.ts` client, and
navigation wiring in `App.tsx` (`centerView === 'skills'`). But the LoomeX host
exposes **no REST endpoints** to back it. The core has a
`LocalSkillCapabilityProvider` that lets agents *discover and execute* skills,
but there is no management (CRUD + remote pull) layer.

The reference implementation is miniAgents'
`app/api/v1/routes/local_skills.py` plus its service/store/zip layers. This work
ports that capability onto the host.

## Endpoints (consumed by `frontend-desktop/src/api/skills.ts`, prefix `/api/v1`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/skills` | List local skills |
| DELETE | `/skills/{skill_id}` | Delete a local skill (and its directory) |
| POST | `/skills/import` | Upload a zip, import as local skill |
| GET | `/skills/pull-server/catalog` | List remote marketplace skills |
| POST | `/skills/pull-server/catalog/{remote_id}/pull` | Pull a remote skill locally |
| POST | `/skills/pull-server/import` | Upload a zip to the remote server |

`skill_id` is the **folder name** under `skills_dir` (matches miniAgents). The
core provider only exposes `meta.name`, not the folder, so the list endpoint
scans `skills_dir` directly rather than reusing the provider's `list()`.

## Response schemas (must match `skills.ts` exactly)

- `LocalSkillResponse`: `skill_id, name, description, version, triggers[]`
- `RemoteCatalogItem`: `id, name, description|null, domain|null, create_time|null, is_pulled`
- `PullSkillResponse`: `skill_id, name`

## Layout

New package `src/loomex_host/providers/capability/skills/` (sibling of the
existing `capability/mcp/`; the directory previously held an abandoned
`RemoteSkillSourceManager`, removed in commit `6e63837` — repurposed here):

- `__init__.py`
- `errors.py` — `SkillError(code, message)` + `ERROR_STATUS` (code → HTTP status,
  ported from miniAgents `_ERROR_STATUS`).
- `zip_utils.py` — `sanitize_folder`, `validate_skill_zip`, `extract_zip`. Ported
  from miniAgents; `AppError` → `SkillError`; SKILL.md parsing reuses core's
  `loomex_core.providers.capability_skill_local._parser.parse_skill_md`
  (single source of truth).
- `store.py` — `SkillPullStore`, persists `data_dir/skill_pull_config.json`
  mapping `remote_id → local_folder` (atomic write).
- `local_service.py` — `LocalSkillService`:
  - `list_skills()` — scan `skills_dir/*/SKILL.md`, metadata via core
    `load_skill_md`, `skill_id = dir.name`.
  - `delete_skill(skill_id)` — path-traversal guard, `rmtree`, clear pull record.
  - `import_skill(data)` — `validate_skill_zip` → `extract_zip` to `skills_dir`.
- `pull_service.py` — `SkillPullService` (httpx against the remote server):
  - `list_remote()` — GET `{server}/skills`, merge `is_pulled` from store.
  - `pull_skill(remote_id, name)` — GET `{server}/skills/{id}/export`, extract,
    record pull.
  - `import_to_remote(data, filename)` — POST `{server}/skills/import`.

New API files:

- `src/loomex_host/api/skills.py` — router (prefix `/skills`); `pull-server/*`
  routes registered **before** `/{skill_id}`; maps `SkillError.code` →
  `HTTPException` via `ERROR_STATUS`.
- `src/loomex_host/api/schemas/skills.py` — the three response models above.

## Changes to existing files

- `config.py` — add `skill_pull_server_url` field, env
  `LoomeX_SKILL_PULL_SERVER_URL`, default `http://10.25.228.203:8080/api`
  (carried over from miniAgents); document it in the env docstring list.
- `api/deps.py` — `get_local_skill_service()` / `get_skill_pull_service()`
  (`@lru_cache` singletons). Both need resolved `skills_dir` + `data_dir`;
  `server_url` from `Settings`. To avoid drift, lift startup.py's
  `_resolve_skills_dir` (and the analogous `data_dir` resolution) into a shared
  helper both startup and deps call.
- `api/main.py` — `include_router(skills_router, prefix="/api/v1")`.

## Not changed

- Frontend — already complete.
- Core `LocalSkillCapabilityProvider` — the list endpoint scans the directory
  itself; the existing directory watcher already invalidates the provider cache
  after import/delete/pull, so agent-side discovery stays fresh.

## Error handling

Port miniAgents' code→status map: `LOCAL_SKILL_NOT_FOUND`→404,
`LOCAL_SKILL_INVALID_ID`→400, `LOCAL_SKILL_DELETE_FAILED`→500,
`PULL_SERVER_NOT_CONFIGURED`→400, `PULL_SERVER_UNREACHABLE`→502,
`PULL_SERVER_ERROR`→502, `REMOTE_SKILL_NOT_FOUND`→404, `PULL_EXTRACT_FAILED`→500,
`IMPORT_*`→400/500. Route raises `HTTPException(status, {code, message})` so the
frontend client (`err.detail?.message`) renders it.

## Testing

`tests/test_skills_api.py` (FastAPI `TestClient`, temp `skills_dir`/`data_dir`):

- Local: import a built zip → appears in list → delete → gone. Invalid zip /
  missing SKILL.md / missing name → correct error codes & statuses. Path
  traversal in `skill_id` → 400.
- Remote: monkeypatch httpx — catalog merges `is_pulled` from store; pull writes
  the folder and records the mapping; unreachable server → 502.

## Open questions

None — scope (local + remote market), parser reuse, and default URL all
confirmed with the user.

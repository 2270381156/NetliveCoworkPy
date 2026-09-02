# Profile Skill Presets Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let downloaded cowork profiles declare default remote Skill references that are reconciled on startup, profile refresh, and W3 login without adding Electron UI states or permanently downloading Skill ZIPs.

**Architecture:** Extend the tolerant cowork manifest with complete preset L1 metadata, upgrade remote references to a scoped/principal-aware opaque identity, and add a pure profile-preset reconciler with atomic store commits. Shared sources reconcile during host assembly, per-user sources reconcile after W3 identity is known, and runtime materialization routes through the stored market scope.

**Tech Stack:** Python 3.11, dataclasses, JSON/atomic `Path.replace`, FastAPI, pytest, React 19, TypeScript, Vitest.

---

## Constraints and references

- Design: `docs/plans/2026-09-02-profile-skill-presets-design.md`
- Existing manifest model/parser: `src/netlivecowork/cowork/manifest.py`, `manifest_parse.py`
- Existing reference store: `src/netlivecowork/providers/capability/skills/references/store.py`
- Existing market aggregation: `src/netlivecowork/providers/capability/skills/services/market.py`
- Existing single source for profile-derived state: `src/netlivecowork/bootstrap/host_runtime.py::apply_cowork_state`
- Preserve tolerant runtime parsing: one malformed preset is skipped; it does not make the whole profile unusable.
- Enforce runtime count and metadata-length limits in this repository. Strict profile authoring/publishing validation is an upstream integration dependency because no publisher exists in this repository; it must reuse the same contract before this feature is released end to end.
- Do not access the network during preset reconciliation.
- Do not modify the vendored `ctx_weft` wheel.
- Use @superpowers:test-driven-development for every task and @superpowers:verification-before-completion before claiming completion.

### Task 1: Parse profile Skill presets

**Files:**
- Modify: `src/netlivecowork/cowork/manifest.py`
- Modify: `src/netlivecowork/cowork/manifest_parse.py`
- Modify: `tests/test_cowork_manifest.py`

**Step 1: Write failing parser tests**

Add tests covering a valid list, malformed list entries, normalized strings, duplicate entries, the preset-count limit, and every metadata-length limit:

```python
def test_manifest_parses_skill_presets():
    c = parse(_raw(skills={
        "pullServerUrl": "https://cowork",
        "presets": [{
            "source": "mythos",
            "remoteId": "1129",
            "name": "调用量上报",
            "description": "上报调用量",
            "version": "1.0",
            "triggers": ["调用量", "上报"],
        }],
    }))
    assert c is not None
    assert c.skill_presets == (SkillPreset(
        source="mythos",
        remote_id="1129",
        name="调用量上报",
        description="上报调用量",
        version="1.0",
        triggers=("调用量", "上报"),
    ),)


def test_manifest_skips_invalid_and_duplicate_skill_presets(caplog):
    c = parse(_raw(skills={"presets": [
        {"source": "cowork", "remoteId": "1", "name": "A", "description": "d"},
        {"source": "cowork", "remoteId": "1", "name": "duplicate", "description": "d"},
        {"source": "", "remoteId": "2", "name": "bad", "description": "d"},
        "not-an-object",
    ]}))
    assert [(p.source, p.remote_id) for p in c.skill_presets] == [("cowork", "1")]
    assert "preset" in caplog.text.lower()


def test_manifest_limits_skill_preset_count_and_metadata(caplog): ...
```

**Step 2: Run the tests and verify failure**

Run:

```powershell
uv run pytest tests/test_cowork_manifest.py -q
```

Expected: FAIL because `SkillPreset` and `Cowork.skill_presets` do not exist.

**Step 3: Add the immutable runtime model**

Add to `manifest.py`:

```python
@dataclass(frozen=True)
class SkillPreset:
    source: str
    remote_id: str
    name: str
    description: str
    version: str = ""
    triggers: tuple[str, ...] = ()


@dataclass(frozen=True)
class Cowork:
    # existing fields stay unchanged
    skill_presets: tuple[SkillPreset, ...] = ()
```

**Step 4: Implement tolerant parsing**

Add a `_skill_presets(raw)` helper in `manifest_parse.py`. It must:

- accept only a list/tuple;
- inspect at most `MAX_SKILL_PRESETS = 128` entries and log when the input is longer;
- require non-empty `source`, `remoteId`, `name`, and `description`;
- reject an item when `source` exceeds 64 characters, `remoteId` 256, `name` 200, `description` 4,000, or `version` 128;
- reject an item when it has more than 64 triggers or a trigger exceeds 256 characters;
- normalize `triggers` with `_str_tuple`;
- deduplicate by `(source, remote_id)`, keeping the first item;
- log and skip malformed entries;
- pass the result into `Cowork(skill_presets=...)`.

Use this shape:

```python
def _skill_presets(raw: object) -> tuple[SkillPreset, ...]:
    if not isinstance(raw, (list, tuple)):
        return ()
    out: list[SkillPreset] = []
    seen: set[tuple[str, str]] = set()
    for index, item in enumerate(raw[:MAX_SKILL_PRESETS]):
        if not isinstance(item, dict):
            logger.warning("cowork：skills.presets[%d] 不是对象，跳过", index)
            continue
        source = str(item.get("source") or "").strip()
        remote_id = str(item.get("remoteId") or "").strip()
        name = str(item.get("name") or "").strip()
        description = str(item.get("description") or "").strip()
        key = (source, remote_id)
        if not all((*key, name, description)) or key in seen:
            logger.warning("cowork：skills.presets[%d] 字段不全或重复，跳过", index)
            continue
        seen.add(key)
        out.append(SkillPreset(
            source=source,
            remote_id=remote_id,
            name=name,
            description=description,
            version=str(item.get("version") or "").strip(),
            triggers=_str_tuple(item.get("triggers")),
        ))
    return tuple(out)
```

Define the limits as named constants next to the parser/model contract so tests and an upstream profile publisher can mirror them. Runtime parsing remains tolerant: it logs and skips oversized entries. The external publisher must reject the same invalid input rather than silently trimming it; documenting that handoff is part of Task 8.

**Step 5: Run tests and commit**

Run:

```powershell
uv run pytest tests/test_cowork_manifest.py -q
git add src/netlivecowork/cowork/manifest.py src/netlivecowork/cowork/manifest_parse.py tests/test_cowork_manifest.py
git commit -m "feat(cowork): parse profile skill presets"
```

Expected: tests PASS and the commit contains only manifest changes.

### Task 2: Upgrade remote reference identity and storage

**Files:**
- Modify: `src/netlivecowork/providers/capability/skills/references/store.py`
- Modify: `src/netlivecowork/providers/capability/skills/references/defaults.py`
- Modify: `tests/test_skills_reference.py`
- Modify: `tests/test_cowork_skill_ownership.py`
- Create: `tests/test_skill_reference_defaults.py`

**Step 1: Write failing identity and migration tests**

Cover all four identity dimensions, deterministic opaque IDs, effective labels, v2 migration, principal filtering, and migration of the bundled-default anti-resurrection ledger:

```python
def test_reference_identity_separates_market_scope_and_principal():
    a = ReferenceIdentity("general", "mythos", "1129", "alice")
    b = ReferenceIdentity("ipmaster", "mythos", "1129", "alice")
    c = ReferenceIdentity("general", "mythos", "1129", "bob")
    assert len({a.reference_id, b.reference_id, c.reference_id}) == 3
    assert a.reference_id == ReferenceIdentity("general", "mythos", "1129", "alice").reference_id


def test_v2_reference_migrates_without_changing_visibility(tmp_path):
    (tmp_path / "skill_references.json").write_text(json.dumps({
        "version": 2,
        "references": {"mythos:9": {
            "source": "mythos", "remote_id": "9", "name": "M",
            "owner": "alice", "labels": ["ipmaster"],
        }},
    }), encoding="utf-8")
    ref = SkillReferenceStore(tmp_path).list_references()[0]
    assert ref.identity == ReferenceIdentity("general", "mythos", "9", "alice")
    assert ref.manual_labels == ("ipmaster",)
    assert ref.effective_labels == ("ipmaster",)


def test_deleted_bundled_default_does_not_reappear_after_v2_to_v3(tmp_path, default_file):
    # The reference is absent because the user deleted it, but v2 remembers that it was seeded.
    (tmp_path / "skill_references.json").write_text(json.dumps({
        "version": 2,
        "references": {},
        "seeded_defaults": ["cowork:9"],
    }), encoding="utf-8")
    store = SkillReferenceStore(tmp_path)
    seed_default_references(default_file, store)
    assert store.list_references() == []
```

**Step 2: Run tests and verify failure**

Run:

```powershell
uv run pytest tests/test_skills_reference.py tests/test_cowork_skill_ownership.py -q
```

Expected: FAIL because scoped identities and provenance-aware labels do not exist.

**Step 3: Add the v3 data model**

Use a deterministic opaque ID so callers never parse identity fields:

```python
@dataclass(frozen=True)
class ReferenceIdentity:
    market_scope: str
    source: str
    remote_id: str
    principal: str = "*"

    @property
    def reference_id(self) -> str:
        raw = "\0".join((self.market_scope, self.source, self.remote_id, self.principal))
        return f"ref:v3:{hashlib.sha256(raw.encode('utf-8')).hexdigest()}"


@dataclass
class SkillReference:
    identity: ReferenceIdentity
    name: str
    description: str | None = None
    triggers: list[str] = field(default_factory=list)
    skill_version: str | None = None
    referenced_at: str | None = None
    manual_labels: tuple[str, ...] = ()
    preset_bindings: tuple[str, ...] = ()

    @property
    def key(self) -> str:
        return self.identity.reference_id

    @property
    def effective_labels(self) -> tuple[str, ...]:
        labels = set(self.manual_labels) | set(self.preset_bindings)
        return tuple(sorted(labels)) or (ANY_LABEL,)
```

Keep read-only compatibility properties `source`, `remote_id`, `owner`, and `labels` during migration so existing callers can be converted incrementally. They must derive from `identity` and `effective_labels`, not maintain duplicate state.

The on-disk v3 root is explicit and remains one file:

```json
{
  "version": 3,
  "references": {},
  "seeded_defaults": [],
  "preset_ledger": {
    "active_bindings": {},
    "opt_outs": []
  }
}
```

`references`, `seeded_defaults`, and `preset_ledger` are fields in the same in-memory root and must be saved by the same temporary-file-plus-`Path.replace` operation. Do not create a second ledger file.

**Step 4: Implement one atomic transaction API**

Add:

```python
def mutate(self, fn: Callable[[dict], T]) -> T:
    data = self._load_v3()
    working = copy.deepcopy(data)
    result = fn(working)
    self._save(working)
    return result

def get_by_id(self, reference_id: str) -> SkillReference | None: ...
def remove_by_id(self, reference_id: str) -> None: ...
def set_manual_labels(self, reference_id: str, labels: Iterable[str]) -> None: ...
```

`_save` must continue writing a sibling temporary file and then call `Path.replace`. `mutate` passes the complete root above to its callback, so reference and ledger changes share one transaction. The v2 reader converts records in memory; the first successful mutation persists version 3.

**Step 5: Migrate and preserve bundled-default deletion bookkeeping**

The existing `seed_default_references()` startup path remains active, but profile presets never use it. Introduce a stable seed-ledger ID derived only from the old logical bundled-default key, for example:

```python
def bundled_default_seed_id(source: str, remote_id: str) -> str:
    raw = "\0".join((source, remote_id))
    return f"default:v3:{hashlib.sha256(raw.encode('utf-8')).hexdigest()}"
```

When loading v2, convert every parseable `seeded_defaults` entry from `source:remote_id` to that stable seed ID. This ID is deliberately independent of the new reference hash: the old ledger cannot encode market scope or principal, and its purpose is to remember that a logical bundled default was seeded once.

Update `defaults.py` to:

- construct `ReferenceIdentity(market_scope=GENERAL_SCOPE, ...)` and the new `SkillReference` shape;
- derive `principal` without changing existing visibility: use the old `owner` only when `source in market_registry.per_user_sources()` and the owner is non-empty; otherwise use `*`;
- query and mark `bundled_default_seed_id(source, remote_id)`, never `ref.key`;
- perform each seed/update plus ledger mark in one `store.mutate()` transaction.

The regression test above is mandatory: an absent reference plus a migrated seed-ledger entry means “user deleted it” and must not be recreated.

**Step 6: Keep legacy helper compatibility temporarily**

Allow old calls such as `get_reference(source, remote_id)` only when they resolve to exactly one v3 reference. Raise a clear `ValueError` on ambiguity so scoped duplicates cannot silently pick the wrong market.

**Step 7: Run tests and commit**

Run:

```powershell
uv run pytest tests/test_skills_reference.py tests/test_cowork_skill_ownership.py tests/test_skill_reference_defaults.py -q
git add src/netlivecowork/providers/capability/skills/references/store.py src/netlivecowork/providers/capability/skills/references/defaults.py tests/test_skills_reference.py tests/test_cowork_skill_ownership.py tests/test_skill_reference_defaults.py
git commit -m "refactor(skills): add scoped reference identities"
```

Expected: tests PASS, including v2 compatibility.

### Task 3: Add the profile-preset reconciler

**Files:**
- Create: `src/netlivecowork/providers/capability/skills/references/presets.py`
- Modify: `src/netlivecowork/providers/capability/skills/references/__init__.py`
- Create: `tests/test_profile_skill_presets.py`

**Step 1: Write the reconciliation matrix as failing tests**

Create helpers for profiles and references, then cover:

```python
def test_new_preset_creates_binding_and_reference(tmp_path): ...
def test_existing_user_opt_out_is_not_reseeded(tmp_path): ...
def test_profile_update_removes_only_its_binding(tmp_path): ...
def test_profile_removal_keeps_manual_and_other_profile_bindings(tmp_path): ...
def test_readding_with_no_opt_out_seeds_again(tmp_path): ...
def test_manual_pull_clears_matching_opt_out(tmp_path): ...
def test_mythos_state_is_separate_for_each_principal(tmp_path): ...
def test_cowork_state_uses_shared_principal(tmp_path): ...
def test_store_failure_keeps_the_previous_complete_state(tmp_path, monkeypatch): ...
```

The central profile reduction assertion should be explicit:

```python
before = profile("ipmaster", presets=[preset("A"), preset("B")])
after = profile("ipmaster", presets=[preset("A")])
reconciler.reconcile([before], username="alice")
reconciler.reconcile([after], username="alice")
assert names(store) == {"A"}
```

**Step 2: Run tests and verify failure**

Run:

```powershell
uv run pytest tests/test_profile_skill_presets.py -q
```

Expected: FAIL because `ProfileSkillPresetReconciler` does not exist.

**Step 3: Implement pure desired-state calculation**

Define small immutable inputs and result types:

```python
@dataclass(frozen=True)
class ResolvedPreset:
    profile_id: str
    identity: ReferenceIdentity
    name: str
    description: str
    version: str
    triggers: tuple[str, ...]


@dataclass(frozen=True)
class ReconcileResult:
    added: int = 0
    updated: int = 0
    removed: int = 0
    changed: bool = False
```

`reconcile()` must:

1. resolve presets before opening a store mutation;
2. compare the desired bindings with the ledger's previous active bindings;
3. add new bindings unless the exact profile/identity/principal tuple is opted out;
4. remove bindings no longer desired;
5. delete a reference only when it has neither manual labels nor preset bindings;
6. refresh non-empty profile metadata;
7. commit references and ledger together through `SkillReferenceStore.mutate`.

The ledger in these steps is exactly the `preset_ledger` member of the same `skill_references.json` root introduced in Task 2. `active_bindings` and `opt_outs` must never be written to another file or committed separately from `references`.

**Step 4: Add explicit user operations**

Implement methods used by the API and market service:

```python
def user_delete(self, reference_id: str) -> bool: ...
def user_set_labels(self, reference_id: str, labels: Iterable[str]) -> bool: ...
def user_reference(self, ref: SkillReference, profile_id: str | None) -> str: ...
```

`user_delete` records opt-outs for active preset bindings before deleting. `user_reference` clears the matching opt-out. `user_set_labels` stores manual labels and records opt-outs for each active preset binding whose profile label the user removed; otherwise the next union reconciliation would silently restore the removed assignment.

**Step 5: Run tests and commit**

Run:

```powershell
uv run pytest tests/test_profile_skill_presets.py -q
git add src/netlivecowork/providers/capability/skills/references/presets.py src/netlivecowork/providers/capability/skills/references/__init__.py tests/test_profile_skill_presets.py
git commit -m "feat(skills): reconcile profile preset references"
```

Expected: the entire lifecycle matrix PASS.

### Task 4: Resolve market scope and route materialization correctly

**Files:**
- Modify: `src/netlivecowork/providers/capability/skills/adapters/scopes.py`
- Modify: `src/netlivecowork/providers/capability/skills/adapters/registry.py`
- Modify: `src/netlivecowork/providers/capability/skills/references/presets.py`
- Modify: `src/netlivecowork/providers/capability/skills/services/market.py`
- Modify: `src/netlivecowork/providers/capability/skills/provider.py`
- Modify: `tests/test_cowork_skill_markets.py`
- Modify: `tests/test_skill_market_service.py`
- Modify: `tests/test_skills_reference.py`

**Step 1: Write failing collision tests**

Prove that the same source and remote ID can exist in general and profile markets:

```python
def test_catalog_identity_includes_effective_market_scope(): ...
def test_scoped_reference_marks_only_its_exact_market_as_pulled(): ...
def test_general_reference_does_not_mark_profile_market_as_pulled(): ...
def test_wildcard_label_does_not_cross_market_identity(): ...
def test_another_users_reference_is_not_pulled(): ...
def test_legacy_v2_reference_marks_only_general_market_as_pulled(): ...

@pytest.mark.asyncio
async def test_provider_downloads_from_the_references_saved_scope(tmp_path):
    general = ReferenceIdentity("general", "mythos", "1129", "alice")
    scoped = ReferenceIdentity("ipmaster", "mythos", "1129", "alice")
    # Arrange two references/adapters returning different SKILL.md content.
    # Bind the session to ipmaster and assert the scoped content is loaded.
```

**Step 2: Run tests and verify failure**

Run:

```powershell
uv run pytest tests/test_cowork_skill_markets.py tests/test_skill_market_service.py tests/test_skills_reference.py -q
```

Expected: FAIL because provider materialization omits `cowork/market_scope`.

**Step 3: Extend the existing scope model instead of defining another one**

`adapters/scopes.py` is the single source of truth. Reuse its existing `GENERAL_SCOPE`, `MarketScope`, and `build_scopes()`; do not define another `GENERAL_SCOPE` in `registry.py`.

Add data-only helpers to `scopes.py`:

```python
@dataclass(frozen=True)
class MarketScope:
    # existing fields stay unchanged
    profile_ids: tuple[str, ...] = ()


def source_url(scope: MarketScope, source: str) -> str:
    if source == "cowork":
        return scope.cowork_url
    if source == "mythos":
        return scope.mythos_url
    return ""


def effective_scope_id(
    scopes: Sequence[MarketScope], profile_id: str | None, source: str,
) -> str | None:
    # Select from already-built scope data; never construct adapters here.
    ...
```

The resolver rules are:

- no `profile_id`: return `general` only if the general scope configures that source;
- a distinct profile scope exists: return that profile ID only if it configures that source; if it omits the source, return `None` and do not fall back across markets (H3);
- a profile with no configured market uses `general` only when that source exists there;
- when `build_scopes()` merges identical URLs, append the merged profile ID to the retained scope's `profile_ids`; resolve the preset to that retained effective scope ID (which may be `general` or another profile), not blindly to `general`.

Expose one registry function such as `market_scopes(settings) -> list[MarketScope]`, built from configured global URLs plus `cowork_markets()`. Its return value is data, not adapter instances, and it calls `build_scopes()` once. Add tests for a profile with no market, a distinct market missing the requested source, a profile merged into general, and two profiles whose identical URLs merge into the first profile scope.

Finally, define the previously referenced wrapper in `references/presets.py`:

```python
def resolve_profile_preset_scope(profile_id: str, source: str, settings: Any) -> str | None:
    scopes = market_registry.market_scopes(settings)
    return effective_scope_id(scopes, profile_id, source)
```

Task 5 imports this exact function. There is no dangling second resolver.

**Step 4: Pass scope through market APIs and make `is_pulled` exact**

- `catalog()` computes deterministic `reference_id` per catalog item.
- `pull()` builds a `ReferenceIdentity` with scope and principal and delegates persistence to the reconciler's `user_reference`.
- Rename/reinterpret the existing fourth `download_zip(source, remote_id, username, cowork=None)` parameter as `market_scope`; do not add a fifth parameter. Translate `general` to deployment adapters and any other value to `build_for_cowork`.
- Existing catalog/pull route parameters may stay UI-facing as `cowork`, but convert them once to an effective `market_scope` internally.
- Replace `_tag`/`_usable_keys` matching by `source:remote_id` with exact backend `reference_id` matching for the active principal. A wildcard label changes visibility only; it does not erase market provenance.
- Treat migrated v2 references as `market_scope=general`, so they mark only the general catalog entry as `is_pulled=true`.
- `ReferencedSkillCapabilityProvider._borrow_local()` calls:

```python
zip_bytes = self._market.download_zip(
    ref.identity.source,
    ref.identity.remote_id,
    username,
    market_scope=ref.identity.market_scope,
)
```

**Step 5: Run tests and commit**

Run:

```powershell
uv run pytest tests/test_cowork_skill_markets.py tests/test_skill_market_service.py tests/test_skills_reference.py -q
git add src/netlivecowork/providers/capability/skills/adapters/scopes.py src/netlivecowork/providers/capability/skills/adapters/registry.py src/netlivecowork/providers/capability/skills/references/presets.py src/netlivecowork/providers/capability/skills/services/market.py src/netlivecowork/providers/capability/skills/provider.py tests/test_cowork_skill_markets.py tests/test_skill_market_service.py tests/test_skills_reference.py
git commit -m "fix(skills): route references by saved market scope"
```

Expected: scoped/general collision tests PASS.

### Task 5: Wire reconciliation into startup, login, and profile refresh

**Files:**
- Modify: `src/netlivecowork/api/deps.py`
- Modify: `src/netlivecowork/bootstrap/host_runtime.py`
- Modify: `src/netlivecowork/api/skills.py`
- Modify: `tests/test_cowork_state_single_source.py`
- Modify: `tests/test_skills_routes.py`
- Create: `tests/test_profile_skill_preset_wiring.py`

**Step 1: Write failing wiring tests**

Add assertions that:

- shared presets reconcile before referenced provider registration;
- `apply_cowork_state()` reads `current_user.get_current_username()` and reconciles shared plus active-user profile-derived presets;
- `POST /skills/current-user` reconciles per-user presets before invalidating caches;
- cache invalidation happens when `ReconcileResult.changed` is true and does not happen when it is false;
- one failing derived-state step does not stop existing LLM/template/MCP refreshes.

Example:

```python
def test_current_user_reconciles_per_user_presets(monkeypatch):
    calls = []
    monkeypatch.setattr(skills_api.current_user, "set_current_username", lambda u: calls.append(("user", u)))
    def reconcile(u):
        calls.append(("preset", u))
        return ReconcileResult(changed=True)
    monkeypatch.setattr(skills_api, "_reconcile_profile_skill_presets", reconcile)
    monkeypatch.setattr(skills_api, "_mark_skill_index_dirty", lambda: calls.append(("dirty", None)))
    skills_api.set_current_user(CurrentUserRequest(username="alice"))
    assert calls == [("user", "alice"), ("preset", "alice"), ("dirty", None)]


def test_current_user_does_not_dirty_index_when_reconcile_is_unchanged(monkeypatch):
    monkeypatch.setattr(
        skills_api,
        "_reconcile_profile_skill_presets",
        lambda _u: ReconcileResult(changed=False),
    )
    dirty = Mock()
    monkeypatch.setattr(skills_api, "_mark_skill_index_dirty", dirty)
    skills_api.set_current_user(CurrentUserRequest(username="alice"))
    dirty.assert_not_called()
```

**Step 2: Run tests and verify failure**

Run:

```powershell
uv run pytest tests/test_cowork_state_single_source.py tests/test_skills_routes.py tests/test_profile_skill_preset_wiring.py -q
```

Expected: FAIL because no reconciliation wiring exists.

**Step 3: Add a cached reconciler dependency**

In `api/deps.py`:

```python
@lru_cache
def get_profile_skill_preset_reconciler() -> ProfileSkillPresetReconciler:
    settings = get_settings()
    return ProfileSkillPresetReconciler(
        store=get_skill_reference_store(),
        scope_resolver=lambda profile_id, source: resolve_profile_preset_scope(
            profile_id, source, settings,
        ),
        per_user_sources=market_registry.per_user_sources,
    )
```

Ensure `get_skill_market_service()` reuses `get_skill_reference_store()` instead of constructing a second store object.

Also replace the direct `SkillReferenceStore(data_dir)` construction in `host_runtime._register_skills()` with `deps.get_skill_reference_store()`. All three current creation paths then share the cached store facade; persistent correctness still comes from the file transaction.

**Step 4: Add one reusable coordination helper**

Place orchestration in `host_runtime.py`, close to other profile-derived state:

```python
def reconcile_profile_skill_presets(username: str | None = None) -> ReconcileResult:
    active_username = (
        current_user.get_current_username() if username is None else username
    )
    profiles = installed.list_all(paths.coworks_dir())
    return deps.get_profile_skill_preset_reconciler().reconcile(
        profiles, username=active_username,
    )
```

Call it:

- during `_register_skills()` with `username=""` for shared sources before the referenced provider is registered;
- as an isolated step inside `apply_cowork_state()` with no argument, so `/coworks/recheck` uses `current_user.get_current_username()` and reconciles shared plus that user's per-user sources;
- from `set_current_user()` with the newly active username.

Call `_mark_skill_index_dirty()` only when `ReconcileResult.changed` is true and the runtime already exists. The `changed=False` test above is as important as the changed case; do not use an unconditional assertion with a mock returning `None`.

**Step 5: Run tests and commit**

Run:

```powershell
uv run pytest tests/test_cowork_state_single_source.py tests/test_skills_routes.py tests/test_profile_skill_preset_wiring.py -q
git add src/netlivecowork/api/deps.py src/netlivecowork/bootstrap/host_runtime.py src/netlivecowork/api/skills.py tests/test_cowork_state_single_source.py tests/test_skills_routes.py tests/test_profile_skill_preset_wiring.py
git commit -m "feat(skills): reconcile presets on startup and login"
```

Expected: all three entry points use the same reconciler.

### Task 6: Make API operations reference-ID based

**Files:**
- Modify: `src/netlivecowork/api/schemas/skills.py`
- Modify: `src/netlivecowork/api/skills.py`
- Modify: `src/netlivecowork/providers/capability/skills/services/market.py`
- Modify: `tests/test_skills_routes.py`
- Modify: `tests/test_skill_market_service.py`

**Step 1: Write failing API tests**

Add tests for opaque IDs, opt-out deletion, manual labels, and catalog IDs:

```python
def test_delete_cloud_reference_uses_opaque_id_and_records_opt_out(): ...
def test_set_coworks_uses_opaque_reference_id(): ...
def test_publish_rejects_cloud_by_store_lookup_not_colon_heuristic(): ...
def test_catalog_returns_reference_id_and_exact_is_pulled(): ...
```

**Step 2: Run tests and verify failure**

Run:

```powershell
uv run pytest tests/test_skills_routes.py tests/test_skill_market_service.py -q
```

Expected: FAIL because routes split IDs on `:`.

**Step 3: Replace string-shape heuristics**

- `list_local_skills()` returns `skill_id=ref.key` and `coworks=ref.effective_labels`.
- Deletion calls `reconciler.user_delete(skill_id)` when `store.get_by_id(skill_id)` exists; otherwise it calls the local service.
- Cowork assignment calls `reconciler.user_set_labels(skill_id, labels)` for a reference ID.
- Publishing rejects cloud references by `store.get_by_id(skill_id) is not None`, not `":" in skill_id`.
- `RemoteCatalogItem` adds `reference_id: str`.
- Manual market pull returns the opaque `reference_id` and clears matching opt-outs.
- Catalog `is_pulled` is true only for the exact scoped/principal-aware `reference_id`; there is no `is_referenced` response field.

Keep a one-release fallback resolver for legacy `source:remote_id` IDs so in-flight frontend state remains operable across an update.

**Step 4: Run tests and commit**

Run:

```powershell
uv run pytest tests/test_skills_routes.py tests/test_skill_market_service.py -q
git add src/netlivecowork/api/schemas/skills.py src/netlivecowork/api/skills.py src/netlivecowork/providers/capability/skills/services/market.py tests/test_skills_routes.py tests/test_skill_market_service.py
git commit -m "refactor(skills): use opaque reference ids in api"
```

Expected: route tests PASS without ID parsing.

### Task 7: Update Electron matching without changing interaction

**Files:**
- Modify: `frontend-desktop/src/api/skills.ts`
- Modify: `frontend-desktop/src/components/SkillsPage.tsx`
- Create: `frontend-desktop/src/components/SkillsPage.skillIdentity.test.ts`

**Step 1: Write a failing identity-matching test**

Expose a small pure helper from `SkillsPage.tsx` or move it to an adjacent module:

```typescript
export const catalogReferenceId = (item: RemoteCatalogItem) => item.reference_id
```

Test that two entries with the same `source/id` but different backend-provided identities remain distinct:

```typescript
it('matches installed references with backend-provided scoped ids', () => {
  const general = { source: 'mythos', id: '1129', reference_id: 'ref:v3:general' }
  const scoped = { source: 'mythos', id: '1129', reference_id: 'ref:v3:ipmaster' }
  expect(catalogReferenceId(general as RemoteCatalogItem)).not.toBe(
    catalogReferenceId(scoped as RemoteCatalogItem),
  )
})
```

**Step 2: Run the test and verify failure**

Run from `frontend-desktop`:

```powershell
npm test -- src/components/SkillsPage.skillIdentity.test.ts
```

Expected: FAIL because `RemoteCatalogItem.reference_id` and the helper do not exist.

**Step 3: Replace synthesized keys**

- Add `reference_id: string` to `RemoteCatalogItem`.
- Replace `${item.source}:${item.id}` and `keyOf(item)` for installed/catalog matching with `item.reference_id`.
- Keep `${source}:${id}` only for ephemeral UI request/error keys if desired; it must not determine reference identity or `is_pulled` behavior.
- Accept the intentional behavior change: equal `source/id` entries in general and profile markets no longer share the “已引用” state. The backend-provided scoped ID controls each card independently.
- Keep all current labels and buttons. Do not add an “预置” badge or download indicator.

**Step 4: Run frontend tests and build**

Run:

```powershell
npm test -- src/components/SkillsPage.skillIdentity.test.ts
npm run build
```

Expected: test PASS and TypeScript/Vite build succeeds.

**Step 5: Commit**

```powershell
git add frontend-desktop/src/api/skills.ts frontend-desktop/src/components/SkillsPage.tsx frontend-desktop/src/components/SkillsPage.skillIdentity.test.ts
git commit -m "fix(frontend): match skills by scoped reference id"
```

### Task 8: End-to-end regression and documentation

**Files:**
- Create: `tests/test_profile_skill_presets_end_to_end.py`
- Modify: `docs/Skill架构设计.md`
- Modify: `docs/2026-08-26-NetLIVE-Cowork-地端架构设计.md`
- Modify: `docs/2026-08-28-Cowork-验收对照表.md`

**Step 1: Write the end-to-end profile update test**

Exercise real manifest parsing, store mutation, reconciliation, listing, and market routing:

```python
def test_profile_v1_to_v2_reduces_presets_without_removing_user_owned_refs(tmp_path):
    # v1: A + B; reconcile and assert both are listed as cloud references.
    # Add a manual wildcard label to B.
    # v2: A only; reconcile.
    # Assert A remains profile-bound, B remains because of the manual wildcard.
    # Remove B's manual label and reconcile again; assert B is deleted.


def test_same_remote_id_in_general_and_profile_market_routes_correctly(tmp_path):
    # Install two references with equal source/id but distinct market scopes.
    # Bind a session to the profile and assert the profile adapter is called.


def test_deleted_bundled_default_stays_deleted_after_store_upgrade(tmp_path):
    # Start from a v2 seeded_defaults entry with the corresponding reference absent.
    # Upgrade, run normal bundled-default seeding, and assert it is still absent.
```

**Step 2: Run the focused backend suite**

Run:

```powershell
uv run pytest tests/test_cowork_manifest.py tests/test_profile_skill_presets.py tests/test_profile_skill_preset_wiring.py tests/test_profile_skill_presets_end_to_end.py tests/test_skill_reference_defaults.py tests/test_skills_reference.py tests/test_skill_market_service.py tests/test_cowork_skill_markets.py tests/test_skills_routes.py tests/test_cowork_state_single_source.py -q
```

Expected: PASS.

**Step 3: Update architecture and acceptance documentation**

Document:

- `skills.presets` schema;
- reference identity including scope and principal;
- startup versus W3-login reconciliation timing;
- opt-out and profile reduction semantics;
- unchanged Electron “已引用” interaction;
- exact cross-market `is_pulled` semantics and v2-as-general migration behavior;
- bundled-default `seeded_defaults` migration and the no-resurrection guarantee;
- runtime preset limits and the matching strict-validation contract that the external profile authoring/publishing service must adopt;
- the new acceptance scenarios.

Because the publishing service is outside this repository, record its strict-validation integration as a release dependency with an owner/link in the delivery ticket. Do not mark publisher-side validation complete merely because runtime parsing is covered here.

**Step 4: Run full verification**

Run:

```powershell
uv run pytest -q
```

From `frontend-desktop` run:

```powershell
npm test
npm run build
```

Expected: all backend tests, frontend tests, and production build PASS.

**Step 5: Inspect repository state and commit**

Run:

```powershell
git status --short
git diff --check
git add tests/test_profile_skill_presets_end_to_end.py docs/Skill架构设计.md docs/2026-08-26-NetLIVE-Cowork-地端架构设计.md docs/2026-08-28-Cowork-验收对照表.md
git commit -m "test(skills): cover profile preset lifecycle"
```

Expected: only intentional files are committed and `git diff --check` reports no whitespace errors.

## Completion criteria

- A profile preset appears through existing APIs and Electron as “已引用” without a startup download.
- Removing a preset from a newer profile removes only that profile's automatic binding.
- User deletion produces an opt-out and ordinary startup does not resurrect the reference.
- A bundled default deleted before the v2→v3 upgrade also stays deleted after normal startup seeding.
- Manual re-reference clears the opt-out.
- Mythos references are isolated by W3 principal; cowork references are shared.
- General and profile markets can reuse a source/remote ID without collision or wrong-server download.
- `is_pulled` is exact by market scope and principal; wildcard visibility does not cross market provenance, and migrated v2 references mark only general-market entries.
- Startup, profile recheck, and W3 login use one reconciler.
- Profile recheck uses the active W3 username for per-user sources.
- Store migration preserves old visibility, migrates bundled-default deletion bookkeeping, and atomically commits references plus `preset_ledger` in one file.
- Full backend/frontend verification passes.

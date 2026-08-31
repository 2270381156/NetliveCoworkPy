# 客户端观测 Phase C 实现 Plan(用户主动"上报此会话" → per-session SQLite)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户在会话头部点"上报此会话"→ 后端把该会话的 DB 行导出为一个独立 SQLite 文件 → electron 连同运行日志尾部打成一个 zip → `POST /logs`(reason=session_report)。唯一上传对话内容的路径,需用户明确确认。

**Architecture:** 后端新增 `observability/session_export.py::export_session_db(session_id, factory) -> bytes`(ORM 行拷贝,源无关:把 7 张 session 相关表的行读出来写进一个全新 sqlite 文件)+ 路由 `GET /api/v1/sessions/{id}/export`。electron 新增纯函数 `lib/session-report.js::buildSessionReportEntries` + `ipcMain.handle('report-session')`(复用 Phase B 的 `collectTail`/`zipEntries`/`uploadLogs`/`clientFields`)+ preload 暴露 `reportSession`。前端新增自包含 `ReportSessionButton` 接到 `ChatPanel` 头部。服务端零改动。

**Tech Stack:** Python FastAPI + SQLAlchemy async(pytest async)、Electron main(node:test)、React 19 + Vite + vitest。Spec:`docs/superpowers/specs/2026-06-25-client-observability-db-export-design.md`(§3、§4)。

## Global Constraints

- **直接在 `master` 实现**(本轮用户指定;master 上有并发无关 WIP)。
- 测试:后端 `uv run pytest tests/<file> -v`;electron `cd electron && npm test`;前端 `cd frontend-desktop && npm test`(vitest run)+ `npx tsc -b`。
- **绝不提交**:`uv.lock`、`.gitignore`、`electron/package-lock.json`、`frontend-desktop/package-lock.json`、`.claire/`、任何并发 WIP。每任务 **`git add` 仅本任务文件**,绝不 `git add -A`。
- **不打包、不 bump 版本**。
- **零 core 改动**(不碰 `ctx-weft/`)。
- 风格:electron 纯逻辑入 `electron/lib/*.js` 可注入、配 `electron/test/*.test.js`;前端组件自包含、配 `*.test.tsx`;注释只写"代码看不出来的约束"。
- **导出表清单**(按 `session_id` 过滤,`sessions` 按 `id`):`sessions`/`tasks`/`events`/`memory_events`/`memory_subscriptions`/`session_sse_events`/`snapshots`。`agent_templates` 是全局表 → **只建 schema 不拷数据**(`Base.metadata.create_all` 会建它、保持 schema 与 app 一致,但不灌行)。
- **导出产物 schema 必须与 app 一致**(viewer 可直接打开)——故用 `Base.metadata` 建表,产物 sqlite 文件按需读字节返回。
- **同意模型**:仅此路径出对话内容,确认框明确告知,用户点"上报"才发(spec §2)。
- **依赖**:复用 Phase B 的 `electron/lib/zip.js`/`log-bundler.js`/`log-uploader.js` 与 main.js 的 `clientFields`/`logFilesForTail`(均已落地)。

## 服务端契约(交并行会话,本仓不改)
`POST /logs` 已收 `reason` + `command_id`。Phase C 发**可选**字段 `session_id`、`user_note`;`reason=session_report` 服务端单独标注、展示 user_note。客户端按本计划发这两字段。

## 文件结构

| 文件 | 职责 |
|------|------|
| Create `src/ipmastercowork/observability/session_export.py` | `export_session_db(session_id, factory) -> bytes`(+ `SessionNotFoundError`) |
| Create `tests/test_session_export.py` | 导出只含目标会话行 + schema 完整 + 404 |
| Modify `src/ipmastercowork/api/sessions.py` | `GET /{session_id}/export` → `Response(bytes, application/octet-stream)` |
| Create `tests/test_session_export_route.py` | 路由 200/404(monkeypatch export) |
| Create `electron/lib/session-report.js` | 纯函数 `buildSessionReportEntries` → zip 条目 |
| Create `electron/test/session-report.test.js` | 上同单测 |
| Modify `electron/main.js` | `ipcMain.handle('report-session')` + require |
| Modify `electron/preload.js` | `electronAPI.reportSession` |
| Create `frontend-desktop/src/components/ReportSessionButton.tsx` | 按钮 + 确认框 + 备注 + 状态 |
| Create `frontend-desktop/src/components/ReportSessionButton.test.tsx` | 组件单测 |
| Modify `frontend-desktop/src/i18n.tsx` | 加 `chat.reportSession*` key(zh + en) |
| Modify `frontend-desktop/src/components/NewSessionDialog.tsx` | `window.electronAPI` 类型加 `reportSession?` |
| Modify `frontend-desktop/src/components/ChatPanel.tsx` | 头部接入 `<ReportSessionButton>` |

---

### Task 0: 基线确认

**Files:** 无代码改动。

- [ ] **Step 1: 分支 + 三侧基线**

Run:
```bash
git branch --show-current
cd electron && npm test 2>&1 | grep -aE "# pass|# fail"
cd ../frontend-desktop && npm test 2>&1 | tail -4
cd .. && uv run pytest tests/test_observability_events.py -q 2>&1 | tail -2
```
Expected: 分支 `master`;electron 全 PASS(74);前端 vitest 全 PASS;后端烟囱用例 PASS。记录基线,**回归判据=无新增失败**。

---

### Task 1: 后端 `session_export.py` — ORM 行拷贝导出

**Files:**
- Create: `src/ipmastercowork/observability/session_export.py`
- Create: `tests/test_session_export.py`

**Interfaces:**
- Produces: `class SessionNotFoundError(Exception)`;`async def export_session_db(session_id: str, factory) -> bytes`(`factory` 为 `async_sessionmaker[AsyncSession]`;会话 `sessions` 行不存在 → 抛 `SessionNotFoundError`;否则返回一个独立 sqlite 文件的字节)。

- [ ] **Step 1: 写失败测试**

`tests/test_session_export.py`(沿用 `tests/test_delete_session_purges_events.py` 的 async 测试风格 —— 若该文件用 `@pytest.mark.asyncio` 就照用,若靠 asyncio auto-mode 就不加):
```python
"""export_session_db 只导出目标会话的行,且 schema 完整。"""
import sqlite3

import pytest

from ipmastercowork.persistence.postgres import init_db
from ipmastercowork.persistence.postgres.models import (
    SessionModel, TaskModel, EventModel, SnapshotModel,
)
from ipmastercowork.observability.session_export import (
    export_session_db, SessionNotFoundError,
)


async def _seed(factory):
    async with factory() as db:
        async with db.begin():
            db.add(SessionModel(id="s1", user_prompt="go"))
            db.add(SessionModel(id="s2", user_prompt="other"))
            db.add(TaskModel(id="t1", session_id="s1"))
            db.add(TaskModel(id="t2", session_id="s2"))
            db.add(EventModel(id="e1", session_id="s1", type="StepStarted", sequence=1))
            db.add(EventModel(id="e2", session_id="s2", type="StepStarted", sequence=1))
            db.add(SnapshotModel(id="snp1", session_id="s1", last_event_id="e1",
                                 last_event_sequence=1, state_blob_json="{}"))


async def test_export_contains_only_target_session(tmp_path):
    factory = await init_db(f"sqlite:///{(tmp_path / 'src.db').as_posix()}")
    await _seed(factory)

    data = await export_session_db("s1", factory)
    out = tmp_path / "out.sqlite"
    out.write_bytes(data)

    conn = sqlite3.connect(str(out))
    try:
        assert conn.execute("select id from sessions").fetchall() == [("s1",)]
        assert conn.execute("select id from tasks").fetchall() == [("t1",)]
        assert {r[0] for r in conn.execute("select id from events")} == {"e1"}
        assert conn.execute("select count(*) from snapshots").fetchone()[0] == 1
        # 全局表 agent_templates 建了 schema 但不灌数据
        assert conn.execute("select count(*) from agent_templates").fetchone()[0] == 0
        names = {r[0] for r in conn.execute("select name from sqlite_master where type='table'")}
        assert {"sessions", "tasks", "events", "memory_events",
                "memory_subscriptions", "session_sse_events", "snapshots"} <= names
    finally:
        conn.close()


async def test_export_missing_session_raises(tmp_path):
    factory = await init_db(f"sqlite:///{(tmp_path / 'src2.db').as_posix()}")
    with pytest.raises(SessionNotFoundError):
        await export_session_db("nope", factory)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_session_export.py -v`
Expected: FAIL,`No module named 'ipmastercowork.observability.session_export'`。

- [ ] **Step 3: 实现**

`src/ipmastercowork/observability/session_export.py`:
```python
"""把单个会话的 DB 行导出为一个独立 SQLite 文件(ORM 行拷贝,源无关)。

读路径用现有 async session_factory(SQLite 或 Postgres 都行),逐表把目标会话的行
读成普通 dict;再用一个临时 sync sqlite 引擎按同一 Base.metadata 建表并灌入。产物
schema 与 app 完全一致,管理员可直接置换进 viewer 按事件溯源重放。

排除全局表 agent_templates 的数据(create_all 仍建它的 schema,保持一致)。
契约见 docs/superpowers/specs/2026-06-25-client-observability-db-export-design.md §3。
"""
from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path

from sqlalchemy import create_engine, select

from ipmastercowork.persistence.postgres.models import (
    Base, SessionModel, TaskModel, EventModel, MemoryEventModel,
    MemorySubscriptionModel, SessionSSEEventModel, SnapshotModel,
)


class SessionNotFoundError(Exception):
    """目标会话的 sessions 行不存在 → 路由层转 404。"""


# (model, 过滤列) —— SessionModel 按主键 id,其余按 session_id。
# SessionModel 在最前:tasks/snapshots 有 FK → sessions,先插 sessions 行。
_SESSION_TABLES = [
    (SessionModel, SessionModel.id),
    (TaskModel, TaskModel.session_id),
    (EventModel, EventModel.session_id),
    (MemoryEventModel, MemoryEventModel.session_id),
    (MemorySubscriptionModel, MemorySubscriptionModel.session_id),
    (SessionSSEEventModel, SessionSSEEventModel.session_id),
    (SnapshotModel, SnapshotModel.session_id),
]


async def _read_session_rows(session_id: str, factory) -> dict:
    """逐表读目标会话的行为 [{col: value}]。会话不存在 → SessionNotFoundError。"""
    collected: dict = {}
    async with factory() as db:
        if await db.get(SessionModel, session_id) is None:
            raise SessionNotFoundError(session_id)
        for model, col in _SESSION_TABLES:
            rows = (await db.execute(select(model).where(col == session_id))).scalars().all()
            cols = [c.name for c in model.__table__.columns]
            collected[model.__tablename__] = [
                {name: getattr(r, name) for name in cols} for r in rows
            ]
    return collected


def _write_sqlite_bytes(collected: dict) -> bytes:
    """把收集到的行写进一个全新 sqlite 文件,返回其字节。"""
    fd, tmp = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    try:
        engine = create_engine(f"sqlite:///{Path(tmp).as_posix()}")
        try:
            Base.metadata.create_all(engine)
            with engine.begin() as conn:
                for model, _col in _SESSION_TABLES:
                    rows = collected.get(model.__tablename__) or []
                    if rows:
                        conn.execute(model.__table__.insert(), rows)
        finally:
            engine.dispose()
        return Path(tmp).read_bytes()
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


async def export_session_db(session_id: str, factory) -> bytes:
    collected = await _read_session_rows(session_id, factory)
    # sync sqlite 写入放线程,避免阻塞事件循环。
    return await asyncio.to_thread(_write_sqlite_bytes, collected)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_session_export.py -v`
Expected: 2 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/ipmastercowork/observability/session_export.py tests/test_session_export.py
git commit -m "feat(obs): export one session's rows to a standalone SQLite file"
```

---

### Task 2: 后端路由 `GET /sessions/{id}/export`

**Files:**
- Modify: `src/ipmastercowork/api/sessions.py`
- Create: `tests/test_session_export_route.py`

**Interfaces:**
- Consumes: `export_session_db`/`SessionNotFoundError`(Task 1);session factory via `_sm._state_store._factory`。
- Produces: `async def export_session(session_id) -> Response`(挂在现有 `/sessions` 路由下,完整路径 `GET /api/v1/sessions/{session_id}/export`);200 = sqlite 字节(`application/octet-stream`);会话不存在 → 404;持久化未就绪 → 503。

- [ ] **Step 1: 写失败测试**

`tests/test_session_export_route.py`:
```python
"""export_session 路由:200 返回字节、404 缺失会话。"""
import pytest
from fastapi import HTTPException

import app  # noqa: F401  (确保包可导入;若无此顶层模块,删本行)
import ipmastercowork.api.sessions as sessions_mod
from ipmastercowork.observability.session_export import SessionNotFoundError


async def test_export_route_returns_bytes(monkeypatch):
    async def fake_export(session_id, factory):
        assert session_id == "s1"
        return b"SQLITEDATA"
    monkeypatch.setattr(sessions_mod, "export_session_db", fake_export)
    monkeypatch.setattr(sessions_mod, "_session_factory", lambda: object())

    resp = await sessions_mod.export_session("s1")
    assert resp.body == b"SQLITEDATA"
    assert resp.media_type == "application/octet-stream"


async def test_export_route_404_when_missing(monkeypatch):
    async def boom(session_id, factory):
        raise SessionNotFoundError(session_id)
    monkeypatch.setattr(sessions_mod, "export_session_db", boom)
    monkeypatch.setattr(sessions_mod, "_session_factory", lambda: object())

    with pytest.raises(HTTPException) as ei:
        await sessions_mod.export_session("nope")
    assert ei.value.status_code == 404
```

注:本测试 monkeypatch 一个 `_session_factory()` 辅助 + 模块级 `export_session_db` 名,故实现须把这两者作为 `sessions_mod` 的模块级可替换符号(见下)。`import app` 行仅用于确认环境;若本仓无顶层 `app` 包,删除该行。

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_session_export_route.py -v`
Expected: FAIL(`export_session` / `_session_factory` 不存在)。

- [ ] **Step 3: 实现**

`src/ipmastercowork/api/sessions.py`:在文件顶部 import 区(`from fastapi.responses import StreamingResponse` 附近)加:
```python
from fastapi.responses import Response
from ipmastercowork.observability.session_export import export_session_db, SessionNotFoundError
```
在模块级(任意函数定义区,如 `get_session` 路由附近)加一个工厂访问辅助:
```python
def _session_factory():
    """The live async_sessionmaker, reached via the registered state store.
    Wrapped in a module-level fn so tests can monkeypatch it."""
    store = _sm._state_store
    if store is None:
        raise HTTPException(status_code=503, detail="persistence not ready")
    return store._factory
```
在 `get_session` 路由(`@router.get("/{session_id}", ...)`)**之后**新增:
```python
@router.get("/{session_id}/export")
async def export_session(session_id: str) -> Response:
    """导出该会话为独立 SQLite 文件,供用户主动"上报此会话"。"""
    try:
        data = await export_session_db(session_id, _session_factory())
    except SessionNotFoundError:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    return Response(content=data, media_type="application/octet-stream")
```

- [ ] **Step 4: 跑测试确认通过(+ 既有 sessions 路由不回归)**

Run: `uv run pytest tests/test_session_export_route.py tests/test_session_export.py -v`
Expected: 全 PASS。再跑 `uv run pytest tests/ -q -k "session or api" 2>&1 | tail -5` 确认无新增失败。

- [ ] **Step 5: 提交**

```bash
git add src/ipmastercowork/api/sessions.py tests/test_session_export_route.py
git commit -m "feat(obs): GET /sessions/{id}/export returns session SQLite bytes"
```

---

### Task 3: electron `session-report.js` — 纯函数组装 zip 条目

**Files:**
- Create: `electron/lib/session-report.js`
- Create: `electron/test/session-report.test.js`

**Interfaces:**
- Produces: `buildSessionReportEntries({sessionId, env, sqliteBuf, logEntries}) -> [{name, data:Buffer}]`(第一条 `session-<id>.sqlite`=sqlite 字节;第二条 `environment.json`=`JSON.stringify(env)` 字节;其后追加 `logEntries`)。

- [ ] **Step 1: 写失败测试**

`electron/test/session-report.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildSessionReportEntries } = require('../lib/session-report');

test('builds sqlite + environment.json entries then appends log tails', () => {
  const entries = buildSessionReportEntries({
    sessionId: 'sess-1',
    env: { app_version: '0.4.8', hostname: 'h', os_username: 'u', platform: 'win32', arch: 'x64' },
    sqliteBuf: Buffer.from('SQLITEBYTES'),
    logEntries: [{ name: 'electron.log', data: Buffer.from('e') }],
  });
  assert.strictEqual(entries.length, 3);
  assert.strictEqual(entries[0].name, 'session-sess-1.sqlite');
  assert.strictEqual(entries[0].data.toString(), 'SQLITEBYTES');
  assert.strictEqual(entries[1].name, 'environment.json');
  assert.deepStrictEqual(JSON.parse(entries[1].data.toString('utf8')), {
    app_version: '0.4.8', hostname: 'h', os_username: 'u', platform: 'win32', arch: 'x64',
  });
  assert.strictEqual(entries[2].name, 'electron.log'); // log tails appended last
});

test('tolerates missing logEntries (still sqlite + environment.json)', () => {
  const entries = buildSessionReportEntries({
    sessionId: 's', env: { app_version: '0.4.8' }, sqliteBuf: Buffer.from('z'),
  });
  assert.deepStrictEqual(entries.map((e) => e.name), ['session-s.sqlite', 'environment.json']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && node --test test/session-report.test.js`
Expected: FAIL,`Cannot find module '../lib/session-report'`。

- [ ] **Step 3: 实现**

`electron/lib/session-report.js`:
```js
'use strict';

// Assemble the zip entries for a "report this session" upload: the backend's
// per-session SQLite export, a client environment block, then the run-log tails.
// Pure — the caller supplies the fetched sqlite bytes, the env block, and the
// log entries (from collectTail).
function buildSessionReportEntries({ sessionId, env, sqliteBuf, logEntries }) {
  return [
    { name: `session-${sessionId}.sqlite`, data: sqliteBuf },
    { name: 'environment.json', data: Buffer.from(JSON.stringify(env, null, 2), 'utf8') },
    ...(logEntries || []),
  ];
}

module.exports = { buildSessionReportEntries };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/session-report.test.js`
Expected: 2 PASS。

- [ ] **Step 5: 提交**

```bash
git add electron/lib/session-report.js electron/test/session-report.test.js
git commit -m "feat(obs): session-report zip entry assembly (pure)"
```

---

### Task 4: electron `report-session` IPC handler + preload

**Files:**
- Modify: `electron/main.js`
- Modify: `electron/preload.js`

无单测(IPC + fetch + 上传);Task 7 手工 E2E。**Interfaces consumed:** `buildSessionReportEntries`(Task 3)、`collectTail`/`zipEntries`/`uploadLogs`/`clientFields`/`logFilesForTail`/`shouldReportTelemetry`/`updateConfig`/`osMod`/`BACKEND_URL`(现有)。

- [ ] **Step 1: require**

`electron/main.js` 顶部 require 区(`const { zipEntries } = require('./lib/zip');` 之后,按内容定位)加:
```js
const { buildSessionReportEntries } = require('./lib/session-report');
```

- [ ] **Step 2: 注册 handler**

按内容定位现有 `ipcMain.handle('update-install', ...)` 块(模块级 ipcMain.handle 区),在其**之后**插入:
```js
  // User-initiated "report this session": fetch the per-session SQLite export from
  // the local backend, wrap it with a client environment block + run-log tails, zip
  // it, and upload to /logs (reason=session_report). Returns {ok, error?} — never
  // throws (the renderer shows the status). This is the ONLY path that uploads
  // conversation content, and only on the user's explicit click (spec §2).
  ipcMain.handle('report-session', async (_e, sessionId, note) => {
    try {
      if (!shouldReportTelemetry(updateConfig)) return { ok: false, error: 'telemetry disabled' };
      const res = await fetch(`${BACKEND_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/export`);
      if (!res.ok) return { ok: false, error: `export failed (${res.status})` };
      const sqliteBuf = Buffer.from(await res.arrayBuffer());
      const env = {
        app_version: app.getVersion(),
        hostname: osMod.hostname(),
        os_username: (() => { try { return osMod.userInfo().username; } catch (_) { return ''; } })(),
        platform: process.platform,
        arch: process.arch,
      };
      const logEntries = collectTail({ files: logFilesForTail() });
      const entries = buildSessionReportEntries({ sessionId, env, sqliteBuf, logEntries });
      const zip = zipEntries(entries);
      const ok = await uploadLogs({
        endpoint: updateConfig.telemetryUrl,
        fields: clientFields('session_report', { session_id: sessionId, user_note: note || '' }),
        archive: { name: 'session-report.zip', data: zip },
      });
      return ok ? { ok: true } : { ok: false, error: 'upload failed' };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
```

- [ ] **Step 3: preload 暴露**

`electron/preload.js` 的 `electronAPI` 对象里(`installUpdate` 行之后,按内容定位)加:
```js
  reportSession: (sessionId, note) => ipcRenderer.invoke('report-session', sessionId, note),
```

- [ ] **Step 4: 语法检查 + 现有测试**

Run: `cd electron && node --check main.js && node --check preload.js && npm test 2>&1 | grep -aE "# pass|# fail"`
Expected: 语法 OK;electron 全 PASS(74 + session-report 2 = 76)。

- [ ] **Step 5: 提交**

```bash
git add electron/main.js electron/preload.js
git commit -m "feat(obs): report-session IPC handler (export -> zip -> /logs) + preload"
```

---

### Task 5: 前端 `ReportSessionButton` 组件 + i18n + 类型

**Files:**
- Create: `frontend-desktop/src/components/ReportSessionButton.tsx`
- Create: `frontend-desktop/src/components/ReportSessionButton.test.tsx`
- Modify: `frontend-desktop/src/i18n.tsx`
- Modify: `frontend-desktop/src/components/NewSessionDialog.tsx`(`window.electronAPI` 类型)

**Interfaces:**
- Produces: `<ReportSessionButton sessionId={string} />`;调用 `window.electronAPI?.reportSession?.(sessionId, note)`。

- [ ] **Step 1: i18n key(zh + en)**

`frontend-desktop/src/i18n.tsx`:在 `zh` 字典里、`'chat.showWorkspace'` 键附近(按内容定位)加:
```js
  'chat.reportSession': '上报此会话',
  'chat.reportSessionConsent': '将上传该会话的全部对话内容(含工具调用)与运行日志,用于问题排查。仅发送至内网管理服务。',
  'chat.reportSessionNote': '备注(可选):描述你遇到的问题',
  'chat.reportSessionSubmit': '上报',
  'chat.reportSessionSending': '上报中…',
  'chat.reportSessionDone': '已上报',
  'chat.reportSessionFail': '上报失败',
```
在 `en` 字典里、`'chat.showWorkspace'` 键附近加:
```js
  'chat.reportSession': 'Report this session',
  'chat.reportSessionConsent': 'This uploads the full conversation (including tool calls) and recent run logs for troubleshooting. Sent only to the internal management server.',
  'chat.reportSessionNote': 'Note (optional): describe the problem',
  'chat.reportSessionSubmit': 'Report',
  'chat.reportSessionSending': 'Reporting…',
  'chat.reportSessionDone': 'Reported',
  'chat.reportSessionFail': 'Report failed',
```

- [ ] **Step 2: `window.electronAPI` 类型加 `reportSession?`**

`frontend-desktop/src/components/NewSessionDialog.tsx` 的 `declare global { interface Window { electronAPI?: { ... } } }` 里(按内容定位,`getSession?` 行之后)加:
```ts
      reportSession?: (sessionId: string, note: string) => Promise<{ ok: boolean; error?: string }>
```

- [ ] **Step 3: 写失败测试**

`frontend-desktop/src/components/ReportSessionButton.test.tsx`:
```tsx
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (k: string) => k, lang: 'en', setLang: () => {} }) }))
import { ReportSessionButton } from './ReportSessionButton'

describe('ReportSessionButton', () => {
  beforeEach(() => { (window as unknown as { electronAPI?: unknown }).electronAPI = undefined })
  afterEach(() => { delete (window as unknown as { electronAPI?: unknown }).electronAPI })

  test('opens confirm and calls reportSession with id + note', async () => {
    const reportSession = vi.fn().mockResolvedValue({ ok: true })
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = { reportSession }
    render(<ReportSessionButton sessionId="sess-1" />)
    fireEvent.click(screen.getByTitle('chat.reportSession'))
    fireEvent.change(screen.getByPlaceholderText('chat.reportSessionNote'), { target: { value: 'hi' } })
    fireEvent.click(screen.getByText('chat.reportSessionSubmit'))
    await waitFor(() => expect(reportSession).toHaveBeenCalledWith('sess-1', 'hi'))
  })

  test('shows the error when reportSession returns ok:false', async () => {
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = { reportSession: vi.fn().mockResolvedValue({ ok: false, error: 'boom' }) }
    render(<ReportSessionButton sessionId="s" />)
    fireEvent.click(screen.getByTitle('chat.reportSession'))
    fireEvent.click(screen.getByText('chat.reportSessionSubmit'))
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy())
  })
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `cd frontend-desktop && npm test -- ReportSessionButton 2>&1 | tail -8`
Expected: FAIL(找不到 `./ReportSessionButton`)。

- [ ] **Step 5: 实现**

`frontend-desktop/src/components/ReportSessionButton.tsx`:
```tsx
import { useState } from 'react'
import { UploadIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

export function ReportSessionButton({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<null | { ok: boolean; msg: string }>(null)

  async function submit() {
    setBusy(true)
    setStatus(null)
    try {
      const r = await window.electronAPI?.reportSession?.(sessionId, note)
      if (r?.ok) {
        setStatus({ ok: true, msg: t('chat.reportSessionDone') })
        setOpen(false)
        setNote('')
      } else {
        setStatus({ ok: false, msg: r?.error || t('chat.reportSessionFail') })
      }
    } catch (e) {
      setStatus({ ok: false, msg: String((e as Error)?.message || e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        onClick={() => { setStatus(null); setOpen(true) }}
        title={t('chat.reportSession')}
        className="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
        style={{ background: 'none', color: 'var(--t3)', border: 'none', cursor: 'pointer' }}
        onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'var(--bg3)'; el.style.color = 'var(--t2)' }}
        onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'none'; el.style.color = 'var(--t3)' }}
      >
        <UploadIcon size={15} />
      </button>
      {status && !open && (
        <span className="mr-1 text-xs" style={{ color: status.ok ? 'var(--teal, #0d9488)' : 'var(--red, #dc2626)' }}>{status.msg}</span>
      )}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(15,31,61,.35)', backdropFilter: 'blur(4px)' }}>
          <div className="w-96 p-4" style={{ background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 24px 80px rgba(15,31,61,.18)' }}>
            <p className="mb-2 text-sm font-medium" style={{ color: 'var(--t1)' }}>{t('chat.reportSession')}</p>
            <p className="mb-3 text-xs" style={{ color: 'var(--t2)' }}>{t('chat.reportSessionConsent')}</p>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder={t('chat.reportSessionNote')}
              className="mb-3 w-full rounded-md p-2 text-sm"
              style={{ background: 'var(--bg2)', border: '1px solid var(--border)', color: 'var(--t1)', minHeight: 60, resize: 'vertical' }}
            />
            {status && !status.ok && (
              <p className="mb-2 text-xs" style={{ color: 'var(--red, #dc2626)' }}>{status.msg}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => { setOpen(false); setNote('') }} disabled={busy}>{t('common.cancel')}</Button>
              <Button variant="default" size="sm" onClick={submit} disabled={busy}>{busy ? t('chat.reportSessionSending') : t('chat.reportSessionSubmit')}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
```

- [ ] **Step 6: 跑测试确认通过 + 类型检查**

Run: `npm test -- ReportSessionButton 2>&1 | tail -8 && npx tsc -b 2>&1 | tail -5`
Expected: 2 PASS;tsc 无错。

- [ ] **Step 7: 提交**

```bash
git add frontend-desktop/src/components/ReportSessionButton.tsx frontend-desktop/src/components/ReportSessionButton.test.tsx frontend-desktop/src/i18n.tsx frontend-desktop/src/components/NewSessionDialog.tsx
git commit -m "feat(obs): ReportSessionButton component + i18n + electronAPI type"
```

---

### Task 6: 接入 ChatPanel 头部

**Files:**
- Modify: `frontend-desktop/src/components/ChatPanel.tsx`

- [ ] **Step 1: import**

`ChatPanel.tsx` 顶部 import 区(按内容定位,与其它 `@/components` import 一处)加:
```tsx
import { ReportSessionButton } from '@/components/ReportSessionButton'
```

- [ ] **Step 2: 头部插入按钮**

按内容定位会话头部右侧 cluster(`<div className="ml-3 flex flex-shrink-0 items-center gap-1">`)。在该 cluster 内 `{canShowWorkspace && ...}` 块**之前**插入:
```tsx
            <ReportSessionButton sessionId={session.id} />
```

- [ ] **Step 3: 类型检查 + 前端全量测试**

Run: `cd frontend-desktop && npx tsc -b 2>&1 | tail -5 && npm test 2>&1 | tail -6`
Expected: tsc 无错;vitest 全 PASS。

- [ ] **Step 4: 提交**

```bash
git add frontend-desktop/src/components/ChatPanel.tsx
git commit -m "feat(obs): wire ReportSessionButton into session header"
```

---

### Task 7: 全量回归 + 手工 E2E 清单

**Files:** 无代码改动(最后记录结果时改本 plan)。

- [ ] **Step 1: 三侧回归**

Run:
```bash
cd electron && npm test 2>&1 | grep -aE "# pass|# fail"
cd ../frontend-desktop && npx tsc -b && npm test 2>&1 | tail -4
cd .. && uv run pytest tests/test_session_export.py tests/test_session_export_route.py -q 2>&1 | tail -3
```
Expected: electron 全 PASS(76);前端 tsc 干净 + vitest 全 PASS;后端 export 4 PASS。

- [ ] **Step 2: 手工打包 E2E(需服务端处理 session_report 或代理观察;记录每项 PASS/FAIL + 现象)**

1. 打包桌面,指向 `:8077`(或代理)。
2. 打开/选一个有内容的会话 → 头部点"上报此会话"图标 → 确认框出现、文案清晰 → 填备注 → 点"上报"。
3. 代理/服务端见**一个** `POST /logs` 部件 `session-report.zip`、`reason=session_report` + `session_id` + `user_note`。
4. 下载解压:含 `session-<id>.sqlite`(用 sqlite 打开,含 events/tasks/snapshots 等该会话行,可置换进 viewer 重放)+ `environment.json` + `electron.log` + `backend.log`。
5. UI 显示"已上报";telemetry 关闭时显示禁用错误且不发。

- [ ] **Step 3: 记录结果 + 收尾提交**

```bash
git add docs/superpowers/plans/2026-06-25-phase-c-session-report.md
git commit -m "docs(obs): record Phase C verification results"
```

---

## Self-review 记录

- **Spec 覆盖**:§3 导出机制(ORM 行拷贝、7 表、排除 agent_templates 数据、schema 一致)=Task1;§3.3 + §4 路由=Task2;§4 environment.json + 日志尾组装=Task3;§4 IPC(fetch export → zip → /logs)=Task4;preload=Task4;§4 UI(按钮 + 确认框 + 备注 + 同意文案 + 状态)=Task5;接入=Task6;i18n=Task5;服务端契约=顶部说明(交并行会话)。
- **类型一致**:`export_session_db(session_id, factory) -> bytes`(raises `SessionNotFoundError`)↔ 路由 `_session_factory()` + 404;electron `buildSessionReportEntries({sessionId,env,sqliteBuf,logEntries}) -> [{name,data:Buffer}]` ↔ `zipEntries` 消费 ↔ `uploadLogs({archive})`;`reportSession(sessionId,note) -> {ok,error?}` preload/main/renderer 一致;fields 用 `session_id`/`user_note`。
- **源无关**:导出读用 async factory(SQLite/Postgres 同一 ORM 路径),写用临时 sync sqlite 引擎 + `Base.metadata`;sync 写入走 `asyncio.to_thread` 不阻塞事件循环。
- **失败语义**:`report-session` 全 try/catch 返回 `{ok:false,error}` 不抛;telemetry 关闭直接禁用;export 失败/上传失败各自报错。
- **同意/隐私**:仅此路径出对话内容,确认框明确告知,用户点击才发。
- **零 core 改动**;**YAGNI**:不做 display_name、不做大小裁剪、不引 toast 库、不改服务端。
- 不打包、不 bump、不提交 lockfile/.gitignore;每任务 `git add` 仅本任务文件。
```

---

## 验证结果(2026-06-25,subagent-driven,落 master)

**实现提交链**:a0cccad(plan)→ de10da3(T1 session_export.py)→ 4e17ec8(T2 export 路由)→ 0291c0f(T3 session-report.js 组装)→ 25cd90a(T4 report-session IPC + preload)→ 151ec77(T5 ReportSessionButton + i18n + type)→ 3b99407(T6 接入 ChatPanel 头部)。每任务两段式 review(spec + quality)通过(T6 因 2 行 diff 由 controller 内联核验)。

**Step 1 三侧回归 ✅**:electron `npm test` 76/76;前端 `npx tsc -b` 干净(exit 0)+ vitest 71/71(17 文件);后端 `uv run pytest tests/test_session_export.py tests/test_session_export_route.py` 4/4。

**终审(opus,a0cccad..3b99407,6 commits)= READY TO MERGE**:无 Critical / 无 Important。端到端契约全部核验:路由路径↔IPC fetch(encodeURIComponent)、zip entry 形状↔zipEntries/uploadLogs、三层字段 `reason=session_report`/`session_id`/`user_note` 一致、preload↔renderer↔main 签名一致;导出 7 表 FK 安全(SessionModel 先)、agent_templates 仅建 schema 不灌数据、缺会话→404、`asyncio.to_thread` 离事件循环、engine.dispose+temp unlink in finally;同意/隐私=严格用户触发(无 mount 自发)+ fetch 前 gate shouldReportTelemetry + 确认框先告知 + 7 表无凭据(LLM creds 在 IPMC_* env);失败语义全 `{ok,error}` 不抛、telemetry 关闭短路、export/upload 失败各自报错;**零 ctx-weft/ 改动**;ChatPanel 头部 cluster 插入不破坏既有控件。

**确认/三角的 Minor(均非阻塞,延后)**:(1) export fetch 无 timeout/AbortSignal——backend 卡死时对话框停在"上报中…";(2) endpoint 末尾斜杠归一化——当前无实际不匹配;(3) `tests/test_session_export.py` 未对 memory_events/memory_subscriptions/session_sse_events 灌数据断言(filter 列未被有数据地覆盖,共享代码路径低风险)。

**Step 2 手工打包 E2E:未跑(需已安装桌面端 + 可达 :8077 或代理)**。清单待用户执行:
1. 打包桌面指向 :8077(或代理);
2. 开有内容会话→头部"上报此会话"图标→确认框出现文案清晰→填备注→点"上报";
3. 代理/服务端见**一个** `POST /logs` 部件 `session-report.zip`,`reason=session_report` + `session_id` + `user_note`;
4. 解压含 `session-<id>.sqlite`(sqlite 打开含该会话 events/tasks/snapshots 等行,可置换进 viewer 重放)+ `environment.json` + `electron.log` + `backend.log`;
5. UI 显示"已上报";telemetry 关闭时显示禁用错误且不发。

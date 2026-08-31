# 客户端观测 Phase A 实现 Plan(事件流,纯客户端)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 后端失败/生命周期事件经本地 spool 文件 + electron 现有遥测通道结构化自动上报到 `/events`;埋点用 host EventBus 订阅者(零 core 改动),并修缮 electron.log 轮转。

**Architecture:** 后端 `observability/events.py::emit()` append 到 `paths.data_dir()/telemetry-spool.jsonl`(异常全吞);`observability/telemetry_subscriber.py` 是个 EventBus 订阅者(仿 `EventPersister`),在 `api/startup.py` 经 `runtime.event_bus.subscribe` 注册,把 `StepFailed`/`TaskFailed` 映射为 `emit()`。electron 启动 + 每 30s `rename-then-read` drain spool 合入现有 reporter;`buildEvent` 扩展 `hostname`/`os_username`;新增 `backend_crash`/`renderer_crash`/`backend_start_duration` 与 electron.log 轮转。服务端零改动。

**Tech Stack:** Python 3.11(pytest,`uv run pytest`)、Electron main(CommonJS,`node:test`)。Spec:`docs/superpowers/specs/2026-06-25-client-observability-db-export-design.md`(§5)。

## Global Constraints

- **直接在 `master` 实现**(本次用户明确指定;非常规 feature-first)。
- 后端测试:`uv run pytest tests/<file> -v`(pyproject 已配 `pythonpath=["."]`)。
- Electron 测试:`cd electron && npm test`(`node --test test/*.test.js`)。
- **绝不提交**:`uv.lock`、`.gitignore`、`electron/package-lock.json`、`.claire/`。
- 本 plan **不打包、不 bump 版本**(发版属后续动作)。
- 代码风格:electron 纯逻辑入 `electron/lib/*.js` 可注入依赖、配 `electron/test/*.test.js`;后端纯逻辑可单测;注释只写"代码看不出来的约束"。
- **零 core 改动**:不碰 `ctx-weft/`;失败埋点全在 host EventBus 订阅者里。
- 事件**只带错误类别与元数据**(`error_code`/`error_message`/`session_id`/`task_id`),绝不带 prompt/对话内容。

---

### Task 0: 基线确认

**Files:** 无代码改动。

- [ ] **Step 1: 确认分支 + 后端基线**

Run: `git branch --show-current && uv run pytest tests/ -q 2>&1 | tail -5`
Expected: 分支 `master`;记录当前 passed/failed 数作为基线(**回归判据=无新增失败**;若基线即有挂的用例,记录并跳过,不顺手修)。

- [ ] **Step 2: 确认 electron 基线**

Run: `cd electron && npm test 2>&1 | tail -8`
Expected: 全 PASS(记录用例数作基线)。

---

### Task 1: 后端 `emit()` 写 spool

**Files:**
- Create: `src/ipmastercowork/observability/events.py`
- Test: `tests/test_observability_events.py`

**Interfaces:**
- Produces: `emit(event_type: str, **extra) -> None`(append 一行 JSON 到 `data_dir()/telemetry-spool.jsonl`,绝不抛);内部经 `_data_dir()` 间接取目录(测试可 monkeypatch)。

- [ ] **Step 1: 写失败测试**

`tests/test_observability_events.py`:
```python
"""emit() 写 spool 的行为与绝不抛错保证。"""
import json
from pathlib import Path

import ipmastercowork.observability.events as events_mod


def test_emit_appends_one_json_line(tmp_path, monkeypatch):
    monkeypatch.setattr(events_mod, "_data_dir", lambda: tmp_path)
    events_mod.emit("step_failed", session_id="s1", error_code="LLMCallError")
    events_mod.emit("task_failed", session_id="s1")

    lines = (tmp_path / "telemetry-spool.jsonl").read_text(encoding="utf-8").strip().split("\n")
    assert len(lines) == 2
    first = json.loads(lines[0])
    assert first["event_type"] == "step_failed"
    assert first["session_id"] == "s1" and first["error_code"] == "LLMCallError"
    assert "T" in first["ts"]  # ISO datetime


def test_emit_never_raises(monkeypatch):
    def boom():
        raise RuntimeError("no data dir")
    monkeypatch.setattr(events_mod, "_data_dir", boom)
    events_mod.emit("anything", x=1)  # 不应抛


def test_emit_serializes_non_json_values(tmp_path, monkeypatch):
    monkeypatch.setattr(events_mod, "_data_dir", lambda: tmp_path)
    events_mod.emit("e", path=Path(tmp_path))  # Path 非 JSON 原生 → default=str
    line = (tmp_path / "telemetry-spool.jsonl").read_text(encoding="utf-8").strip()
    assert json.loads(line)["path"] == str(tmp_path)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_observability_events.py -v`
Expected: FAIL,`No module named 'ipmastercowork.observability.events'`。

- [ ] **Step 3: 实现**

`src/ipmastercowork/observability/events.py`:
```python
"""客户端观测事件:append 到本地 spool 文件,由 Electron 统一上报。

契约见 docs/superpowers/specs/2026-06-25-client-observability-db-export-design.md §5:
- 一行一个 JSON 对象 {event_type, ts, **extra};
- 每次 open-append-close,不持长 fd(Electron 用 rename 接管文件,Windows 上
  rename 打开中的文件会失败);
- 任何异常静默吞掉——遥测绝不影响业务。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path


def _data_dir() -> Path:
    from ipmastercowork.paths import data_dir
    return data_dir()


def emit(event_type: str, **extra) -> None:
    try:
        path = _data_dir() / "telemetry-spool.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "event_type": event_type,
            "ts": datetime.now(timezone.utc).isoformat(),
            **extra,
        }
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
    except Exception:
        pass
```

Note:若 `src/ipmastercowork/observability/__init__.py` 已存在(现有 OTel 包),**不要覆盖**,本模块与之并存即可。

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_observability_events.py -v`
Expected: 3 PASS。

- [ ] **Step 5: 提交**

Run:
```bash
git add src/ipmastercowork/observability/events.py tests/test_observability_events.py
git commit -m "feat(obs): backend emit() appends events to telemetry spool"
```

---

### Task 2: 后端 `TelemetrySubscriber`(EventBus 订阅者)

**Files:**
- Create: `src/ipmastercowork/observability/telemetry_subscriber.py`
- Test: `tests/test_telemetry_subscriber.py`

**Interfaces:**
- Consumes: `emit()`(Task 1);core `EventType`(`ctx_weft.core.events.types`,只读引用常量)。
- Produces: `class TelemetrySubscriber` with `async def on_event(self, event) -> None`;`event` 鸭子类型:`.type:str`、`.session_id`、`.task_id`、`.payload:dict`。映射 `StepFailed→step_failed`、`TaskFailed→task_failed`,其余忽略。

- [ ] **Step 1: 写失败测试**

`tests/test_telemetry_subscriber.py`:
```python
"""TelemetrySubscriber 把失败事件映射为 emit()。"""
import asyncio
from types import SimpleNamespace

import ipmastercowork.observability.telemetry_subscriber as sub_mod
from ipmastercowork.observability.telemetry_subscriber import TelemetrySubscriber


def _ev(type_, **kw):
    return SimpleNamespace(
        id="e1", type=type_, session_id=kw.get("session_id"),
        task_id=kw.get("task_id"), payload=kw.get("payload", {}),
    )


def test_step_failed_emits(monkeypatch):
    calls = []
    monkeypatch.setattr(sub_mod, "emit", lambda et, **kw: calls.append((et, kw)))
    ev = _ev("StepFailed", session_id="s1", task_id="t1",
             payload={"step_name": "act", "error_code": "LLMCallError", "error_message": "api down"})
    asyncio.run(TelemetrySubscriber().on_event(ev))
    assert len(calls) == 1
    et, kw = calls[0]
    assert et == "step_failed"
    assert kw["session_id"] == "s1" and kw["task_id"] == "t1"
    assert kw["error_code"] == "LLMCallError" and kw["error_message"] == "api down"


def test_task_failed_emits(monkeypatch):
    calls = []
    monkeypatch.setattr(sub_mod, "emit", lambda et, **kw: calls.append((et, kw)))
    ev = _ev("TaskFailed", session_id="s1", payload={"error_code": "TASK_FAILED_AT_RUN", "error_message": "boom"})
    asyncio.run(TelemetrySubscriber().on_event(ev))
    assert calls[0][0] == "task_failed"


def test_non_failure_event_ignored(monkeypatch):
    calls = []
    monkeypatch.setattr(sub_mod, "emit", lambda et, **kw: calls.append(et))
    asyncio.run(TelemetrySubscriber().on_event(_ev("TaskCreated", session_id="s1")))
    assert calls == []


def test_on_event_never_raises(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("emit broke")
    monkeypatch.setattr(sub_mod, "emit", boom)
    # 不应抛(订阅者绝不影响 EventBus 派发)
    asyncio.run(TelemetrySubscriber().on_event(_ev("StepFailed", session_id="s1")))
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_telemetry_subscriber.py -v`
Expected: FAIL,`No module named 'ipmastercowork.observability.telemetry_subscriber'`。

- [ ] **Step 3: 实现**

`src/ipmastercowork/observability/telemetry_subscriber.py`:
```python
"""把 core 的失败事件映射为客户端观测 emit()。

host 侧 EventBus 订阅者(仿 persistence/event_persister.py),在 api/startup.py 经
runtime.event_bus.subscribe 注册。零 core 改动:只读 EventType 常量,只消费事件。

粒度取舍(spec §5):MCP/skill 的 capability 失败当前以 CapabilityEvent(kind="error")
吸收进 tool 结果、未成独立事件,故只能随 StepFailed/TaskFailed 粗粒度捕获;要 server/tool
明细须另给 core 回灌 CapabilityFailed seam(本期不做)。
"""
from __future__ import annotations

import logging

from ctx_weft.core.events.types import EventType

from ipmastercowork.observability.events import emit

logger = logging.getLogger(__name__)

# core 失败事件类型 → 上报 event_type(EventType 是 StrEnum,成员即字符串值)
_FAILURE_MAP = {
    EventType.STEP_FAILED.value: "step_failed",
    EventType.TASK_FAILED.value: "task_failed",
}

_MAX_MSG = 512  # error_message 截断,避免把长堆栈塞进事件


class TelemetrySubscriber:
    """EventBus 订阅者:失败事件 → emit()。绝不抛(不污染派发)。"""

    async def on_event(self, event) -> None:
        try:
            mapped = _FAILURE_MAP.get(getattr(event, "type", None))
            if mapped is None:
                return
            payload = getattr(event, "payload", None) or {}
            emit(
                mapped,
                session_id=getattr(event, "session_id", None),
                task_id=getattr(event, "task_id", None),
                error_code=payload.get("error_code"),
                error_message=(payload.get("error_message") or "")[:_MAX_MSG],
            )
        except Exception:
            logger.exception("TelemetrySubscriber failed for event %s", getattr(event, "id", "?"))
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_telemetry_subscriber.py -v`
Expected: 4 PASS。

- [ ] **Step 5: 提交**

Run:
```bash
git add src/ipmastercowork/observability/telemetry_subscriber.py tests/test_telemetry_subscriber.py
git commit -m "feat(obs): host EventBus subscriber maps StepFailed/TaskFailed to emit()"
```

---

### Task 3: 在 `api/startup.py` 注册订阅者(wiring)

**Files:**
- Modify: `src/ipmastercowork/api/startup.py`(`StartupHandles` 约 L26-31;持久化 setup 函数 L82-128;调用方 L201-226;关停 L233-238)

无单测(纯 wiring);靠 import 检查 + 既有 startup 测试不回归。**Interfaces consumed:** `TelemetrySubscriber.on_event`(Task 2)。

- [ ] **Step 1: 加 import**

`src/ipmastercowork/api/startup.py`,在持久化 setup 函数的 import 区(`from ipmastercowork.persistence.event_persister import EventPersister` 一行,约 L86)**之后**加:
```python
    from ipmastercowork.observability.telemetry_subscriber import TelemetrySubscriber
```

- [ ] **Step 2: 订阅 + 进返回元组**

在 `snapshot_handle = runtime.event_bus.subscribe(...)` 块(约 L111-113)**之后**加:
```python
    tele_handle = runtime.event_bus.subscribe(None, TelemetrySubscriber().on_event)
```
把该函数 `return state_store, event_store, persist_handle, proj_handle, snapshot_handle`(约 L128)改为:
```python
    return state_store, event_store, persist_handle, proj_handle, snapshot_handle, tele_handle
```
并把其 docstring(约 L82)末尾同步加 `, tele_handle`。

- [ ] **Step 3: `StartupHandles` 加字段**

`@dataclass class StartupHandles`(约 L26-31)末尾加:
```python
    tele_handle: Any | None = None
```

- [ ] **Step 4: 调用方解包 + 构造**

约 L201 的初始化与 L203 的解包改为带 `tele_handle`:
```python
    state_store = event_store = persist_handle = proj_handle = snapshot_handle = tele_handle = None
```
```python
        state_store, event_store, persist_handle, proj_handle, snapshot_handle, tele_handle = await _setup_db(
```
`StartupHandles(...)` 构造(约 L221-226)加:
```python
        tele_handle=tele_handle,
```

- [ ] **Step 5: 关停时注销**

关停函数里 `snapshot_handle` 的 unsubscribe 块(约 L237-238)**之后**加:
```python
    if handles.tele_handle is not None:
        await handles.tele_handle.unsubscribe()
```

- [ ] **Step 6: 验证(import + 既有 startup/api 测试不回归)**

Run:
```bash
uv run python -c "import ipmastercowork.api.startup"
uv run pytest tests/ -q -k "startup or session or api" 2>&1 | tail -8
```
Expected: import 无错;相关用例无新增失败(对照 Task 0 基线)。

- [ ] **Step 7: 提交**

Run:
```bash
git add src/ipmastercowork/api/startup.py
git commit -m "feat(obs): register TelemetrySubscriber on the runtime EventBus"
```

---

### Task 4: electron `buildEvent` 扩展 hostname/os_username + `tailString`

**Files:**
- Modify: `electron/lib/telemetry-core.js`
- Modify: `electron/test/telemetry-core.test.js`(更新既有深比较 + 追加用例)

**Interfaces:**
- Produces: `buildEvent` 输出新增 `hostname`/`os_username`(取自 `ctx.hostname`/`ctx.osUsername`);新增 `tailString(s, maxBytes) -> string`(取尾部,供 Task 8 的 stderr_tail)。`extra` 仍最后展开(后端 ts 胜出)。

- [ ] **Step 1: 更新既有测试 + 加新用例**

`electron/test/telemetry-core.test.js`:把顶部 require 改为同时引入 `tailString`,把 `ctx` 加上 hostname/osUsername,并更新首个用例的深比较;末尾追加 tailString 用例。完整替换为:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildEvent, enqueue, tailString } = require('../lib/telemetry-core');

const ctx = {
  installId: 'iid-1', appVersion: '0.1.0', channel: 'stable',
  os: 'win32', arch: 'x64', hostname: 'HOST-1', osUsername: 'alice',
  now: () => 1700000000000,
};

test('buildEvent sets common fields and event_type', () => {
  const ev = buildEvent('app_launch', ctx);
  assert.deepStrictEqual(ev, {
    event_type: 'app_launch', install_id: 'iid-1', app_version: '0.1.0',
    channel: 'stable', os: 'win32', arch: 'x64',
    hostname: 'HOST-1', os_username: 'alice', ts: 1700000000000,
  });
});

test('buildEvent merges extra fields', () => {
  const ev = buildEvent('update_download_failed', ctx, { error: 'boom' });
  assert.strictEqual(ev.event_type, 'update_download_failed');
  assert.strictEqual(ev.error, 'boom');
});

test('extra.ts overrides ctx.now (spool events keep backend timestamp)', () => {
  const ev = buildEvent('step_failed', ctx, { ts: 'BACKEND-TS', session_id: 's1' });
  assert.strictEqual(ev.ts, 'BACKEND-TS');
});

test('enqueue appends', () => {
  assert.deepStrictEqual(enqueue([], { a: 1 }), [{ a: 1 }]);
});

test('enqueue trims to maxLen keeping newest', () => {
  const q = enqueue(enqueue(enqueue([], { n: 1 }, 2), { n: 2 }, 2), { n: 3 }, 2);
  assert.deepStrictEqual(q, [{ n: 2 }, { n: 3 }]);
});

test('tailString keeps at most maxBytes from the end', () => {
  assert.strictEqual(tailString('abcdef', 4), 'cdef');
  assert.strictEqual(tailString('ab', 4), 'ab');
  assert.strictEqual(tailString('', 4), '');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && node --test test/telemetry-core.test.js`
Expected: FAIL(`tailString` 未导出 / 首个用例多了 hostname 字段不匹配旧实现)。

- [ ] **Step 3: 实现**

`electron/lib/telemetry-core.js` 整体替换为:
```js
'use strict';

// Pure telemetry helpers. ctx.now() supplies the timestamp so tests are deterministic.
// extra is spread LAST so spool events can carry their own backend-side ts.
function buildEvent(eventType, ctx, extra = {}) {
  return {
    event_type: eventType,
    install_id: ctx.installId,
    app_version: ctx.appVersion,
    channel: ctx.channel,
    os: ctx.os,
    arch: ctx.arch,
    hostname: ctx.hostname,
    os_username: ctx.osUsername,
    ts: ctx.now(),
    ...extra,
  };
}

function enqueue(queue, event, maxLen = 200) {
  const next = [...queue, event];
  return next.length > maxLen ? next.slice(next.length - maxLen) : next;
}

function tailString(s, maxBytes) {
  if (!s) return '';
  return s.length <= maxBytes ? s : s.slice(s.length - maxBytes);
}

module.exports = { buildEvent, enqueue, tailString };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/telemetry-core.test.js`
Expected: 全 PASS(含 telemetry-reporter.test.js 若复用 buildEvent 不受影响——下一步全量验证)。

- [ ] **Step 5: 全量 electron 测试 + 提交**

Run: `npm test`
Expected: 全 PASS(对照 Task 0)。
```bash
git add lib/telemetry-core.js test/telemetry-core.test.js
git commit -m "feat(obs): buildEvent carries hostname/os_username; add tailString"
```

---

### Task 5: electron `spool.js`(解析 + rename-then-read drain)

**Files:**
- Create: `electron/lib/spool.js`
- Create: `electron/test/spool.test.js`

**Interfaces:**
- Produces: `parseSpoolText(text) -> {events: object[], errors: number}`;`drainSpool({spoolPath, fsImpl=fs}) -> object[]`(rename→read→unlink,缺文件返回 `[]`,残留 `.draining` 可恢复)。

- [ ] **Step 1: 写失败测试**

`electron/test/spool.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseSpoolText, drainSpool } = require('../lib/spool');

test('parseSpoolText parses one JSON object per line, counts bad lines', () => {
  const text = '{"event_type":"a","ts":"T1"}\nnot-json\n\n{"event_type":"b","x":1}\n';
  const { events, errors } = parseSpoolText(text);
  assert.deepStrictEqual(events, [
    { event_type: 'a', ts: 'T1' },
    { event_type: 'b', x: 1 },
  ]);
  assert.strictEqual(errors, 1); // 空行不算错误
});

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'spool-')); }

test('drainSpool renames, reads, deletes, returns events', () => {
  const spool = path.join(tmpDir(), 'telemetry-spool.jsonl');
  fs.writeFileSync(spool, '{"event_type":"a"}\n');
  const events = drainSpool({ spoolPath: spool });
  assert.strictEqual(events.length, 1);
  assert.ok(!fs.existsSync(spool));
  assert.ok(!fs.existsSync(spool + '.draining'));
});

test('drainSpool recovers a leftover .draining from a crashed previous run', () => {
  const spool = path.join(tmpDir(), 'telemetry-spool.jsonl');
  fs.writeFileSync(spool + '.draining', '{"event_type":"left"}\n');
  const events = drainSpool({ spoolPath: spool });
  assert.strictEqual(events[0].event_type, 'left');
  assert.ok(!fs.existsSync(spool + '.draining'));
});

test('drainSpool with no file returns empty array', () => {
  const events = drainSpool({ spoolPath: path.join(tmpDir(), 'none.jsonl') });
  assert.deepStrictEqual(events, []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/spool.test.js`
Expected: FAIL,`Cannot find module '../lib/spool'`。

- [ ] **Step 3: 实现**

`electron/lib/spool.js`:
```js
'use strict';
const fs = require('fs');

// Backend appends one JSON event per line (open-append-close per write, never
// holds a long-lived fd — required so our rename below can't fail on Windows).
// Contract: spec §5.

function parseSpoolText(text) {
  const events = [];
  let errors = 0;
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') events.push(obj);
      else errors += 1;
    } catch (_) {
      errors += 1;
    }
  }
  return { events, errors };
}

// rename-then-read: atomic hand-off so a concurrent backend append lands in a
// fresh spool file instead of the one being read. A leftover .draining file
// (crash between rename and unlink) is recovered before taking a new batch.
function drainSpool({ spoolPath, fsImpl = fs }) {
  const draining = spoolPath + '.draining';
  try {
    if (!fsImpl.existsSync(draining)) {
      if (!fsImpl.existsSync(spoolPath)) return [];
      fsImpl.renameSync(spoolPath, draining);
    }
    const { events } = parseSpoolText(fsImpl.readFileSync(draining, 'utf8'));
    fsImpl.unlinkSync(draining);
    return events;
  } catch (_) {
    return []; // racing write / locked file → retry on next tick
  }
}

module.exports = { parseSpoolText, drainSpool };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/spool.test.js`
Expected: 4 PASS。

- [ ] **Step 5: 提交**

```bash
git add lib/spool.js test/spool.test.js
git commit -m "feat(obs): spool parse + rename-then-read drain (pure, fs-injectable)"
```

---

### Task 6: electron `main.js` 接入 drain + context 补 hostname/os_username

**Files:**
- Modify: `electron/main.js`(require 区 L1-16;context 构造 L997-1002;telemetry 块后 ~L1006)

无单测(wiring);`node --check` + 全量回归。**Interfaces consumed:** `drainSpool`(Task 5)、`telemetry.report`(现有)。

- [ ] **Step 1: require `os` + `drainSpool`**

`electron/main.js` 顶部 require 区(`const crypto = require('crypto');` 之后)加:
```js
const osMod = require('os');
const { drainSpool } = require('./lib/spool');
```

- [ ] **Step 2: context 补 hostname/os_username**

`createReporter({ ... context: { ... } })` 的 context(约 L997-1002)改为:
```js
      context: {
        installId: getOrCreateInstallId(), appVersion: app.getVersion(),
        channel: updateConfig.channel, os: process.platform, arch: process.arch,
        hostname: osMod.hostname(),
        osUsername: (() => { try { return osMod.userInfo().username; } catch (_) { return ''; } })(),
        now: () => new Date().toISOString(),  // server expects ts as ISO date-time string
      },
```

- [ ] **Step 3: drain 函数 + 定时器**

在 `if (shouldReportTelemetry(updateConfig)) { ... }` 块(约 L995-1006,含 `telemetry.report('app_launch')`)**之后**插入:
```js
  // Drain backend-emitted observability events (spec §5). The backend only appends
  // to the spool; we own the network path. Each spool event carries its own backend
  // ts, which buildEvent lets win over ctx.now(). Spool dir = IPMC_DATA_DIR = AppData\...\data.
  function drainSpoolIntoTelemetry() {
    if (!telemetry) return;
    const spoolPath = path.join(getAppDataDir(), 'data', 'telemetry-spool.jsonl');
    for (const ev of drainSpool({ spoolPath })) {
      const { event_type, ...extra } = ev;
      if (!event_type) continue;
      telemetry.report(event_type, extra).catch(() => {});
    }
  }
  drainSpoolIntoTelemetry();
  setInterval(drainSpoolIntoTelemetry, 30_000);
```

注:dev 模式后端 data_dir 可能是仓库相对 `./data`,electron 读 AppData——dev 下 drain 不到是已知且可接受,不为此加分支。

- [ ] **Step 4: 验证**

Run: `cd electron && node --check main.js && npm test 2>&1 | tail -6`
Expected: 语法 OK;全 PASS。

- [ ] **Step 5: 提交**

```bash
git add main.js
git commit -m "feat(obs): drain backend telemetry spool on launch and every 30s"
```

---

### Task 7: electron.log 启动轮转

**Files:**
- Create: `electron/lib/log-rotate.js`
- Create: `electron/test/log-rotate.test.js`
- Modify: `electron/main.js`(`openElectronLog()` L141-153)

**Interfaces:**
- Produces: `rotateIfNeeded({logPath, maxBytes=2*1024*1024, fsImpl=fs}) -> boolean`(>maxBytes 时 rename 到 `.1` 并覆盖旧 `.1`,否则 false;任何 fs 错→false)。

- [ ] **Step 1: 写失败测试**

`electron/test/log-rotate.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rotateIfNeeded } = require('../lib/log-rotate');

function tmpLog(sizeBytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logrot-'));
  const p = path.join(dir, 'electron.log');
  fs.writeFileSync(p, 'x'.repeat(sizeBytes));
  return p;
}

test('small file is not rotated', () => {
  const p = tmpLog(10);
  assert.strictEqual(rotateIfNeeded({ logPath: p, maxBytes: 100 }), false);
  assert.ok(fs.existsSync(p));
  assert.ok(!fs.existsSync(p + '.1'));
});

test('oversize file rotates to .1 and replaces stale .1', () => {
  const p = tmpLog(200);
  fs.writeFileSync(p + '.1', 'old');
  assert.strictEqual(rotateIfNeeded({ logPath: p, maxBytes: 100 }), true);
  assert.ok(!fs.existsSync(p));
  assert.strictEqual(fs.readFileSync(p + '.1', 'utf8'), 'x'.repeat(200));
});

test('missing file is a no-op false', () => {
  assert.strictEqual(
    rotateIfNeeded({ logPath: path.join(os.tmpdir(), 'logrot-none', 'nope.log'), maxBytes: 100 }),
    false,
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/log-rotate.test.js`
Expected: FAIL,`Cannot find module '../lib/log-rotate'`。

- [ ] **Step 3: 实现**

`electron/lib/log-rotate.js`:
```js
'use strict';
const fs = require('fs');

// Startup-time rotation: electron.log is opened with flags:'a' and would grow
// unbounded across runs. Called BEFORE the write stream is opened, so rename
// is safe (no open handle on Windows).
function rotateIfNeeded({ logPath, maxBytes = 2 * 1024 * 1024, fsImpl = fs }) {
  try {
    const st = fsImpl.statSync(logPath);
    if (st.size <= maxBytes) return false;
    const rotated = logPath + '.1';
    if (fsImpl.existsSync(rotated)) fsImpl.unlinkSync(rotated);
    fsImpl.renameSync(logPath, rotated);
    return true;
  } catch (_) {
    return false; // missing file / locked / any fs error → just keep appending
  }
}

module.exports = { rotateIfNeeded };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/log-rotate.test.js`
Expected: 3 PASS。

- [ ] **Step 5: 接入 `openElectronLog()`**

`electron/main.js` 顶部 require 区加:
```js
const { rotateIfNeeded } = require('./lib/log-rotate');
```
`openElectronLog()`(约 L141-153)里,在 `const logPath = path.join(logsDir, 'electron.log');` 与 `electronLogStream = fs.createWriteStream(logPath, { flags: 'a' });` **之间**插入:
```js
    rotateIfNeeded({ logPath });
```

- [ ] **Step 6: 验证 + 提交**

Run: `node --check main.js && npm test 2>&1 | tail -6`
Expected: 语法 OK;全 PASS。
```bash
git add lib/log-rotate.js test/log-rotate.test.js main.js
git commit -m "feat(obs): rotate electron.log at startup when >2MB"
```

---

### Task 8: electron 生命周期事件(backend_crash / renderer_crash / backend_start_duration)

**Files:**
- Modify: `electron/main.js`(三处,均给锚点)

无单测(纯 wiring,依赖 electron 运行时);Task 9 有手工验证项。**Interfaces consumed:** `telemetry.report`、`tailString`(Task 4)。

- [ ] **Step 1: require tailString + 定位后端进程管理**

顶部 require 区加(若 Task 6 未引入则新增):
```js
const { tailString } = require('./lib/telemetry-core');
```
先确认本仓后端进程退出/spawn 与渲染崩溃锚点(命名可能与下文略异,按实际改):
Run: `grep -nE "backendProcess|\.on\('exit'|spawn\(|render-process-gone|stderr|backendStopping|waitForBackend|Backend ready" electron/main.js | head`
依据输出把下列三处接到真实锚点上(变量名以本仓为准)。

- [ ] **Step 2: backend_crash(后端非 0 退出,排除主动停)**

锚点:后端子进程 `.on('exit', (code, signal) => { ... })`。在其日志行之后插入(`stderrLines` / `backendStopping` 用本仓实际变量;若无 stderr 缓存则省去 stderr_tail):
```js
    if (code !== null && code !== 0 && !backendStopping && telemetry) {
      telemetry.report('backend_crash', {
        exit_code: code,
        stderr_tail: tailString((typeof stderrLines !== 'undefined' ? stderrLines.join('\n') : ''), 4096),
      }).catch(() => {});
    }
```
(若本仓无 `backendStopping` 抑制变量,改用其等价的"正在主动停后端"标志;无则先省略该条件,Task 9 E2E 验证正常退出是否误报,再补抑制。)

- [ ] **Step 3: renderer_crash**

锚点:`mainWindow.webContents` 创建处。其后插入:
```js
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details && details.reason === 'clean-exit') return;
    elog(`renderer gone: ${details && details.reason} exitCode=${details && details.exitCode}`);
    if (telemetry) {
      telemetry.report('renderer_crash', {
        reason: details && details.reason,
        exit_code: details && details.exitCode,
      }).catch(() => {});
    }
  });
```

- [ ] **Step 4: backend_start_duration**

模块级状态区(`let backendProcess` 附近)加:
```js
let backendStartedAt = 0;
```
后端 spawn **之前**加 `backendStartedAt = Date.now();`;`waitForBackend()` 成功后(`Backend ready` 日志附近)加:
```js
    if (telemetry && backendStartedAt) {
      telemetry.report('backend_start_duration', {
        duration_ms: Date.now() - backendStartedAt,
      }).catch(() => {});
    }
```

- [ ] **Step 5: 验证 + 提交**

Run: `node --check main.js && npm test 2>&1 | tail -6`
Expected: 语法 OK;全 PASS。
```bash
git add main.js
git commit -m "feat(obs): report backend_crash, renderer_crash, backend_start_duration"
```

---

### Task 9: 全量回归 + 手工 E2E 清单

**Files:** 无代码改动(最后记录结果时改本 plan)。

- [ ] **Step 1: 双侧全量**

Run:
```bash
uv run pytest tests/ -q 2>&1 | tail -5
cd electron && npm test 2>&1 | tail -6
```
Expected: 后端无新增失败(对照 Task 0);electron 全 PASS。

- [ ] **Step 2: 手工 E2E(dev 可做的部分,记录 PASS/FAIL + 现象)**

1. **spool drain**:手工写一行
   `{"event_type":"step_failed","ts":"2026-06-25T00:00:00Z","session_id":"x","error_code":"LLMCallError"}`
   到 `%APPDATA%\IPMaster-Cowork\data\telemetry-spool.jsonl`,启动应用,30s 内 spool 文件消失;若遥测服务可达,后台 `/events` 见该事件且 `ts` 保持原值、带 `hostname`/`os_username`。
2. **真实失败 → 事件**:制造一次 LLM/任务失败(如断网触发 LLM 失败),确认产生 `step_failed`/`task_failed` 入 spool 并上报。
3. **backend_crash**:任务管理器结束后端 exe → 出现 `backend_crash`;正常关闭应用**不应**出现(验证抑制)。
4. **轮转**:把 electron.log 撑到 >2MB 重启 → 出现 `electron.log.1`。

- [ ] **Step 3: 记录结果 + 收尾提交**

```bash
git add docs/superpowers/plans/2026-06-25-client-observability-phase-a.md
git commit -m "docs(obs): record Phase A verification results"
```

---

## Self-review 记录

- **Spec §5 覆盖**:emit=Task1;EventBus 订阅者=Task2+Task3;buildEvent 扩展/tailString=Task4;spool/drain=Task5+Task6;electron.log 轮转=Task7;生命周期事件=Task8;`.env` LOG_DIR 自愈=**无需代码**(现有 `reconcileUserEnv` 的 canonical 已含 `IPMC_LOG_DIR`,版本门控自动补行——仅在 Task 9 E2E 顺带验证)。
- **零 core 改动**:失败埋点仅在 host 订阅者,只读 `EventType` 常量。
- **类型一致**:`emit(event_type, **extra)`↔订阅者调用;`buildEvent` 新增 `ctx.hostname`/`ctx.osUsername`↔main.js context 注入 `hostname`/`osUsername`;`drainSpool` 返回 `[{event_type, ...}]`↔main.js 解构 `{event_type, ...extra}`;`extra` 后展开使后端 ts 胜出(Task4 用例锁定、Task6 依赖)。
- **粒度取舍**已在 Task2 注释与 spec §5 标注:MCP/skill 失败随 step/task 粗粒度,server/tool 明细留待将来 core seam。
- **wiring 任务**(Task3/6/8)无单测,靠 import 检查 / `node --check` / 全量回归;Task8 锚点变量名以本仓 grep 结果为准。
- 不打包、不 bump、不提交 uv.lock/.gitignore/package-lock。

---

## Phase A 实施结果(2026-06-25,subagent-driven 执行,落 master)

**全部 8 个代码任务完成,终审(opus 全特性 review)通过。**

提交链(master,基于 plan a178c3a;期间穿插了无关的并发 HITL 提交,已按文件范围隔离):
- `35527ef` 后端 emit()(T1)、`c0549bc` TelemetrySubscriber(T2)、`06b1c56` startup 注册 tele_handle(T3)、`f53e8cc` buildEvent+hostname/os_username+tailString(T4)、`3357aa9` spool.js(T5)、`8b69d06` main.js drain 接入(T6)、`3e87133` electron.log 轮转(T7)、`5ba78b5` 生命周期事件 + `92753d4` backendStopping 抑制(T8)、`7f7ff62` 终审 follow-up(observer error_message 内容泄漏修复)。

测试:后端 `uv run pytest tests/` 全绿(exit 0,新增 obs 测试 events×3/subscriber×5);electron `npm test` = **58/58 PASS**(新增 telemetry-core/spool/log-rotate 单测)。

**终审确认的端到端**:backend emit `{event_type,ts,...extra}` → spool → rename-then-read drain → 解构 `{event_type,...extra}` → buildEvent 合并 context(extra 后展开,后端 ts 胜出)→ POST `/events`。**spool 路径契约已核验**:electron 把 `IPMC_DATA_DIR=AppData\IPMaster-Cowork\data` 注入后端 spawn env,backend `paths.data_dir()` 解析一致,两侧都指 `…\data\telemetry-spool.jsonl`。零 core 改动(仅只读 import EventType);全链路 fire-and-forget(emit/subscriber/drain/report 均吞异常)。

**终审发现并已修复(Important)**:`TASK_FAILED_BY_OBSERVER` 的 `error_message` 是 observer 摘要、可能回显 agent 输出文字 → 违反 §5"不带对话内容"。修法:host 侧 `_CONTENT_UNSAFE_ERROR_CODES` 守卫,该 code 下 `error_message=None`(`error_code` 仍上报);技术性错误路径(StepFailed 的 `str(e)`、TASK_FAILED_AT_RUN)不受影响。
其余终审 Minor(接受不改):`tailString` 的 `maxBytes` 按字符非字节计(stderr_tail 上限略松);`drainSpool` 单批读失败靠下次重试。

### 手工 E2E 清单(打包安装态执行,**尚未跑** —— 需安装态 + 真实服务端)
1. spool drain:手写一行事件到 `%APPDATA%\IPMaster-Cowork\data\telemetry-spool.jsonl`,启动应用,30s 内文件消失;后台 `/events` 见事件且 `ts` 保持后端时间戳、带 hostname/os_username。
2. 真实失败 → 事件:制造 LLM/任务失败,确认 `step_failed`/`task_failed` 入 spool 并上报。
3. backend_crash:结束后端 exe → 出现 `backend_crash`;**正常关闭应用不应**出现(验证 backendStopping 抑制)。
4. 轮转:electron.log 撑过 2MB 重启 → 出现 `electron.log.1`。

### 已知延后项
- Plan B(日志上传 + 指令轮询 + zip 写入器)、Plan C(会话 SQLite 导出 + 上报 UI)未开始;**B 先于 C**。
```

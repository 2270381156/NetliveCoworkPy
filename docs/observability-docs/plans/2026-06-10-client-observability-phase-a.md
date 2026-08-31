# 客户端观测系统 Phase A 实现 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 客户端观测 Phase A——后端经 spool 文件、electron 经现有遥测通道,把崩溃/MCP/LLM/skill 失败与启动耗时变成结构化事件自动上报;同时修缮 electron.log 轮转与 .env LOG_DIR 缺失。

**Architecture:** 后端新增 `app/observability/events.py::emit()`,失败路径一行埋点写 `{data_dir}/telemetry-spool.jsonl`(append、open-write-close、异常全吞);electron 启动+每 30s rename-then-read drain 该文件,合入现有 reporter 离线队列上报 `/events`。`buildEvent` 公共字段扩展 `hostname`/`os_username`。服务端零改动(`/events` 兼容附加字段)。

**Tech Stack:** Electron main(CommonJS,node:test)、Python 3.11 FastAPI(pytest,uv)。Spec:`docs/superpowers/specs/2026-06-10-client-observability-design.md`(§4、§6、§8)。

---

## 全局约定(每个任务都适用)

- **工作目录:worktree `D:\20_code\miniAgentsDemo-obs`,分支 `feature/client-observability`**(Task 0 创建)。主目录在 master 上不要动。
- Electron 测试:`cd electron && npm test`(node --test test/*.test.js)。
- 后端测试:仓库根 `uv run pytest tests/<file> -v`。
- **绝不提交**:`uv.lock`、`.claire/`、`.gitignore`、`electron/package-lock.json`(除非任务明确要求)。
- 本 plan **不打包**。打包发布属 0.3.0 发版动作,按 CLAUDE.md 原则届时先 bump 版本号。
- 现有代码风格:electron 纯逻辑放 `electron/lib/*.js` 可注入依赖、配 `electron/test/*.test.js`;注释只写"代码看不出来的约束"。

---

### Task 0: 创建 worktree 与分支

**Files:** 无代码改动。

- [ ] **Step 1: 从 master 创建 worktree**

```bash
cd /d/20_code/miniAgentsDemo
git worktree add -b feature/client-observability ../miniAgentsDemo-obs master
```

- [ ] **Step 2: 验证**

```bash
cd /d/20_code/miniAgentsDemo-obs && git branch --show-current && git log --oneline -1
```
Expected: `feature/client-observability`,HEAD = master 同一提交(e4b5427 或其后)。

- [ ] **Step 3: 基线测试通过确认**

```bash
cd /d/20_code/miniAgentsDemo-obs/electron && npm install --ignore-scripts && npm test
cd /d/20_code/miniAgentsDemo-obs && uv sync && uv run pytest tests/ -x -q
```
Expected: 全部 PASS(基线干净才能开工;若基线即有挂的用例,记录并跳过该用例,不要顺手修)。

---

### Task 1: electron.log 启动轮转

**Files:**
- Create: `electron/lib/log-rotate.js`
- Create: `electron/test/log-rotate.test.js`
- Modify: `electron/main.js`(`openElectronLog`,约 L108)

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

```bash
cd electron && node --test test/log-rotate.test.js
```
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

```bash
node --test test/log-rotate.test.js
```
Expected: 3 PASS。

- [ ] **Step 5: 接入 main.js**

`electron/main.js` 顶部 require 区(`const { initUpdater } = require('./updater');` 之后)加:
```js
const { rotateIfNeeded } = require('./lib/log-rotate');
```
`openElectronLog()` 中,在 `const logPath = path.join(logsDir, 'electron.log');` 与
`electronLogStream = fs.createWriteStream(logPath, { flags: 'a' });` **之间**插入:
```js
    rotateIfNeeded({ logPath });
```

- [ ] **Step 6: 全量测试 + 提交**

```bash
npm test
git add lib/log-rotate.js test/log-rotate.test.js main.js
git commit -m "feat(obs): rotate electron.log at startup when >2MB"
```

---

### Task 2: buildEvent 扩展 hostname/os_username + tailString 工具

**Files:**
- Modify: `electron/lib/telemetry-core.js`
- Modify: `electron/test/telemetry-core.test.js`(追加用例)
- Modify: `electron/main.js`(ctx 构造,约 L673-681;顶部 require)

- [ ] **Step 1: 写失败测试**

`electron/test/telemetry-core.test.js` 追加(沿用文件内现有的 require 与 ctx 构造方式):
```js
test('buildEvent includes hostname and os_username from ctx', () => {
  const ctx = {
    installId: 'i', appVersion: '1', channel: 'stable', os: 'win32', arch: 'x64',
    hostname: 'HOST-1', osUsername: 'alice', now: () => 'T',
  };
  const ev = buildEvent('app_launch', ctx);
  assert.strictEqual(ev.hostname, 'HOST-1');
  assert.strictEqual(ev.os_username, 'alice');
});

test('extra.ts overrides ctx.now (spool events keep backend timestamp)', () => {
  const ctx = {
    installId: 'i', appVersion: '1', channel: 'stable', os: 'win32', arch: 'x64',
    hostname: 'h', osUsername: 'u', now: () => 'NOW',
  };
  const ev = buildEvent('mcp_call_failed', ctx, { ts: 'BACKEND-TS', server: 'kb' });
  assert.strictEqual(ev.ts, 'BACKEND-TS');
});

test('tailString keeps at most maxBytes from the end', () => {
  const { tailString } = require('../lib/telemetry-core');
  assert.strictEqual(tailString('abcdef', 4), 'cdef');
  assert.strictEqual(tailString('ab', 4), 'ab');
  assert.strictEqual(tailString('', 4), '');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test test/telemetry-core.test.js
```
Expected: 新增 3 个用例 FAIL(hostname undefined / ts 不等 / tailString 不存在)。

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

```bash
node --test test/telemetry-core.test.js
```
Expected: 全 PASS(含原有用例——若原有用例对事件做了全字段深比较,补上两个新字段)。

- [ ] **Step 5: main.js 注入真实值**

顶部 require 区加(`const crypto = require('crypto');` 之后):
```js
const osMod = require('os');
```
`app.whenReady` 内 `createReporter({ ... context: { ... } })`(约 L675-679)的 context 改为:
```js
      context: {
        installId: getOrCreateInstallId(), appVersion: app.getVersion(),
        channel: updateConfig.channel, os: process.platform, arch: process.arch,
        hostname: osMod.hostname(),
        osUsername: (() => { try { return osMod.userInfo().username; } catch (_) { return ''; } })(),
        now: () => new Date().toISOString(),  // server expects ts as ISO date-time string
      },
```

- [ ] **Step 6: 全量测试 + 提交**

```bash
npm test
git add lib/telemetry-core.js test/telemetry-core.test.js main.js
git commit -m "feat(obs): identify clients with hostname/os_username; add tailString helper"
```

---

### Task 3: spool 解析与 drain 模块(纯逻辑)

**Files:**
- Create: `electron/lib/spool.js`
- Create: `electron/test/spool.test.js`

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
  const dir = tmpDir();
  const spool = path.join(dir, 'telemetry-spool.jsonl');
  fs.writeFileSync(spool, '{"event_type":"a"}\n');
  const events = drainSpool({ spoolPath: spool });
  assert.strictEqual(events.length, 1);
  assert.ok(!fs.existsSync(spool));
  assert.ok(!fs.existsSync(spool + '.draining'));
});

test('drainSpool recovers a leftover .draining file from a crashed previous run', () => {
  const dir = tmpDir();
  const spool = path.join(dir, 'telemetry-spool.jsonl');
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

```bash
node --test test/spool.test.js
```
Expected: FAIL,`Cannot find module '../lib/spool'`。

- [ ] **Step 3: 实现**

`electron/lib/spool.js`:
```js
'use strict';
const fs = require('fs');

// Backend appends one JSON event per line (open-append-close per write, never
// holds a long-lived fd — required so our rename below can't fail on Windows).
// Contract: spec §4.2.

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

```bash
node --test test/spool.test.js
```
Expected: 4 PASS。

- [ ] **Step 5: 提交**

```bash
git add lib/spool.js test/spool.test.js
git commit -m "feat(obs): spool parse + rename-then-read drain (pure, fs-injectable)"
```

---

### Task 4: main.js 接入 spool drain(启动 + 每 30s)

**Files:**
- Modify: `electron/main.js`

- [ ] **Step 1: require**

顶部 require 区加:
```js
const { drainSpool } = require('./lib/spool');
```

- [ ] **Step 2: drain 函数 + 定时器**

在 `app.whenReady().then(async () => {` 的 telemetry 创建块(`if (shouldReportTelemetry(updateConfig)) { ... }`,约 L672-683)**之后**插入:
```js
  // Drain backend-emitted observability events (spec §4.2). The backend only
  // appends to the spool; we own the network path. extra carries the backend's
  // own ts, which buildEvent lets win over ctx.now().
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

注意:spool 路径必须与后端 `settings.data_dir` 一致——打包态两者都是
`%APPDATA%\IPMaster-Cowork\data`(`ensureUserEnvFile` 写的 `IPMASTER_COWORK_DATA_DIR`)。
dev 模式后端 data_dir 是仓库相对 `./data`,electron 读 AppData —— dev 下 drain 不到是已知且可接受的,不要为此加分支。

- [ ] **Step 3: 验证(语法 + 现有测试)**

```bash
node --check main.js && npm test
```
Expected: 语法 OK,全部 PASS。

- [ ] **Step 4: 提交**

```bash
git add main.js
git commit -m "feat(obs): drain backend telemetry spool on launch and every 30s"
```

---

### Task 5: 后端 emit 模块

**Files:**
- Create: `app/observability/events.py`
- Create: `tests/test_observability_events.py`

- [ ] **Step 1: 写失败测试**

`tests/test_observability_events.py`:
```python
"""emit() 写 spool 的行为与绝不抛错的保证。"""
import json
from types import SimpleNamespace

import app.observability.events as events_mod


def test_emit_appends_one_json_line(tmp_path, monkeypatch):
    monkeypatch.setattr(
        events_mod, "_get_settings", lambda: SimpleNamespace(data_dir=tmp_path)
    )
    events_mod.emit("mcp_call_failed", server="kb", tool="search", duration_ms=120)
    events_mod.emit("llm_call_failed", provider="OpenAIAdapter", model="m")

    lines = (tmp_path / "telemetry-spool.jsonl").read_text(encoding="utf-8").strip().split("\n")
    assert len(lines) == 2
    first = json.loads(lines[0])
    assert first["event_type"] == "mcp_call_failed"
    assert first["server"] == "kb" and first["duration_ms"] == 120
    assert "ts" in first and first["ts"].endswith("Z") is False or "T" in first["ts"]


def test_emit_never_raises(monkeypatch):
    def boom():
        raise RuntimeError("settings unavailable")
    monkeypatch.setattr(events_mod, "_get_settings", boom)
    events_mod.emit("anything", x=1)  # 不应抛出


def test_emit_serializes_non_json_values(tmp_path, monkeypatch):
    monkeypatch.setattr(
        events_mod, "_get_settings", lambda: SimpleNamespace(data_dir=tmp_path)
    )
    events_mod.emit("e", path=tmp_path)  # Path 不是 JSON 原生类型,走 default=str
    line = (tmp_path / "telemetry-spool.jsonl").read_text(encoding="utf-8").strip()
    assert json.loads(line)["path"] == str(tmp_path)
```

- [ ] **Step 2: 跑测试确认失败**

```bash
uv run pytest tests/test_observability_events.py -v
```
Expected: FAIL,`No module named 'app.observability.events'`。

- [ ] **Step 3: 实现**

`app/observability/events.py`:
```python
"""客户端观测事件:append 到本地 spool 文件,由 Electron 统一上报。

契约见 docs/superpowers/specs/2026-06-10-client-observability-design.md §4.2:
- 一行一个 JSON 对象 {event_type, ts, **extra};
- 每次 open-append-close,不持长 fd(Electron 用 rename 接管文件,Windows 上
  rename 打开中的文件会失败);
- 任何异常静默吞掉——遥测绝不影响业务。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone


def _get_settings():
    from app.config.settings import get_settings
    return get_settings()


def emit(event_type: str, **extra) -> None:
    try:
        path = _get_settings().data_dir / "telemetry-spool.jsonl"
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

- [ ] **Step 4: 跑测试确认通过**

```bash
uv run pytest tests/test_observability_events.py -v
```
Expected: 3 PASS。

- [ ] **Step 5: 提交**

```bash
git add app/observability/events.py tests/test_observability_events.py
git commit -m "feat(obs): backend emit() appends events to telemetry spool"
```

---

### Task 6: MCP 失败/超时埋点

**Files:**
- Modify: `app/tools/mcp_base.py`(`call()`,L90-111)
- Create: `tests/test_mcp_emit.py`

- [ ] **Step 1: 写失败测试**

`tests/test_mcp_emit.py`:
```python
"""MCP call() 失败路径 emit 行为。"""
import pytest

import app.tools.mcp_base as mcp_base
from app.common.errors import AppError
from app.tools.mcp_provider import MCPStdioProvider


def _failing_provider(monkeypatch, exc, events):
    monkeypatch.setattr(mcp_base, "emit", lambda et, **kw: events.append((et, kw)))
    p = MCPStdioProvider(name="kb", command="nonexistent")
    p._initialized = True

    def boom(tool_name, arguments, meta):
        raise exc
    monkeypatch.setattr(p, "_do_call", boom)
    return p


def test_generic_failure_emits_mcp_call_failed(monkeypatch):
    events = []
    p = _failing_provider(monkeypatch, RuntimeError("conn reset"), events)
    with pytest.raises(RuntimeError):
        p.call("search", {"q": "x"})
    assert len(events) == 1
    et, kw = events[0]
    assert et == "mcp_call_failed"
    assert kw["server"] == "kb" and kw["tool"] == "search"
    assert kw["error_class"] == "RuntimeError"
    assert isinstance(kw["duration_ms"], int)


def test_timeout_emits_mcp_call_timeout(monkeypatch):
    events = []
    p = _failing_provider(
        monkeypatch, AppError("MCP_CONNECT_TIMEOUT", "timed out"), events
    )
    with pytest.raises(AppError):
        p.call("search", {"q": "x"})
    et, kw = events[0]
    assert et == "mcp_call_timeout"
    assert kw["timeout_s"] == p._request_timeout


def test_success_emits_nothing(monkeypatch):
    events = []
    monkeypatch.setattr(mcp_base, "emit", lambda et, **kw: events.append(et))
    p = MCPStdioProvider(name="kb", command="nonexistent")
    p._initialized = True
    monkeypatch.setattr(p, "_do_call", lambda *a: "ok")
    assert p.call("search", {}) == "ok"
    assert events == []
```

- [ ] **Step 2: 跑测试确认失败**

```bash
uv run pytest tests/test_mcp_emit.py -v
```
Expected: FAIL,`module 'app.tools.mcp_base' has no attribute 'emit'`。

- [ ] **Step 3: 实现**

`app/tools/mcp_base.py` 顶部 import 区(`from app.common.errors import AppError` 附近)加:
```python
import time

from app.observability.events import emit
```
`call()` 方法整体替换为(保留既有 session-terminated 处理,新增计时与 emit):
```python
    def call(self, tool_name: str, arguments: dict, ctx: CallContext | None = None) -> ToolResult:
        with self._drain:
            if not self._initialized:
                raise AppError(
                    "MCP_NOT_STARTED",
                    f"{type(self).__name__}.start() has not been called",
                )
            self._active_calls += 1
        meta = {"netcowork/sessionId": ctx.session_id} if ctx else None
        t0 = time.monotonic()
        try:
            return self._do_call(tool_name, arguments, meta)
        except Exception as e:
            if _is_session_terminated(e):
                with self._drain:
                    self._initialized = False
                logger.warning("MCP session terminated while calling '%s', marked as disconnected", tool_name)
            is_timeout = isinstance(e, AppError) and e.code == "MCP_CONNECT_TIMEOUT"
            extra: dict = {
                "server": getattr(self, "_name", "?"),
                "tool": tool_name,
                "error_class": type(e).__name__,
                "duration_ms": int((time.monotonic() - t0) * 1000),
            }
            if is_timeout:
                extra["timeout_s"] = self._request_timeout
            emit("mcp_call_timeout" if is_timeout else "mcp_call_failed", **extra)
            raise
        finally:
            with self._drain:
                self._active_calls -= 1
                if self._active_calls == 0:
                    self._drain.notify_all()
```

- [ ] **Step 4: 跑测试确认通过(含既有 MCP 套件防回归)**

```bash
uv run pytest tests/test_mcp_emit.py tests/test_mcp_providers.py tests/test_registry_mcp.py -v
```
Expected: 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add app/tools/mcp_base.py tests/test_mcp_emit.py
git commit -m "feat(obs): emit mcp_call_failed/mcp_call_timeout from MCP call path"
```

---

### Task 7: LLM 失败埋点

**Files:**
- Modify: `app/llm/base.py`(`BaseChatClient.send_message` L92-108、`stream_message` L110-126)
- Create: `tests/test_llm_emit.py`

- [ ] **Step 1: 写失败测试**

`tests/test_llm_emit.py`:
```python
"""BaseChatClient 失败路径 emit 行为。"""
import pytest

import app.llm.base as llm_base
from app.llm.base import BaseChatClient


class _BoomAdapter:
    def complete(self, req):
        raise RuntimeError("api down")

    def stream(self, req):
        raise RuntimeError("api down")
        yield  # pragma: no cover  (使其成为生成器函数)


def test_send_message_failure_emits(monkeypatch):
    events = []
    monkeypatch.setattr(llm_base, "emit", lambda et, **kw: events.append((et, kw)))
    client = BaseChatClient(adapter=_BoomAdapter(), model="glm-4")
    with pytest.raises(RuntimeError):
        client.send_message([])
    et, kw = events[0]
    assert et == "llm_call_failed"
    assert kw["provider"] == "_BoomAdapter"
    assert kw["model"] == "glm-4"
    assert kw["error_class"] == "RuntimeError"


def test_stream_message_failure_emits_on_iteration(monkeypatch):
    events = []
    monkeypatch.setattr(llm_base, "emit", lambda et, **kw: events.append((et, kw)))
    client = BaseChatClient(adapter=_BoomAdapter(), model="glm-4")
    it = client.stream_message([])   # 构造迭代器本身不应触发
    assert events == []
    with pytest.raises(RuntimeError):
        next(it)
    assert events[0][0] == "llm_call_failed"
    assert events[0][1]["stream"] is True
```

- [ ] **Step 2: 跑测试确认失败**

```bash
uv run pytest tests/test_llm_emit.py -v
```
Expected: FAIL,`module 'app.llm.base' has no attribute 'emit'`。

- [ ] **Step 3: 实现**

`app/llm/base.py` import 区(`from app.llm.types import (...)` 之后)加:
```python
from app.observability.events import emit
```
`send_message` 的最后一行 `return self._adapter.complete(req)` 替换为:
```python
        try:
            return self._adapter.complete(req)
        except Exception as e:
            emit(
                "llm_call_failed",
                provider=type(self._adapter).__name__,
                model=self._model,
                error_class=type(e).__name__,
            )
            raise
```
`stream_message` 的最后一行 `return self._adapter.stream(req)` 替换为:
```python
        def _stream_with_emit():
            try:
                yield from self._adapter.stream(req)
            except Exception as e:
                emit(
                    "llm_call_failed",
                    provider=type(self._adapter).__name__,
                    model=self._model,
                    error_class=type(e).__name__,
                    stream=True,
                )
                raise

        return _stream_with_emit()
```

- [ ] **Step 4: 跑测试确认通过(含既有 adapter 套件防回归)**

```bash
uv run pytest tests/test_llm_emit.py tests/test_llm_adapters.py -v
```
Expected: 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add app/llm/base.py tests/test_llm_emit.py
git commit -m "feat(obs): emit llm_call_failed from unified client (sync + stream)"
```

---

### Task 8: skill 执行失败埋点

**Files:**
- Modify: `app/tools/skill_executor.py`(`exec_skill_script`,L73-84)
- Create: `tests/test_skill_emit.py`

注意:`@skill_executor_tool` 把函数替换为 `ToolDefinition`,模块名 `exec_skill_script`
是 ToolDefinition 对象;测试经 `.handler(arguments_dict, ctx)` 调用(签名见
`app/tools/utils.py::make_tool_handler`)。

- [ ] **Step 1: 写失败测试**

`tests/test_skill_emit.py`:
```python
"""exec_skill_script 失败路径 emit 行为。"""
import pytest

import app.tools.skill_executor as se
from app.common.errors import AppError


class _FakeSkill:
    name = "olt"

    def exec_script(self, script_path, args, ctx):
        raise AppError("SCRIPT_NOT_FOUND", "no such script")


def test_exec_skill_script_failure_emits(monkeypatch):
    events = []
    monkeypatch.setattr(se, "emit", lambda et, **kw: events.append((et, kw)))
    monkeypatch.setattr(se, "_skill_name_from_ctx", lambda ctx: "olt")
    monkeypatch.setattr(se, "_get_skill", lambda name, ctx: _FakeSkill())

    with pytest.raises(AppError):
        se.exec_skill_script.handler({"script_path": "scripts/x.py"}, None)

    et, kw = events[0]
    assert et == "skill_exec_failed"
    assert kw["skill"] == "olt"
    assert kw["error_class"] == "AppError"
    assert kw["error_code"] == "SCRIPT_NOT_FOUND"
```

- [ ] **Step 2: 跑测试确认失败**

```bash
uv run pytest tests/test_skill_emit.py -v
```
Expected: FAIL,`module ... has no attribute 'emit'`。

- [ ] **Step 3: 实现**

`app/tools/skill_executor.py` import 区(`from app.common.errors import AppError` 之后)加:
```python
from app.observability.events import emit
```
`exec_skill_script` 函数体(装饰器内的原函数)替换为:
```python
@skill_executor_tool
def exec_skill_script(
    script_path: Annotated[str, "Relative path to the script within the skill directory (e.g. 'scripts/extract.py')"],
    args: Annotated[str, "Command-line argument string appended after the script path"] = "",
    *,
    ctx: CallContext | None = None,
) -> ToolResult:
    """Execute a script from the current task's skill directory. The working directory is set to the skill root. Construct args as described in the skill instructions."""
    if not script_path:
        raise AppError("INVALID_ARGUMENT", "script_path is required")
    skill = _get_skill(_skill_name_from_ctx(ctx), ctx)
    try:
        return skill.exec_script(script_path, args, ctx)
    except Exception as e:
        emit(
            "skill_exec_failed",
            skill=skill.name,
            script=script_path,
            error_class=type(e).__name__,
            error_code=getattr(e, "code", None),
        )
        raise
```

- [ ] **Step 4: 跑测试确认通过(含既有套件防回归)**

```bash
uv run pytest tests/test_skill_emit.py tests/test_builtins.py -v
```
Expected: 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add app/tools/skill_executor.py tests/test_skill_emit.py
git commit -m "feat(obs): emit skill_exec_failed from exec_skill_script"
```

---

### Task 9: electron 生命周期事件(backend_crash / renderer_crash / backend_start_duration)

**Files:**
- Modify: `electron/main.js`(三处,均给出锚点)

无法单测(纯 wiring,依赖 electron 运行时);Task 11 有手工验证项。

- [ ] **Step 1: backend_crash**

顶部 require 区把 Task 2 的 telemetry-core require 改为同时引入 tailString
(若尚无此行则新增):
```js
const { tailString } = require('./lib/telemetry-core');
```
锚点:`backendProcess.on('exit', (code, signal) => {`(约 L322)。在
`elog(`[exit] code=${code} signal=${signal}`);` 之后插入:
```js
    if (code !== null && code !== 0 && telemetry) {
      telemetry.report('backend_crash', {
        exit_code: code,
        stderr_tail: tailString(stderrLines.join('\n'), 4096),
      }).catch(() => {});
    }
```

- [ ] **Step 2: renderer_crash**

锚点:`createWindow()` 内 `mainWindow.setMenuBarVisibility(false);`。其后插入:
```js
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    elog(`renderer gone: ${details.reason} exitCode=${details.exitCode}`);
    if (telemetry) {
      telemetry.report('renderer_crash', {
        reason: details.reason,
        exit_code: details.exitCode,
      }).catch(() => {});
    }
  });
```

- [ ] **Step 3: backend_start_duration**

模块级状态区(`let backendProcess = null;` 附近)加:
```js
let backendStartedAt = 0;
```
`startBackend()` 内 `backendProcess = spawn(exePath, [], {` **之前**加:
```js
  backendStartedAt = Date.now();
```
锚点:`createWindow()` 内 `await waitForBackend();` 成功后的
`elog('Backend ready, loading UI');` 之后插入:
```js
    if (telemetry && backendStartedAt) {
      telemetry.report('backend_start_duration', {
        duration_ms: Date.now() - backendStartedAt,
      }).catch(() => {});
    }
```

- [ ] **Step 4: 验证 + 提交**

```bash
node --check main.js && npm test
git add main.js
git commit -m "feat(obs): report backend_crash, renderer_crash, backend_start_duration"
```

---

### Task 10: .env 缺失 LOG_DIR 自愈(后端文件日志前置修缮)

旧版本生成的 `.env`(或 NetLIVE 迁移而来的)可能没有 `IPMASTER_COWORK_LOG_DIR`
行 → 后端不写文件日志 → 日志上报(Phase B)拿不到后端日志。启动时自愈补行。

**Files:**
- Create: `electron/lib/env-heal.js`
- Create: `electron/test/env-heal.test.js`
- Modify: `electron/main.js`(`ensureUserEnvFile`,约 L131-168)

- [ ] **Step 1: 写失败测试**

`electron/test/env-heal.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { ensureEnvLine } = require('../lib/env-heal');

test('appends the line when key is absent', () => {
  const r = ensureEnvLine('A=1\n', 'IPMASTER_COWORK_LOG_DIR', 'C:/logs');
  assert.strictEqual(r.changed, true);
  assert.match(r.content, /^IPMASTER_COWORK_LOG_DIR=C:\/logs$/m);
  assert.match(r.content, /^A=1$/m);
});

test('leaves existing value untouched (user edits win)', () => {
  const input = 'IPMASTER_COWORK_LOG_DIR=D:/custom\n';
  const r = ensureEnvLine(input, 'IPMASTER_COWORK_LOG_DIR', 'C:/logs');
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.content, input);
});

test('does not match commented-out lines as present', () => {
  const r = ensureEnvLine('# IPMASTER_COWORK_LOG_DIR=old\n', 'IPMASTER_COWORK_LOG_DIR', 'C:/logs');
  assert.strictEqual(r.changed, true);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test test/env-heal.test.js
```
Expected: FAIL,`Cannot find module '../lib/env-heal'`。

- [ ] **Step 3: 实现**

`electron/lib/env-heal.js`:
```js
'use strict';

// Append `KEY=value` to .env content when the key has no active line.
// Never rewrites an existing assignment — user edits win.
function ensureEnvLine(content, key, value) {
  const re = new RegExp('^' + key + '=', 'm');
  if (re.test(content)) return { content, changed: false };
  const sep = content.endsWith('\n') || content === '' ? '' : '\n';
  return { content: content + sep + key + '=' + value + '\n', changed: true };
}

module.exports = { ensureEnvLine };
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test test/env-heal.test.js
```
Expected: 3 PASS。

- [ ] **Step 5: 接入 ensureUserEnvFile**

顶部 require 区加:
```js
const { ensureEnvLine } = require('./lib/env-heal');
```
`ensureUserEnvFile()` 中,现有 `if (!fs.existsSync(envPath)) { ... }` 块**之后**、
`return envPath;` **之前**插入:
```js
  // Heal pre-existing .env files that predate the LOG_DIR line — without it the
  // backend never writes its file log, and Phase B log upload has nothing to ship.
  try {
    const current = fs.readFileSync(envPath, 'utf8');
    const healed = ensureEnvLine(
      current,
      'IPMASTER_COWORK_LOG_DIR',
      path.join(appDataDir, 'logs').replace(/\\/g, '/'),
    );
    if (healed.changed) {
      fs.writeFileSync(envPath, healed.content, 'utf8');
      elog('Healed .env: added IPMASTER_COWORK_LOG_DIR');
    }
  } catch (e) { elog('env heal failed: ' + e.message); }
```

- [ ] **Step 6: 全量测试 + 提交**

```bash
npm test
git add lib/env-heal.js test/env-heal.test.js main.js
git commit -m "fix(obs): heal .env missing LOG_DIR so backend file logging is active"
```

---

### Task 11: 全量回归 + 手工 E2E 清单

- [ ] **Step 1: 双侧全量测试**

```bash
cd /d/20_code/miniAgentsDemo-obs/electron && npm test
cd /d/20_code/miniAgentsDemo-obs && uv run pytest tests/ -q
```
Expected: 全 PASS。

- [ ] **Step 2: 手工 E2E(dev 可做的部分)**

1. **spool drain**:手工写一行
   `{"event_type":"mcp_call_failed","ts":"2026-06-10T00:00:00Z","server":"kb"}` 到
   `%APPDATA%\IPMaster-Cowork\data\telemetry-spool.jsonl`,启动应用(`cd electron && npm start`,
   需先有打包后端或跑全量构建的 dist),30s 内 spool 文件消失;若更新服务可达,管理后台
   `/events` 可见该事件且 `ts` 保持 `2026-06-10T00:00:00Z`、带 hostname/os_username。
2. **backend_crash**:任务管理器结束 `ipmaster-cowork.exe` → electron.log 出现
   `[exit] code=1`,事件队列/服务端出现 `backend_crash` 且 stderr_tail 非空。
3. **轮转**:把 electron.log 撑到 >2MB(复制粘贴自身若干次),重启 → 出现
   `electron.log.1`,新 electron.log 从头开始。
4. **env 自愈**:从 `.env` 删除 `IPMASTER_COWORK_LOG_DIR` 行,重启 → 行被补回,
   electron.log 出现 `Healed .env`;后端日志文件 `logs/ipmaster-cowork.log` 开始生成。

- [ ] **Step 3: 记录验证结果到 plan 末尾,提交收尾**

```bash
git add docs/superpowers/plans/2026-06-10-client-observability-phase-a.md
git commit -m "docs(obs): record Phase A verification results"
```

---

## Self-review 记录

- Spec §4.1 全部事件有任务覆盖(Task 6/7/8/9);§4.2 spool 契约 = Task 3/4/5;
  §3 标识扩展 = Task 2;§8 前置修缮 1 = Task 1、修缮 2 = Task 10。
- `extra` 后展开使 spool 的 backend ts 覆盖 ctx.now() —— Task 2 测试显式锁定该行为,
  Task 4 依赖之。
- `@skill_executor_tool` 返回 ToolDefinition(非函数)→ Task 8 测试经 `.handler()` 调用,
  已核对 `make_tool_handler` 签名 `(arguments: dict, ctx=None)`。
- AppError 的码属性为 `.code`(`app/common/errors.py`)— Task 6 超时判定使用之;
  master 上超时码为 `MCP_CONNECT_TIMEOUT`(注意 hotfix/0.1.x 的 DEFAULT_MCP_TIMEOUT
  改动尚未合入 master,本 plan 不依赖它)。
- 不打包、不 bump 版本(发版时按 CLAUDE.md 原则处理);不提交 uv.lock/.claire/.gitignore。

---

## Task 0 基线记录(2026-06-10,worktree @ e4b5427)

- electron:`npm test` 17/17 PASS。
- pytest:**107 passed / 11 failed(均为 master 既有失败,与本工作无关)**;另有 4 个文件
  收集即损坏需 `--ignore`:test_builtins.py(import http_request)、test_llm_adapters.py、
  test_phase_implementations.py(import agent_framework)、test_tool_decorator.py。
- 既有失败清单:test_lifecycle_manager.py ×2;test_mcp_providers.py ×3
  (test_is_tool_provider_protocol ×2、test_map_function_tool_is_inherited_from_base);
  test_registry_mcp.py ×6(TestToolRegistryBasic 全组)。
- **回归判定标准:无新增失败**(Task 6/7/8 的"全 PASS"预期按此修正;基线 pytest 命令:
  `uv run pytest tests/ -q --ignore=tests/test_builtins.py --ignore=tests/test_llm_adapters.py --ignore=tests/test_phase_implementations.py --ignore=tests/test_tool_decorator.py`)。

---

## Phase A 实施结果(2026-06-10,subagent-driven 执行)

**全部 10 个代码任务 + 前置修缮完成,终审通过(零 Critical / 零 Important)。**

提交链(feature/client-observability,基于 master e4b5427):
- log-rotate(Task1)、telemetry-core hostname/os_username + tailString(Task2)、spool 模块(Task3)、main.js drain 接入(Task4)、后端 emit(Task5)、MCP 埋点(Task6)、LLM 埋点(Task7)、skill 埋点(Task8)、electron 生命周期事件(Task9,含修两个误报 Critical:stopBackend 期间 taskkill 误报 backend_crash → backendStopping 抑制;renderer clean-exit 误报 → 过滤)、env-heal(Task10)、终审 follow-up(telemetry 关闭也清 spool + mcp 超时分类注释)。

测试:
- electron `npm test` = **34/34 PASS**(基线 17 + 新增 17)。
- pytest = **117 passed / 11 failed**,11 个失败全为 Task 0 记录的基线既有失败,**零新增回归**;新增观测测试 events×3/mcp×3/llm×2/skill×2 全过。

终审确认的端到端:backend emit `{event_type,ts,...extra}` → spool → rename-then-read drain → 解构 `{event_type,...extra}` → buildEvent 合并 context(extra 后展开,后端 ts 胜出)→ POST `/events`,14 字段无碰撞无丢失;打包态 spool 路径两侧一致(electron 写 IPMASTER_COWORK_DATA_DIR=AppData\data,_run.py load_dotenv,settings.data_dir 解析一致);无 import 循环;安全降级(telemetry 关闭仍清 spool;dev 模式不 drain 是已知 no-op;emit 吞所有异常)。

### 手工 E2E 清单(打包态执行,尚未跑 —— 需安装态)
1. spool drain:手写一行事件到 `%APPDATA%\IPMaster-Cowork\data\telemetry-spool.jsonl`,启动应用,30s 内文件消失;管理后台 /events 见事件且 ts 保持后端时间戳、带 hostname/os_username。
2. backend_crash:结束 ipmaster-cowork.exe → 出现 backend_crash 且 stderr_tail 非空;正常关闭应用**不应**出现 backend_crash(验证 backendStopping 抑制)。
3. renderer_crash:正常关窗**不应**上报(clean-exit 过滤);真崩溃才报。
4. 轮转:electron.log 撑过 2MB 重启 → 出现 electron.log.1。
5. env 自愈:删 .env 的 LOG_DIR 行重启 → 行被补回 + 后端 logs/ipmaster-cowork.log 开始生成。

### 已知延后项(非阻塞,记入待办)
- llm_call_failed 的可选 status_code 未接(需 per-adapter 钩子)—— Phase A 之外的增强。
- Phase B(日志上传 + 指令轮询 + 服务端)、Phase C(会话上报 + 手填标签)未开始。

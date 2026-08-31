# Phase C: 用户主动"上报此会话" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在会话界面点"上报此会话"，把该会话的完整对话（messages + tool_calls + 元信息 + environment）连同运行日志尾部，打成**一个 zip** 上传到遥测服务（`reason=session_report`），需用户明确确认。

**Architecture:** 后端加 `GET /sessions/{id}/export`（组合现有读路径）；electron 新增纯函数 `buildSessionReportEntries` + `ipcMain.handle('report-session')`（复用 Phase B 的 `collectTail`/`zipEntries`/`uploadLogs`/`clientFields`）；preload 暴露 `reportSession`；frontend-desktop 新增自包含 `ReportSessionButton` 组件接到 ChatPanel 头部。服务端不在本仓改（契约交并行会话）。

**Tech Stack:** Python FastAPI（pytest）、Electron main（node:test）、React 19 + Vite + vitest/testing-library。Spec: `docs/superpowers/specs/2026-06-11-phase-c-session-report-design.md`。

---

## 全局约定

- **工作目录 `D:\20_code\miniAgentsDemo`，分支 `feat/phase-c-session-report`**（已建，含 spec 提交）。
- 后端测试：`uv run pytest tests/<file> -v`。electron：`cd electron && npm test`。前端：`cd frontend-desktop && npm test`（vitest run）+ `npx tsc -b`。
- **绝不提交** uv.lock / .claire / .gitignore / package-lock.json。不打包。
- 风格：electron 纯逻辑入 `electron/lib/*.js` 可注入、配 `electron/test/*.test.js`；前端组件自包含、配 `*.test.tsx`；注释只写代码看不出来的约束。

## 服务端契约（交并行会话，本仓不改）
`POST /logs` 已收 `reason` + `command_id`。Phase C 需新增**可选**表单字段 `session_id`、`user_note`，写进该上传的 `.meta.json`；`reason=session_report` 在看板单独标注并展示 `session_id` + `user_note`。客户端按本计划发这两个字段。

## 文件结构

| 文件 | 职责 |
|------|------|
| Modify `app/api/v1/routes/sessions.py` | 加 `GET /{session_id}/export` → `{session, messages, tool_calls}` |
| Create `tests/test_session_export.py` | export 路由单测（monkeypatch 直调） |
| Create `electron/lib/session-report.js` | 纯函数 `buildSessionReportEntries` → zip 条目 |
| Create `electron/test/session-report.test.js` | 上同单测 |
| Modify `electron/main.js` | `ipcMain.handle('report-session')` wiring + require |
| Modify `electron/preload.js` | `electronAPI.reportSession` |
| Create `frontend-desktop/src/components/ReportSessionButton.tsx` | 上报按钮 + 确认框 + 备注 + 状态 |
| Create `frontend-desktop/src/components/ReportSessionButton.test.tsx` | 组件单测（mock window.electronAPI + i18n） |
| Modify `frontend-desktop/src/i18n.tsx` | 加 `chat.reportSession*` key（zh + en） |
| Modify `frontend-desktop/src/components/ChatPanel.tsx` | 头部接入 `<ReportSessionButton>` |

---

### Task 0: 基线确认

- [ ] **Step 1: 分支 + 三侧基线**

```bash
cd /d/20_code/miniAgentsDemo && git branch --show-current
cd electron && npm test 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
cd ../frontend-desktop && npm test 2>&1 | tail -5
cd .. && uv run pytest tests/test_observability_events.py -q 2>&1 | tail -2
```
Expected: 分支 `feat/phase-c-session-report`；electron 全 PASS（53）；前端 vitest 全 PASS；pytest 烟囱用例 PASS（确认环境可跑）。

---

### Task 1: 后端 `GET /sessions/{id}/export`

**Files:**
- Modify: `app/api/v1/routes/sessions.py`
- Create: `tests/test_session_export.py`

- [ ] **Step 1: 写失败测试**

`tests/test_session_export.py`:
```python
"""sessions.py::export_session 组合 session+messages+tool_calls 的行为。"""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import app.api.v1.routes.sessions as sessions_mod
from app.common.errors import AppError


def test_export_composes_session_messages_tool_calls(monkeypatch):
    class FakeSession:
        def to_dict(self):
            return {"id": "sess-1", "working_dir": "C:/p", "goal": "g"}

    monkeypatch.setattr(sessions_mod, "get_session_service",
                        lambda: SimpleNamespace(get=lambda sid: FakeSession()))
    monkeypatch.setattr(sessions_mod, "get_memory_service",
                        lambda: SimpleNamespace(get_all_messages=lambda aid: [{"role": "user", "created_at": "t1"}]))

    import app.storage.file.agent_store as agent_store_mod
    import app.storage.file.tool_call_store as tcs_mod
    monkeypatch.setattr(agent_store_mod, "AgentStore",
                        lambda: SimpleNamespace(list_by_session=lambda sid: ["agt-1"]))
    monkeypatch.setattr(tcs_mod, "ToolCallStore",
                        lambda: SimpleNamespace(read_all=lambda sid: [{"tool": "x"}]))

    out = sessions_mod.export_session("sess-1")
    assert out["session"]["working_dir"] == "C:/p"
    assert out["messages"] == [{"role": "user", "created_at": "t1"}]
    assert out["tool_calls"] == [{"tool": "x"}]


def test_export_404_when_session_missing(monkeypatch):
    def boom(sid):
        raise AppError("SESSION_NOT_FOUND", "no such session")
    monkeypatch.setattr(sessions_mod, "get_session_service",
                        lambda: SimpleNamespace(get=boom))
    with pytest.raises(HTTPException) as ei:
        sessions_mod.export_session("nope")
    assert ei.value.status_code == 404
```

- [ ] **Step 2: 跑测试确认失败**

```bash
uv run pytest tests/test_session_export.py -v
```
Expected: FAIL（`export_session` 不存在 / AttributeError）。

- [ ] **Step 3: 实现**

`app/api/v1/routes/sessions.py`：把第 13 行的 deps import 改为同时引入 `get_memory_service`：
```python
from app.api.v1.deps import get_memory_service, get_session_manager, get_session_service, get_task_service
```
在 `get_session`（`@router.get("/{session_id}", ...)`）路由**之后**新增：
```python
@router.get("/{session_id}/export")
def export_session(session_id: str) -> dict:
    """导出该会话用于用户主动"上报此会话"：session + 全量 messages + tool_calls。"""
    from app.storage.file.agent_store import AgentStore
    from app.storage.file.tool_call_store import ToolCallStore
    try:
        session = get_session_service().get(session_id)
    except AppError as e:
        status = 404 if e.code == "SESSION_NOT_FOUND" else 400
        raise HTTPException(status_code=status, detail={"code": e.code, "message": e.message})
    mem_svc = get_memory_service()
    messages: list[dict] = []
    for agent_id in AgentStore().list_by_session(session_id):
        messages.extend(mem_svc.get_all_messages(agent_id))
    messages.sort(key=lambda m: m.get("created_at", ""))
    tool_calls = ToolCallStore().read_all(session_id)
    return {"session": session.to_dict(), "messages": messages, "tool_calls": tool_calls}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
uv run pytest tests/test_session_export.py -v
```
Expected: 2 PASS。

- [ ] **Step 5: 提交**

```bash
git add app/api/v1/routes/sessions.py tests/test_session_export.py
git commit -m "feat(obs): GET /sessions/{id}/export (session + messages + tool_calls)"
```

---

### Task 2: `session-report.js` — 纯函数组装 zip 条目

**Files:**
- Create: `electron/lib/session-report.js`
- Create: `electron/test/session-report.test.js`

- [ ] **Step 1: 写失败测试**

`electron/test/session-report.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildSessionReportEntries } = require('../lib/session-report');

test('builds session-<id>.json (environment + export) and appends log entries', () => {
  const now = new Date(2026, 5, 11, 12, 0, 0);
  const entries = buildSessionReportEntries({
    sessionId: 'sess-1',
    env: { app_version: '0.3.0', hostname: 'h', os_username: 'u', platform: 'win32', arch: 'x64' },
    exportObj: { session: { id: 'sess-1', working_dir: 'C:/p' }, messages: [{ role: 'user' }], tool_calls: [{ tool: 'x' }] },
    logEntries: [{ name: 'electron.log', data: Buffer.from('e'), mtime: now }],
    now,
  });
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].name, 'session-sess-1.json');
  assert.strictEqual(entries[0].mtime, now);
  const parsed = JSON.parse(entries[0].data.toString('utf8'));
  assert.deepStrictEqual(parsed.environment, { app_version: '0.3.0', hostname: 'h', os_username: 'u', platform: 'win32', arch: 'x64' });
  assert.strictEqual(parsed.session.working_dir, 'C:/p');
  assert.strictEqual(parsed.messages.length, 1);
  assert.strictEqual(parsed.tool_calls.length, 1);
  assert.strictEqual(entries[1].name, 'electron.log'); // log tails appended after the json
});

test('tolerates a missing/garbage export (still produces a json entry)', () => {
  const entries = buildSessionReportEntries({
    sessionId: 's', env: { app_version: '0.3.0' }, exportObj: null, logEntries: [], now: new Date(2026, 0, 1),
  });
  assert.strictEqual(entries.length, 1);
  const parsed = JSON.parse(entries[0].data.toString('utf8'));
  assert.deepStrictEqual(parsed.environment, { app_version: '0.3.0' });
  // export fields absent but the object is still valid JSON with the environment block
  assert.ok(!('session' in parsed) || parsed.session === undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && node --test test/session-report.test.js
```
Expected: FAIL，`Cannot find module '../lib/session-report'`。

- [ ] **Step 3: 实现**

`electron/lib/session-report.js`:
```js
'use strict';

// Assemble the zip entries for a "report this session" upload: a self-describing
// session-<id>.json (environment block + the backend export) followed by the
// run-log tail entries. Pure — the caller supplies the fetched export, the env
// block, the log entries (from collectTail), and the timestamp.
function buildSessionReportEntries({ sessionId, env, exportObj, logEntries, now }) {
  const json = JSON.stringify({ environment: env, ...(exportObj || {}) }, null, 2);
  return [
    { name: `session-${sessionId}.json`, data: Buffer.from(json, 'utf8'), mtime: now },
    ...(logEntries || []),
  ];
}

module.exports = { buildSessionReportEntries };
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test test/session-report.test.js
```
Expected: 2 PASS。

- [ ] **Step 5: 提交**

```bash
git add lib/session-report.js test/session-report.test.js
git commit -m "feat(obs): session-report zip entry assembly (pure)"
```

---

### Task 3: electron main `report-session` IPC handler

**Files:**
- Modify: `electron/main.js`

无法单测（IPC + fetch + 上传）；Task 7 手工 E2E。

- [ ] **Step 1: require**

`electron/main.js` 顶部 require 区（`const { zipEntries } = require('./lib/zip');` 之后）加：
```js
const { buildSessionReportEntries } = require('./lib/session-report');
```

- [ ] **Step 2: 注册 handler**

在现有 `ipcMain.handle('update-install', ...)` 块**之后**插入：
```js
  // User-initiated "report this session": fetch the session export from the local
  // backend, wrap it with a client environment block, attach run-log tails, zip it
  // all, and upload to /logs with reason=session_report. Returns {ok, error?} —
  // never throws (the renderer shows the status).
  ipcMain.handle('report-session', async (_e, sessionId, note) => {
    try {
      if (!shouldReportTelemetry(updateConfig)) return { ok: false, error: 'telemetry disabled' };
      const res = await fetch(`${BACKEND_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/export`);
      if (!res.ok) return { ok: false, error: `export failed (${res.status})` };
      const exportObj = await res.json();
      const env = {
        app_version: app.getVersion(),
        hostname: osMod.hostname(),
        os_username: (() => { try { return osMod.userInfo().username; } catch (_) { return ''; } })(),
        platform: process.platform,
        arch: process.arch,
      };
      const logEntries = collectTail({ files: logFilesForTail() });
      const entries = buildSessionReportEntries({ sessionId, env, exportObj, logEntries, now: new Date() });
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

- [ ] **Step 3: 语法 + 现有测试**

```bash
cd /d/20_code/miniAgentsDemo/electron && node --check main.js && npm test 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
```
Expected: 语法 OK；electron 全 PASS（53 + session-report 2 = 55）。

- [ ] **Step 4: 提交**

```bash
git add main.js
git commit -m "feat(obs): report-session IPC handler (export → zip → /logs)"
```

---

### Task 4: preload 暴露 `reportSession`

**Files:**
- Modify: `electron/preload.js`

- [ ] **Step 1: 实现**

`electron/preload.js` 的 `electronAPI` 对象里，`installUpdate` 行**之后**加：
```js
  reportSession: (sessionId, note) => ipcRenderer.invoke('report-session', sessionId, note),
```

- [ ] **Step 2: 语法检查 + 提交**

```bash
cd /d/20_code/miniAgentsDemo/electron && node --check preload.js
git add preload.js
git commit -m "feat(obs): expose reportSession on electronAPI bridge"
```

---

### Task 5: `ReportSessionButton` 组件 + i18n

**Files:**
- Create: `frontend-desktop/src/components/ReportSessionButton.tsx`
- Create: `frontend-desktop/src/components/ReportSessionButton.test.tsx`
- Modify: `frontend-desktop/src/i18n.tsx`

- [ ] **Step 1: 加 i18n key（zh + en）**

`frontend-desktop/src/i18n.tsx` 的 `zh` 字典里，`'chat.showWorkspace': '打开工作区',` 行**之后**加：
```js
  'chat.reportSession': '上报此会话',
  'chat.reportSessionConsent': '将上传该会话的全部对话内容（含工具调用）与运行日志尾部，用于问题排查。仅发送至内网管理服务。',
  'chat.reportSessionNotePlaceholder': '备注（可选）：描述你遇到的问题',
  'chat.reportSessionConfirm': '上报',
  'chat.reportSessionSending': '上报中…',
  'chat.reportSessionDone': '已上报',
  'chat.reportSessionFail': '上报失败',
```
`en` 字典里，`'chat.showWorkspace': 'Show workspace',` 行**之后**加：
```js
  'chat.reportSession': 'Report this session',
  'chat.reportSessionConsent': 'This uploads the full conversation (including tool calls) and recent run-log tails for troubleshooting. Sent only to the internal management server.',
  'chat.reportSessionNotePlaceholder': 'Note (optional): describe the problem',
  'chat.reportSessionConfirm': 'Report',
  'chat.reportSessionSending': 'Reporting…',
  'chat.reportSessionDone': 'Reported',
  'chat.reportSessionFail': 'Report failed',
```

- [ ] **Step 2: 写失败测试**

`frontend-desktop/src/components/ReportSessionButton.test.tsx`:
```tsx
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (k: string) => k }) }))
import { ReportSessionButton } from './ReportSessionButton'

describe('ReportSessionButton', () => {
  beforeEach(() => { (window as any).electronAPI = undefined })

  test('opens confirm and calls reportSession with id + note', async () => {
    const reportSession = vi.fn().mockResolvedValue({ ok: true })
    ;(window as any).electronAPI = { reportSession }
    render(<ReportSessionButton sessionId="sess-1" />)
    fireEvent.click(screen.getByTitle('chat.reportSession'))
    fireEvent.change(screen.getByPlaceholderText('chat.reportSessionNotePlaceholder'), { target: { value: 'hi' } })
    fireEvent.click(screen.getByText('chat.reportSessionConfirm'))
    await waitFor(() => expect(reportSession).toHaveBeenCalledWith('sess-1', 'hi'))
  })

  test('shows the error when reportSession returns ok:false', async () => {
    ;(window as any).electronAPI = { reportSession: vi.fn().mockResolvedValue({ ok: false, error: 'boom' }) }
    render(<ReportSessionButton sessionId="s" />)
    fireEvent.click(screen.getByTitle('chat.reportSession'))
    fireEvent.click(screen.getByText('chat.reportSessionConfirm'))
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy())
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd frontend-desktop && npm test -- ReportSessionButton 2>&1 | tail -8
```
Expected: FAIL（找不到 `./ReportSessionButton`）。

- [ ] **Step 4: 实现**

`frontend-desktop/src/components/ReportSessionButton.tsx`:
```tsx
import { useState } from 'react'
import { UploadIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

// preload (electron/preload.js) exposes window.electronAPI.reportSession.
declare global {
  interface Window {
    electronAPI?: {
      reportSession?: (sessionId: string, note: string) => Promise<{ ok: boolean; error?: string }>
    }
  }
}

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
        <span className="mr-1 text-xs" style={{ color: status.ok ? 'var(--teal)' : 'var(--red)' }}>{status.msg}</span>
      )}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(15,31,61,.35)', backdropFilter: 'blur(4px)' }}>
          <div className="w-96 p-4" style={{ background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 24px 80px rgba(15,31,61,.18)' }}>
            <p className="mb-2 text-sm font-medium" style={{ color: 'var(--t1)' }}>{t('chat.reportSession')}</p>
            <p className="mb-3 text-xs" style={{ color: 'var(--t2)' }}>{t('chat.reportSessionConsent')}</p>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder={t('chat.reportSessionNotePlaceholder')}
              className="mb-3 w-full rounded-md p-2 text-sm"
              style={{ background: 'var(--bg2)', border: '1px solid var(--border)', color: 'var(--t1)', minHeight: 60, resize: 'vertical' }}
            />
            {status && !status.ok && (
              <p className="mb-2 text-xs" style={{ color: 'var(--red)' }}>{status.msg}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => { setOpen(false); setNote('') }} disabled={busy}>{t('common.cancel')}</Button>
              <Button variant="default" size="sm" onClick={submit} disabled={busy}>{busy ? t('chat.reportSessionSending') : t('chat.reportSessionConfirm')}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
npm test -- ReportSessionButton 2>&1 | tail -8
```
Expected: 2 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/components/ReportSessionButton.tsx src/components/ReportSessionButton.test.tsx src/i18n.tsx
git commit -m "feat(obs): ReportSessionButton component + i18n"
```

---

### Task 6: 接入 ChatPanel 头部

**Files:**
- Modify: `frontend-desktop/src/components/ChatPanel.tsx`

- [ ] **Step 1: import**

`ChatPanel.tsx` 顶部 import 区（`import { ModelPickerButton } ...` 之后）加：
```tsx
import { ReportSessionButton } from '@/components/ReportSessionButton'
```

- [ ] **Step 2: 头部插入按钮**

会话头部右侧 cluster（`<div className="ml-3 flex flex-shrink-0 items-center gap-1">`）里，`{session.llm_provider && (...)}` 块**之后**、`{canShowWorkspace && ...}` 块**之前**插入：
```tsx
            <ReportSessionButton sessionId={session.id} />
```

- [ ] **Step 3: 类型检查 + 前端全量测试**

```bash
cd /d/20_code/miniAgentsDemo/frontend-desktop && npx tsc -b 2>&1 | tail -5 && npm test 2>&1 | tail -6
```
Expected: tsc 无错；vitest 全 PASS。

- [ ] **Step 4: 提交**

```bash
git add src/components/ChatPanel.tsx
git commit -m "feat(obs): wire ReportSessionButton into session header"
```

---

### Task 7: 全量回归 + 手工 E2E

**Files:** 无代码改动（最后记录结果时改 plan）。

- [ ] **Step 1: 三侧回归**

```bash
cd /d/20_code/miniAgentsDemo/electron && npm test 2>&1 | grep -E "pass [0-9]|fail [0-9]"
cd ../frontend-desktop && npx tsc -b && npm test 2>&1 | tail -4
cd .. && uv run pytest tests/test_session_export.py -q 2>&1 | tail -2
```
Expected: electron 全 PASS（55）；前端 tsc 干净 + vitest 全 PASS；后端 export 2 PASS。

- [ ] **Step 2: 手工打包 E2E（需服务端处理 session_report，或代理观察）**

1. 打包桌面（`packaging/build_electron.ps1` 流程或 build:dir），指向 `:8077`（或代理）。
2. 打开/选一个有内容的会话 → 头部点"上报此会话"图标 → 确认框出现、文案清晰 → 填备注 → 点"上报"。
3. 代理/服务端见**一个** `POST /logs` 部件 `session-report.zip`、`reason=session_report` + `session_id` + `user_note`。
4. 下载解压：含 `session-{id}.json`（顶层 environment + session(含 working_dir) + messages + tool_calls）+ `electron.log` + `backend.log`；时间戳正常。
5. UI 显示"已上报"；telemetry 关闭时显示禁用错误且不发。

- [ ] **Step 3: 记录结果 + 收尾提交**

```bash
git add docs/superpowers/plans/2026-06-11-phase-c-session-report.md
git commit -m "docs(obs): record Phase C verification results"
```

---

## Self-review 记录

- **Spec 覆盖**：export 端点=Task1；environment+session+messages+tool_calls 的 json=Task2(组装)+Task3(env 注入);日志尾部=Task3(collectTail);IPC=Task3;preload=Task4;UI 按钮+确认框+备注+同意文案+状态=Task5;接入=Task6;i18n=Task5;服务端契约=顶部说明（交并行会话）。
- **类型一致**：`buildSessionReportEntries({sessionId,env,exportObj,logEntries,now})`→`[{name,data,mtime}]`；`zipEntries` 消费之（带 mtime）；`uploadLogs({archive})` 收单包；`reportSession(sessionId,note)`→`{ok,error?}` preload/main/renderer 一致；fields 用 `session_id`/`user_note`（服务端契约一致）。
- **无 placeholder**：每步含完整代码与期望输出。
- **失败语义**：report-session 全 try/catch 返回 {ok:false,error}；telemetry 关闭直接禁用；export 失败/上传失败各自报错；不抛到渲染端。
- **YAGNI**：不做 display_name、不做大小裁剪、不引 toast 库、不改服务端。
- **不提交** package-lock/.claire/.gitignore；不打包。

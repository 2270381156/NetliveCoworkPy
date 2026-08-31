# Workspace 浏览端点 (host 侧) + create-session workspace 字段对齐

**日期**: 2026-06-13
**状态**: 已批准设计，待实现计划

## 背景与问题

`frontend-desktop`（miniAgents 桌面前端）的 WorkspacePanel + 文件预览功能依赖三个
后端只读端点来浏览/读取某 session 的工作目录文件，但当前 `loomex_host` 后端：

1. **没有任何 `/workspace` 路由**——这三个端点全缺，WorkspacePanel 与 FilePreviewModal 整块不可用。
2. **create-session 的工作目录字段名错位且不回传**：前端发 `working_dir`，后端 `CreateSessionRequest`
   收 `workspace`；且 `SessionEntry.to_dict()` 既不返回 `workspace` 也不返回 `working_dir`，
   导致前端 `session.working_dir` 永远 undefined，WorkspacePanel 拿不到根目录。

workspace 的**生命周期/落盘**链路已经存在（`fs provider` 的 `register_session/workspace_for/spill`
+ `state_store.save_workspace/get_workspace` + `sessions.py` 的登记接线），本设计**不动 fs provider**，
只在 host 侧补浏览端点，并打通 create-session 的 workspace 字段。

## 前端契约（已核实，固定不变；preview 取数 URL 不动）

前端三个取数入口（`api/workspace.ts`、`preview/viewers/common.tsx`）：

| 端点 | 返回 | 消费方 |
|---|---|---|
| `GET /api/v1/workspace/files?path=<绝对路径>` | `WorkspaceListing { root, path, parent, entries[] }`，`entry = { name, path(绝对), is_dir, size\|null }` | WorkspacePanel 文件树 |
| `GET /api/v1/workspace/file?path=<绝对路径>` | `{ path, content }`（UTF-8 文本） | code / text / markdown viewer |
| `GET /api/v1/workspace/file/raw?path=<绝对路径>` | 原始字节（带正确 content-type） | pdf / docx / xlsx / pptx / image viewer + markdown 内嵌图 |

前端行为要点：
- `WorkspacePanel.browsePath` 初值 = `workingDir`（绝对路径），导航时直接把 `entry.path`（绝对）当下一次的 `path`。
  → 故 `entries[].path` **必须是绝对路径**。
- 错误处理：`fetchOrThrow`（raw/text）直接读 JSON `detail` 字符串；`http.get`（files）读 `detail?.message`
  取不到则回退 statusText。→ 端点 `detail` 用**纯字符串**，两侧都不崩。

## 路径安全边界（已确认：约束到所有已登记 workspace 根之内）

三端点共用一个解析+校验 helper：

```
resolve_and_authorize(path: str) -> Path:
    target = Path(path).resolve()              # 解析 symlink / .. ，得真实绝对路径
    roots  = registered_roots()                # 见下
    if not any(target == r or r in target.parents for r in roots):
        raise HTTPException(403, detail="path outside any registered workspace")
    if not target.exists():
        raise HTTPException(404, detail="not found")
    return target
```

- **`registered_roots()` 来源（方案 A）**：内存 `_sessions` 各 entry 的 workspace。
  `roots = { Path(e.workspace).resolve() for e in _sessions.values() if e.workspace }`。
  零额外 DB 查询、永远最新；已完成的 session 其 workspace 仍在内存 entry 上，故仍可浏览
  （符合「所有已登记根」语义）。
- symlink/`..` 逃逸：先 `.resolve()` 再判子孙关系，堵越权。
- `path` 省略/空：兜底取根集合中任一（实际前端总带绝对 path，空仅防御）。

## 后端改动

### 新文件 `src/loomex_host/api/workspace.py`

`APIRouter(prefix="/workspace", tags=["workspace"])`，挂在 `main.py` 的 `/api/v1`。
三个端点 + 共用 `resolve_and_authorize` + `registered_roots`：

- `GET /files`：`os.scandir(target)` → `WorkspaceListing`。`entry.path` 用绝对路径；
  `is_dir` 用 `entry.is_dir()`；`size` 文件取 `stat().st_size`、目录为 `null`；
  `root`/`parent` 按所属根与父目录填。目录项与文件项都返回，前端自行分组排序。
- `GET /file`：读 UTF-8 文本，返回 `{ path, content }`。非文本/解码失败 → 由前端按类型走 raw；
  此端点解码失败返回 `400 detail="not valid UTF-8 text"`。
- `GET /file/raw`：`FileResponse(target)`，由 starlette 按扩展名推断 content-type。

排序：目录在前、文件在后由前端处理；后端可按 name 稳定排序（实现细节）。

### `SessionEntry` + `to_dict`（`api/models/session.py`）

- `SessionEntry.__init__` 增 `self.workspace: str | None = None`。
- `to_dict()` 增 `"workspace": self.workspace`。
- `create_session`（`sessions.py`）：设 `entry.workspace = req.workspace`。
- `load_sessions_from_db`：设 `entry.workspace = sess.workspace`
  （`SessionRecord.workspace` 已随 `list_sessions()` 读出，零新查询）。

`CreateSessionRequest.workspace` schema **不变**（前端适配它）。

## 前端改动（改前端适配后端；仅 API 边界字段，内部 camelCase 名不动）

- `types/index.ts`：`Session.working_dir` → `Session.workspace`；
  `CreateSessionRequest.working_dir` → `CreateSessionRequest.workspace`。
- `api/sessions.ts` 无需改（create 直接透传 CreateSessionRequest）。
- `components/ChatPanel.tsx:129`：`working_dir: ...` → `workspace: pendingSession?.workingDir || null`。
- `App.tsx:79`：`sse.session?.working_dir` → `sse.session?.workspace`。
- `hooks/useProjectGroups.ts`：读 session 字段处 `s.working_dir` → `s.workspace`
  （`Project.working_dir` 是前端内部派生类型，可保留原名，仅改“从 Session 读”那一处）。
- **不动**：`PendingSession.workingDir`、`WorkspacePanel` 的 `workingDir` prop、NewSessionDialog 状态、
  preview 三个取数 URL（已正确）。

## 不在本次范围（避免范围蔓延）

以下契约缺口属于另外的工作，本次**只做 workspace 浏览 + create-session workspace 字段**：

- `llm_provider` vs `llm_account` 字段错位（create/send-message/响应）。
- `/llms/ping`、`/llms/{name}/ping`、`/llms/available-models`、`/llms/{name}/available-models` 缺失。
- skills：前端 `/skills` + `/skills/pull-server/*` vs 后端 `/skill-sources/*`。
- `/sessions/{id}/input`（HITL 文本应答）、`/sessions/{id}/cancel` 缺失。
- SSE 小遗漏（`observer_reasoning_*`、`task_failed`、`session_goal_updated` 等前端未处理）。

## 测试

### 后端（pytest）
- `/files`：列目录返回形状正确；`entry.path` 为绝对路径；`is_dir`/`size` 正确；`root`/`parent` 正确。
- `/file`：文本读取返回 `{path, content}`；非 UTF-8 → 400。
- `/file/raw`：返回字节 + 合理 content-type。
- **越权**：`path` 落在所有已登记根之外 → 403；symlink/`..` 逃逸 → 403。
- 不存在 path → 404；空 path 兜底到某根。
- `to_dict()` 含 `workspace`；create 后 `workspace` 正确；restart（load_sessions_from_db）后 entry.workspace 灌回。

### 前端（vitest）
- 类型改名后全量 `vitest run` 无回归（preview 已有大量测试）。
- `tsc -b` 通过（字段改名无遗漏引用）。

## 验收

- 创建带工作目录的 session 后，`GET /sessions/{id}` 响应含正确 `workspace`。
- WorkspacePanel 能列出根目录、逐级进子目录、返回父级。
- 文本/代码/markdown 文件能预览；pdf/docx/xlsx/pptx/图片能预览（走 raw）。
- 传入工作目录之外的 path 被 403 拒绝。

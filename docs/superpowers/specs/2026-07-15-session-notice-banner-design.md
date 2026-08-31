# 会话通告框：失败/中断原因直达用户 + 继续对话引导

日期：2026-07-15
仓库：IpMasterCoworkPy（host 翻译层 + `frontend/`；**core 零改动**）
分支：feat/session-notice-banner（基于 feat/run-crash-recoverable-suspend @ ba6110b——依赖 v2 熔断真终结的事件语义）

## 背景与问题

会话落 FAILED 的四条路径（observer 判死终局、熔断真终结、崩溃后恢复收尾、host 消费者兜底）中，
失败原因文本在每条路上都存在于某个事件字段里，但全部在 host SSE 翻译层被丢弃或降级：

- `TASK_FAILED.error_message`（observer 判决摘要）只翻成 `task_updated` 状态翻转，文本丢弃；
- `FAILURE_THRESHOLD_HIT` 翻译直接 `return None`，payload 里的连败清单（每个失败子任务的
  title+reason）无人消费（ledger 备案项）；
- `SESSION_STATUS_CHANGED(FAILED, reason=...)` 的 reason 被丢（`session_update` 只对
  INTERRUPTED 保留 reason）；
- `task_failed` 气泡不进 `_HISTORY_TYPES`，刷新页面即消失，且 observer 判死时其 error 取自
  `run_error`（必为 None）→ 永远是通用文案 "Task failed"。

前端现状：FAILED 只渲染一个无原因、无动作的红药丸「会话失败」（ChatPanel.tsx:1311）；
INTERRUPTED 有一个文案写死为「服务重启导致任务中断」的横幅 + 恢复按钮（ChatPanel.tsx:1284），
后端发的 `interrupt_reason`（llm_outage / CONTEXT_OVERFLOW / 崩溃错误码）前端未消费；
v1 给 `/resume` 加的可选换模型字段（专为上下文溢出换大窗口模型设计）前端未接。

## 用户定案（需求澄清结论）

1. **原因跨 host 重启仍精确显示**（不接受重启后降级为通用文案）。
2. **文案按路径定制**：observer 判死显示判决摘要；熔断显示阈值说明 + 可展开的连败清单；
   其余路径通用文案。
3. **框显示时输入区收起不可用**；点「继续对话」后输入框恢复显示。
4. **范围：FAILED + INTERRUPTED 收敛为同一个底部框组件**；CANCELED 是用户主动触发，
   不做提示（保留现有药丸）。
5. **INTERRUPTED 框顺手接全**：按 `interrupt_reason` 显示准确文案，且（至少 CONTEXT_OVERFLOW 时）
   提供模型选择器，`/resume` 带 `llm_account/llm_model` body。

## 方案（已选 A）：合成一条持久化的「会话通告」SSE 帧

原因载体是一条 host 翻译层合成的新 SSE 帧类型 `session_notice`，走**已存在**的持久化/重放链路
（`_append_json` 落库 → history 快照 → host 重启 `load_sse_events` 重灌），零 DB migration。

### 帧形状

```json
{
  "type": "session_notice",
  "kind": "failed" | "interrupted",
  "reason_code": "TASK_FAILED_BY_THRESHOLD" | "TASK_FAILED_BY_OBSERVER"
               | "SESSION_FAILED" | "llm_outage" | "CONTEXT_OVERFLOW" | "<崩溃错误码>",
  "reason_text": "人话原因（后端合成；interrupted 的展示文案由前端按 code 映射，text 作回退）",
  "failures": [{"title": "…", "reason": "…"}],
  "created_at": "<ISO>"
}
```

`failures` 仅熔断路径非空。多次中断产生多条 notice 无碍——前端只取最后一条。

### ① 后端：素材暂存（SessionEntry 两个新私有字段）

- `_last_task_failure: dict | None`：`TASK_FAILED` 翻译分支（session.py `TASK_STATUS_BY_EVENT`
  段，counter 折叠旁）记 `{code: error_code, message: error_message}`；
  `error_code == "TASK_FAILED_BY_THRESHOLD"` 不覆盖（聚合结果非新失败，与 counter 折叠同判据）；
  `TASK_FINISHED` 清空（连败语义，与 counter 清零同步）。
- `_threshold_failures: dict | None`：`FAILURE_THRESHOLD_HIT` 翻译分支（现整条静默）记
  `{failures: p["failures"], counter, threshold}`。
- **恢复回填**：`_load_entry`（已在遍历持久化 sse_events 数 user turns）顺路记录**最后一条**
  `task_failed` 帧回填 `_last_task_failure={code: error_type 或 "TASK_FAILED", message: error}`，
  且遇到后续 `message`(role=user) 或 `session_notice` 帧不清空——回填只为「崩溃后恢复收尾判死」
  这条路兜底取材，取最后一条即可。

### ② 后端：notice 合成

`SessionEntry.apply` 的 `SESSION_STATUS_CHANGED` 分支扩展为返回
`[session_update, session_notice]` 两条（`translate_event` 返回 list，`append_event` 已支持）：

- **new_status == "FAILED"**，reason 素材优先级：
  1. 熔断的 failed notice 改在 **FAILURE_THRESHOLD_HIT 翻译处**即刻合成
     （`code=TASK_FAILED_BY_THRESHOLD` + 清单；素材在手且立刻持久化，崩在 trip
     步骤 2~8 之间不丢死因）；`SESSION_STATUS_CHANGED(FAILED, reason="failure_threshold")`
     不再重复合成，只发 session_update；
  2. 否则 `_last_task_failure` 非空 → 用其 code+message；
  3. 否则 → `code=SESSION_FAILED`，text=「会话失败」（通用）。
- **new_status == "INTERRUPTED"** → `kind=interrupted`，`code=p.reason`（可空），
  text=按 code 的后端回退文案（前端有自己的映射）。
- 其余状态不合成 notice。
- `"session_notice"` 加入 `_HISTORY_TYPES`。

### ③ 前端：SessionNoticeBar 组件（`frontend/`）

- `useSessionSSE.ts`：新增 `notice` 状态——history 数组里取**最后一条** `session_notice`；
  live 流遇到该帧更新；类型联合补全。
- **显示规则**（框渲染在原 INTERRUPTED 横幅位置，且显示时**输入区整体不渲染**）：
  - `session.status == "FAILED"` → 失败框：有 notice(kind=failed) 用其内容；
    无 notice（存量旧会话 / host 消费者兜底路径）→ 通用文案「会话失败」。
  - `session.status == "INTERRUPTED"` → 中断框：按 `notice.reason_code` 映射文案
    （`llm_outage`→「LLM 连接中断」；`CONTEXT_OVERFLOW`→「上下文超出模型窗口，建议换更大
    窗口的模型后恢复」；其他 code→「服务异常导致任务中断 (code)」；无 notice→沿现有
    「服务重启导致任务中断」）。
  - 其余状态不显示，输入区照常。
- **失败框（红系）**：标题「会话失败」+ reason_text；熔断时清单默认折叠（「查看 N 条失败记录」
  展开，每条 title+reason）；按钮「继续对话」→ 本地 `dismissed=true`，框消失、输入框恢复。
  刷新后若会话仍 FAILED 框重现（dismissed 不持久化）；发出新消息后状态离开 FAILED，框自然消失。
- **中断框（橙系）**：按钮「恢复会话」（现有 resumeMutation）；恢复按钮旁挂账号/模型
  选择器（默认「沿用当前」），选择后 `/resume` 带 `{llm_account, llm_model}`。
  ~~仅 CONTEXT_OVERFLOW 挂选择器~~（用户后续定案放开：换模型恢复对**所有中断成因**开放——
  llm_outage 换账号绕开故障供应商等同样合理；CONTEXT_OVERFLOW 仅文案上特别提示换大窗口）。
- `api/sessions.ts`：`resume(sessionId, body?: {llm_account?: string; llm_model?: string})`
  （后端 v1 已支持可选 body，无需后端改动）。
- **删除**：现有 INTERRUPTED 横幅（ChatPanel.tsx:1284-1301）、FAILED 红药丸（与框重复；
  SUCCEEDED/CANCELED 药丸保留）。

### ④ 四条失败路径覆盖核对

| 路径 | 素材来源 | 框内容 |
|---|---|---|
| observer 判死终局 | `TASK_FAILED.error_message` 暂存 | 观察者判决摘要 |
| 熔断真终结 | `FAILURE_THRESHOLD_HIT.failures` | 阈值说明 + 连败清单（可展开） |
| 崩溃后恢复收尾（runtime `finalize_idle_session`） | restore 回填的最后 `task_failed` 帧 | 上一轮失败原因（无则通用） |
| host 消费者兜底（session_consumer 异常） | 无事件产生 | 前端无 notice 兜底通用文案 |

事件顺序保证：熔断的 HIT（trip 步骤 2）先于 SESSION_STATUS_CHANGED（步骤 8）；
observer 的 TASK_FAILED 先于会话终态事件——素材总是先于合成点就位。

## 测试

- host 新增 `tests/test_session_notice.py`：
  - observer 判死：TASK_FAILED(error_message) → SESSION_STATUS_CHANGED(FAILED) 合成
    notice 带判决摘要；
  - 熔断：FAILURE_THRESHOLD_HIT(failures) → FAILED(reason=failure_threshold) 合成
    notice 带清单；TASK_FAILED_BY_THRESHOLD 码不覆盖 `_last_task_failure`；
  - TASK_FINISHED 清空素材（先败后成不残留）；
  - 无素材兜底：直接 FAILED → code=SESSION_FAILED；
  - INTERRUPTED：reason 透传进 notice；
  - `_HISTORY_TYPES` 含 `session_notice`（history 快照可见）；
  - `_load_entry` 回填：持久化 sse_events 含 task_failed → `_last_task_failure` 就位。
- 前端沿仓内现有惯例（无既有测试设施则不新建，人工核验交互）。

## 不做（本次范围外）

- CANCELED 提示（用户主动触发，无需解释）。
- ~~`task_failed` 气泡文案改进~~（计划阶段收回：气泡 error 回落到 `_last_task_failure.message`
  是 restore 回填跨重启精确的前提——持久化的气泡帧就是回填素材，顺带修复 observer 判死
  气泡永远是通用文案的缺口）。
- host 消费者兜底路径的 notice 事件化（防御分支，前端通用文案覆盖即可）。
- core 侧任何改动。

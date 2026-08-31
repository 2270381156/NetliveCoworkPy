# golden-master 采集指南(Step 0c)

## 采集状态(2026-06-29,Step 3 已完成 6/6)
Playwright auto-driver(`capture/sse-capture.spec.ts` + `capture.config.ts`)对**真实后端**采齐 **6 类**,已落 `src/features/chat/sse/__fixtures__/` 并接入 reducer golden-master:
- ✅ `01-plain-dialog`(109)· `02-tool-call`(233,真 tool_call)· `03-observer-rounds`(500,真多轮)· `04-hitl`(95,审批)· `05-retry-fail`(task_failed)· `06-interrupt-resume`(473,PAUSED + 续跑非空 history)
- ➕ `03b-observer-synthetic`(**合成**):见下方"两点真实约束 #1"。

**采法要点 / 两点真实约束(实测发现):**
1. **observer 不流式输出文本**:本后端/`default` 模板下,observer 轮的输出走 `control_tool_call`(report_task_outcome 裁决,每个会话都有),**不发** `observer_text_*`/`observer_reasoning_*`(`03-observer-rounds` 500 帧里 observer 帧为 0)。故真实 fixture 采不到 observer 流式帧;reducer 的 observer_text 分支用**合成 fixture** `03b-observer-synthetic` 覆盖(已标注 synthetic)。
2. **"中断"实为软暂停 PAUSED**:红色 Square → `/interrupt` → `runtime.pause_session()` → 会话转 **PAUSED**(非 INTERRUPTED;`恢复运行` 按钮只对 INTERRUPTED 显示,那是崩溃恢复态)。续跑靠**发一条新消息**(触发 reconnect → 非空 history)。`06-interrupt-resume` 采的就是这个真实流程。要采集时让任务"够长"(多步 + 每步 `sleep` 的 bash)才能在 RUNNING 时点中。
- #5 采法:后端用 `IPMC_LLM_API_KEY=sk-bad … IPMC_LLM_SELF_HEAL_MAX_DURATION_SEC=15` 启动制造失败,采完恢复好 key。
- 仍未自然出现的边角帧:`image`(agent 出图,少见)、`llm_retry`(快速失败跳过重试)—— reducer 已移植 handler,可后补 fixture。

---


> 目的:从**旧系统**捕获真实 SSE 帧序列,作为 Step 3 新 reducer 的回归基线(架构文档 §4.1)。
> 机制:旧 `src/hooks/useSessionSSE.ts` 已加 dev-only dump 钩子(`import.meta.env.DEV` 守卫,生产 tree-shake)。

## 控制台 API(开发模式下挂在 `window`)
- `window.__sseDump` — 已录制的帧数组 `[{ sessionId, frame }]`
- `window.__sseClear()` — 清空(每个场景开始前调一次)
- `window.__sseSave('NN-name')` — 下载该场景的帧序列为 `NN-name.json`

采完把文件移到 `src/features/chat/sse/__fixtures__/`(该目录在 Step 3 建)。

## 前置
- 后端跑起来(根目录 `.env` 配好**可用**的 LLM:`uv run netlivecowork serve --port 15926`)。
  ⚠️ 注意当前 `.env` 的 `IPMC_LLM_MODEL=deepseek-v4-flash` —— 采集前先确认它是 DeepSeek **真实可用**模型;
  若不可用,正常对话场景会失败(反而只能采到"失败/重试")。
- 前端 `npm run dev`,Electron 或浏览器进入。

## 六类场景与触发方式(用 `default` 模板)
| # | fixture 名 | 触发 | 备注 |
|---|---|---|---|
| 1 | `01-plain-dialog` | 问一个**不需要工具**的问题(如"用一句话解释 SDN") | 覆盖 text_delta/text_done |
| 2 | `02-tool-call` | 让 agent **读/列文件**(如"列出工作目录下的文件") | 覆盖 tool_call;若走 bash 见 #4 |
| 3 | `03-observer` | 任意任务 —— `default` 模板天然有 observe 轮(`ROLE.md`) | 覆盖 observer_text_*/observer_reasoning_* |
| 4 | `04-hitl` | 让 agent **执行 bash**(如"运行 echo hello") → 弹审批 → 点**批准** | 覆盖 waiting_input/bash_exec_confirm + 恢复 |
| 5 | `05-retry` | **制造 LLM 失败**:临时把 `.env` 的 `IPMC_LLM_API_KEY` 改错 → 发消息 → 出现 llm_retry/task_failed;采完**改回** | 唯一需要"故障注入"的场景 |
| 6 | `06-interrupt-resume` | 发一个较长任务 → 中途点**中断**(INTERRUPTED)→ 再点**恢复** | 覆盖 history 回放 + live 续跑(两条路径都要在) |

## 每个场景的步骤
1. `window.__sseClear()`
2. 触发该场景,**等它彻底结束**(出现终态/审批完成/回放完成)
3. `window.__sseSave('NN-name')`
4. 移动文件到 `__fixtures__/`

> 采集是**半自动**(需真实后端 + 真实会话);采完后 reducer 的快照测试是**全自动**纯函数(无需后端/浏览器),纳入每步验收。

# capture/ — 给 agent 发真实消息的 Playwright 全套

驱动**真后端**(不是 mock)自动新建会话、发消息、走完对话/工具/HITL/中断续跑,
并采集 SSE 帧或截图。视觉基线那套(`playwright.config.ts` + `visual/`,mock `/api`)是另一码事。

## 组成

| 文件 | 作用 |
|---|---|
| `capture.config.ts` | 本套的 Playwright 配置:testDir=`capture/`、连真后端、单 worker、超时 150s、`webServer` 自动起 vite(:5181) |
| `capture/sse-capture.spec.ts` | **golden-master 采集**:6 场景各发消息 → 读 `window.__sseDump` → 落 `golden-master/*.json` |
| `capture/smoke.spec.ts` | **冒烟 + 截图**:9 场景(代码块/表格/ASCII/mermaid/富 md/工具/HITL/流式/LLM 设置)→ `capture/smoke-out/*.png` |
| `capture/workspace/` | agent 工作目录的样例文件(`topology.txt` / `ip-plan.txt`),读文件类场景要用 |

## 依赖(缺一不可)

1. **真后端在 :15926 跑** —— `uv run netlivecowork serve`(或桌面壳)。vite 把 `/api` 代理过去(见 `vite.config.ts`)。
2. **后端已配好可用 LLM 账号** —— 否则对话发不出去。`05-retry-fail` 反过来**需要坏 key + 快速失败 env** 才采得到重试帧。
3. **`window.__sseDump` DEV 钩子** —— 所有 helper(`waitDone`/`waitHitl`/`waitForFrame`)都读它。旧 `src/hooks/useSessionSSE.ts` 和新 `src/features/chat/sse/useEventStream.ts` 都注入了,只要 App 用其一即可。必须 **DEV 模式**(`npm run dev`),生产构建会 tree-shake 掉。
4. **playwright 浏览器** —— 首次跑先 `npx playwright install chromium`。

## 跑

```bash
# 前提:后端已在 :15926 起、且配好 LLM 账号
npm run smoke      # 冒烟 + 截图 → capture/smoke-out/
npm run capture    # 采 golden-master → golden-master/

# 单个场景
npx playwright test -c capture.config.ts capture/smoke.spec.ts -g "mermaid"
```

> `capture.config.ts` 的 `webServer` 会自动 `npm run dev -- --port 5181`,已在跑就复用(`reuseExistingServer`)。

## 换工作目录

默认用仓内 `capture/workspace`。要指向别处:

```bash
CAPTURE_WS=/path/to/ws npm run smoke     # bash
$env:CAPTURE_WS='D:\ws'; npm run smoke   # PowerShell
```

## 采完 golden-master 后

把 `golden-master/*.json` 挑好的移到 `src/features/chat/sse/__fixtures__/`,给纯 reducer 做快照测试
(见 `reducer.test.ts`)。

## 发消息的关键动作(两 spec 一致)

```ts
await page.getByTitle('新建会话').click()
await page.getByText('点击选择目录…').click()        // 触发 selectDirectory 桩 → 返回 WS
await page.getByRole('button', { name: '创建会话' }).click()
const ta = page.getByPlaceholder('输入第一条消息（Enter 发送）')
await ta.fill(prompt); await ta.press('Enter')       // ← 给 agent 发消息
// HITL:先 PUT /api/v1/sessions/{id}/bash-review-mode {mode:'manual'} 再等「允许」按钮
// 中断:page.locator('button:has(.lucide-square)').click() → 转 PAUSED → 发新消息续跑
```

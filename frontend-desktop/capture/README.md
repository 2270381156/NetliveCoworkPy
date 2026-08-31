# capture/ — 给 agent 发真实消息的 Playwright 全套

驱动**真后端**(不是 mock)自动新建会话、发消息、走完对话/工具/HITL/中断续跑,
并采集 SSE 帧或截图。与单元测试(`vitest`, `src/**`)是两码事。

## 零产品代码改动

SSE 帧的采集**不改任何产品代码**(`src/**` 一行不动):`_setup.ts` 的 `prep()` 在
`page.addInitScript` 里劫持 `window.EventSource`,把每帧 tee 进 `window.__sseDump`。
App 用裸全局 `new EventSource(...)`(`useSessionSSE.ts`),劫持全局即透明生效。

## 组成

| 文件 | 作用 |
|---|---|
| `../capture.config.ts` | 本套的 Playwright 配置:testDir=`capture/`、连真后端、单 worker、超时 150s、`webServer` 自动起 vite(:5181) |
| `_setup.ts` | 共享 `prep()`(桩 electronAPI + localStorage + 劫持 EventSource)与 `startSession()` |
| `sse-capture.spec.ts` | **golden-master 采集**:6 场景各发消息 → 读 `window.__sseDump` → 落 `capture/golden-master/*.json` |
| `smoke.spec.ts` | **冒烟 + 截图**:9 场景(代码块/表格/ASCII/mermaid/富 md/工具/HITL/流式/LLM 设置)→ `capture/smoke-out/*.png` |
| `workspace/` | agent 工作目录的样例文件(`topology.txt` / `ip-plan.txt`),读文件类场景要用 |

## 依赖(缺一不可)

1. **真后端在 :15926 跑** —— `uv run netlivecowork serve`(或桌面壳)。vite 把 `/api` 代理过去(见 `../vite.config.ts`)。
2. **后端已配好可用 LLM 账号** —— 否则对话发不出去。`05-retry-fail` 反过来**需要坏 key + 快速失败 env** 才采得到重试帧。
3. **前端在跑** —— `capture.config.ts` 的 `webServer` 默认 `npm run dev -- --port 5181`,已在跑就复用。采集机制不依赖 DEV 门控,dev/preview 均可。
4. **playwright 浏览器** —— 首次跑先 `npx playwright install chromium`。

## 跑

```bash
# 前提:后端已在 :15926 起、且配好 LLM 账号
npm run smoke      # 冒烟 + 截图 → capture/smoke-out/
npm run capture    # 采 golden-master → capture/golden-master/

# 单个场景
npx playwright test -c capture.config.ts capture/smoke.spec.ts -g "mermaid"
```

## 换工作目录

默认用仓内 `capture/workspace`。要指向别处:

```bash
CAPTURE_WS=/path/to/ws npm run smoke        # bash
$env:CAPTURE_WS='D:\ws'; npm run smoke      # PowerShell
```

## 采完 golden-master 后

`capture/golden-master/*.json` 是纯 SSE 帧序列,可挑好的喂给纯 reducer 做快照测试
(本仓 reducer 逻辑在 `src/hooks/useSessionSSE.ts` + `src/lib/`;接线为独立后续任务)。

## 发消息的关键动作(两 spec 一致,见 `_setup.ts`)

```ts
await page.getByTitle('新建会话').click()
await page.getByText('点击选择目录…').click()      // 触发 selectDirectory 桩 → 返回 WS
await page.getByRole('button', { name: '创建会话' }).click()
const ta = page.getByPlaceholder('输入第一条消息（Enter 发送）')
await ta.fill(prompt); await ta.press('Enter')     // ← 给 agent 发消息
// HITL:先 PUT /api/v1/sessions/{id}/bash-review-mode {mode:'manual'} 再等「允许」按钮
// 中断:page.locator('button:has(.lucide-square)').click() → 转 PAUSED → 发新消息续跑
```

## cowork 验收（需求文档 §7 的 AC-*）

`cowork-acceptance.spec.ts` / `cowork-ownership.spec.ts` —— 每条测试名带验收编号，
失败时能直接回到需求那一行。

**前提**（比上面那套多两样）：

1. 后端已装两个套件，且它们的 `mcp.use` / `llm.allow` / `skills.mythosBaseUrl`
   **互补**——一方有一方无只能证明"没有的那边看不到"，证明不了"各看各的"；
2. 每个套件的市场地址各指一个 mock 实例：

   ```bash
   MOCK_MYTHOS_PORT=9099 MOCK_MYTHOS_LABEL=ip   python dev/mock/mock_mythos_server.py
   MOCK_MYTHOS_PORT=9098 MOCK_MYTHOS_LABEL=core python dev/mock/mock_mythos_server.py
   ```

```bash
NLC_COWORKS_DIR=... NLC_COWORK_PACKAGES_DIR=...   npx playwright test -c capture.config.ts capture/cowork-acceptance.spec.ts
```

⚠ **这两个文件会改动开发环境里已装的套件**（靠 `POST /coworks/recheck` 走真对账）。
每条用例自己 finally 复原，`afterAll` 再兜一次底；复原失败会显式报错，不会静默
把坏环境留给下一轮。跑挂在半路时，把 `packages/entitled.json` 改回全量再调一次
recheck 即可。

### 哪些 AC 不在这里，在哪

| AC | 为什么不在这 | 在哪 |
|---|---|---|
| AC-3 / AC-4 | 是**模型手里的**工具与 skill，没有 HTTP 接口能吐出来 | `tests/test_cowork_guard_mcp.py`、`tests/test_cowork_guard_local_skill.py` |
| AC-5 / AC-10 | 要重启后端 / 重新打包 | `tests/test_cowork_reconcile.py` |
| AC-12~14 | 登录态。dev 入口恒跳过鉴权，这里测不出真的 | 待联调 |
| AC-15~17 | 验签；AC-17 是构建期检查不是运行期行为 | `tests/test_cowork_signature.py` |
| AC-21~30 | 存量导入，要有一份真的旧版安装 | `tests/test_migration_legacy_import.py` |
| AC-31~35 | 日志与打点，不经界面 | 人工核对 |

# capture/ 采集套件移植方案（forked-ren `frontend-desktop-v2` → 本仓 `frontend-desktop`）

> 状态：设计稿，待评审。**硬约束：完全不改现有前端代码**——采集套件对 `src/**` 零改动，
> 全部为 `capture/` 下的新增文件 + `package.json` 追加 devDep/scripts + `.gitignore` 追加忽略项。
> SSE 帧的采集不再靠改产品 hook，而是在测试 `addInitScript` 里劫持 `window.EventSource`
> （见「SSE 采集设计」）。因此本套件与任何在跑的特性分支互不冲突，可独立实施。

## 背景与目标

`forked-ren/master` 的 `frontend-desktop-v2/capture/` 是一套 **Playwright E2E 采集套件**，
驱动**真实后端**（`:15926`，不 mock）自动新建会话、发真消息、走完
对话/工具/HITL/中断续跑，并：

1. **采 golden-master**：读 `window.__sseDump` 落 `golden-master/*.json`（纯 SSE 帧序列）。
   —— forked-ren 靠改产品 hook 注入该全局；本移植改为**测试侧劫持 `EventSource`**，见下。
2. **冒烟 + 截图**：9 类渲染场景截图供人工核验前端渲染。

目标：把这套完整移植进本仓 `frontend-desktop/`，让本仓也能对真后端采集 SSE 帧、跑冒烟截图。

**范围**：完整套件（两个 spec + workspace 夹具 + 配置 + npm scripts）。
**不含**：golden-master → reducer 快照测试的后续接线（forked-ren 有 `features/chat/sse/__fixtures__/`，
本仓 reducer 逻辑在 `hooks/useSessionSSE.ts` + `lib/`，无对应落点；作为独立后续任务，见「非目标」）。

## 现状比对（已核验）

本仓 `frontend-desktop` 与 forked-ren `frontend-desktop-v2` 是近亲，不是重写。逐项核验：

**已对齐（无需改）**
- UI 选择器 1:1 一致：`新建会话`、`点击选择目录…`、`创建会话`、
  `输入第一条消息（Enter 发送）`、`输入消息（Enter 发送，Shift+Enter 换行）`、
  `允许`、`LLM 配置`、`添加大模型`、`.lucide-square`（`ChatPanel.tsx:215`）、
  `PUT /api/v1/sessions/{id}/bash-review-mode`。
- 引导/语言 localStorage 键一致：`netlive.lang.v1`、`onboarding.{main,workspace,llm,skills}.v1`。
- `window.electronAPI.selectDirectory()` 一致（`NewSessionDialog.tsx:93`）。
- Vite 代理 `/api → :15926` 已存在（`vite.config.ts`），且对 `text/event-stream` 关缓存。

**待补（移植工作量所在，全部在 `capture/` 内，不碰 `src/**`）**
1. **`window.__sseDump` 采集机制** —— 不改产品 hook。改在测试 `addInitScript` 里劫持
   `window.EventSource`，把每帧 tee 进 `window.__sseDump`，见「SSE 采集设计」。
   已核验本仓 hook 用裸全局 `new EventSource(...)`（`useSessionSSE.ts:154`）、无 polyfill import，
   劫持全局即可透明生效。
2. **无 Playwright** —— 本仓仅有 vitest。须加 `@playwright/test` devDep + `capture.config.ts` +
   `capture/` + `npm run smoke`/`capture` scripts。
3. **LLM 设置入口选择器有小差异** —— forked-ren 用 `getByTitle('Tester')` 打开用户菜单再点
   `LLM 配置`；本仓经 `SessionList` 的 `data-tour="user-menu"` 区域切 `centerView='llm'`。
   spec 04/08 的两步导航须按本仓 `SessionList.tsx` 实测重选（仅改**测试**代码，不碰产品代码）。

## 组件与落点

移植后本仓 `frontend-desktop/` 新增（**全部为新增文件，零改动 `src/**`；`package.json` 仅追加**）：

| 落点 | 类型 | 说明 |
|---|---|---|
| `capture.config.ts` | 新增 | Playwright 配置：`testDir=capture/`、单 worker、150s 超时、自动起 vite `:5181`、连真后端 |
| `capture/_setup.ts` | 新增 | 共享 `prep()`：桩 `electronAPI` + localStorage + **劫持 `EventSource` 注入 `__sseDump`** |
| `capture/sse-capture.spec.ts` | 新增 | golden-master 采集（6 场景），逐字移植 + 选择器已验证一致 |
| `capture/smoke.spec.ts` | 新增 | 冒烟 + 截图（9 场景），逐字移植；仅 spec 04/08 的 LLM 入口两步按本仓重选 |
| `capture/workspace/topology.txt` | 新增 | 夹具：`router config A` |
| `capture/workspace/ip-plan.txt` | 新增 | 夹具：`10.0.0.0/8 core` |
| `capture/.gitignore` | 新增 | 忽略采集产物 `smoke-out/`、`golden-master/`（**不碰个人化的根 `.gitignore`**） |
| `package.json` | **仅追加** | 加 `@playwright/test` devDep + `smoke`/`capture` scripts（不改现有依赖/脚本） |

> 产物落点统一收到 `capture/` 下（`smoke-out/` 与 `golden-master/` 均在 `capture/`），
> 一个 `capture/.gitignore` 全覆盖；避免动本仓「故意自忽略、个人配置」的根 `.gitignore`。

### SSE 采集设计（零产品代码改动，关键）

forked-ren 的 dump 每条形如 `{ sessionId, frame }`（spec 里读 `e.frame.type`、`e.frame.status`、
`e.sessionId`、`d[0].sessionId`），forked-ren 靠**改产品 hook**注入。本移植**不改产品代码**——
在测试的 `page.addInitScript`（早于 App 脚本运行）里劫持全局 `EventSource`，把每帧透明 tee 进
`window.__sseDump`。App 的 `new EventSource(...)`（裸全局）自然用到被包装的构造器：

```ts
// capture/_setup.ts —— prep() 内的 addInitScript，注入页面上下文
await page.addInitScript((ws) => {
  // ① 原有桩：语言 / 引导 / electronAPI（同 forked-ren）
  localStorage.setItem('netlive.lang.v1', 'zh')
  for (const t of ['main', 'workspace', 'llm', 'skills']) localStorage.setItem(`onboarding.${t}.v1`, '1')
  ;(window as any).electronAPI = {
    getSession: async () => ({ id: 'u1', username: 'Tester', role: 'user' }),
    logout: async () => {},
    selectDirectory: async () => ws,
  }
  // ② 采集钩子：劫持 EventSource，把每帧 tee 进 __sseDump（纯测试侧，产品代码零改）
  const Orig = window.EventSource
  const dump = ((window as any).__sseDump ??= [] as { sessionId: string; frame: unknown }[])
  class Tapped extends Orig {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init)
      const m = String(url).match(/\/sessions\/([^/]+)\/stream/)
      const sessionId = m ? m[1] : ''
      this.addEventListener('message', (e: MessageEvent) => {
        try {
          const frame = JSON.parse(e.data as string)
          if (frame && frame.type !== 'ping') dump.push({ sessionId, frame })  // 滤 ping 噪声
        } catch { /* 非 JSON 帧忽略 */ }
      })
    }
  }
  ;(window as any).EventSource = Tapped
}, WS)
```

要点：
- **零产品代码改动**：注入全在测试 `addInitScript`，`src/**` 一行不动；与在跑的特性分支互不冲突。
- **透明生效**：App 用裸全局 `new EventSource(...)`（`useSessionSSE.ts:154`），劫持全局即被采集；
  已核验无 EventSource polyfill import。
- **`sessionId` 从流 URL 提取**：`/sessions/{id}/stream`，与每帧配对写入，满足 `d[0].sessionId` 等读取。
- **滤 `ping`**：后端每 3s 心跳，剔除以保 golden-master 干净；其余帧（含 `history`）原样保留。
- **无需 DEV/生产区分**：不再依赖 `import.meta.env.DEV` 门控与 tree-shake——因为根本没往产品里塞代码。
  App 用 dev 还是 preview 起都行（默认 `npm run dev`，见配置）。
- dump 不清空/不设上限：单次采集一个会话、帧量有限；spec 每场景走新 `page`（新 window）天然隔离。

## 数据流

```
Playwright(capture.config.ts, :5181)
  → 起 vite（default: npm run dev）
  → page.addInitScript：桩 electronAPI.selectDirectory ⇒ capture/workspace + 劫持 EventSource
  → 走 新建会话 / 选目录 / 创建会话 / 发消息
  → App 的 EventSource（已被 Tapped 包装）连 /api/v1/sessions/{id}/stream（vite 代理 → 真后端 :15926）
  → Tapped 的 message 监听把每帧 push 进 window.__sseDump（产品 useSessionSSE 照常收帧，互不干扰）
  → spec 轮询 __sseDump 等待目标帧（done / PAUSED / bash_exec_confirm / …）
      ├─ sse-capture：page.evaluate 取 __sseDump → 写 capture/golden-master/*.json
      └─ smoke：到目标态 → page.screenshot → capture/smoke-out/*.png
```

## 依赖与前提（沿用 forked-ren README）

1. **真后端在 `:15926` 跑**：`uv run ipmastercowork serve`（或桌面壳）。
2. **后端已配可用 LLM 账号**，否则消息发不出。
3. **前端在跑**（`capture.config.ts` 的 `webServer` 默认 `npm run dev`，已跑则复用）。
   —— 采集机制在测试侧劫持 `EventSource`，不依赖 DEV 门控，dev/preview 均可。
4. **首次装 chromium**：`npx playwright install chromium`。
5. `05-retry-fail` 场景另需**坏 key + 快速失败 env** 启动后端才采得到重试帧（沿用上游约定，文档标注）。

## 错误处理与边界

- **选择器漂移**：spec 04/08 的 LLM 入口是唯一按本仓重写的两步；其余选择器已核验一致，
  逐字移植即可。移植后须实跑一遍确认（见验证）。
- **真 LLM 不确定性**：单 worker、`retries:0`、150s 超时，沿用上游——采集/冒烟本就允许人工重跑。
- **产物不污染仓库**：`capture/smoke-out/`、`capture/golden-master/` 由 `capture/.gitignore` 忽略
  （不动个人化的根 `.gitignore`）。
- **零产品影响**：采集代码全在测试侧，`src/**` 一行不改；劫持只在 Playwright 页面上下文生效，
  真实用户的 App 完全不受影响。
- **与 vitest 互不干扰**：已核验 `vitest.config.ts` 的 `include: ['src/**/*.{test,spec}.{ts,tsx}']`
  只扫 `src/**`，而 `capture/` 在 `frontend-desktop` 根、不在 `src/` 下，vitest 天然不拾取 Playwright specs。

## 验证

移植后（在具备真后端 + LLM 账号的环境）：
1. `npm run smoke -- -g "code-and-table"` 单场景跑通、`capture/smoke-out/01-*.png` 生成且渲染正常。
2. `npm run capture -- -g "01-plain-dialog"` 生成 `capture/golden-master/01-plain-dialog.json` 且含 `done` 帧。
3. 抽验 HITL（06/04）与 interrupt-resume（06）——这两条最依赖选择器/状态机，须实跑确认。
4. `git status` 确认改动只落 `capture/` + `package.json`，`src/**` 无任何改动（零产品影响的硬保证）。

## 实施与分支

- **不改产品代码 → 与在跑的 `feat/compact-visible-web` 无文件冲突**（唯一交集 `package.json` 是追加，
  非改现有行）。可等当前特性收尾、从 `master` 拉独立分支（如 `feat/capture-harness`）实施，
  符合本仓「每特性拉分支」工作流。
- 实施顺序建议：① 配置 `capture.config.ts` + `capture/_setup.ts`（含 EventSource 劫持）+ 夹具 +
  `package.json` 追加 → ② 逐字移植两 spec、`prep()` 改用 `_setup.ts` → ③ 重选 spec 04/08 的 LLM 入口 →
  ④ 真环境实跑验证（含 `git status` 确认 `src/**` 零改动）。

## 非目标（后续可选）

- golden-master → reducer 快照测试接线：本仓无 `features/chat/sse/__fixtures__/` 结构，
  reducer 逻辑在 `useSessionSSE.ts` + `lib/`。若要做，需另建 `__fixtures__` + vitest 快照测试
  回放 dump，属独立任务，不在本次范围。

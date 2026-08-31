# browser-mcp

一个通用的浏览器操作 MCP server，通过 CDP Chrome 提供页面自动化能力（导航、点击、填写、执行 JS、快照、SSO 等待）。

> ⚠️ **本 MCP 必须与 Skill 配合使用。** 它只提供通用浏览器原子操作，不包含任何领域知识（目标网址、SSO 模式、页面结构、搜索流程）。所有领域知识必须来自配套的 Skill。Skill 不固定为某一个——任何需要浏览器自动化的 Skill 都可以与本 MCP 配对。

## 定位

| | 本 MCP | 配套 Skill |
|---|---|---|
| 职责 | 浏览器原子操作（启动/导航/点击/填写/执行JS/快照/SSO等待） | 领域知识（目标网址、SSO 模式、页面踩坑、搜索 SOP） |
| 是否含领域知识 | ❌ 不含任何网站特定知识 | ✅ 全部领域知识在此 |
| 可否独立使用 | ❌ 必须配 Skill | ❌ 必须配本 MCP 才能操作浏览器 |
| 换一个领域 | ✅ MCP 不用改 | 换一个 Skill 即可 |

**核心原则：MCP 是"手"，Skill 是"脑"。** MCP 不知道该去哪个网站、怎么搜索、页面长什么样——这些全由 Skill 告诉它。

## 它做了什么

- **CDP Chrome 启动管理**：在 `127.0.0.1:9222` 启动（或复用）一个带固定用户目录的 Chrome 实例，保留登录态（Cookie/会话）。
- **直接走 Chrome DevTools Protocol**：通过 WebSocket 连到 CDP endpoint，用 `Runtime.evaluate` / `Page.navigate` 等原语操作页面。
- **多 Tab 并发隔离**：每个会话通过 `tab_id` 拥有独立 Tab，多个会话可同时操作同一 Chrome 互不干扰。
- **结构化快照**：`get_snapshot` 返回可访问性树 + `[ref]` 编号，点击/填写可直接用 ref 编号定位，无需猜 CSS 选择器。
- **SSO 等待**：`wait_for_sso` 轮询 URL 直到 SSO 跳转收敛，SSO 模式由 Skill 通过 `sso_url_pattern` 参数传入。

## 提供的工具（13 个）

| 工具 | 作用 |
|------|------|
| `browser_launch` | 启动/复用 CDP Chrome，为指定 tab_id 创建独立 Tab（可用 `start_url` 直接导航该 Tab） |
| `browser_shutdown` | 关闭调用者的 Tab（不杀 Chrome 进程，不影响其他会话；不会为了关闭而启动浏览器） |
| `navigate` | 跳转到指定 URL 并等待 load |
| `get_snapshot` | 返回结构化可访问性树快照（含 ref 编号） |
| `click` | 按 ref 编号或 CSS 选择器点击元素 |
| `click_and_read` | 复合：点击 + 返回点击后的快照（省 1 次往返） |
| `fill` | 按 ref 编号或 CSS 选择器填入值（支持受控组件 / contenteditable / checkbox） |
| `evaluate` | 在页面上下文执行 JS，返回 JSON 结果 |
| `wait_for_sso` | 等待 SSO 跳转登录收敛（SSO 模式由 Skill 传入） |
| `wait_for_selector` | 等待某个 CSS 选择器出现 |
| `open_and_search` | 复合：导航 + 等 SSO + 快照（省 2~3 次往返；`wait_ms` 是整次调用的总预算） |

### 关于 `[ref]` 编号

`get_snapshot` 会把每个输出节点登记到页面内的 `window.__browserMcpRefs`，`click` / `fill` 的 `ref` 参数就从那里 O(1) 取回元素——**看到的就是点到的**。

Ref 在页面导航或重新渲染后失效。此时工具会返回明确的 `isError` 错误并提示「重新 `get_snapshot`」，而不是静默点错元素。

## 安装与构建

```bash
cd browser-mcp
npm install
npm run build
```

## 测试

`test/e2e.test.mjs` 会真实拉起 Chrome 跑完整链路（工具注册、ref 定位准确性、失效 ref 报错、导航不超时、多 Tab 隔离、并发去重）：

```bash
npm run build && npm test        # 需要本机装有 Chrome 或 Edge
VERBOSE=1 npm test               # 同时打印 server 的 stderr 日志
```

## 配置

在 MCP 客户端（如 Claude Desktop / 本 Agent）里注册（stdio 传输）：

```json
{
  "mcpServers": {
    "browser-mcp": {
      "command": "node",
      "args": ["D:/test_skills/untitled1/browser-mcp/dist/index.js"]
    }
  }
}
```

固定用户目录默认在 `~/.browser-mcp/chrome-profile`，首次需手动在弹出的 Chrome 窗口完成 SSO 登录，之后会话会被保留复用。

### 环境变量

| 变量 | 作用 |
|------|------|
| `BROWSER_MCP_LOG_LEVEL` | `silent` / `error` / `warn` / `info`（默认） / `debug` |
| `BROWSER_MCP_CHROME_PATH` | 指定 Chrome/Edge 可执行文件，优先于自动探测 |

日志一律走 stderr（stdout 留给 MCP JSON-RPC）；`fill` 的 `value` 在日志中会被脱敏，长参数会被截断。

## 架构

```
src/
  index.ts              # 入口：启动 stdio MCP server + 退出清理钩子
  browser/
    manager.ts          # CDP Chrome 启动/复用/关闭（启动串行化 + 可回收的启动锁）
    cdp-client.ts       # 底层 CDP WebSocket 客户端（命令超时 + 断线唤醒 + 按 session 路由事件）
    page-ops.ts         # 高层页面操作（navigate/evaluate/click/fill/snapshot/wait_for_sso）
  tools/
    definitions.ts      # MCP 工具 schema 定义
    handler.ts          # 工具执行逻辑（启动时校验 schema 与 handler 一一对应）
    index.ts            # 工具注册（含多 Tab session 管理，按 tab_id 串行创建）
    types.ts            # 共享 session / 结果类型
  utils/
    logger.ts           # stderr 日志（分级 + 脱敏 + 截断）
    args.ts             # 参数校验与类型强制
test/
  e2e.test.mjs          # 端到端回归测试（真实 Chrome）
```

## 0.2.0 修复要点

| 问题 | 影响 | 现状 |
|------|------|------|
| `get_snapshot` 在 schema 里声明了但没有 handler | 读页面的主要工具返回 `Unknown tool` 纯文本，无报错标记 | 补上 handler；启动时校验 schema↔handler，缺一个就启动失败 |
| `navigate` / `get_url` / `wait_for_sso` 有实现但没接到 MCP | README 里写的工具调不到 | 全部接入（当时 13 个工具） |
| `click`/`fill` 的 ref 编号规则与 `get_snapshot` 不一致 | **点错元素**：实测请求 "Bravo" 点到了 "Alpha" | 改为页面内 ref 注册表，O(1) 取回；失效 ref 明确报错 |
| CDP 命令无超时，socket 断开不 reject | 渲染进程卡住/Tab 崩溃时整个调用永久挂起 | 每条命令有 deadline；socket 断开唤醒所有在途请求 |
| `Page.navigate` 之后才订阅 load 事件 | 竞态，丢事件即空等满 timeout | 先订阅再导航 |
| 同文档导航（`#fragment`）不触发 load 事件 | 实测必然空等满 `wait_ms`（默认 30s） | 用 CDP 缺省的 `loaderId` 判定并跳过等待（实测 20s → 89ms） |
| 启动锁非原子、异常时不释放、无过期回收 | 一次崩溃就永久锁死后续所有启动 | `wx` 原子创建 + `finally` 释放 + 过期/进程已死回收 |
| 同进程内并发启动互相踩 | 落败方直接报 "Another launch is in progress" | 共享同一个在途启动 Promise |
| 同一 `tab_id` 并发首次调用 | 各建一个 Tab，其中一个泄漏 | 按 tab_id 串行化 session 创建 |
| `browser_shutdown` 走 `ensureSession` | 为了关闭一个空闲 tab 反而启动 Chrome、开一个 Tab | 只查不建 |
| 进程退出无清理 | 打开的 Tab、Chrome 子进程、启动锁全部残留 | SIGINT/SIGTERM/stdin 关闭时清理；Windows 用 `taskkill /T` 收整棵进程树 |
| `open_and_search` 里 navigate 和 SSO 各自用满 `wait_ms` | 最差阻塞 2×`wait_ms` | 改为整次调用共享一个 deadline |
| `start_url` 作为 Chrome 命令行参数传入 | 开出一个无人拥有的 Tab（关不掉），调用者自己的 Tab 还停在 about:blank | 改为导航调用者自己的 Tab |
| 快照给每层 wrapper div 都输出一遍后代文本 | 嵌套重复文本占满 `max_chars`，真正能点的元素被截断丢掉 | 通用容器只输出自身文本；实测同样 20k 预算内可见交互元素 30 → 88 个，完整输出 241KB → 72KB |
| 快照对每个元素调 `getComputedStyle` | 全树强制样式解析 | 优先用 `Element.checkVisibility()` |
| `wait_for_sso` 每轮两次 `evaluate` | 每秒两次 CDP 往返，跳转中报错即中断等待 | 合并为一次；跳转期报错视为「仍在跳转」 |
| 参数一律 `as number` 强转、错误无 `isError` | 客户端传 `"9222"` 之类会在 CDP 深处炸开；失败与页面内容无法区分 | 边界处统一校验/强制类型；错误结果带 `isError` |
| 日志原样打印 `fill` 的 `value` | SSO 密码可能进日志 | 脱敏 + 截断 + 分级 |
| `tsc` 报错仍写出 dist | 构建失败却「构建成功」，跑的是坏代码 | 开启 `noEmitOnError` |

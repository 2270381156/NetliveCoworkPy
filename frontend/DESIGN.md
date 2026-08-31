# miniAgents 前端设计方案

## 一、技术选型

| 层级 | 选择 | 理由 |
|------|------|------|
| 框架 | **React 19 + TypeScript** | 生态成熟，组件复用性强 |
| 构建工具 | **Vite** | 极快的开发体验 |
| UI 组件库 | **shadcn/ui + Tailwind CSS** | 现代设计，高度可定制，无框架锁定 |
| 状态管理 | **Zustand** | 轻量，适合中小型应用 |
| 数据请求 | **TanStack Query (React Query)** | 内置轮询支持，缓存，loading/error 状态管理，完美匹配异步轮询需求 |
| 路由 | **React Router v7** | 标准路由方案 |
| 图表 | **Recharts** | Token 用量进度可视化 |
| 代码编辑器 | **CodeMirror 6** | 显示 JSON 工具参数、Prompt 预览 |

---

## 二、整体布局

```
┌─────────────────────────────────────────────────────────┐
│  侧边导航栏 (64px)  │  主内容区                          │
│                     │                                    │
│  ○  Sessions        │  <当前页面内容>                    │
│  ○  Templates       │                                    │
│  ○  LLM Providers   │                                    │
│  ○  MCP Servers     │                                    │
│  ─────────────────  │                                    │
│  ○  Settings        │                                    │
└─────────────────────────────────────────────────────────┘
```

**固定侧边栏**，主内容区承载页面内容。顶部有全局状态栏（显示当前活跃 Session 数量、系统健康状态）。

---

## 三、页面设计

### 页面 1：Sessions（主页 `/sessions`）

这是核心页面，分为左右两栏：

**左侧：Session 列表面板**
```
[+ 新建 Session]

🟢 ses_01HV...  research-agent  RUNNING    2m ago
🔴 ses_01HU...  default         FAILED     1h ago
✅ ses_01HT...  research-agent  SUCCEEDED  3h ago

[全部] [运行中] [已完成] [失败]
```

- 状态图标颜色：QUEUED=灰、RUNNING=蓝动画、SUCCEEDED=绿、FAILED=红、CANCELED=灰
- 点击任意 Session → 右侧展示详情
- 顶部"新建 Session"按钮 → 弹出 Modal

**新建 Session Modal：**
```
目标 (Goal)
┌─────────────────────────────────────┐
│ 请描述你希望 Agent 完成的任务...      │
└─────────────────────────────────────┘

Agent 模板           Token 预算      最大轮次
[research-agent ▼]  [200000      ]  [20  ]

                           [取消]  [启动 Session]
```

**右侧：Session 详情面板**

顶部状态卡片：
```
┌────────────────────────────────────────────────┐
│  ses_01HV...  research-agent  🔵 RUNNING       │
│  Goal: "Analyze this codebase and write..."    │
│                                                │
│  Token 用量    ████████░░░░░░░  45,000/200,000 │
│  Turns         ██████░░░░░░░░   6/20           │
│  失败次数       0/3                             │
│                              [取消]            │
└────────────────────────────────────────────────┘
```

下方三 Tab：

**Tab 1：任务流** — 卡片时间线，每个 Task 一张卡片：
```
  🔵 ACTIVE   tsk_...  [reasoning]
  "分析代码结构"
  ┄┄┄┄┄ (实时刷新中...) ┄┄┄┄┄

  ✅ FINISHED tsk_...  [tool-call]  bash_exec  0.3s
  "列出项目文件"
  > ls -la app/
  < drwxr-xr-x ...
```

**Tab 2：消息记录** — 对话气泡式布局：
```
  [user]      分析这个代码库
  [assistant] 我来分析这个代码库的结构...
  [tool]      bash_exec: ls -la app/
              Result: app/ contains...
  [assistant] 根据分析，项目结构如下...
```

**Tab 3：工具调用日志** — 表格：
```
  时间    工具名        状态    耗时   参数摘要
  12:03  bash_exec    ✅      0.3s   ls -la app/
  12:04  http_request ✅      1.2s   GET https://...
  12:04  bash_exec    ❌      0.1s   rm -rf /  (被拦截)
```

---

### 页面 2：Agent Templates（`/templates`）

只读展示，网格卡片布局：

```
┌─────────────────────┐  ┌─────────────────────┐
│ research-agent      │  │ default-agent       │
│ v1.0.0              │  │ v1.0.0              │
│                     │  │                     │
│ A research-focused  │  │ General purpose...  │
│ agent template...   │  │                     │
│                     │  │                     │
│ Tools: bash_exec    │  │ Tools: bash_exec    │
│        http_request │  │        http_request │
│ 可生成子 Agent: 否   │  │ 可生成子 Agent: 是   │
│            [查看]   │  │            [查看]   │
└─────────────────────┘  └─────────────────────┘
```

点击"查看" → 侧边抽屉展示完整 System Prompt（用 CodeMirror 显示 Markdown）。

---

### 页面 3：LLM Providers（`/llms`）

**先决条件提示**：若无任何 Provider，显示醒目引导横幅。

```
⚠️  尚未配置 LLM Provider，无法启动 Session。  [立即配置]

[+ 注册 LLM Provider]

名称              类型        模型              状态
my-gpt4o         OpenAI      gpt-4o            ✅     [删除]
claude-opus      Anthropic   claude-opus-4-6   ✅     [删除]
```

**注册表单（右侧抽屉）：**
```
名称*         [              ]
类型*         [OpenAI ▼]
API Key*      [sk-...        ] (提交后不可查看)
Base URL      [              ] (可选)
模型*         [gpt-4o        ]
超时(秒)      [60            ]

                    [取消]  [注册]
```

---

### 页面 4：MCP Servers（`/mcp-servers`）

标签页切换 Stdio / HTTP 两种类型：

```
[Stdio]  [HTTP]                      [+ 注册 MCP Server]

名称          类型    工具数    状态    操作
my-tools     stdio   12       ✅      [刷新工具]  [删除]
web-search   http    3        ✅      [刷新工具]  [删除]
```

展开某行 → 显示该 MCP Server 提供的工具列表。

---

## 四、轮询策略

```typescript
// 使用 TanStack Query 的 refetchInterval
useQuery({
  queryKey: ['session', sessionId],
  queryFn: () => fetchSession(sessionId),
  refetchInterval: (query) => {
    const status = query.state.data?.status
    // 终态停止轮询
    if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(status)) return false
    // 运行中每 2s 轮询一次
    return 2000
  }
})
```

- **QUEUED / RUNNING**：每 2s 轮询 Session + Tasks + Messages
- **终态**：停止轮询，显示最终结果
- **Token 进度 > 80%**：显示橙色警告，> 95% 显示红色

---

## 五、目录结构

```
frontend/
├── src/
│   ├── api/               # API 客户端函数（按资源分文件）
│   │   ├── sessions.ts
│   │   ├── tasks.ts
│   │   ├── templates.ts
│   │   ├── llms.ts
│   │   ├── mcp.ts
│   │   └── memory.ts
│   ├── components/
│   │   ├── ui/            # shadcn/ui 基础组件
│   │   ├── session/       # Session 相关组件
│   │   ├── task/          # Task 时间线、卡片
│   │   ├── memory/        # 消息气泡组件
│   │   └── layout/        # Sidebar、TopBar
│   ├── pages/
│   │   ├── SessionsPage.tsx
│   │   ├── TemplatesPage.tsx
│   │   ├── LLMsPage.tsx
│   │   └── MCPPage.tsx
│   ├── hooks/             # 自定义 hooks（useSession、usePoll...）
│   ├── stores/            # Zustand stores
│   └── types/             # TypeScript 类型（与后端 schema 对齐）
├── package.json
└── vite.config.ts
```

---

## 六、开发阶段规划

| 阶段 | 内容 | 优先级 |
|------|------|--------|
| **P0** | 项目脚手架 + API 客户端 + 类型定义 | 必须 |
| **P0** | LLM Provider 管理页（注册/删除先决条件） | 必须 |
| **P0** | Sessions 页：创建 + 状态轮询 + Task 列表 | 必须 |
| **P1** | Messages 消息记录 Tab + Tool Call 日志 Tab | 重要 |
| **P1** | Agent Templates 浏览页 | 重要 |
| **P2** | MCP Servers 管理页 | 次要 |
| **P2** | Token 用量图表、失败报警 UI 优化 | 次要 |

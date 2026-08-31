# frontend-desktop 完整实现文档

> 本文档力求**逐项详尽**地记录 `frontend-desktop`(IPMaster-Cowork 桌面应用前端)的全部实现:配色、间距、字号、圆角、阴影、动画等视觉细节,以及每个组件、每个按钮/可交互元素点击后的行为、调用的 API、状态变更与副作用。绝大多数条目标注了 `文件路径:行号` 以便核对。
>
> 覆盖范围为 `frontend-desktop/src/**` 及构建配置(`index.html` / `vite.config.ts` / `package.json`)。文档按功能分为 6 章,由对各源文件的逐行阅读整理而成。

## 技术栈概览

- **框架**:React 19 + TypeScript,Vite 8 构建,SPA。
- **样式**:Tailwind CSS v4(`@tailwindcss/vite`)+ `@tailwindcss/typography`;一套 CSS 变量设计令牌定义在 `src/index.css`(详见第 1 章)。
- **数据**:TanStack React Query(服务端状态);本地状态用 `App.tsx` 的 `useState` + `localStorage`(经核实**无 zustand**:`package.json` 未声明、`src/` 零引用)。后端经 Vite dev 代理 `/api` → `http://localhost:15926`,聊天为 SSE(`text/event-stream`)。
- **运行形态**:由 Electron 加载(dev 指向 Vite dev server;生产由 PyInstaller 后端内嵌静态产物挂载)。
- **预览能力**:Markdown(react-markdown + remark-gfm,mermaid 图表)、代码、文本、图片、Excel(xlsx)、PDF(pdfjs-dist)、PPTX(自研 pptx→HTML 解析引擎)、DOCX(docx-preview);重型解析跑在 Web Worker。

## 目录结构(src)

```
src/
├── main.tsx                      入口(StrictMode + Providers)
├── App.tsx                       应用骨架 / 路由 / 布局
├── index.css                     设计令牌(CSS 变量)+ 全局样式
├── i18n.tsx                      国际化(中/英文案表)
├── types/index.ts                全局 TypeScript 类型
├── api/                          后端接口封装(client/sessions/llms/skills/workspace)
├── hooks/                        useSessionSSE / useProjectGroups / useOnboarding
├── lib/                          activity / taskSummary / llmError / utils
├── components/
│   ├── ChatPanel.tsx             对话区(核心)
│   ├── SessionList.tsx           会话列表与分组
│   ├── NewSessionDialog.tsx      新建会话
│   ├── WorkspacePanel.tsx        工作区文件面板
│   ├── FilePreviewModal.tsx      文件预览弹窗外壳
│   ├── LLMSettingsPage.tsx /     LLM 账号设置
│   │   LLMSettingsDialog.tsx
│   ├── SkillsPage.tsx            技能管理
│   ├── LLMErrorModal.tsx / ReportSessionButton.tsx / LoginGate.tsx
│   └── ui/                       button / input / badge / ModelPickerButton
└── preview/
    ├── fileType.ts               文件类型 → 查看器分发
    ├── toolbar/                  预览工具栏 / 目录侧栏 / Context
    ├── viewers/                  Markdown / Mermaid / Code / Text / Image / Excel / Pdf / Pptx / Docx
    └── worker/                   解析 Worker(parseClient / protocol / parsers)
```

## 章节目录

1. [设计基础与应用骨架(配色 / 间距 / 字体 / 动画、UI 原子组件、路由布局、国际化)](#1-设计基础与应用骨架配色--间距--字体--动画ui-原子组件路由布局国际化)
2. [对话区(ChatPanel)与会话事件流(SSE)](#2-对话区chatpanel与会话事件流sse)
3. [会话列表 / 新建会话 / 模型选择 / 新手引导 / 登录](#3-会话列表--新建会话--模型选择--新手引导--登录)
4. [LLM 账号设置 与 技能(Skills)管理](#4-llm-账号设置-与-技能skills管理)
5. [工作区面板 与 文件预览框架(工具栏 / 目录 / 类型分发)+ 轻量查看器](#5-工作区面板-与-文件预览框架工具栏--目录--类型分发-轻量查看器)
6. [重型查看器(PDF / PPTX / DOCX)与解析 Worker](#6-重型查看器pdf--pptx--docx与解析-worker)

---

## 1. 设计基础与应用骨架(配色 / 间距 / 字体 / 动画、UI 原子组件、路由布局、国际化)

本章覆盖 IPMaster-Cowork 桌面前端(`frontend-desktop`)的**设计令牌(Design Tokens)**、**全局样式**、**构建与依赖技术栈**、**应用入口与骨架布局**、**UI 原子组件**以及**国际化(i18n)机制**。所有数值均直接取自源码,逐条标注 `文件路径:行号`。

---

### 1.1 技术栈与依赖清单

来源:`frontend-desktop/package.json`

包基本信息:
- `name`: `ipmaster-cowork-desktop`(`package.json:2`)
- `private`: `true`(`package.json:3`)
- `version`: `0.0.0`(`package.json:4`)——注意此处仍为占位版本号,真正的发布版本号在仓库根 changelog/Electron 主进程侧管理(本目录的 `package.json` 版本未随发布更新)。
- `type`: `module`(`package.json:5`)——ESM 模块体系。

NPM scripts(`package.json:6-12`):

| script | 命令 | 说明 |
|---|---|---|
| `dev` | `vite` | 启动 Vite 开发服务器 |
| `build` | `tsc -b && vite build` | 先做 TypeScript 工程引用构建(类型检查),再 Vite 打包 |
| `preview` | `vite preview` | 预览打包产物 |
| `test` | `vitest run` | 单次跑测试 |
| `test:watch` | `vitest` | 监听模式跑测试 |

运行时依赖 `dependencies`(`package.json:13-31`):

| 包 | 版本范围 | 用途(推断) |
|---|---|---|
| `@tailwindcss/typography` | `^0.5.19` | Tailwind 排版插件(`.prose`),用于 Markdown 渲染 |
| `@tanstack/react-query` | `^5.95.2` | 数据请求/缓存(`QueryClient`) |
| `@xmldom/xmldom` | `^0.8.13` | XML DOM 解析(docx 相关) |
| `clsx` | `^2.1.1` | className 条件拼接 |
| `docx-preview` | `^0.3.7` | Word(.docx)文件预览 |
| `driver.js` | `^1.3.1` | 新手引导(onboarding tour) |
| `highlight.js` | `^11.11.1` | 代码高亮 |
| `jszip` | `^3.10.1` | zip 解压(skills 导入、xlsx/docx 解析) |
| `lucide-react` | `^1.7.0` | 图标库 |
| `mermaid` | `^11.16.0` | Markdown 图表渲染 |
| `pdfjs-dist` | `^4.10.38` | PDF 预览 |
| `react` | `^19.2.4` | React 19 |
| `react-dom` | `^19.2.4` | React DOM |
| `react-markdown` | `^10.1.0` | Markdown 渲染 |
| `remark-gfm` | `^4.0.1` | GitHub 风格 Markdown(表格/任务列表等) |
| `tailwind-merge` | `^3.5.0` | 合并 Tailwind 类(去冲突) |
| `xlsx` | `^0.18.5` | Excel 预览 |

开发依赖 `devDependencies`(`package.json:32-48`):

| 包 | 版本范围 | 用途 |
|---|---|---|
| `@eslint/js` | `^9.39.4` | ESLint |
| `@tailwindcss/vite` | `^4.2.2` | Tailwind v4 的 Vite 插件 |
| `@testing-library/dom` | `^10.4.1` | 测试 |
| `@testing-library/jest-dom` | `^6.9.1` | 测试断言 |
| `@testing-library/react` | `^16.3.2` | React 组件测试 |
| `@types/node` | `^24.12.0` | Node 类型 |
| `@types/react` | `^19.2.14` | React 类型 |
| `@types/react-dom` | `^19.2.3` | React DOM 类型 |
| `@vitejs/plugin-react` | `^6.0.1` | Vite React 插件 |
| `jsdom` | `^25.0.1` | 测试 DOM 环境 |
| `tailwindcss` | `^4.2.2` | Tailwind v4 |
| `typescript` | `~5.9.3` | TypeScript |
| `vite` | `^8.0.1` | Vite 8 |
| `vite-plugin-static-copy` | `^4.1.0` | 静态资源拷贝(pdfjs cmaps) |
| `vitest` | `^3.2.6` | 测试框架 |

关键结论:这是一个 **React 19 + Vite 8 + Tailwind v4** 的纯前端 SPA。Tailwind 采用 v4 的 `@tailwindcss/vite` 插件方式(无传统 `tailwind.config.js` 必需),配色等通过 CSS 变量在 `index.css` 中定义。

---

### 1.2 构建配置与开发代理

来源:`frontend-desktop/vite.config.ts`

插件列表(`vite.config.ts:10-21`):
1. `react()`(`vite.config.ts:11`)——`@vitejs/plugin-react`。
2. `tailwindcss()`(`vite.config.ts:12`)——`@tailwindcss/vite`。
3. `viteStaticCopy(...)`(`vite.config.ts:13-20`)——把 `node_modules/pdfjs-dist/cmaps/*` 拷到产物的 `cmaps/` 目录,`rename: { stripBase: true }` 把 `.bcmap` 文件**扁平化**直接落到 `<dist>/cmaps/`。注释说明这是 CJK(中文)PDF 正确渲染字形所必需(`vite.config.ts:15-18`)。

路径别名(`vite.config.ts:22-24`):`'@'` → `path.resolve(__dirname, './src')`。全代码以 `@/...` 引用 `src` 下模块。

开发服务器(`vite.config.ts:25-44`):
- `host: '0.0.0.0'`(`vite.config.ts:26`)——监听所有网卡。
- 后端端口:`const backendPort = process.env.BACKEND_PORT ?? '15926'`(`vite.config.ts:7`)——默认 **15926**,可由环境变量 `BACKEND_PORT` 覆盖。
- 代理 proxy(`vite.config.ts:27-43`),**注意顺序**(更具体的路径在前):
  1. `'/api/v1/sessions'`(`vite.config.ts:28-38`):target = `http://localhost:${backendPort}`,`changeOrigin: true`。`configure` 钩子(`vite.config.ts:31-37`)监听 `proxyRes`,当响应 `content-type` 包含 `text/event-stream` 时,把 `cache-control` 设为 `no-cache`——这是为 **SSE(聊天流)** 专门处理,防止缓存截断流。
  2. `'/api'`(`vite.config.ts:39-42`):兜底,所有其余 `/api` 请求都转发到后端,`changeOrigin: true`。

未显式设置 `server.port`,因此 dev server 使用 Vite 默认端口(通常 5173,**需确认** Electron 主进程加载 URL 时是否覆盖)。

---

### 1.3 HTML 宿主页面

来源:`frontend-desktop/index.html`

- `<!doctype html>`,`<html lang="zh-CN">`(`index.html:1-2`)——默认中文语言标记。
- `<meta charset="UTF-8" />`(`index.html:4`)。
- `<meta name="viewport" content="width=device-width, initial-scale=1.0" />`(`index.html:5`)。
- `<title>IPMaster-Cowork Desktop</title>`(`index.html:6`)。
- 挂载点:`<div id="root"></div>`(`index.html:9`)。
- 入口脚本:`<script type="module" src="/src/main.tsx"></script>`(`index.html:10`)。

页面 `<head>` 不含外链字体或图标——字体走系统字体栈(见 1.5),favicon/品牌图标用 `/icon.svg`(在 `App.tsx` 的 BrandBlock 中引用)。

---

### 1.4 应用入口 main.tsx

来源:`frontend-desktop/src/main.tsx`

导入与挂载顺序非常讲究:
1. **第一条导入**必须是 `import './preview/viewers/pdf/pdfSetup'`(`main.tsx:6`)。注释(`main.tsx:1-5`)说明:`pdfSetup` 通过副作用设置 `globalThis.pdfjsLib`,而 `pdfjs-dist/web/pdf_viewer.mjs` 在模块加载时会解构该全局;把它放在应用入口的第一行,保证任何后续路径触达 `pdf_viewer.mjs` 之前全局已就绪(`PdfViewer.tsx` 内也再导入一次作为第二道防线)。
2. 其余导入:`StrictMode`(react)、`createRoot`(react-dom/client)、`./index.css`、`App`、`LanguageProvider`(`main.tsx:7-11`)。

渲染(`main.tsx:13-19`):
```
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </StrictMode>,
)
```
即顶层包裹 `StrictMode` → `LanguageProvider`(i18n)→ `App`。注意 `QueryClientProvider` 在 `App.tsx` 内部(见 1.6),不在此处。

**渲染就绪信号(Electron 白屏看门狗)**(`main.tsx:21-42`):
- 定义 `signalReady()`(`main.tsx:34-40`):`try { window.electronAPI?.signalReady?.() } catch {}`,在非 Electron(浏览器/dev)环境下安全降级。
- 通过**两条路径**触发,各自弥补对方失效场景(注释 `main.tsx:23-33` 详述):
  - `requestAnimationFrame(signalReady)`(`main.tsx:41`)——首屏可见时的快路径;但窗口被遮挡/最小化/后台时 Chromium 会挂起 rAF。
  - `setTimeout(signalReady, 0)`(`main.tsx:42`)——后台被节流到约 1s,但即使遮挡也会触发,作为与可见性无关的兜底。
- 目的:清除 Electron 主进程的 20s 白屏看门狗,避免误报"界面已打开但未能正常显示"。IPC 在主进程侧幂等,多次触发无害。

---

### 1.5 设计令牌:CSS 变量(配色 / 圆角 / 阴影 / 字体 / 过渡)

来源:`frontend-desktop/src/index.css`,`:root` 块(`index.css:4-29`)。

顶部还有两条全局导入:`@import "tailwindcss";`(`index.css:1`)与 `@plugin "@tailwindcss/typography";`(`index.css:2`)——后者启用 `.prose` 排版样式。

完整 CSS 变量取值表(逐条精确):

| 变量名 | 取值 | 类别 | 含义/用途(推断) |
|---|---|---|---|
| `--bg0` | `#f0f4fa` | 背景 | 最底层窗口背景(`body` 背景,淡蓝灰) |
| `--bg1` | `#ffffff` | 背景 | 纯白卡片背景(中间内容卡、工作区卡) |
| `--bg2` | `#f5f8fe` | 背景 | 次级背景(整窗灰框底、输入框底) |
| `--bg3` | `#eaf0fb` | 背景 | 三级背景(hover 浅蓝、徽章底) |
| `--border` | `#dde6f3` | 边框 | 常规细边框 |
| `--border2` | `#c6d5eb` | 边框 | 较深边框 / 滚动条 thumb |
| `--blue` | `#2563eb` | 主题色 | 主品牌蓝(主按钮、focus ring、链接) |
| `--blue-dim` | `rgba(37, 99, 235, .09)` | 主题色 | 蓝色弱化背景(RUNNING 徽章底等) |
| `--blue-glow` | `rgba(37, 99, 235, .2)` | 主题色 | 蓝色光晕 |
| `--teal` | `#0891b2` | 强调色 | 青色 |
| `--amber` | `#d97706` | 强调色 | 琥珀/橙(等待输入态) |
| `--red` | `#dc2626` | 强调色 | 红(危险/失败) |
| `--green` | `#16a34a` | 强调色 | 绿(成功) |
| `--t1` | `#0f1f3d` | 文字 | 主文字色(深海军蓝,近黑) |
| `--t2` | `#3d5a80` | 文字 | 次级文字色(中蓝灰,标签) |
| `--t3` | `#8aa3bf` | 文字 | 三级文字色(浅蓝灰,占位/弱提示) |
| `--shadow` | `0 1px 4px rgba(15, 31, 61, .07)` | 阴影 | 轻阴影 |
| `--shadow2` | `0 4px 16px rgba(15, 31, 61, .1)` | 阴影 | 重阴影(浮层/弹窗) |
| `--r` | `8px` | 圆角 | 小圆角 |
| `--r2` | `12px` | 圆角 | 中圆角(卡片) |
| `--r3` | `16px` | 圆角 | 大圆角 |
| `--font-ui` | `system-ui, -apple-system, sans-serif` | 字体 | UI 系统字体栈 |
| `--font-mono` | `'JetBrains Mono', ui-monospace, monospace` | 字体 | 等宽字体栈(代码) |
| `--tr` | `.15s ease` | 过渡 | 统一过渡时长/缓动(150ms ease) |

注意:RGBA 颜色基于 `#2563eb`(blue) 的 `rgb(37,99,235)` 与 `#0f1f3d`(t1) 的 `rgb(15,31,61)`。

---

### 1.6 全局样式、滚动条、动画

来源:`frontend-desktop/src/index.css`

**盒模型与基础重置**(`index.css:31-46`):
- `* { box-sizing: border-box; }`(`index.css:31-33`)。
- `html, body, #root { height: 100%; margin: 0; padding: 0; }`(`index.css:35-39`)——三者撑满高度。
- `body`(`index.css:41-46`):
  - `font-family: system-ui, -apple-system, sans-serif;`(注意此处是写死的字体栈,与 `--font-ui` 等价但未引用变量)。
  - `background: var(--bg0);`(`#f0f4fa`)。
  - `color: var(--t1);`(`#0f1f3d`)。
  - `-webkit-font-smoothing: antialiased;`。

**自定义滚动条**(WebKit,`index.css:48-62`):
- `::-webkit-scrollbar { width: 4px; height: 4px; }`(极细滚动条)。
- `::-webkit-scrollbar-track { background: transparent; }`。
- `::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 2px; }`(`#c6d5eb`,圆角 2px)。
- `::-webkit-scrollbar-thumb:hover { background: var(--t3); }`(hover 变 `#8aa3bf`)。

**动画 keyframes**(`index.css:64-72`):
- `@keyframes msg-fade-up`(`index.css:65-68`):`from { opacity: 0; transform: translateY(4px); }` → `to { opacity: 1; transform: none; }`——消息进场上浮淡入(位移 4px)。
- `@keyframes t-bounce`(`index.css:69-72`):`0%, 80%, 100% { transform: scale(.7); opacity: .4; }` / `40% { transform: scale(1.1); opacity: 1; }`——打字"三点跳动"加载动画(typing indicator)。

**复制按钮悬停显隐**(`index.css:74-76`):
- `.msg-row .copy-btn { opacity: 0; transition: opacity var(--tr); }`(默认隐藏,150ms ease 过渡)。
- `.msg-row:hover .copy-btn { opacity: 1; }`(消息行 hover 时显现)。

**Prose / Markdown 覆盖**:
- `.prose code::before, .prose code::after { content: '' !important; }`(`index.css:79-82`)——去掉 typography 插件给行内 `code` 加的反引号伪元素。
- `.msg-md pre, .md-doc pre { background: #f6f8fa !important; color: var(--t1) !important; }`(`index.css:89-93`)——把 typography 默认给 `pre` 的深色 slate 背景改成约定俗成的浅灰 `#f6f8fa`,作用域限定在聊天气泡(`.msg-md`)和文件预览 Markdown 视图(`.md-doc`),不污染其他 prose(注释 `index.css:84-88`)。
- `.msg-md pre code, .md-doc pre code { background: transparent !important; color: var(--t1) !important; }`(`index.css:94-98`)——块内 code 透明背景、主文字色。

---

### 1.7 工具函数 lib/utils

来源:`frontend-desktop/src/lib/utils.ts`

- `cn(...inputs: ClassValue[])`(`utils.ts:4-6`):`return twMerge(clsx(inputs))`——先用 `clsx` 拼接条件类,再用 `tailwind-merge` 去除冲突的 Tailwind 类。这是全项目 className 合并的标准工具。
- `formatTime(iso: string): string`(`utils.ts:8-18`):空串返回 `''`;否则 `new Date(iso).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })`,**固定用 zh-CN 区域**格式化为"月-日 时:分"。出错回退原 `iso`。(注:此处区域硬编码 zh-CN,不随 i18n 语言切换。)
- `formatBytes(n: number | null): string`(`utils.ts:20-25`):`null` → `''`;`< 1024` → `${n} B`;`< 1MB` → `${(n/1024).toFixed(1)} KB`;否则 `${(n/1024/1024).toFixed(1)} MB`。
- `now(): string`(`utils.ts:27-29`):`new Date().toISOString()`。

---

### 1.8 UI 原子组件

> `frontend-desktop/src/components/ui/` 共 **5 个**组件文件,本节详述其中 3 个通用原子件(Button / Input / Badge);另外 2 个因与具体业务耦合,在其它章节文档化,**重构时勿遗漏**:
> - `spinner.tsx` — 加载指示器(在用到的页面/按钮处出现;注意 §1.8.1 的 `Button` 自身 `loading` **不**画 spinner,需调用方自行渲染该组件)。
> - `ModelPickerButton.tsx` — 模型选择下拉按钮,完整文档见 **§3.3**(并在 §2 ChatPanel 底栏、§3.2 新建会话弹窗中被使用)。

#### 1.8.1 Button

来源:`frontend-desktop/src/components/ui/button.tsx`

Props(`button.tsx:4-8`):继承 `ButtonHTMLAttributes<HTMLButtonElement>`,额外:
- `variant?: 'default' | 'ghost' | 'danger' | 'outline'`(默认 `'default'`)。
- `size?: 'sm' | 'md' | 'icon'`(默认 `'md'`)。
- `loading?: boolean`。

行为:`disabled={disabled || loading}`(`button.tsx:13`)——loading 时一并禁用。`children` 原样渲染(`button.tsx:27`)。注意:`loading` **只禁用按钮,不渲染 spinner**(组件本身不画 loading 图标,需调用方处理)。

基础类(始终应用,`button.tsx:15`):
`inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2563eb] disabled:pointer-events-none disabled:opacity-50`
- 即:inline-flex 居中、图标与文字间距 `gap-1.5`(6px)、圆角 `rounded-md`、`font-medium`、颜色过渡;键盘聚焦(focus-visible)显示 1px 蓝色 `#2563eb` ring、去除默认 outline;**禁用态**:`pointer-events-none` + `opacity-50`(半透明且不可点)。

尺寸(size,`button.tsx:16-18`):

| size | 类 | 高度/内距/字号 |
|---|---|---|
| `sm` | `h-7 px-2.5 text-xs` | 高 28px、左右 10px、字号 12px |
| `md` | `h-8 px-3 text-sm` | 高 32px、左右 12px、字号 14px |
| `icon` | `h-7 w-7 p-0` | 28×28px 正方形、无内距(纯图标按钮) |

变体(variant,`button.tsx:19-22`):

| variant | 类 | 常态 | hover | 说明 |
|---|---|---|---|---|
| `default` | `bg-[#2563eb] text-white hover:bg-[#1d4ed8]` | 蓝底白字 | 加深为 `#1d4ed8` | 主操作按钮 |
| `ghost` | `hover:bg-[#eaf0fb]` | 透明 | 浅蓝 `#eaf0fb` 底 | 无边框次级 |
| `outline` | `border border-[#dde6f3] text-[#3d5a80] hover:bg-[#eaf0fb] hover:border-[#c6d5eb]` | 细边框 `#dde6f3`、文字 `#3d5a80` | 底变 `#eaf0fb`、边框变 `#c6d5eb` | 描边次级 |
| `danger` | `bg-red-50 text-red-600 hover:bg-red-100` | 浅红底红字 | 红底加深 | 危险操作 |

(无 `active` 专属类;按下态由浏览器默认 + hover 类覆盖。各 variant 共用上面的 disabled 半透明态。)

#### 1.8.2 Input 与 Select

来源:`frontend-desktop/src/components/ui/input.tsx`

**Input**(`input.tsx:9-27`):
- Props:`InputHTMLAttributes<HTMLInputElement>` + `label?: string`、`error?: string`(`input.tsx:4-7`)。
- 结构:外层 `div.flex.flex-col.gap-1`(`input.tsx:11`);
  - 若有 `label`:`<label class="text-xs" style={color: var(--t2)}>`(`input.tsx:12`,12px、`#3d5a80`)。
  - `<input>` 类:`h-8 rounded-md border px-3 text-sm` + `focus:outline-none focus:ring-1 focus:ring-[#2563eb]` + `disabled:opacity-50` + 条件 `error && 'border-red-400'`(`input.tsx:14-20`)。即:高 32px、圆角、左右 12px、字号 14px;聚焦显 1px 蓝 ring;禁用半透明;有 error 时边框变 `red-400`。
  - 内联 style:`borderColor: var(--border)`、`background: var(--bg2)`、`color: var(--t1)`(`input.tsx:21`)。
  - 若有 `error`:`<span class="text-xs text-red-500">`(`input.tsx:24`,12px 红字)。

**Select**(`input.tsx:29-47`):
- Props:`React.SelectHTMLAttributes<HTMLSelectElement>` + `label?`、`error?`(`input.tsx:29`)。
- 与 Input 同构:外层 `div.flex.flex-col.gap-1`、可选 `label`(同样 12px / `--t2`)。
- `<select>` 类:`h-8 rounded-md border px-2 text-sm` + `focus:outline-none focus:ring-1 focus:ring-[#2563eb]`(`input.tsx:34-37`)。差异:内距是 `px-2`(8px,比 Input 的 px-3 小),且**无** `disabled:opacity-50`、**无** error 边框红色逻辑(仅在底部渲染 error 文案)。
- 内联 style 同 Input(`input.tsx:39`):border `--border`、bg `--bg2`、color `--t1`。
- `children`(option)原样渲染(`input.tsx:43`);末尾可选 error `<span>`(`input.tsx:44`)。

#### 1.8.3 StatusBadge(状态徽章)

来源:`frontend-desktop/src/components/ui/badge.tsx`

- 组件:`StatusBadge({ status, className })`(`badge.tsx:17`),`status: SessionStatus`。
- 渲染 `<span>`,基础类:`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium`(`badge.tsx:20`)——圆角 `rounded`、左右 6px、上下 2px、字号 **10px**、`font-medium`。
- 文案:`t('status.' + status)`(`badge.tsx:21`)——经 i18n 翻译(见 1.10 的 status.* 键)。
- 颜色按 `STATUS_STYLES` 映射(`badge.tsx:5-15`):

| status | 类 | 视觉 |
|---|---|---|
| `QUEUED` | `bg-[#eaf0fb] text-[#8aa3bf]` | 浅蓝底、灰字 |
| `RUNNING` | `bg-[rgba(37,99,235,0.09)] text-[#2563eb] animate-pulse` | 蓝弱底、蓝字、**脉冲动画** |
| `WAITING_INPUT` | `bg-amber-50 text-amber-600 animate-pulse` | 琥珀底、橙字、**脉冲** |
| `PAUSED_HITL` | `bg-amber-50 text-amber-600` | 琥珀底橙字(无脉冲) |
| `PAUSED` | `bg-[#eaf0fb] text-[#8aa3bf]` | 浅蓝底灰字 |
| `SUCCEEDED` | `bg-emerald-50 text-emerald-600` | 浅绿底绿字 |
| `FAILED` | `bg-red-50 text-red-600` | 浅红底红字 |
| `CANCELED` | `bg-[#eaf0fb] text-[#8aa3bf]` | 浅蓝底灰字 |
| `INTERRUPTED` | `bg-[#eaf0fb] text-[#8aa3bf]` | 浅蓝底灰字 |

---

### 1.9 应用骨架:路由、布局、顶层状态

来源:`frontend-desktop/src/App.tsx`

本应用**无传统路由库**(无 react-router);"路由"通过顶层状态 `centerView` 在三种中央视图间切换:`type CenterView = 'chat' | 'skills' | 'llm'`(`App.tsx:48`)。

#### 1.9.1 顶层 Provider 与 QueryClient

- `queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 1000, retry: 1 } } })`(`App.tsx:50-52`)——查询 staleTime 1 秒、失败重试 1 次。
- `App`(`App.tsx:54-60`):`<QueryClientProvider client={queryClient}><AuthGate /></QueryClientProvider>`。

#### 1.9.2 草稿持久化(pendingSession)

注释说明 `pendingSession` 是 Smart B 阶段唯一不入后端的状态,关 app 即丢,故落 localStorage(Electron 下落 `%APPDATA%\IPMaster-Cowork\Local Storage\`)(`App.tsx:14-17`)。
- 存储 key:`'netlive.pendingSession.v1'`(`App.tsx:18`)。
- `loadPendingSession()`(`App.tsx:20-37`):读取并 JSON.parse;容错——仅当 `workingDir` 为非空字符串时返回 `{ workingDir, provider, model }`(provider/model 非字符串则置 `''`)。任何异常返回 `null`。
- `savePendingSession(p)`(`App.tsx:39-46`):有值 `setItem`,无值 `removeItem`;异常静默忽略(配额满不阻断 UI)。

#### 1.9.3 AuthGate(启动鉴权门)

`AuthGate`(`App.tsx:64-87`):
- `hasElectron = !!window.electronAPI?.getSession`(`App.tsx:65`)——是否处于 Electron 环境。
- state:`user: AuthUser | null | undefined`,初值 `undefined`(`App.tsx:66`)。三态:`undefined`=加载中、`null`=未登录、对象=已登录。
- `useEffect`(`App.tsx:68-73`):非 Electron 直接 `setUser(null)`(浏览器调试跳过登录);否则调 `window.electronAPI.getSession()`,成功 `setUser(u ?? null)`,失败 `setUser(null)`。依赖 `[hasElectron]`。
- `handleLogout`(`App.tsx:75-78`):`await window.electronAPI?.logout?.()`(异常忽略),然后 `setUser(null)`。
- 条件渲染(`App.tsx:80-86`):
  - `user === undefined` → 加载占位:`<div className="h-screen" style={{ background: 'var(--bg2)' }} />`(全屏 `#f5f8fe` 空屏)。
  - `hasElectron && user === null` → `<LoginGate onLogin={setUser} />`(登录页)。
  - 否则 → `<Desktop user={user} onLogout={hasElectron ? handleLogout : undefined} />`(浏览器调试下 `onLogout` 为 undefined,即不显示登出)。

#### 1.9.4 Desktop(主骨架)

`Desktop({ user, onLogout })`(`App.tsx:89-254`)。

顶层 state(`App.tsx:90-97`):
- `selectedId: string | null`(选中会话 id,初 `null`)。
- `pendingSession: PendingSession | null`(初始从 localStorage 恢复:`useState(loadPendingSession)`)。
- `centerView: CenterView`(初 `'chat'`)。
- `nextProvider: string`(初 `''`)。
- `nextModel: string`(初 `''`)。
- `workspaceOpen: boolean`(初 `true`)——工作区面板显隐,全局偏好跨会话保持。

副作用与 hooks:
- `useEffect(() => savePendingSession(pendingSession), [pendingSession])`(`App.tsx:100-102`)——草稿任何变更落盘。
- `const { lang } = useI18n()`(`App.tsx:105`)。
- 新手引导(`App.tsx:106-110`):
  - `useFirstVisitTour('main', mainTourSteps(lang), { enabled: centerView === 'chat' })`——首次进 chat 视图引导侧栏部分。
  - `useFirstVisitTour('workspace', workspaceTourSteps(lang), { enabled: centerView === 'chat' && (!!selectedId || !!pendingSession) })`——有会话/草稿后再引导聊天+工作区。
- `const sse = useSessionSSE(centerView === 'chat' ? selectedId : null)`(`App.tsx:112`)——仅在 chat 视图且有选中会话时建立 SSE 连接(否则传 null,不连接)。

派生值(`App.tsx:114-117`):
- `draftActive = selectedId === null && pendingSession !== null`——当前处于"草稿"态。
- `workingDir = draftActive ? (pendingSession?.workingDir ?? '') : (sse.session?.workspace ?? '')`——草稿优先取草稿目录,否则取会话工作区。

回调函数:
- `handleSelect(id)`(`App.tsx:121-124`):`setSelectedId(id)` + `setCenterView('chat')`;**保留** pendingSession 不清(修复草稿丢失 bug)。
- `handleNewSession(pending)`(`App.tsx:126-134`):`setSelectedId(null)`;`setPendingSession({ ...pending, provider: pending.provider || nextProvider, model: pending.model || nextModel })`;切 chat。
- `handleSessionCreated(id)`(`App.tsx:136-139`):`setPendingSession(null)` + `setSelectedId(id)`(草稿转正)。
- `handlePendingSelect()`(`App.tsx:142-145`):切回草稿视图,`setSelectedId(null)` + chat。
- `handleDismissDraft()`(`App.tsx:148-150`):`setPendingSession(null)`(X 显式取消草稿)。
- `handleNextLLMChange(provider, model)`(`App.tsx:152-158`):更新 `nextProvider/nextModel`;若有草稿则同步更新草稿的 provider/model。

工作区显隐派生(`App.tsx:162-164`):
- `canShowWorkspace = centerView === 'chat' && (!!selectedId || draftActive)`——具备显示条件(不要求 workingDir 已设定)。
- `showWorkspace = canShowWorkspace && workspaceOpen`——实际显示。

#### 1.9.5 布局结构(精确尺寸)

最外层(`App.tsx:166-168`):`<div className="flex h-screen flex-col overflow-hidden" style={{ background: 'var(--bg2)', color: 'var(--t1)' }}>`——全屏纵向 flex,底色 `#f5f8fe`、文字 `#0f1f3d`,溢出隐藏。整窗即一块淡灰"边框"底。

**(A) 顶栏**(`App.tsx:170-181`):
- `height: 36`(px)、`flexShrink: 0`、`display: flex`、`alignItems: center`、`paddingRight: 150`、`WebkitAppRegion: 'drag'`——36px 高、不收缩、整条可拖动窗口、右侧留 150px 给原生窗口控件 overlay(最小化/关闭按钮区)。
- 内含 `<BrandBlock />`。

**(B) 主体行**(`App.tsx:183-251`):`<div className="flex min-h-0 flex-1" style={{ paddingTop: 8, paddingRight: 8, paddingBottom: 8 }}>`——横向 flex 占满剩余高度;上/右/下各 8px 灰边(左侧不留,侧栏贴左)。

**(B1) 左侧栏**(`App.tsx:185-199`):`<div className="w-60 flex-shrink-0 flex flex-col" style={{ paddingLeft: 4 }}>`——宽 `w-60`(240px)、不收缩、纵向 flex、左内距 4px(内容透气但外宽不变,中间卡片不右移)。内含 `<SessionList ... />`,传入:
  - `selectedId`(仅 chat 视图传真实值,否则 null)
  - `pendingSession`(同上条件)
  - `centerView`、`onViewChange={setCenterView}`
  - `onSelect={handleSelect}`、`onNewSession={handleNewSession}`
  - `onPendingSelect={handlePendingSelect}`、`onDismissDraft={handleDismissDraft}`
  - `user`、`onLogout`

**(B2) 中间内容卡**(`App.tsx:201-231`):`<div data-tour="chat-area" className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--bg1)', borderRadius: 12, border: '1px solid var(--border)', overflow: 'hidden', marginLeft: 4 }}>`——白底 `#ffffff`、圆角 12px、`1px solid #dde6f3` 边框、溢出隐藏、左外距 4px、占满剩余宽度(`flex-1 min-w-0`)。`data-tour="chat-area"` 供引导定位。内部按 `centerView` 三选一(`App.tsx:213-230`):
  - `'skills'` → `<SkillsPage onClose={() => setCenterView('chat')} />`
  - `'llm'` → `<LLMSettingsPage onClose={() => setCenterView('chat')} />`
  - 否则(`'chat'`)→ `<ChatPanel ... />`,props:`sessionId={selectedId}`、`sse`、`pendingSession={draftActive ? pendingSession : null}`、`onSessionCreated={handleSessionCreated}`、`nextProvider`、`nextModel`、`onNextLLMChange={handleNextLLMChange}`、`canShowWorkspace`、`workspaceOpen`、`onToggleWorkspace={() => setWorkspaceOpen(v => !v)}`。

**(B3) 右侧工作区卡**(`App.tsx:233-250`,仅 `showWorkspace` 为真时渲染):`<div data-tour="workspace" className="w-72 flex-shrink-0 flex flex-col" style={{ background: 'var(--bg1)', borderRadius: 12, border: '1px solid var(--border)', overflow: 'hidden', marginLeft: 8 }}>`——宽 `w-72`(288px)、不收缩、白底、圆角 12px、`1px solid #dde6f3`、左外距 8px(与中间卡间隔 8px)。内含 `<div className="flex-1 min-h-0"><WorkspacePanel workingDir={workingDir} onClose={() => setWorkspaceOpen(false)} /></div>`。

#### 1.9.6 BrandBlock(品牌块)

`BrandBlock`(`App.tsx:256-287`):
- 外层 `<div className="flex items-center gap-2" style={{ padding: '0 12px', height: '100%', WebkitAppRegion: 'no-drag' }}>`——左右内距 12px、满高、`no-drag`(品牌区不参与窗口拖动,内部元素可点)、图标与文字间距 `gap-2`(8px)。
- 图标:`<img src="/icon.svg" alt="" style={{ width: 20, height: 20, flexShrink: 0 }} />`(20×20px)。
- 文字组 `<div className="flex items-center" style={{ gap: 3 }}>`(`App.tsx:267-271`):
  - `IPMaster` —— 13px / `fontWeight 700` / 色 `--t1` / `letterSpacing 0.2px`。
  - `·` —— 13px / `fontWeight 400` / 色 `--t3` / `letterSpacing 0.2px`(分隔点)。
  - `Cowork` —— 13px / `fontWeight 700` / 色 `--t1` / `letterSpacing 0.2px`。
- `beta` 徽章(`App.tsx:272-284`):`marginLeft 2`、`fontSize 9`、`fontWeight 700`、`lineHeight 1`、`letterSpacing 0.5px`、`textTransform uppercase`、文字色 `#2563eb`、背景 `rgba(37,99,235,0.12)`、边框 `1px solid rgba(37,99,235,0.25)`、`borderRadius 4`、`padding '2px 4px'`。

---

### 1.10 国际化(i18n)

来源:`frontend-desktop/src/i18n.tsx`

#### 1.10.1 机制

轻量自实现 i18n:React Context + `t()` + localStorage 持久化(`i18n.tsx:1-10` 文件头注释)。
- 语言类型:`type Lang = 'zh' | 'en'`(`i18n.tsx:14`)。
- 可选语言:`LANGUAGES = [{ value:'zh', label:'简体中文' }, { value:'en', label:'English' }]`(`i18n.tsx:16-19`)。
- 存储 key:`'netlive.lang.v1'`(`i18n.tsx:21`)。
- 词典类型 `Dict = Record<string, string>`(`i18n.tsx:23`);两份字典 `zh`(`i18n.tsx:25-240`)、`en`(`i18n.tsx:242-457`),合并为 `DICTS = { zh, en }`(`i18n.tsx:459`)。词典以 zh 为基准,en 为翻译;缺键回退 zh,再回退 key 本身。

初始语言探测 `detectInitial()`(`i18n.tsx:461-475`):
1. 优先用 localStorage 中用户手动选过的值(仅接受 `'zh'`/`'en'`)。
2. 否则跟随系统:取 `navigator.languages?.[0] || navigator.language`,以 `zh` 开头返回 `'zh'`,其余非空返回 `'en'`。
3. 兜底 `'en'`(仅中英两种,非中文/检测失败统一英文)。

Provider 与 Hook:
- `LanguageProvider`(`i18n.tsx:485-504`):`useState<Lang>(detectInitial)`;`setLang(l)` 同时写 localStorage(`i18n.tsx:488-491`);`t(key, vars?)`(`i18n.tsx:493-501`):`let s = DICTS[lang][key] ?? zh[key] ?? key`;若传 `vars`,对每个 key 用 `new RegExp('\\{${k}\\}', 'g')` 全局替换 `{k}` 占位为 `String(vars[k])`。提供 `{ lang, setLang, t }`。
- `useI18n()`(`i18n.tsx:506-510`):读 Context,缺失则抛 `'useI18n must be used within LanguageProvider'`。

插值示例:`t('workspace.items', { count: 3 })` → "3 项"。

#### 1.10.2 完整文案表(所有 key 及中/英文案)

> 下表按源码分组列出全部键。占位符如 `{ext}`、`{count}`、`{n}`、`{total}`、`{name}`、`{id}`、`{q}`、`{tool}`、`{attempt}`、`{max}` 在运行时由 `t()` 替换。

**common**(`i18n.tsx:27-33` / `244-250`)

| key | 中文 | English |
|---|---|---|
| common.cancel | 取消 | Cancel |
| common.delete | 删除 | Delete |
| common.confirm | 确认 | Confirm |
| common.back | 返回 | Back |
| common.retry | 重试 | Retry |
| common.loading | 加载中… | Loading… |
| common.close | 关闭 | Close |

**file preview**(`i18n.tsx:36-54` / `253-271`)

| key | 中文 | English |
|---|---|---|
| filePreview.unsupported | 不支持预览此文件类型（{ext}） | Preview not supported for this file type ({ext}) |
| filePreview.unknownExt | 未知 | unknown |
| filePreview.empty | 文件为空 | File is empty |
| preview.download | 下载 | Download |
| preview.copy | 复制 | Copy |
| preview.copied | 已复制 | Copied |
| preview.zoomIn | 放大 | Zoom in |
| preview.zoomOut | 缩小 | Zoom out |
| preview.zoomReset | 实际大小 | Actual size |
| preview.zoomFit | 适应窗口 | Fit to window |
| preview.search | 搜索 | Search |
| preview.searchPlaceholder | 在文件中搜索… | Search in file… |
| preview.prevMatch | 上一个 | Previous |
| preview.nextMatch | 下一个 | Next |
| preview.page | 页 | Page |
| preview.toc | 目录 | Contents |
| preview.slideN | 第 {n} 页 | Slide {n} |
| preview.parsing | 解析中… | Parsing… |
| preview.parsingN | 解析中 {n}/{total}… | Parsing {n}/{total}… |

**sidebar**(`i18n.tsx:57-67` / `274-284`)

| key | 中文 | English |
|---|---|---|
| sidebar.sessions | 会话 | Sessions |
| sidebar.newSession | 新建会话 | New Session |
| sidebar.noSessions | 暂无会话，点击 + 新建 | No sessions yet — click + to create |
| sidebar.settings | 设置 | Settings |
| sidebar.skillMarket | Skill 市场 | Skill Market |
| sidebar.llmConfig | LLM 配置 | LLM Providers |
| sidebar.noProject | 未指定目录 | No directory |
| sidebar.deleteSessionConfirm | 确认删除这个会话？此操作不可撤销。 | Delete this session? This cannot be undone. |
| sidebar.draftWaiting | 等待第一条消息… | Waiting for the first message… |
| sidebar.dismissDraft | 放弃这个未发送的草稿 | Discard this unsent draft |
| sidebar.createInProject | 在 {name} 项目内新建会话 | New session in project {name} |

**settings popup / update**(`i18n.tsx:70-81` / `287-298`)

| key | 中文 | English |
|---|---|---|
| settings.language | 语言 | Language |
| settings.version | 版本 | Version |
| update.check | 检查更新 | Check for updates |
| update.checking | 检查中… | Checking… |
| update.available | 发现新版本 | Update available |
| update.downloading | 下载中 | Downloading |
| update.downloaded | 已下载 | Update ready |
| update.restart | 重启更新 | Restart |
| update.uptodate | 已是最新 | Up to date |
| update.error | 更新检查失败 | Update check failed |
| update.readyTitle | 更新已就绪 | Update ready to install |
| update.dismiss | 稍后提醒 | Remind me later |

**session status**(`i18n.tsx:84-92` / `301-309`)

| key | 中文 | English |
|---|---|---|
| status.QUEUED | 等待中 | Queued |
| status.RUNNING | 运行中 | Running |
| status.WAITING_INPUT | 等待输入 | Waiting |
| status.PAUSED_HITL | 等待输入 | Awaiting input |
| status.PAUSED | 暂停 | Paused |
| status.SUCCEEDED | 完成 | Done |
| status.FAILED | 失败 | Failed |
| status.CANCELED | 已取消 | Canceled |
| status.INTERRUPTED | 已中断 | Interrupted |

**activity strip**(输入框上方状态条:工具真名 / 轮换氛围词)(`i18n.tsx:95-111` / `312-328`)

| key | 中文 | English |
|---|---|---|
| activity.tool | 正在执行 {tool} | Running {tool} |
| activity.vibe.llm_pending.0 | 组织思路中 | Organizing thoughts |
| activity.vibe.llm_pending.1 | 冥思苦想中 | Pondering |
| activity.vibe.llm_pending.2 | 酝酿中 | Brewing ideas |
| activity.vibe.llm_pending.3 | 捋一捋 | Thinking it through |
| activity.vibe.reasoning.0 | 抽丝剥茧中 | Untangling the threads |
| activity.vibe.reasoning.1 | 推演中 | Working it out |
| activity.vibe.reasoning.2 | 权衡利弊中 | Weighing the options |
| activity.vibe.reasoning.3 | 正在推理 | Reasoning |
| activity.vibe.generating.0 | 奋笔疾书中 | Writing it up |
| activity.vibe.generating.1 | 正在落笔 | Putting it to words |
| activity.vibe.generating.2 | 整理成文中 | Composing |
| activity.vibe.generating.3 | 正在回复 | Replying |
| activity.vibe.tool_hidden.0 | 整理思绪中 | Collecting thoughts |
| activity.vibe.tool_hidden.1 | 规划下一步 | Planning next step |
| activity.vibe.tool_hidden.2 | 内部协调中 | Coordinating internally |
| activity.vibe.tool_hidden.3 | 梳理任务中 | Sorting out tasks |

**misc**(`i18n.tsx:114` / `331`)

| key | 中文 | English |
|---|---|---|
| misc.connectionLost | 连接断开，正在重连… | Connection lost, reconnecting… |

**chat**(`i18n.tsx:117-160` / `334-377`)

| key | 中文 | English |
|---|---|---|
| chat.inputPlaceholder | 输入消息（Enter 发送，Shift+Enter 换行） | Type a message (Enter to send, Shift+Enter for newline) |
| chat.firstInputPlaceholder | 输入第一条消息（Enter 发送） | Type your first message (Enter to send) |
| chat.defaultModel | 默认模型 | Default model |
| chat.startAgentHint | 发送第一条消息来启动 Agent | Send the first message to start the Agent |
| chat.hideWorkspace | 隐藏工作区 | Hide workspace |
| chat.showWorkspace | 打开工作区 | Show workspace |
| chat.reportSession | 上报此会话 | Report this session |
| chat.reportSessionConsent | 将上传该会话的全部对话内容(含工具调用)与运行日志,用于问题排查。仅发送至内网管理服务。 | This uploads the full conversation (including tool calls) and recent run logs for troubleshooting. Sent only to the internal management server. |
| chat.reportSessionNote | 备注(可选):描述你遇到的问题 | Note (optional): describe the problem |
| chat.reportSessionSubmit | 上报 | Report |
| chat.reportSessionSending | 上报中… | Reporting… |
| chat.reportSessionDone | 已上报 | Reported |
| chat.reportSessionFail | 上报失败 | Report failed |
| chat.copy | 复制 | Copy |
| chat.copied | 已复制 | Copied |
| chat.me | 我 | Me |
| chat.startConversation | 开始对话 | Start a conversation |
| chat.selectOrCreate | 选择或新建一个会话 | Select or create a session |
| chat.waitingResponse | 等待 Agent 响应… | Waiting for the Agent… |
| chat.toolFailed | ✕ 失败 | ✕ Failed |
| chat.toolDone | ✓ 完成 | ✓ Done |
| chat.toolEnded | 已结束 | Finished |
| chat.args | 参数： | Args: |
| chat.error | 错误： | Error: |
| chat.result | 结果： | Result: |
| chat.resultTruncated | （结果已截断） | (result truncated) |
| chat.reasoning | 推理过程 | Reasoning |
| chat.execConfirm | 执行确认 | Execution Confirmation |
| chat.allow | 允许 | Allow |
| chat.reject | 拒绝 | Reject |
| chat.agentNeedsInput | Agent 需要你的输入 | The Agent needs your input |
| chat.agentNeedsApproval | Agent 请求授权 | The Agent requests approval |
| chat.callArguments | 调用参数 | Call arguments |
| chat.multiSelectHint | (可多选) | (multi-select) |
| chat.otherOption | 其他… | Other… |
| chat.recommended | (推荐) | (recommended) |
| chat.submit | 提交 | Submit |
| chat.interruptedHint | 会话被中断(可能因服务重启)。 | Session was interrupted (possibly by a service restart). |
| chat.resume | 恢复运行 | Resume |
| chat.replyPlaceholder | 输入你的回复… | Type your reply… |
| chat.send | 发送 | Send |
| chat.workModeLabel | 工作模式 | Mode |
| chat.workModeAuto | 风险审核 | Risk-based review |
| chat.workModeManual | 逐条审核 | Per-command review |

**LLM call error**(`i18n.tsx:163-168` / `380-385`)

| key | 中文 | English |
|---|---|---|
| llmError.title | LLM 调用出错 | LLM call failed |
| llmError.body | 向大模型发送信息时,模型返回了一个预料之外的错误——这通常是模型服务自身(供应商、网络或限流)的问题,并非你的操作或任务有误。建议上报本次会话,以便开发者排查修复。 | While sending your message to the model, the LLM returned an unexpected error — this is usually a problem on the model service's side (provider, network, or rate limits), not with your task. We recommend reporting this session so the developers can investigate. |
| llmError.detail | 错误详情 | Error detail |
| llmError.retrying | LLM 调用失败,正在自动重试… | LLM call failed, retrying… |
| llmError.retryingN | LLM 连接不稳,正在重试(第 {attempt}/{max} 次)… | LLM connection unstable, retrying ({attempt}/{max})… |
| llmError.interrupted | LLM 服务连接中断,会话已暂停。点击恢复运行以继续。 | Lost connection to the LLM service; the session is paused. Click Resume to continue. |

**new session dialog**(`i18n.tsx:171-178` / `388-395`)

| key | 中文 | English |
|---|---|---|
| newSession.title | 新建会话 | New Session |
| newSession.workingDir | 工作目录 | Working Directory |
| newSession.selectDir | 点击选择目录… | Click to select a directory… |
| newSession.model | 模型（可选） | Model (optional) |
| newSession.useDefault | 使用默认 | Use default |
| newSession.create | 创建会话 | Create Session |
| newSession.appliedRecent | 已套用此目录最近会话的模型（{id}…） | Applied the model from this directory's recent session ({id}…) |
| newSession.dirNeedsElectron | 目录选择需要在 Electron 客户端中使用 | Directory selection requires the Electron client |

**workspace panel**(`i18n.tsx:181-190` / `398-407`)

| key | 中文 | English |
|---|---|---|
| workspace.title | 工作区 | Workspace |
| workspace.items | {count} 项 | {count} items |
| workspace.openInExplorer | 在文件管理器中打开 | Open in file explorer |
| workspace.refresh | 刷新 | Refresh |
| workspace.close | 关闭工作区 | Close workspace |
| workspace.backToParent | 返回上级 | Back to parent |
| workspace.empty | 目录为空 | Directory is empty |
| workspace.notConfigured | 工作区未配置 | Workspace not configured |
| workspace.folders | {count} 个文件夹 | {count} folder(s) |
| workspace.files | {count} 个文件 | {count} file(s) |

**skills page**(`i18n.tsx:193-213` / `410-430`)

| key | 中文 | English |
|---|---|---|
| skills.title | Skills | Skills |
| skills.localTab | 本地 Skills | Local Skills |
| skills.marketTab | Skill 市场 | Skill Market |
| skills.importZip | 导入 zip | Import zip |
| skills.uploadRemote | 上传到远端 | Upload to remote |
| skills.emptyLocalTitle | 暂无本地 Skill | No local skills |
| skills.emptyLocalDesc | 前往 Skill 市场下载 Skills 到本地使用 | Go to the Skill Market to download skills for local use |
| skills.deleteTitle | 删除 Skill | Delete Skill |
| skills.deleteConfirmPre | 确认删除 (后空格) | Delete (后空格) |
| skills.deleteConfirmPost | ？ | ? |
| skills.deleteConfirmNote | 将同时删除对应目录，此操作不可撤销。 | Its directory will also be removed. This cannot be undone. |
| skills.searchPlaceholder | 搜索 Skill 名称、描述或分类… | Search skills by name, description or category… |
| skills.fetchFailed | 获取失败 | Failed to load |
| skills.fetchFailedDesc | 无法连接到 Skill 服务器，请检查网络连接 | Cannot reach the Skill server — please check your network |
| skills.emptyRemoteTitle | 远端暂无可用 Skill | No skills available remotely |
| skills.emptyRemoteDesc | 稍后再来查看 | Check back later |
| skills.noMatchTitle | 未找到匹配的 Skill | No matching skills |
| skills.noMatchDesc | 没有与 "{q}" 相关的结果 | No results related to "{q}" |
| skills.noDescription | 暂无描述 | No description |
| skills.installed | 已安装 | Installed |
| skills.install | 安装 | Install |

**LLM settings page**(`i18n.tsx:216-239` / `433-456`)

| key | 中文 | English |
|---|---|---|
| llm.title | LLM 配置 | LLM Providers |
| llm.addProvider | 添加大模型 | Add Provider |
| llm.emptyTitle | 尚未配置任何大模型 | No providers configured yet |
| llm.emptyDesc | 添加大模型后即可在对话中使用 | Add a provider to use it in conversations |
| llm.deleteTitle | 删除大模型 | Delete Provider |
| llm.deleteConfirmPre | 确认删除 (后空格) | Delete (后空格) |
| llm.deleteConfirmPost | ？ | ? |
| llm.deleteConfirmNote | 关联的模型配置将一并删除，此操作不可撤销。 | Its model configuration will be removed too. This cannot be undone. |
| llm.openaiCompat | OpenAI 兼容 | OpenAI-compatible |
| llm.models | 模型 | Models |
| llm.testConnection | 测试连通性 | Test connectivity |
| llm.modelNamePlaceholder | 输入模型名称，验证后添加 | Enter a model name, then verify to add |
| llm.verifyAndAdd | 验证并添加 | Verify & add |
| llm.fetchModelsList | 从接口获取可用模型列表 | Fetch available models from the API |
| llm.availableModels | 可用模型 | Available models |
| llm.name | 名称 | Name |
| llm.namePlaceholder | 供应商名称，如：OpenAI | Provider name, e.g. OpenAI |
| llm.type | 类型 | Type |
| llm.authEndpoint | 认证与端点 | Authentication & Endpoint |
| llm.baseUrlOptional | Base URL（可选） | Base URL (optional) |
| llm.defaultHint | 点击 ★ 设为默认；首个模型自动设为默认。 | Click ★ to set default; the first model is the default. |
| llm.saveProvider | 保存大模型 | Save Provider |
| llm.connectFailed | 连接失败 | Connection failed |
| llm.fetchFailed | 获取失败 | Failed to load |

---

### 1.11 小结(本章关键约定)

- **设计令牌**集中在 `index.css` 的 `:root`,以 CSS 变量供全项目复用;颜色基色为蓝 `#2563eb`,文字三级灰蓝 `#0f1f3d`/`#3d5a80`/`#8aa3bf`,背景四级 `#f0f4fa`/`#ffffff`/`#f5f8fe`/`#eaf0fb`;圆角 8/12/16px;统一过渡 `.15s ease`。
- **布局**为三栏:左侧栏 `w-60`(240px)+ 中间卡片(flex-1)+ 右侧工作区 `w-72`(288px),卡片白底圆角 12px、`1px solid --border`,间隔 4/8px;顶栏 36px 可拖动、右留 150px 给原生控件。
- **"路由"**靠 `centerView`('chat'|'skills'|'llm')状态切换,无路由库;鉴权三态门 `AuthGate`(undefined/null/user)。
- **原子组件**:Button(4 variant × 3 size,带 loading/disabled)、Input/Select、StatusBadge(9 状态色,含 pulse 动画)。
- **i18n**:自实现 Context + `t()`,zh/en 双词典,缺键回退 zh→key,`{var}` 插值;初始语言按 localStorage→系统语言→英文兜底。


---

## 2. 对话区(ChatPanel)与会话事件流(SSE)

> 范围:`frontend-desktop/src/components/ChatPanel.tsx`(1048 行,本章重点)、`LLMErrorModal.tsx`、`ReportSessionButton.tsx`、`hooks/useSessionSSE.ts`、`lib/activity.ts`、`lib/taskSummary.ts`、`lib/llmError.ts`、`api/sessions.ts`、`api/client.ts`。所有标注均为 `文件:行号`。
>
> 配色全部来自 `src/index.css:4-28` 的 CSS 变量(见下表),文档中凡写 `var(--xx)` 均可在此查到 hex/rgba。

### 2.0 设计令牌(CSS 变量,`index.css:5-28`)

| 变量 | 值 | 变量 | 值 |
|---|---|---|---|
| `--bg0` | `#f0f4fa` | `--t1` | `#0f1f3d` |
| `--bg1` | `#ffffff` | `--t2` | `#3d5a80` |
| `--bg2` | `#f5f8fe` | `--t3` | `#8aa3bf` |
| `--bg3` | `#eaf0fb` | `--blue` | `#2563eb` |
| `--border` | `#dde6f3` | `--blue-dim` | `rgba(37,99,235,.09)` |
| `--border2` | `#c6d5eb` | `--blue-glow` | `rgba(37,99,235,.2)` |
| `--teal` | `#0891b2` | `--amber` | `#d97706` |
| `--red` | `#dc2626` | `--green` | `#16a34a` |
| `--shadow` | `0 1px 4px rgba(15,31,61,.07)` | `--shadow2` | `0 4px 16px rgba(15,31,61,.1)` |
| `--r` | `8px` | `--r2` | `12px` |
| `--tr` | `.15s ease` | `--font-ui` | `system-ui, -apple-system, sans-serif` |

动画关键帧(`index.css:64-72`):
- `@keyframes msg-fade-up`:`from{opacity:0; transform:translateY(4px)}` → `to{opacity:1; transform:none}`。所有消息/工具块进场用 `msg-fade-up .2s ease both`。
- `@keyframes t-bounce`(`index.css:69-72`):`0/80/100%{scale(.7) opacity .4}`、`40%{scale(1.1) opacity 1}`。定义但本章组件未直接引用(为"thinking dots"预留,代码中该行已注释掉,`ChatPanel.tsx:688`)。
- `pulse`:流式光标用 `animation:'pulse 1s infinite'`(`ChatPanel.tsx:680`),`pulse` 关键帧由 Tailwind 注入(opacity 1↔.5,(需确认实际定义,index.css 未声明,应为 Tailwind 内置 `pulse`))。
- 复制按钮可见性(`index.css:74-76`):`.msg-row .copy-btn { opacity:0; transition:opacity var(--tr) }`,`.msg-row:hover .copy-btn { opacity:1 }` —— 复制按钮平时隐藏,鼠标悬停所在消息行才浮现。
- prose 修正(`index.css:78-98`):`.prose code::before/::after{content:'' !important}`(去掉 typography 插件给行内代码加的反引号);`.msg-md pre / .md-doc pre` 强制 `background:#f6f8fa !important; color:var(--t1)`,`pre code` 强制透明背景 + `--t1` 字色(覆盖 typography 默认深色代码块)。

---

### 2.1 网络层

#### 2.1.1 `api/client.ts` —— HTTP 封装

- 常量 `BASE = '/api/v1'`(`client.ts:1`)。所有请求走 `fetch(`${BASE}${path}`)`,由 Vite 代理转发到后端 `:15926`。
- `request<T>(method, path, body?)`(`client.ts:3-15`):
  - 仅当 `body !== undefined` 时设 `Content-Type: application/json` 并 `JSON.stringify`(`client.ts:6-7`)。
  - `!res.ok` 时:尝试 `res.json()`,失败回退 `{message: res.statusText}`;抛 `new Error(err.detail?.message ?? err.message ?? res.statusText)`(`client.ts:9-12`)。即后端 FastAPI 风格 `detail.message` 优先。
  - `204` → 返回 `undefined as T`(`client.ts:13`);否则 `res.json()`。
- `upload<T>(path, file, fieldName='file')`(`client.ts:17-26`):`FormData` POST,同样的错误处理。本章未直接使用。
- 导出 `http`:`get/post/put/delete/upload`(`client.ts:28-34`)。`delete` 也支持可选 body。

#### 2.1.2 `api/sessions.ts` —— 会话 API

类型(`sessions.ts:4-6`):`TextPart={type:'text';text}`、`ImagePart={type:'image';data;media_type;source_type:'base64'|'url'}`、`MessageContent = string | (TextPart|ImagePart)[]`。

`sessionsApi` 方法清单(`sessions.ts:8-34`):

| 方法 | HTTP+路径 | 返回 | 备注 |
|---|---|---|---|
| `list()` | `GET /sessions` | `Session[]` | |
| `get(id)` | `GET /sessions/{id}` | `Session` | |
| `create(data)` | `POST /sessions` | `Session` | body=`CreateSessionRequest` |
| `interrupt(id)` | `POST /sessions/{id}/interrupt` | `Session` | 中断运行 |
| `resume(id)` | `POST /sessions/{id}/resume` | `Session` | INTERRUPTED 会话事件重放续跑;不接受新文本(`sessions.ts:13`) |
| `delete(id)` | `DELETE /sessions/{id}` | `void` | |
| `sendMessage(id, content, llmProvider?, llmModel?)` | `POST /sessions/{id}/messages` | `Session` | body=`{content, llm_account: llmProvider??null, llm_model: llmModel??null}`(`sessions.ts:22-26`) |
| `answerInput(id, content)` | `POST /sessions/{id}/messages` | `Session` | **没有 `/input` 端点**;HITL 文本应答复用 `/messages` 的 PAUSED_HITL 分支(`sessions.ts:27-29`),body=`{content}` |
| `getBashReviewMode(id)` | `GET /sessions/{id}/bash-review-mode` | `{mode:'auto'|'manual'}` | |
| `setBashReviewMode(id, mode)` | `PUT /sessions/{id}/bash-review-mode` | `{mode}` | body=`{mode}` |

`Session` 类型(`types/index.ts:14-31`):`id, user_prompt, goal, status, template_id, root_agent_id, token_budget, input_tokens_used, output_tokens_used, context_tokens, failure_counter, llm_account, llm_model, workspace, created_at, updated_at`。`SessionStatus`(`types/index.ts:1-3`):`QUEUED | RUNNING | WAITING_INPUT | SUCCEEDED | FAILED | CANCELED | INTERRUPTED | PAUSED_HITL | PAUSED`。`TERMINAL_STATUSES = ['SUCCEEDED','FAILED','CANCELED','INTERRUPTED']`(`types/index.ts:5`)。

---

### 2.2 SSE 事件流 Hook —— `useSessionSSE.ts`

#### 2.2.1 前端 ChatItem 数据模型(`useSessionSSE.ts:9-69`)

桌面端只有 4 类持久 item(注释明确:无 control/daemon/task item,`useSessionSSE.ts:9`):

- `ChatImageData`(11-15):`{media_type, source_type:'base64'|'url', data}`。
- `ChatMessage`(17-25):`{id, kind:'message', role:'user'|'assistant', content, reasoning?, images?, created_at}`。
- `ChatToolCall`(27-35):`{id, kind:'tool_call', tool_name, arguments:Record, result:string, is_error:boolean, created_at}`。
- `AskOption`/`AskQuestion`(37-38):`AskOption={label, description?, recommended?}`、`AskQuestion={question, options?, multi_select?}`。
- `ChatWaitingInput`(40-51):`{id, kind:'waiting_input', prompt, input_type, hitl_kind:'approval'|'input', task_title, command?, arguments?, questions?, created_at}`。注释:`hitl_kind='approval'→Approve/Reject 按钮;'input'→文本框`(45);`arguments`= approval 门控时被调用工具的参数(48);`questions`= ask_user 结构化批量问题(49)。
- `ChatObserverMessage`(53-60):`{id, kind:'observer_message', round_label, content, reasoning?, created_at}`。
- `ChatTaskSummary`(62-67):`{id, kind:'task_summary', summary, created_at}`。
- 联合类型 `ChatItem`(69)= 上述 message | tool_call | waiting_input | observer_message | task_summary。

#### 2.2.2 Hook 状态 `SSEState`(`useSessionSSE.ts:71-90`)

| 字段 | 含义 |
|---|---|
| `session: Session\|null` | 会话快照 |
| `items: ChatItem[]` | 已落定的对话项 |
| `waitingInput: ChatWaitingInput\|null` | 当前等待人工输入项 |
| `streamingText: string\|null` | 流式正文累积 |
| `streamingReasoning: string\|null` | 流式推理累积 |
| `streamingImages: ChatImageData[]` | 流式图片累积 |
| `observerStreamingText: string\|null` | observer 流式正文 |
| `currentActivity: ActivityState\|null` | 状态条(见 2.4) |
| `connected: boolean` | EventSource 是否连通 |
| `error: string\|null` | 连接错误文案 |
| `llmError: {message}\|null` | **终态** LLM 调用错误 → 弹窗(82-83) |
| `llmRetrying: boolean` | LLM 自愈重试中 → 内联提示(84-85) |
| `llmRetryProgress: {attempt,maxAttempts}\|null` | 退避进度(86-87) |
| `interruptReason: string\|null` | INTERRUPTED 成因(如 `llm_outage`)(88-89) |

`SSEHandle extends SSEState`(92-97)额外暴露 `reconnect()`(强制重订阅)与 `clearLlmError()`(关弹窗)。`EMPTY` 初始常量见 99-104。

`uid()`(106-107):`sse-${Date.now()}-${counter++}`,给运行期新增 item 生成 id;**历史回放(history)用稳定 key `h0/h1/…`** 而非 uid(见下)。

#### 2.2.3 连接生命周期(`useSessionSSE.ts:111-382`)

State/Refs:`state`(112)、`esRef`(EventSource,113)、`sessionIdRef`(114)、`lastEventTimeRef`(最近收到任意事件的时刻,含 ping,看门狗用,116)、`epoch`(重连代,118)。

回调:
- `close()`(120-123):`esRef.current?.close()` 并置 null。
- `reconnect()`(125):`setEpoch(e=>e+1)` —— bump epoch 触发主 effect 重订阅。
- `clearLlmError()`(127):若有 `llmError` 则清空(引用相等时不变,避免重渲染)。

主 effect(依赖 `[sessionId, epoch, close]`,129-382):
1. `sessionId` 为空 → `close()` + `setState(EMPTY)` + return(130-134)。
2. `close()` 旧连接;判断 `isNewSession = sessionIdRef.current !== sessionId`(137);更新 ref;**仅换会话时 `setState(EMPTY)`**;同会话 epoch 重连保留已渲染内容,靠稳定 key 原地协调,避免空屏闪烁(139-140)。
3. `new EventSource(`/api/v1/sessions/${sessionId}/stream`)`(142)。**这是聊天 SSE 的唯一端点。**
4. `es.onopen`(146):刷新 `lastEventTimeRef`,`connected:true, error:null`。
5. `es.onerror`(147):`connected:false, error:'连接断开，正在重连…'`。
6. `es.onmessage`(149-152):刷新 `lastEventTimeRef`,`JSON.parse(event.data)` 后交 `handle()`,解析失败静默忽略。
7. 清理函数 `return () => close()`(381)。

`parseContent(raw)`(154-164):数组型 content → 拆 `image` part(映射成 `ChatImageData`,默认 source_type=base64)与 `text` part(`\n` 拼接);非数组 → `{text:String(raw??'')}`。

#### 2.2.4 SSE 事件类型清单与翻译/渲染(`handle()`,166-351)

读取 `type = data.type`(167)。**完整事件处理表**:

| `type` | 处理 | 行 |
|---|---|---|
| `ping` | 直接 return(只用于刷新 `lastEventTimeRef` 保活) | 168 |
| `history` | 批量回放:遍历 `data.events`,逐条喂 `reduceActivity` 累积 activity;`reasoning_done`→暂存 `actorReasoning`、`observer_reasoning_done`→暂存 `observerReasoning`(随后并入对应消息);其余经 `evtToItem` 转 item。**关键:item.id 被改写为稳定 `h${index}`(184)** 使重连重发 history 时 React 原地复用、不重挂载、不重播动画。`text_done`/`observer_text_done` 后清空对应 reasoning 暂存。最后 `setState({items, currentActivity})` | 170-190 |
| (任意非 history 事件) | 先把 `data` 喂 `reduceActivity` 更新 `currentActivity`,无变化(引用相等)则不 setState | 192-196 |
| `init` | 取 `data.session` + `data.messages`。**若 `items` 非空**(重连)→ 仅刷新 session 并清掉所有流式/waiting 态、置 connected;否则把 messages 映射成 message items(用 `parseContent`)并 `{...EMPTY, session, items, connected:true}` | 198-212 |
| `token_update` | 把 `input_tokens_used / output_tokens_used / context_tokens` 合并进 `session`(缺字段则保留旧值) | 214-217 |
| `session_update` | 读 `data.status` 等;构造 updated session(条件并入 `llm_account/llm_model`)。**status==='RUNNING' 时清空 `waitingInput/streamingText/streamingReasoning/observerStreamingText`**;`interruptReason = data.interrupt_reason ?? null`;离开 RUNNING 时熄灭 `llmRetrying/llmRetryProgress` | 219-244 |
| `message` | `parseContent(data.content)` → push 一条 message item(uid) | 246-250 |
| `tool_call` | push `ChatToolCall`(tool_name/arguments/result/is_error/created_at) | 252-255 |
| `control_tool_call` | 经 `taskSummaryFromEvent`(见 2.5)判定;命中根任务 `finish_task` → push `task_summary` item;否则丢弃 | 257-263 |
| `waiting_input` / `bash_exec_confirm` | 计算 `hitl_kind`:`bash_exec_confirm` 或 `data.kind==='approval'` → `'approval'`,否则 `'input'`。构造 `ChatWaitingInput`(input_type:bash 时固定 `'bash_exec_confirm'`,否则 `data.input_type||'user_input'`;command 仅 bash;arguments/questions 透传),`setState({waitingInput:item})` | 265-270 |
| `llm_retry` | `llmRetrying:true`;`maxAttempts>0` 时 `llmRetryProgress={attempt,maxAttempts}` 否则 null | 272-278 |
| `task_failed` | 经 `classifyLlmFailure`(见 2.6):命中则 `llmError=c.error??旧值`、`llmRetrying=c.retrying` | 280-284 |
| `llm_request_started` | 若正在重试 → 熄灭 `llmRetrying/llmRetryProgress`(上次失败提示落幕) | 287-290 |
| `text_delta` | `streamingText += delta`,且 `llmRetrying:false, llmRetryProgress:null`(开始出字即视为恢复) | 292-296 |
| `reasoning_delta` | `streamingReasoning += delta` | 298-302 |
| `image` | push 进 `streamingImages` | 304-308 |
| `text_done` | 若无 text 且无流式图/无流式推理 → 仅清流式;否则把累积(text + reasoning + images)落成一条 assistant message item,清空三个流式态 | 310-318 |
| `reasoning_done` | 有文本则覆盖 `streamingReasoning`(整段) | 320-324 |
| `observer_text_delta` | `observerStreamingText += delta` | 326-330 |
| `observer_text_done` | 有 text → push `observer_message` item(round_label),清 `observerStreamingText`;无 text 仅清 | 332-341 |
| `done` | **终态**:`close()` 主动关闭 EventSource(阻止浏览器对已结束会话每 3s 自动重连导致反复重发 init/history 而闪动);清所有流式/waiting/retry 态;`session.status = data.final_status ?? 旧值` | 343-348 |
| `daemon_*`、`task_*`、`llm_prompt` | **静默忽略**(注释 350) | — |

> ⚠️ **actor / observer 推理(reasoning)处理不对称(重构须知)**:**实时(live)增量链路**只处理 actor 的 `reasoning_delta`(298)与 `reasoning_done`(320)——**没有** `observer_reasoning_delta` / `observer_reasoning_done` 分支,即观察者(Observer)的思维链在实时流中不会被采集渲染。只有**历史回放(`history`)链路**对称处理两者:`reasoning_done`→暂存 `actorReasoning`、`observer_reasoning_done`→暂存 `observerReasoning`(179-180),分别并入 actor message 与 observer_message(362/370)。因此"观察者推理"目前只在刷新/重连回放后可见,实时进行中不显示。重构 SSE hook 时务必保留这一不对称,**不要想当然地"补齐"或"删除"** observer reasoning 分支,否则会改变可见行为。

`evtToItem(evt, actorReasoning?, observerReasoning?)`(353-379):history 专用映射。支持 `message`、`text_done`(空文本→null)、`tool_call`、`observer_text_done`(空→null)、`control_tool_call`(经 taskSummary)。`daemon_*/task_*/llm_prompt` → 跳过返回 null(377)。

#### 2.2.5 僵尸连接看门狗(`useSessionSSE.ts:387-396`)

独立 effect(依赖 `[sessionId, reconnect]`):每 **2000ms** 检查一次;若 `esRef.current.readyState === EventSource.OPEN`(回退常量 1)且 `Date.now() - lastEventTimeRef > 5000ms`(> 5s 无任何事件,含 ping)→ 判定连接已死,调 `reconnect()`(bump epoch 重订阅,凭 Last-Event-ID 拉回错过的事件,如服务重启后的 INTERRUPTED 状态)。注释说明后端每 3s 发 ping(385)。

Hook 返回 `{...state, reconnect, clearLlmError}`(398)。

---

### 2.3 ChatPanel 组件主体(`ChatPanel.tsx`)

#### 2.3.1 props / state / hooks / Query keys

Props(`ChatPanel.tsx:80-93`):`sessionId:string|null`、`sse:SSEHandle`、`pendingSession:PendingSession|null`、`onSessionCreated(id)`、`nextProvider`、`nextModel`、`onNextLLMChange(provider,model)`、`canShowWorkspace?`、`workspaceOpen?`、`onToggleWorkspace?`。

本地 state/refs(94-102):`input`(文本)、`images:{data,media_type}[]`、`bottomRef`(滚到底锚点)、`listRef`(滚动容器)、`autoScroll`(是否贴底)、`textareaRef`。

派生(104-107):`session=sse.session`;`isRunning = status==='RUNNING'||'QUEUED'`;`isWaiting = status==='WAITING_INPUT'||'PAUSED_HITL'`;`isInterrupted = status==='INTERRUPTED'`。

React Query:
- `['llms']`(102)→ `llmsApi.list`,`providers` + `providersLoaded`。
- `['bash-review-mode', sessionId]`(172-176)→ `sessionsApi.getBashReviewMode`,`enabled:!!sessionId`。`bashMode = data?.mode ?? 'auto'`(181)。

Mutations:
- `createMut`(138-155):mutationFn 形参类型为 `{ text: string; imgs: typeof images }`,但**只解构使用了 `text`**(140),`imgs` 被忽略;`sessionsApi.create({user_prompt:text, llm_account:pendingSession?.provider||null, llm_model:pendingSession?.model||null, workspace:pendingSession?.workingDir||null})`——`create` 请求体**不含图片字段**。onSuccess:`invalidate(['sessions'])`、清 input/images、`onSessionCreated(session.id)`。
  - ⚠️ **源码 BUG(重构须知)**:在 pending 模式下,用户在**首条消息**前粘贴的图片(`images`)会随 `createMut.mutate({text, imgs:images})` 传入,但 mutationFn 丢弃 `imgs`,且 `POST /sessions` 不带图片——**首条消息的图片实际被静默丢弃**。只有会话创建后通过 `sendMut`/`answerMut` 发送的后续消息才真正带图。重构时需明确:是照搬此行为,还是顺手修复(让首条消息也能带图)。
- `sendMut`(157-161):`sessionsApi.sendMessage(sessionId!, content, nextProvider||null, nextModel||null)`。onSuccess:`invalidate(['sessions'])`、清 input/images、**`sse.reconnect()`**(向已结束会话发消息会使其恢复运行,终态时事件流已关,需重订阅)。
- `answerMut`(162-165):`sessionsApi.answerInput(sessionId!, text)`。onSuccess:`invalidate(['sessions'])`、清 input。
- `interruptMut`(166):`sessionsApi.interrupt(sessionId!)`。
- `resumeMut`(167-170):`sessionsApi.resume(sessionId!)`。onSuccess:`invalidate(['sessions'])`、`sse.clearLlmError()`、`sse.reconnect()`。
- `bashModeMut`(177-180):`sessionsApi.setBashReviewMode(sessionId!, mode)`。onSuccess:`qc.setQueryData(['bash-review-mode', sessionId], d)`(乐观写缓存)。

副作用 effects:
- 109-116:session 的 `llm_account` 若在可见 providers 列表中,则 `onNextLLMChange(account, model)`(env 默认账号对用户隐藏时回落默认模型)。依赖 `[session?.id, providers]`。
- 118-125:`providersLoaded && nextProvider && 该 provider 不在列表` → `onNextLLMChange('','')`(选中的账号被删/隐藏 → 回落默认模型)。
- 127-129:`autoScroll` 为真时 `bottomRef.scrollIntoView({behavior:'smooth'})`,依赖 `[sse.items, sse.streamingText, sse.observerStreamingText, autoScroll]`。
- `handleScroll`(131-135):距底 `scrollHeight - scrollTop - clientHeight < 80px` 时 `autoScroll=true`,否则 false(用户上滚则停止自动贴底)。

#### 2.3.2 发送逻辑

`send()`(183-207):
1. `text=input.trim()`;若 text 空且无 images → 返回(184-185)。
2. **pending 模式**:`createMut.mutate({text, imgs:images})` 并返回(188-190)。⚠️ 注意 `imgs` 虽被传入,但 `createMut` 内部丢弃它(见 §2.3.1 `createMut` 的 BUG 说明)——**首条消息粘贴的图片不会上传**。
3. 无 sessionId → 返回(193)。
4. **`isWaiting && sse.waitingInput`** → `answerMut.mutate(text)` 返回(195-198)。
5. 否则构造 `content`:有图 → 数组(image parts + 可选 text part);无图 → 纯字符串(200-205);`sendMut.mutate(content)`。

`onKeyDown`(209-214):`Enter` 且非 `Shift` → `preventDefault()` + `send()`(Shift+Enter 换行)。

`pasteImage`(216-230):遍历剪贴板 items,`type` 以 `image/` 开头者 `getAsFile()` → `FileReader.readAsDataURL` → 取 base64(`split(',')[1]`)push 进 `images`。

#### 2.3.3 三种顶层渲染分支

**A. Pending 模式**(`pendingSession` 非空,234-324):
- 容器 `bg:var(--bg1)`,`flex h-full flex-col`。
- Header(242-248):`FolderIcon size=14 text-yellow-500`;主行 `dirName`(从 `workingDir` 末段取,235)字号 `text-sm font-medium` 色 `--t1`;副行完整路径 `text-xs` 色 `--t3`。
- 空区(251-254):居中 emoji 💬(`fontSize:32, opacity:.35`)+ `t('chat.startAgentHint')`(`text-sm`,色 `--t3`)。
- 输入框(257-321):见 2.3.6;`isCreating=createMut.isPending`,`canSend = !isCreating && (input.trim()||images.length)`。错误时(318-320)显示红字 `fontSize:11 color:var(--red)`。

**B. 未选会话**(`!sessionId`,328-336):整屏居中,`bg:var(--bg0)`;💬(`fontSize:36, opacity:.35`);标题 `t('chat.startConversation')`(`fontSize:16 fontWeight:700 color:var(--t2)`);副 `t('chat.selectOrCreate')`(`text-sm`)。

**C. 正常会话**(343-560):见下各小节。`canSend = !isRunning && (input.trim()||images.length)`(340);`waitingItem = sse.waitingInput`(341)。

#### 2.3.4 正常会话 Header(`ChatPanel.tsx:346-383`)

仅 `session` 存在时渲染。`flex items-center justify-between px-4 py-2`。
- 左:标题 `session.goal || session.user_prompt || id.slice(0,8)`,`truncate text-sm font-medium` 色 `--t1`(349-351)。
- 右(353-381,`gap-1`):
  1. **工作模式选择器**(354-370):label `t('chat.workModeLabel')`(text-xs 色 `--t3`)+ `<select value={bashMode}>`,onChange→`bashModeMut.mutate(value)`,`disabled=bashModeMut.isPending`。样式:`fontSize:12 color:var(--t2) bg:var(--bg1) border:1px var(--border) radius:6 padding:2px 6px`。选项:`auto`=`t('chat.workModeAuto')`("风险审核"/"Risk-based review")、`manual`=`t('chat.workModeManual')`("逐条审核"/"Per-command review")。**点击行为**:`PUT /sessions/{id}/bash-review-mode {mode}`,成功写入 `['bash-review-mode', sessionId]` 缓存,影响后续 bash 工具是否走 HITL 门控。
  2. **ReportSessionButton**(371,见 2.7)。
  3. **工作区开关 HeaderIconBtn**(372-380):仅 `canShowWorkspace && onToggleWorkspace` 时显示;`title` 随 `workspaceOpen` 在隐藏/打开间切换;图标 `PanelRightCloseIcon`(开)/`PanelRightIcon`(关),size=15;点击 `onToggleWorkspace()`。

`HeaderIconBtn`(566-585):`h-7 w-7 rounded-md`。active 态 `bg:var(--blue-dim) color:var(--blue)`;非 active `bg:none color:var(--t3)`,hover→`bg:var(--bg3) color:var(--t2)`(只在非 active 时切换)。

#### 2.3.5 消息列表容器(`ChatPanel.tsx:386-421`)

`listRef` + `onScroll=handleScroll`,`flex-1 overflow-y-auto`,`paddingTop:12 paddingBottom:8`。
- 连接中占位(387-389):`!sse.connected && !sse.session` → 居中 `<Spinner>`(`py-4`)。
- `sse.items.map(item => <ChatItemView key={item.id} item={item}/>)`(391)。
- **流式 AI 气泡**(394-396):`streamingText!==null || streamingImages.length || streamingReasoning!==null` → `<AssistantBubble streaming>`。
- **observer 流式**(399-403):`observerStreamingText!==null` → 一行斜体小字,`padding:'4px 16px 4px 58px'`(58px 左缩进对齐 AI 头像),`fontSize:11 color:var(--t3) fontStyle:italic`。
- **等待输入面板**(406-418):`waitingItem` 存在 → `WaitingInputPanel`,`padding:'4px 16px'`,回调:`onSubmit=send`、`onAnswer=t=>answerMut.mutate(t)`、`onApprove=()=>answerMut.mutate('approved')`、`onReject=()=>answerMut.mutate('rejected')`。
- `bottomRef` 锚(420)。

`ChatItemView`(589-595)分发:`message→MessageRow`、`tool_call→ToolCallRow`、`observer_message→ObserverRow`、`task_summary→TaskSummaryRow`,其余 null。

#### 2.3.6 输入框组件(pending 与正常共用结构,257-321 / 471-549)

外层卡片:`bg:var(--bg1) border:1px var(--border) radius:var(--r2)(12px) boxShadow:var(--shadow)`,`transition:border-color .15s, box-shadow .15s`。**focus**(`onFocusCapture`):`borderColor=var(--blue)`、`boxShadow='0 0 0 3px var(--blue-dim)'`;**blur** 恢复(263-264 / 478-479)。

- **图片预览条**(266-275 / 481-490):`flex flex-wrap gap:8 padding:'10px 11px 0'`;每图 56×56 `radius:6 objectFit:cover`;右上角删除按钮 `×`:16×16 圆形 `bg:#94a3b8 color:#fff fontSize:10`,点击从 `images` 移除该项。
- **textarea**(276-293 / 491-507):自动增高(`onChange` 重设 `height=min(scrollHeight,160)`);`onKeyDown`、`onPaste=pasteImage`;pending 模式 `autoFocus`。`disabled` 绑 `isCreating`/`isRunning`。样式:`padding:'11px 13px 4px' bg:transparent border:none outline:none color:var(--t1) font:var(--font-ui) fontSize:13.5 lineHeight:1.6 maxHeight:160 resize:none`,`opacity` 禁用时 0.4(pending)/0.5(正常)。placeholder:pending=`t('chat.firstInputPlaceholder')`;正常 running 时 `t('chat.waitingResponse')` 否则 `t('chat.inputPlaceholder')`。
- **底栏**(294-316 / 508-546):`flex items-center gap:7 padding:'0 9px 8px'`;`<span flex:1>` 占位推右;`ModelPickerButton`(providers/selected/onChange/disabled);**发送/中断按钮**:
  - 发送按钮(303-315 / 532-545):32×32 圆形;`canSend` 时 `bg:var(--blue) color:#fff cursor:pointer`,否则 `bg:var(--bg3) color:var(--t3) cursor:not-allowed`;`transition:background var(--tr)`;内容:pending `isCreating`→`<Spinner h-3 w-3>` 否则 `<ArrowUp size=14 strokeWidth=2.5>`;正常 `sendMut.isPending`→Spinner 否则 ArrowUp。
  - **中断按钮**(正常模式 `isRunning` 时取代发送,517-530):32×32 圆形 `bg:#ef4444 color:#fff`,hover→`#dc2626`,leave→`#ef4444`;图标 `<Square size=13>`;点击 `interruptMut.mutate()` → `POST /sessions/{id}/interrupt`。

#### 2.3.7 LLM 重试内联提示(`ChatPanel.tsx:424-438)

`sse.llmRetrying` 真时显示(无按钮,纯信息;终态失败走弹窗)。条:`flex gap:8 padding:'8px 12px' radius:var(--r) border:1px rgba(220,38,38,.25) bg:rgba(254,242,242,.7)`;`<Spinner h-3 w-3>` + 文案 `fontSize:12.5 color:#b91c1c`:有 `llmRetryProgress` → `t('llmError.retryingN',{attempt,max})`("正在重试(第 N/M 次)"),否则 `t('llmError.retrying')`。

#### 2.3.8 状态条 ActivityStrip(挂载,`ChatPanel.tsx:441-445`)

`!waitingItem && !isInterrupted` 时,`padding:'0 18px'` 包裹 `<ActivityStrip activity={sse.currentActivity}/>`(组件见 2.4)。

#### 2.3.9 INTERRUPTED 续跑条(`ChatPanel.tsx:449-468)

`!waitingItem && isInterrupted` 时**取代输入框**(中断态不接受新文本,只续跑)。`isLlmOutage = sse.interruptReason==='llm_outage'`。
- 容器 `padding:'10px 14px 14px'`;内条 `flex gap:10 padding:'10px 12px' radius:var(--r)`。
- 配色二分:LLM 故障 → `border:1px rgba(220,38,38,.3) bg:rgba(254,242,242,.7)`,文案色 `#b91c1c`,文 `t('llmError.interrupted')`;通用中断(重启等)→ `border:1px rgba(138,163,191,.3) bg:rgba(234,240,251,.5)`,文案色 `var(--t2)`,文 `t('chat.interruptedHint')`。
- 右侧 `<Button size="sm">`:`resumeMut.isPending`→Spinner 否则 `t('chat.resume')`("恢复运行");点击 `resumeMut.mutate()` → `POST /sessions/{id}/resume`,成功后 invalidate sessions + `clearLlmError()` + `reconnect()`。

#### 2.3.10 LLM 错误弹窗挂载(`ChatPanel.tsx:552-559)

`sse.llmError` 真 → `<LLMErrorModal message={llmError.message} onClose={sse.clearLlmError}/>`(详见 2.8;上游已去掉 `resuming`/`onResume`,弹窗只剩关闭)。

---

### 2.4 状态条逻辑 —— `lib/activity.ts` + `ActivityStrip`

#### 2.4.1 纯逻辑(`activity.ts`)

类型:`ActivityPhase = 'llm_pending'|'reasoning'|'generating'|'tool'|'tool_hidden'`(4);`VibePhase` 同上去掉 `tool`(5);`ActivityState={phase, tool_name?, source:'actor'|'observer', started_at:ISO}`(7-12)。

常量:`VIBE_ROTATE_MS=4000`(进入某 vibe 阶段后每 4s 轮换一词,24);`VIBE_POOL_SIZES`(28-33):四个 vibe 阶段各 4 词(i18n 键 `activity.vibe.<phase>.<idx>`,两语言须同条数否则下标越界)。

`obsSource(evt, prev)`(35-39):`evt.source` 为 observer/actor 则取之;`type` 以 `observer_` 前缀 → observer;否则继承 `prev?.source ?? 'actor'`。

`continuesLlmTurn(prev)`(45-47):prev 存在且 phase ∈ {llm_pending, reasoning, generating}。用于 reasoning/text delta 无自身 created_at 时是否续上一段计时(避免把工具时长错算进推理时长)。

`reduceActivity(prev, evt, nowIso=now)`(51-104)状态机:

| 事件 | 结果 phase | started_at |
|---|---|---|
| `llm_request_started` | `llm_pending` | `evt.created_at \|\| nowIso` |
| `reasoning_delta` / `observer_reasoning_delta` | `reasoning` | 续 turn 则沿用 prev,否则 created_at/now |
| `text_delta` / `observer_text_delta` | `generating` | 同上续接逻辑 |
| `tool_call_started` | `is_control`→`tool_hidden`,否则 `tool`(带 tool_name) | created_at/now |
| `tool_call`/`control_tool_call`/`observer_tool_call`/`observer_control_tool_call`/`text_done`/`observer_text_done` | `llm_pending`(回到等待,新计时段锚到该完成事件 created_at) | created_at/now |
| `done`/`interrupted`/`waiting_input`/`bash_exec_confirm` | **null**(清空状态条) | — |
| `session_update` | status 非空且非 RUNNING → null,否则保持 prev | — |
| 其他 | 保持 prev(引用不变) | — |

`formatDuration(ms)`(107-111):`<60s`→`Ns`;`≥60s`→`NmMs`。

`activityLabel(activity, elapsedMs)`(120-125):`tool` 阶段 → `{kind:'tool', tool:tool_name}`;否则 `{kind:'vibe', phase, index}`,`index = floor(elapsed/4000) % poolSize`。

#### 2.4.2 `ActivityStrip`(`ChatPanel.tsx:692-717)

`useState` tick + `setInterval(1000ms)` 每秒重渲染刷新时长(仅 activity 存在时,695-699)。`activity` 为 null → 返回 null。`elapsed = Date.now() - new Date(started_at)`。`lbl = activityLabel(...)`;文案:`tool`→`t('activity.tool',{tool})`("正在执行 {tool}"),vibe→`t(`activity.vibe.${phase}.${index}`)`(氛围词,如"组织思路中"/"抽丝剥茧中"/"奋笔疾书中"/"整理思绪中",见 i18n 96-110)。
样式:`flex gap:8 padding:'2px 4px 8px' fontSize:12 color:var(--t2)`,进场 `msg-fade-up .2s`;`<Spinner h-3 w-3>` + 文案 + `· {formatDuration}`(后者色 `--t3`)。

---

### 2.5 任务总结判定 —— `lib/taskSummary.ts`

`FinishTaskEvent={tool_name?, arguments?:{result?}, is_root?}`(5-9)。`isFinishTask(name)`(17-19):`'control__finish_task'` 或裸名 `'finish_task'`(SSE tool_name 为 `provider__name` 形式)。`taskSummaryFromEvent(evt)`(22-28):非 finish_task / 非根任务(`!is_root`)/ 总结文本空 → null;否则 `{summary: String(arguments.result).trim()}`。**只渲染根任务的 finish_task 总结**(根任务=编排者,其 finish_task 即整会话收尾),子任务一律不显示。命中后由 SSE 落成 `task_summary` item → `TaskSummaryRow` 渲染成普通 AI 气泡。

---

### 2.6 LLM 失败归类 —— `lib/llmError.ts`

`LlmFailureEvent={error_type?, error?, will_retry?}`(12-16)。`classifyLlmFailure(evt)`(23-27):
- `error_type !== 'LLMCallError'` → **null**(非 LLM 失败,调用方忽略)。
- `will_retry` 真 → `{error:null, retrying:true}`(只内联"正在重试",不弹窗)。
- 否则 → `{error:{message: evt.error||''}, retrying:false}`(终态 → 弹窗)。

`error_type` 是后端异常类名,LLM 调用失败时为 `'LLMCallError'`(认证失败/响应截断/传输重试耗尽)。

---

### 2.7 上报会话按钮 —— `ReportSessionButton.tsx`

Props:`{sessionId}`(6)。State:`open`(弹窗)、`note`(备注)、`busy`、`status:{ok,msg}|null`(9-11)。

**触发按钮**(34-43):`h-7 w-7 rounded-md`,`bg:none color:var(--t3)`,hover→`bg:var(--bg3) color:var(--t2)`;图标 `<UploadIcon size=15>`;title `t('chat.reportSession')`("上报此会话")。点击:`setStatus(null); setOpen(true)`。

按钮旁内联状态(44-46):`status && !open` 时显示 `status.msg`,`text-xs`,色 ok→`var(--teal,#0d9488)` / 失败→`var(--red,#dc2626)`。

**弹窗**(47-68):`fixed inset-0 z-50` 居中,遮罩 `bg:rgba(15,31,61,.35) backdropFilter:blur(4px)`;卡片 `w-96 p-4 bg:var(--bg1) border:1px var(--border) radius:12 boxShadow:'0 24px 80px rgba(15,31,61,.18)'`。
- 标题 `t('chat.reportSession')`(`text-sm font-medium` 色 `--t1`)。
- 同意说明 `t('chat.reportSessionConsent')`(`text-xs` 色 `--t2`):将上传全部对话(含工具调用)+ 运行日志,仅发内网管理服务。
- 备注 textarea(52-58):`value=note`,placeholder `t('chat.reportSessionNote')`,`bg:var(--bg2) border:1px var(--border) minHeight:60 resize:vertical text-sm`。
- 失败提示(59-61):`status && !status.ok` → 红字。
- 按钮(62-65):**取消** `Button variant="outline" size="sm"`,点击关弹窗+清 note,`disabled=busy`;**上报** `Button variant="default" size="sm"`,`disabled=busy`,文案 busy→`t('chat.reportSessionSending')` 否则 `t('chat.reportSessionSubmit')`。

`submit()`(13-30):`setBusy(true)`,调 **`window.electronAPI?.reportSession?.(sessionId, note)`**(走 Electron 主进程 IPC,非 HTTP)。`r.ok` → `status={ok:true, msg:t('chat.reportSessionDone')}`、关弹窗、清 note;否则 `status={ok:false, msg:r?.error||t('chat.reportSessionFail')}`;catch → `status={ok:false, msg:错误串}`;finally `setBusy(false)`。

---

### 2.8 LLM 错误弹窗 —— `LLMErrorModal.tsx`

> ⚠️ **上游变更(2026-06,已同步进 v2)**:此弹窗**改为"只关闭"**——去掉了「恢复运行」按钮、`resuming`/`onResume` props 与 `Spinner` 导入;定位从"检查 LLM 配置后恢复"改为"建议上报本次会话供开发者排查"。`llmError.body` 文案同步重写(见 §1.10 i18n)。

Props:`{message, onClose}`(只剩这两项)。Esc 关闭(window keydown 监听,Escape→onClose)。
- 遮罩:`fixed inset-0 z-50` 居中 `backdrop-blur-sm bg:rgba(15,31,61,.35)`;点遮罩自身(target===currentTarget)→onClose。
- 卡片:`rounded-xl width:min(440px,90vw) bg:var(--bg1) boxShadow:'0 24px 80px rgba(15,31,61,.22)'`。
- Header:`<AlertCircleIcon size=18 color:#dc2626>` + `t('llmError.title')`("LLM 调用出错",`text-sm font-semibold` 色 `--t1`),`px-5 pt-5 pb-1`。
- Body:`t('llmError.body')`(`text-[13px] leading-relaxed` 色 `--t2`):向模型发送时返回预料之外错误、多为模型服务侧问题、**建议上报会话**。
- 错误详情:标题 `t('llmError.detail')`(`text-[11px] font-medium` 色 `--t3`)+ 详情框:`text-[12px] font-mono whitespace-pre-wrap break-words maxHeight:160 overflow-auto rounded-md px-3 py-2 bg:var(--bg2) border:1px var(--border) color:var(--t2)`,内容 `message||'—'`。
- Actions:**仅一个「关闭」按钮** `Button size="sm"` → `onClose`(文 `t('common.close')`)。(已无「恢复运行」。)

---

### 2.9 消息与块渲染(`ChatPanel.tsx` 内部组件)

#### 2.9.1 气泡样式常量

`AV_AI` AI 头像(599-604):32×32 `radius:8 marginTop:2`,`fontSize:11 fontWeight:700`,`background:linear-gradient(135deg, var(--blue), var(--teal))` 白字,内容字符 `✦`。

`BUBBLE_USER`(861-866):`inline-block padding:'8px 12px' radius:12` 但 **`borderTopRightRadius:2`**(右上尖角),`fontSize:13.5 lineHeight:1.65 wordBreak:break-word`,`bg:var(--blue) color:#fff textAlign:left`。

`BUBBLE_AI`(868-873):`block padding:'8px 12px' radius:12` 但 **`borderTopLeftRadius:2`**(左上尖角),`fontSize:13.5 lineHeight:1.65`,`bg:#ffffff border:1px var(--border) color:var(--t1)`。

#### 2.9.2 MessageRow(608-657)

`isUser = role==='user'`。
- **用户**(612-631):`flex flex-col items-flex-end padding:'8px 16px'`,进场 `msg-fade-up .2s`。头部行(row-reverse):`t('chat.me')`("我",`fontSize:12 fontWeight:600 color:var(--t2)`)+ 时间 `fmtTime`(`fontSize:10.5 color:var(--t3)`)。气泡容器 `maxWidth:72%`,右对齐;`BUBBLE_USER` 内:图片(`ImageView`)+ `<p whiteSpace:pre-wrap margin:0>{content}`;下方 `<CopyButton alignEnd>`。
- **AI**(635-656):`flex items-flex-start gap:10 padding:'8px 16px'`,头像 `AV_AI`(✦)。容器 `maxWidth:72%`。头部:`IPMaster-Cowork AI`(`fontSize:12 fontWeight:600 color:var(--t2)`)+ 时间。`BUBBLE_AI` 内:图片 → `reasoning && <ReasoningBlock>` → `<div className="prose prose-sm max-w-none msg-md">` 包 `<Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>{content}</Markdown>`;下方 `<CopyButton>`。

`fmtTime(iso)`(22-25):`toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})`,异常返回 `''`。

#### 2.9.3 AssistantBubble(流式,661-686)

与 AI MessageRow 同布局,头部无时间。`BUBBLE_AI` 内:图片 → `reasoning && <ReasoningBlock defaultOpen={streaming}>`(流式时推理默认展开)→ markdown 正文 → **流式光标**(678-681):`streaming` 真时显示 `inline-block width:2 height:13 marginLeft:2 bg:var(--t3) animation:'pulse 1s infinite'`。

#### 2.9.4 ToolCallRow(721-788)

`open` 折叠态(默认收起,723)。`argsStr` = arguments 非空时 `JSON.stringify(...,2)` 否则 `''`(724)。
**中性失败处理**(注释 725-728):失败不用红/不用"错误"措辞。`statusColor = is_error ? var(--t3) : var(--green)`;`statusLabel = is_error ? t('chat.toolEnded')("已结束") : t('chat.toolDone')("✓ 完成")`(729-730)。
- 外卡 `padding:'3px 16px'`;`radius:10 overflow:hidden boxShadow:var(--shadow) border:1px var(--border) bg:var(--bg1)`(732-737)。
- **Header 按钮**(739-760):`flex w-full items-center gap:7 padding:'7px 11px' bg:var(--bg2) border:none`,hover→`bg:var(--bg3)`,leave→`bg:var(--bg2)`;点击 `setOpen(o=>!o)`。内容:⚙ 图标方块(751-756,20×20 `radius:4 bg:var(--blue-dim) color:var(--blue) fontSize:10`,**无论成败恒为蓝**)+ `<code>{tool_name}`(`flex:1 monospace fontSize:11.5 color:var(--t2) fontWeight:500`)+ 状态标签(`fontSize:10.5 color:statusColor`)+ 折叠箭头 `▲/▼`(`fontSize:9 color:var(--t3)`)。
- **Body**(762-784,`open` 时):`padding:'9px 11px' monospace fontSize:11 color:var(--t2) lineHeight:1.6 bg:var(--bg2) borderTop:1px var(--border)`,`flex flex-col gap:6`。`argsStr` → 标题 `t('chat.args')`("参数：",`fontSize:10 color:var(--t3)`)+ `<pre whiteSpace:pre-wrap wordBreak:break-all fontSize:11 color:var(--t2)>`。`result` → 标题 `t('chat.result')`("结果：")+ `<pre>`,**结果 >2000 字符则截断**为前 2000 + `\n` + `t('chat.resultTruncated')`("(结果已截断)")(779)。

#### 2.9.5 ObserverRow(792-811)

`open` 默认收起。外 `padding:'3px 16px'`;内 `borderLeft:2px solid #c084fc paddingLeft:10`(紫色左边线)。
- Header 按钮(797-801):`<Brain size=11>` + `Observer {round_label}` + 折叠箭头,`fontSize:11.5 color:#a855f7`(紫),`bg:none border:none`。
- Body(802-807,open):`marginTop:5 fontSize:12 lineHeight:1.6 color:var(--t2)`;`reasoning` 存在 → `<p>` 斜体 `color:var(--t3)`;正文 `<p>{content}`。

#### 2.9.6 TaskSummaryRow(816-837)

布局与 AI MessageRow 完全一致(头像 ✦ + "IPMaster-Cowork AI" + 时间),`BUBBLE_AI` 内仅渲染 `<Markdown>{summary}` + 下方 `<CopyButton text={summary}>`。即根任务收尾总结以普通 AI 气泡呈现。

#### 2.9.7 ReasoningBlock(841-852)

`open` 默认 `defaultOpen ?? false`(流式时由 AssistantBubble 传 true)。容器 `marginBottom:8 paddingLeft:8 borderLeft:2px solid var(--border2)`。
- 切换按钮(846-848):`<Brain size=10>` + `t('chat.reasoning')`("推理过程") + 箭头 `▲/▶`(注意展开是 `▲`、收起是 `▶`),`fontSize:10 color:var(--t3) bg:none`。
- 展开内容(849):`<p marginTop:4 whiteSpace:pre-wrap fontSize:11 lineHeight:1.6 color:var(--t2)>{text}`。

#### 2.9.8 ImageView(854-857)

`src` = base64 时 `data:${media_type};base64,${data}` 否则直接 `data`(url)。`<img maxHeight:256 maxWidth:100% radius:6 marginBottom:8 objectFit:contain>`。

#### 2.9.9 CopyButton(29-78)

Props:`{text, alignEnd?}`。`copied` state,点击 `navigator.clipboard.writeText(text)` → `copied=true`,1500ms 后复位(32-36)。
- class `copy-btn`(平时 opacity 0,所在 `.msg-row` hover 才显示,见 2.0)。`position:relative marginTop:4 padding:'4px 7px' radius:5`,`alignSelf:alignEnd?'flex-end':'flex-start'`。
- 配色:copied 时 `border:1px var(--teal) bg:rgba(8,145,178,.08) color:var(--teal)`;否则 `border:1px var(--border) bg:var(--bg2) color:var(--t3)`。hover(非 copied)→`bg:var(--bg3) borderColor:var(--border2) color:var(--t2)`(51-62)。
- 图标:copied→`<Check size=12 strokeWidth=2.5>` 否则 `<Copy size=12 strokeWidth=2>`。
- Tooltip(66-75,`.copy-tip`):`absolute bottom:calc(100%+6px) left:50% translateX(-50%)`,`bg:rgba(15,23,42,.85) color:#fff fontSize:11 padding:'3px 7px' radius:4`,默认 `opacity:0`,按钮 hover 时置 1(54-55/60-61);文案 copied→`t('chat.copied')`("已复制") 否则 `t('chat.copy')`("复制")。

---

### 2.10 HITL 等待输入面板 —— `WaitingInputPanel` + `StructuredQuestions`

> ⚠️ **上游变更(2026-06,已同步进 v2)**:HITL 面板里所有"模型给的文案"现在按 **Markdown** 渲染,不再是纯 `<p>` 文本——具体:`item.prompt`(审批类 + 纯文本输入类两处)、结构化问题的 `q.question`、选项的 `opt.description` 都改用 `<Markdown remarkPlugins={[remarkGfm]} components={hitlMdComponents}>`。新增 **`hitlMdComponents`**(`ChatPanel.tsx` 末尾):一套**紧凑** md 组件(段落零外边距),避免撑大弹窗;prompt 外层包 `.prose prose-sm max-w-none msg-md`(故代码块等同样享受 §5 的浅灰底)。

`WaitingInputPanel` props:`{item, input, setInput, onSubmit, onAnswer, onApprove, onReject}`。
判定:`isBash = item.input_type==='bash_exec_confirm'`(880);`isApproval = isBash || item.hitl_kind==='approval'`(882)。
外容器(883-888):`radius:var(--r)`;bash→`border:1px rgba(234,88,12,.25) bg:rgba(255,237,213,.5)`;非 bash approval/input→`border:1px rgba(217,119,6,.25) bg:rgba(254,243,199,.5)`;`padding:12`。

**三种分支**:

1. **审批类 isApproval**(889-908):
   - 标题(890-893):bash→`<Terminal size=12>` + `t('chat.execConfirm')`("执行确认");否则 `t('chat.agentNeedsApproval')`("Agent 请求授权")。`fontSize:12 fontWeight:500 color:var(--amber)`。
   - bash 命令(894-896):`item.command` → `<pre>`,`bg:var(--bg1) border:1px var(--border) padding:'6px 10px' fontSize:11 color:var(--t2) radius:var(--r)`。
   - `item.prompt`(897)→ **Markdown**(`hitlMdComponents`,外层 `.prose prose-sm msg-md`,`fontSize:12 color:var(--t2)`)。
   - **调用参数**(898-903):`item.arguments` 非空 → 标题 `t('chat.callArguments')`("调用参数")+ `<pre maxHeight:200 overflow:auto whiteSpace:pre-wrap>` 显示 `JSON.stringify(arguments,2)`。
   - 按钮行(904-907):**允许** `<Button size="sm" style={bg:var(--amber) color:#fff}>` 文 `t('chat.allow')` → `onApprove`(`answerMut.mutate('approved')`);**拒绝** `<Button size="sm" variant="outline">` 文 `t('chat.reject')` → `onReject`(`answerMut.mutate('rejected')`)。

2. **结构化问题**(`item.questions?.length>0`,909-913):标题 `t('chat.agentNeedsInput')`("Agent 需要你的输入")+ `<StructuredQuestions questions onAnswer>`。

3. **纯文本输入**(914-928):标题同上;`item.prompt`→ **Markdown**(`hitlMdComponents`,外层 `.prose prose-sm msg-md`,`fontSize:13 color:var(--t2)`);输入行:`<input autoFocus value=input onChange=setInput onKeyDown=Enter&&!shift→onSubmit>`(`flex:1 radius:var(--r) border:1px var(--border) padding:'6px 10px' fontSize:13 bg:var(--bg1) color:var(--t1)`)+ `<Button size="sm" disabled={!input.trim()}>` 文 `t('chat.send')` → `onSubmit`(=`send()`,经 isWaiting 分支 → `answerMut.mutate(text)`)。

**StructuredQuestions**(934-1017):props `{questions, onAnswer}`。State:`selected:Record<qi,string[]>`、`other:Record<qi,string>`(936-937)。
- `toggle(qi,label,multi)`(939-950):多选 → 增删;单选 → 替换(再点同项取消);单选时清该题 `other`(单选与"其他"互斥)。
- `setOtherText(qi,val,multi)`(952-955):写 other;单选且 val 非空 → 清该题 selected。
- `answerFor(qi)`(957-962):selected + 非空 other(trim)。
- `allAnswered`(964):每题 `answerFor` 非空。
- `submit()`(966-971):未全答返回;拼成 `"${qi+1}. ${question} → ${answers.join(', ')}"` 多行,`onAnswer(text)`。
- 渲染(973-1016):每题 `gap:14`。题干 `fontSize:13 color:var(--t1)`,序号灰 `--t3`;多选 → `t('chat.multiSelectHint')`("(可多选)")。**选项按钮**(989-1000):`textAlign:left radius:var(--r) padding:'7px 10px'`,选中 `border:1px var(--amber) bg:rgba(254,243,199,.7)` 否则 `border:1px var(--border) bg:var(--bg1)`;label `fontSize:12.5 fontWeight:500 color:var(--t1)`,`recommended` → `t('chat.recommended')`("(推荐)",色 `--amber`);`description` → `fontSize:11 color:var(--t2)`。**"其他"输入框**(1004-1008):placeholder `t('chat.otherOption')`("其他…"),`radius:var(--r) border:1px var(--border) padding:'5px 10px' fontSize:12 bg:var(--bg1)`。底部 `<Button size="sm" disabled={!allAnswered}>` 文 `t('chat.submit')`("提交")→`submit`。

---

### 2.11 Markdown 渲染覆盖 —— `mdComponents`(1021-1048)

`<Markdown remarkPlugins={[remarkGfm]}>`,容器 class `prose prose-sm max-w-none msg-md`。各覆盖确切样式:

- **code**(1022-1032):`isBlock = className?.includes('language-')`。
  - 代码块:外 `<pre margin:'8px 0' radius:8 overflow:hidden border:1px var(--border)>` 包 `<code display:block padding:'12px 14px' monospace fontSize:12 lineHeight:1.6 bg:#f6f8fa color:var(--t1) overflowX:auto whiteSpace:pre border:none>`(另被 `.msg-md pre` 的 `!important` 强制 `#f6f8fa`/`--t1`)。
  - 行内代码:`<code monospace fontSize:12 bg:var(--bg3) border:1px var(--border) padding:'1px 5px' radius:4 color:var(--blue)>`(反引号被 `index.css:79-82` 去除)。
- **a**(1033-1035):`target="_blank" rel="noreferrer"`,`color:var(--blue) textDecoration:underline`。
- **table**(1036-1038):外 `<div overflowX:auto>` 包 `<table borderCollapse:collapse width:100% fontSize:12.5>`。
- **th**(1039-1041):`border:1px var(--border) padding:'5px 10px' bg:var(--bg2) fontWeight:600 color:var(--t1) textAlign:left`。
- **td**(1042-1044):`border:1px var(--border) padding:'5px 10px' textAlign:left`。
- **blockquote**(1045-1047):`margin:'8px 0' padding:'6px 12px' borderLeft:3px solid var(--border2) color:var(--t3) bg:var(--bg2) radius:'0 4px 4px 0'`。

---

### 2.12 关键交互 → 行为 速查表

| 元素 | 文案/图标 | 点击行为 | API / 副作用 |
|---|---|---|---|
| 发送按钮(蓝圆) | `ArrowUp` | `send()` | pending→`createMut`(POST /sessions);waiting→`answerMut`(POST /messages);否则 `sendMut`(POST /messages)+`sse.reconnect()` |
| 中断按钮(红圆) | `Square` | `interruptMut.mutate()` | POST /sessions/{id}/interrupt |
| 恢复运行(中断条/弹窗) | `t('chat.resume')` | `resumeMut.mutate()` | POST /sessions/{id}/resume;onSuccess invalidate sessions + clearLlmError + reconnect |
| 工作模式 select | auto/manual | `bashModeMut.mutate(mode)` | PUT /bash-review-mode;setQueryData 缓存 |
| 允许(HITL) | `t('chat.allow')` | `onApprove` | `answerMut.mutate('approved')` → POST /messages |
| 拒绝(HITL) | `t('chat.reject')` | `onReject` | `answerMut.mutate('rejected')` |
| HITL 文本发送 | `t('chat.send')` | `onSubmit`=send→answerMut | POST /messages |
| 结构化提交 | `t('chat.submit')` | `submit`→onAnswer | POST /messages(编号文本) |
| 复制按钮 | `Copy`/`Check` | `navigator.clipboard.writeText` | 纯前端,1.5s 复位 |
| 上报会话 | `UploadIcon` | 打开弹窗→`submit()` | `window.electronAPI.reportSession(id,note)`(IPC,非 HTTP) |
| 工作区开关 | `PanelRight*` | `onToggleWorkspace()` | 父级 state |
| 工具块/推理块/observer 块头 | 文字+▲▼ | `setOpen(!open)` | 纯前端折叠 |
| LLM 弹窗关闭 | `t('common.close')` / Esc / 点遮罩 | `onClose`=`clearLlmError` | 清 `llmError` |

> Button 尺寸(`ui/button.tsx`):`sm`=`h-7 px-2.5 text-xs`;`md`=`h-8 px-3 text-sm`;`icon`=`h-7 w-7`。variant:`default` `bg-#2563eb text-white hover:#1d4ed8`;`outline` `border-#dde6f3 text-#3d5a80 hover:bg-#eaf0fb`;`ghost` `hover:bg-#eaf0fb`;`danger` `bg-red-50 text-red-600`。统一 `rounded-md`、`disabled:opacity-50`、focus ring `#2563eb`。


---

## 3. 会话列表 / 新建会话 / 模型选择 / 新手引导 / 登录

> 本章覆盖左侧边栏的会话列表与分组、新建会话弹窗、模型选择下拉、driver.js 新手引导、启动登录门，以及 `types/index.ts` 中的全部 TypeScript 类型。
>
> 所有标注均为 `文件路径:行号`。颜色 / 间距 / 字号均给出确切值。涉及的 CSS 变量定义见 `frontend-desktop/src/index.css:4-29`,本章开头先把会用到的变量值整理出来,后文直接引用变量名。

### 3.0 设计令牌(CSS 变量)速查表

来源:`frontend-desktop/src/index.css:4-29`(`:root`)。

| 变量 | 值 | 含义 |
|---|---|---|
| `--bg0` | `#f0f4fa` | 最底层背景 |
| `--bg1` | `#ffffff` | 卡片 / 弹窗 / 菜单背景 |
| `--bg2` | `#f5f8fe` | 侧栏 / 输入框背景 |
| `--bg3` | `#eaf0fb` | hover 背景 / 浅蓝块 |
| `--border` | `#dde6f3` | 常规边框 |
| `--border2` | `#c6d5eb` | 强调边框(选中态) |
| `--blue` | `#2563eb` | 主色(强调/链接/主按钮) |
| `--blue-dim` | `rgba(37, 99, 235, .09)` | 主色淡背景 |
| `--blue-glow` | `rgba(37, 99, 235, .2)` | 主色发光 |
| `--teal` | `#0891b2` | 青色 |
| `--amber` | `#d97706` | 琥珀色 |
| `--red` | `#dc2626` | 危险/错误 |
| `--green` | `#16a34a` | 绿色 |
| `--t1` | `#0f1f3d` | 主文本(最深) |
| `--t2` | `#3d5a80` | 次级文本 |
| `--t3` | `#8aa3bf` | 弱文本/占位/图标 |
| `--shadow` | `0 1px 4px rgba(15, 31, 61, .07)` | 浅阴影 |
| `--shadow2` | `0 4px 16px rgba(15, 31, 61, .1)` | 深阴影(下拉菜单) |
| `--r` | `8px` | 圆角(基准) |
| `--r2` | `12px` | 圆角(大) |
| `--r3` | `16px` | 圆角(更大) |
| `--font-ui` | `system-ui, -apple-system, sans-serif` | UI 字体 |
| `--font-mono` | `'JetBrains Mono', ui-monospace, monospace` | 等宽字体 |
| `--tr` | `.15s ease` | 通用过渡时长 |

> 注意:`LoginGate` 使用了 `--btn-primary-bg` / `--btn-primary-fg`(`frontend-desktop/src/components/LoginGate.tsx:58`),但这两个变量**未在 `index.css` 的 `:root` 中定义**(全仓库仅此一处引用)。(需确认:可能依赖未声明回退,渲染时背景/前景可能落空,或在打包产物中另有定义)。

---

### 3.1 SessionList(会话列表 / 侧栏底部)

文件:`frontend-desktop/src/components/SessionList.tsx`(556 行)。

这是左侧栏的核心组件,自上而下包含:会话列表标题栏(含"新建"按钮)、待创建草稿项(Pending)、空态、按项目(working_dir)分组的会话列表;底部是设置区(弹出二级菜单 + 用户头像/设置按钮 + 更新横幅)。此外有两个全局浮层:删除确认弹窗、新建会话弹窗。

#### 3.1.1 导入与依赖

`SessionList.tsx:1-12`:
- React:`useEffect, useRef, useState`(`:1`)。
- React Query:`useQuery, useMutation, useQueryClient`(`:2`)。
- lucide-react 图标(`:3`):`Trash2Icon, FolderIcon, FolderOpenIcon, Wand2Icon, ZapIcon, ChevronRightIcon, ChevronDownIcon, PlusIcon, XIcon, SettingsIcon, GlobeIcon, DownloadIcon, LogOutIcon`。
- `sessionsApi`(`@/api/sessions`,`:4`)。
- 类型 `Session, PendingSession, AuthUser`(`@/types`,`:5`)。
- `StatusBadge`(`@/components/ui/badge`,`:6`)、`Button`(`@/components/ui/button`,`:7`)、`formatTime`(`@/lib/utils`,`:8`)。
- 子组件 `NewSessionDialog`(`:9`)。
- `useProjectGroups, NO_PROJECT_ID, type Project`(`@/hooks/useProjectGroups`,`:10`)。
- i18n:`useI18n, LANGUAGES, type Lang`(`@/i18n`,`:11`)。
- `type CenterView`(`@/App`,`:12`)——主视图区当前显示模式。

#### 3.1.2 Props(`SessionList.tsx:14-25`)

| Prop | 类型 | 含义 |
|---|---|---|
| `selectedId` | `string \| null` | 当前选中的会话 id;`null` 表示选中草稿或未选 |
| `pendingSession` | `PendingSession \| null` | 待创建草稿(已选目录、未发首条消息) |
| `centerView` | `CenterView` | 主视图当前页:`'chat' \| 'skills' \| 'llm'`(由 `@/App` 定义,见 `:12`) |
| `onViewChange` | `(view: CenterView) => void` | 切换主视图 |
| `onSelect` | `(id: string) => void` | 选中某会话(传 `''` 表示清空选中) |
| `onNewSession` | `(pending: PendingSession) => void` | 创建草稿后回调 |
| `onPendingSelect` | `() => void` | 点击草稿项回调 |
| `onDismissDraft` | `() => void` | 放弃草稿回调 |
| `user?` | `AuthUser \| null` | 登录用户;浏览器调试下为 `null`(`:23`) |
| `onLogout?` | `() => void` | 登出回调,仅 Electron 提供(`:24`) |

#### 3.1.3 本地 state / ref / hooks(`SessionList.tsx:28-41`)

- `qc = useQueryClient()`(`:28`)。
- `{ t, lang, setLang } = useI18n()`(`:29`)——翻译函数、当前语言、切换语言。
- `showNew: boolean`(`:30`,初值 `false`)——是否显示新建会话弹窗。
- `createInitialWd: string`(`:31`,初值 `''`)——新建弹窗预填工作目录。
- `confirmDelete: string | null`(`:32`,初值 `null`)——待删除的会话 id;非 null 时显示删除确认弹窗。
- `collapsedProjects: Set<string>`(`:34`)——折叠的项目 id 集合;初值为 `new Set([NO_PROJECT_ID])`,即"未指定目录"分组默认折叠,其余默认展开。
- `settingsOpen: boolean`(`:35`,初值 `false`)——底部设置二级菜单是否展开。
- `version: string`(`:36`,初值 `''`)——应用版本号(Electron 取得)。
- `update: { status: string; percent?: number; version?: string; message?: string } | null`(`:37`,初值 `null`)——自动更新状态。
- `dismissedVersion: string | null`(`:40`,初值 `null`)——本进程内被用户 × 掉的"更新就绪"横幅对应的版本;仅当前进程有效,重启后重新出现;更高版本下载后会重新弹横幅。
- `settingsBtnRef = useRef<HTMLButtonElement>(null)`(`:41`)——设置/用户按钮 ref,用于点击外部收起判定。

派生值(`SessionList.tsx:44-46`):
- `hasActiveUpdate`(`:44`)= `update?.status` 为 `'available' | 'downloading' | 'downloaded'` 之一——驱动齿轮/头像上的蓝点。
- `showUpdateBanner`(`:46`)= `update?.status === 'downloaded'` 且 `(update.version ?? '__downloaded__') !== dismissedVersion`。

#### 3.1.4 副作用(useEffect)

1. **取版本号**(`:49-51`):挂载时 `window.electronAPI?.getVersion?.().then(setVersion).catch(() => {})`。
2. **订阅更新状态**(`:54-65`):`window.electronAPI?.onUpdateStatus?.((p) => {...})`。每次回调 `setUpdate(p)`;若 `p.status` 为 `'not-available'` 或 `'error'`,设 4000ms 定时器自动 `setUpdate(null)`(`:60-62`,瞬态状态自动消失)。卸载时调用反订阅函数 `off?.()` 并清定时器(`:64`)。定时器存 `dismissTimer = useRef`(`:53`)。
3. **点击外部收起设置菜单**(`:68-83`):仅当 `settingsOpen` 时绑定 `mousedown`。点击设置按钮自身不关闭(让按钮自己 toggle,`:75`);点击 `#settings-popup-menu` 内部不关闭(`:77-78`);其余 `setSettingsOpen(false)`。

#### 3.1.5 数据查询与变更

- **会话列表查询**(`:85-89`):`useQuery({ queryKey: ['sessions'], queryFn: sessionsApi.list, refetchInterval: 3000 })`,默认值 `sessions = []`。每 3 秒轮询一次 `GET /api/v1/sessions`(经 `sessionsApi.list` → `http.get('/sessions')`,见 `frontend-desktop/src/api/sessions.ts:9`)。
- **项目分组**(`:91`):`const projects = useProjectGroups(sessions)`(见 3.5)。
- **删除变更**(`:93-99`):
  - `mutationFn: (id) => sessionsApi.delete(id)` → `DELETE /api/v1/sessions/{id}`(`sessions.ts:15`)。
  - `onSuccess(_d, id)`:`qc.invalidateQueries({ queryKey: ['sessions'] })` 刷新列表;若删除的是当前选中(`selectedId === id`),则 `onSelect('')` 清空选中(`:97`)。
  - 无乐观更新——靠 invalidate + 3s 轮询回填。

#### 3.1.6 回调函数

- `handleNewSession(pending)`(`:101-105`):关闭弹窗(`setShowNew(false)`)、清空预填目录、调 `onNewSession(pending)`。
- `openCreate(initialWd = '')`(`:107-110`):设 `createInitialWd` 并打开弹窗。无参 → 空目录(全局新建);传项目 working_dir → 在该项目内新建。
- `toggleProject(id)`(`:112-119`):在 `collapsedProjects` Set 中切换该 id(有则删、无则加)。

#### 3.1.7 布局结构(`SessionList.tsx:121-397`)

最外层 `<>` 内是 `<div className="flex h-full flex-col">`(`:123`):上为可滚动会话列表 `flex-1 overflow-y-auto py-1`(`:125`,带 `data-tour="session-list"`),下为设置区。

##### (A) 列表标题栏(`:127-142`)

- 容器 `flex items-center justify-between px-3 py-1.5`(`:127`)。
- 左侧标题文字(`:128`):`t('sidebar.sessions')`(中:"会话";英:"Sessions",见 `i18n.tsx:57`/`:274`)。样式:`text-xs font-semibold`,`color: var(--t3)`,`letterSpacing: '1px'`,`textTransform: 'uppercase'`。
- 右侧**新建按钮**(`:129-141`,`data-tour="new-session"`):
  - 文案/图标:字符 `＋`(全角加号,`:141`);`title = t('sidebar.newSession')`(中"新建会话"/英"New Session")。
  - 样式:`width:20 height:20`,`borderRadius:'50%'`,`border:none`,背景 `var(--blue-dim)`、文字色 `var(--blue)`,`fontSize:16 lineHeight:1`,`display:'grid' placeItems:'center'`,`cursor:pointer`,`transition: var(--tr)`。
  - hover(`onMouseEnter`,`:139`):背景变 `var(--blue)`、文字变 `#fff`;移出还原(`:140`)。
  - 点击(`:131`):`openCreate('')` → 打开新建弹窗(无预填目录)。

##### (B) 草稿项 PendingSessionItem(`:143-150`)

仅当 `pendingSession` 存在时渲染。`selected` = `selectedId === null && centerView === 'chat'`。详见 3.1.9。

##### (C) 空态(`:152-154`)

当 `sessions.length === 0 && !pendingSession`:`<p className="px-3 py-4 text-center text-xs" style={{ color: 'var(--t3)' }}>`,文案 `t('sidebar.noSessions')`(中:"暂无会话,点击 + 新建";英见 i18n)。

##### (D) 项目分组列表(`:156-177`)

`projects.map(project => ...)`,每个 project 一个 `<div key={project.id}>`:
- `collapsed = collapsedProjects.has(project.id)`(`:157`)。
- `<ProjectGroupHeader>`(`:160-165`):传 `project / collapsed / onToggle=toggleProject(id) / onCreateInProject=openCreate(project.working_dir)`。详见 3.1.8。
- 未折叠时(`!collapsed`)渲染 `project.sessions.map(s => <SessionItem>)`(`:166-174`):
  - `selected = s.id === selectedId && centerView === 'chat'`(`:170`)。
  - `onSelect = () => onSelect(s.id)`;`onDelete = () => setConfirmDelete(s.id)`(打开删除确认,不直接删)。

##### (E) 底部设置区(`:181-396`)

容器 `<div data-tour="user-menu" className="relative" style={{ padding: '4px' }}>`(`:181`)。无上边线,靠侧栏整体 `bg2` 色块自然分隔(`:180` 注释)。

包含(从上到下,DOM 上弹出菜单先于按钮渲染但绝对定位在上方):

**E1. 设置二级菜单**(`settingsOpen` 时,`:182-283`)

`<div id="settings-popup-menu">`,绝对定位:`bottom: 'calc(100% + 2px)'`、`left:4 right:4`;背景 `var(--bg1)`,边框 `1px solid var(--border)`,圆角 `var(--r)`(8px),阴影 `0 8px 24px rgba(15,31,61,.12)`,`overflow:hidden`,`zIndex:20`(`:185-189`)。内含:

- **Skill 市场 NavItem**(`:192-200`):图标 `<ZapIcon size={14}>`,label `t('sidebar.skillMarket')`(中"Skill 市场"),`active = centerView === 'skills'`。点击:`onViewChange(centerView === 'skills' ? 'chat' : 'skills')` 切换(再点回 chat),并 `setSettingsOpen(false)`。
- **LLM 配置 NavItem**(`:201-209`):图标 `<Wand2Icon size={14}>`,label `t('sidebar.llmConfig')`(中"LLM 配置"),`active = centerView === 'llm'`。点击同理在 `llm`/`chat` 间切换并收起菜单。
- 分隔线 `<div style={{ borderTop: '1px solid var(--border)' }} />`(`:212`)。
- **语言切换**(`:213-236`):
  - 左侧 `<GlobeIcon size={14}>`(色 `var(--t3)`)+ 文字 `t('settings.language')`(中"语言"),字号 13、色 `var(--t2)`(`:215-216`)。
  - 右侧分段按钮组,容器背景 `var(--bg3)`、圆角 6、padding 2(`:218`)。`LANGUAGES.map`(见 `i18n.tsx:16-19`:`{zh,'简体中文'}`,`{en,'English'}`)生成按钮(`:219-234`):
    - 每个按钮 `fontSize:11 padding:'2px 8px' borderRadius:4 border:none cursor:pointer`。
    - 选中(`lang === opt.value`):背景 `var(--bg1)`、色 `var(--blue)`、`fontWeight:600`、`boxShadow:'0 1px 2px rgba(15,31,61,.1)'`;未选中:背景 `transparent`、色 `var(--t3)`、`fontWeight:400`、无阴影(`:225-228`)。
    - 点击:`setLang(opt.value as Lang)`(`:222`)。
- **版本号行**(`:239-242`):`flex justify-between px-3 pb-1`,`fontSize:11 color:var(--t3)`。左 `t('settings.version')`(中"版本"),右等宽字体显示 `version ? 'V'+version : '—'`。
- **更新行**(`:245-268`,仅当 `window.electronAPI?.checkForUpdates` 存在):
  - 左侧状态文案(`:247-255`),按 `update?.status`:`checking`→`t('update.checking')`("检查中…");`available`→`t('update.available')+' '+version`("发现新版本 x");`downloading`→`t('update.downloading')+' '+percent+'%'`("下载中 n%");`downloaded`→`t('update.downloaded')`("已下载");`not-available`→`t('update.uptodate')`("已是最新");`error`→`t('update.error')`("更新检查失败");无 update→空格。色 `var(--t3)`,`fontSize:11`。
  - 右侧按钮二选一:
    - 若 `downloaded`(`:256-260`):**重启更新**按钮,文案 `t('update.restart')`("重启更新"),`fontSize:11 padding:'2px 8px' borderRadius:4 border:none` 背景 `var(--blue)` 色 `#fff`;点击 `window.electronAPI?.installUpdate?.()`。
    - 否则(`:262-265`):**检查更新**按钮,文案 `t('update.check')`("检查更新"),边框 `1px solid var(--border)` 背景 `var(--bg3)` 色 `var(--t2)`;点击 `window.electronAPI?.checkForUpdates?.()`。
- **登出区**(`:271-281`,仅当 `user && onLogout`):分隔线 + NavItem,图标 `<LogOutIcon size={14}>`,label 直接按 `lang` 取 `'Sign out'`/`'登出'`(`:276`,未走 t()),`active=false`;点击:`setSettingsOpen(false); onLogout()`。

**E2. 更新就绪横幅**(`showUpdateBanner` 时,`:286-331`)

显示在设置按钮上方:`marginBottom:4 padding:'8px 10px'`,背景 `var(--blue-dim)`,边框 `1px solid var(--blue)`,圆角 `var(--r)`,`display:flex alignItems:center gap:8 fontSize:12`,阴影 `var(--shadow)`(`:288-299`)。内容:
- `<DownloadIcon size={14}>`(色 `var(--blue)`,`flexShrink:0`)。
- 文字(`:302-304`):`t('update.readyTitle')`("更新已就绪")+(若有 version)` v{version}`;色 `var(--t1)`,`flex:1 lineHeight:1.3 minWidth:0`。
- **重启更新**按钮(`:305-315`):文案 `t('update.restart')`,`fontSize:11 padding:'3px 10px' borderRadius:4 border:none` 背景 `var(--blue)` 色 `#fff` `fontWeight:500`;点击 `installUpdate?.()`。
- **关闭(×)按钮**(`:316-329`):`<XIcon size={14}>`,`aria-label/title = t('update.dismiss')`("稍后提醒");透明背景,色 `var(--t3)`,hover 变 `var(--t1)`(`:325-326`);点击 `setDismissedVersion(update?.version ?? '__downloaded__')`(本进程内不再显示此版本横幅)。

**E3. 用户/设置按钮**(`:332-395`,二选一)

- **有 user 时(Electron 已登录)**(`:334-367`):整行按钮 `ref={settingsBtnRef}`。
  - 样式:`display:flex width:100% alignItems:center gap:8 padding:'6px 8px'`,背景 `settingsOpen ? var(--blue-dim) : transparent`,`border:none cursor:pointer borderRadius:var(--r) transition:var(--tr)`(`:338-343`)。hover(仅当未展开):背景 `var(--bg3)`(`:345`)。
  - `title = user.username`(`:337`)。
  - 左侧**首字母头像**(`:348-361`):`width:26 height:26 borderRadius:'50%'` 背景 `var(--blue)` 色 `#fff`,`display:grid placeItems:center fontSize:12 fontWeight:700 textTransform:'uppercase'`;内容 `(user.username || '?').trim().charAt(0)`。若 `hasActiveUpdate`,右上叠加蓝点(`:355-360`):`position:absolute top:-2 right:-3 width:6 height:6 borderRadius:'50%'` 背景 `var(--blue)` `boxShadow:'0 0 0 1.5px var(--bg2)'`。
  - 中间用户名(`:362-365`):`flex:1 minWidth:0 overflow:hidden textOverflow:ellipsis whiteSpace:nowrap textAlign:left fontSize:13 fontWeight:500 color:var(--t1)`,显示 `user.username`。
  - 右侧 `<SettingsIcon size={13}>`(`:366`):色 `settingsOpen ? var(--blue) : var(--t3)`。
  - 点击:`setSettingsOpen(v => !v)`(`:336`)。
- **无 user 时(纯浏览器调试)**(`:370-395`):"设置"按钮。
  - 样式:`padding:'8px 10px' fontSize:13`,`fontWeight settingsOpen?600:500`,色 `settingsOpen?var(--blue):var(--t2)`,背景 `settingsOpen?var(--blue-dim):transparent`(`:374-379`)。hover(未展开):背景 `var(--bg3)`、色 `var(--t1)`(`:381`)。
  - 内含 `<SettingsIcon size={14}>`(`:385`,同样可叠加 `hasActiveUpdate` 蓝点,`:386-391`)+ 文案 `t('sidebar.settings')`(中"设置")。
  - 点击:`setSettingsOpen(v => !v)`。

##### (F) 删除确认弹窗(`:400-410`)

`confirmDelete` 非 null 时渲染。
- 遮罩:`fixed inset-0 z-50 flex items-center justify-center`,背景 `rgba(15,31,61,.35)`,`backdropFilter:'blur(4px)'`(`:401`)。
- 卡片:`w-72 p-4`(宽 288px),背景 `var(--bg1)`,边框 `1px solid var(--border)`,`borderRadius:12`,阴影 `0 24px 80px rgba(15,31,61,.18)`(`:402`)。
- 文案(`:403`):`mb-4 text-sm` 色 `var(--t2)`,`t('sidebar.deleteSessionConfirm')`(中:"确认删除这个会话?此操作不可撤销。")。
- 按钮行 `flex justify-end gap-2`(`:404`):
  - **取消**:`<Button variant="outline" size="sm">` 文案 `t('common.cancel')`("取消");点击 `setConfirmDelete(null)`。
  - **删除**:`<Button variant="danger" size="sm">` 文案 `t('common.delete')`("删除");点击 `deleteMut.mutate(confirmDelete); setConfirmDelete(null)`(`:406`)。danger 变体样式见 3.7。

##### (G) 新建会话弹窗(`:412-418`)

`<NewSessionDialog open={showNew} initialWorkingDir={createInitialWd} recentSessions={sessions} onClose={...} onCreated={handleNewSession} />`。`onClose` 关闭并清空 `createInitialWd`。详见 3.2。

#### 3.1.8 ProjectGroupHeader(`SessionList.tsx:425-467`)

props:`{ project: Project; collapsed: boolean; onToggle: () => void; onCreateInProject: () => void }`。

- `isNoProject = project.id === NO_PROJECT_ID`(`:429`)。
- `Icon = isNoProject ? FolderIcon : FolderOpenIcon`(`:430`)。
- `displayName = isNoProject ? t('sidebar.noProject') : project.display_name`(`:431`,"未指定目录")。
- 容器 `div.group flex cursor-pointer items-center gap-1`(`:433-434`):`padding:'5px 9px' margin:'0 4px 1px' transition:var(--tr)`;`title = project.working_dir || t('sidebar.noProject')`;hover 背景 `var(--bg3)`,移出清空(`:441-442`)。点击整行 `onToggle`(折叠/展开)。
- 折叠箭头(`:444`):`collapsed` 时 `<ChevronRightIcon size={11}>`,否则 `<ChevronDownIcon size={11}>`,色 `var(--t3)`。
- 文件夹图标(`:445`):`size={11}`,色 `isNoProject ? var(--t3) : '#eab308'`(黄色,Tailwind yellow-500)。
- 名称(`:446-448`):`min-w-0 flex-1 truncate`,`fontSize:12 fontWeight:500 color:var(--t2)`。
- 计数徽标(`:449`):`fontSize:10 color:var(--t3) fontFamily:'monospace'`,内容 `project.session_count`。
- **项目内新建按钮**(`:450-464`,仅当 `!isNoProject`):
  - `<button className="invisible group-hover:visible">`——默认隐藏,鼠标悬停分组行时显示。
  - 图标 `<PlusIcon size={11}>`;`title = t('sidebar.createInProject', { name: project.display_name })`(中:"在 {name} 项目内新建会话")。
  - 样式:透明背景无边框,色 `var(--t3)`,`padding:0 display:grid placeItems:center`;hover 色变 `var(--blue)`(`:459`)。
  - 点击:`e.stopPropagation()`(阻止触发折叠)+ `onCreateInProject()`(`:452`)。

#### 3.1.9 NavItem(`SessionList.tsx:469-487`)

props:`{ icon: React.ReactNode; label: string; active: boolean; onClick: () => void }`。
- 整行按钮:`display:flex width:100% alignItems:center gap:8 padding:'7px 12px' fontSize:13`(`:473-475`)。
- `fontWeight active?600:400`;色 `active?var(--blue):var(--t2)`;背景 `active?var(--blue-dim):transparent`;`border:none cursor:pointer transition:var(--tr)`(`:475-478`)。
- hover(仅未 active):背景 `var(--bg3)`、色 `var(--t1)`(`:480`);移出还原(`:481`)。
- 内容:`{icon}{label}`。

#### 3.1.10 PendingSessionItem(`SessionList.tsx:489-521`)

props:`{ pending: PendingSession; selected: boolean; onClick: () => void; onDismiss: () => void }`。
- `dirName`(`:491`)= `pending.workingDir.split(/[\\/]/).filter(Boolean).pop() ?? pending.workingDir`(取路径尾段)。
- 容器 `div.group`(`:493-503`):`cursor:pointer padding:'6px 12px' transition:var(--tr)`,背景 `selected ? var(--blue-dim) : undefined`,`borderRadius:var(--r) margin:'0 4px 2px'`。hover(未选中)背景 `var(--bg3)`(`:501`)。点击整体 `onClick`。
- 第一行 `flex items-center gap-1.5`(`:504`):
  - `<FolderIcon size={12} className="flex-shrink-0 text-yellow-500">`(黄色文件夹,`:505`)。
  - `<p className="min-w-0 flex-1 truncate text-sm" style={{ color: 'var(--t1)' }}>{dirName}</p>`(`:506`)。
  - **放弃草稿(×)按钮**(`:507-516`):`<XIcon size={11}>`,`className="invisible flex-shrink-0 group-hover:visible"`(悬停才显示),`title = t('sidebar.dismissDraft')`(中:"放弃这个未发送的草稿");色 `var(--t3)`,hover 变 `var(--red)`(`:512`);点击 `e.stopPropagation(); onDismiss()`。
- 第二行(`:518`):`mt-0.5 text-[10px]` 色 `var(--t3)`,文案 `t('sidebar.draftWaiting')`(中:"等待第一条消息…")。

#### 3.1.11 SessionItem(`SessionList.tsx:523-556`)

props:`{ session: Session; selected: boolean; onSelect: () => void; onDelete: () => void }`。
- `title`(`:524`)= `session.goal || session.user_prompt || session.id.slice(0, 8)`(优先目标,其次用户提示,再退化为 id 前 8 位)。
- 容器 `div.group relative cursor-pointer`(`:526-537`):`padding:'7px 9px' margin:'0 4px 2px' borderRadius:var(--r)`;背景 `selected ? var(--bg3) : undefined`;边框 `selected ? '1px solid var(--border2)' : '1px solid transparent'`;`transition:var(--tr)`。hover(未选中)背景 `var(--bg3)`(`:535`)。点击整体 `onSelect`。
- 第一行 `flex items-start justify-between gap-2`(`:538`):
  - 标题 `<p className="min-w-0 flex-1 truncate text-sm" style={{ color: 'var(--t1)', fontWeight: 500 }}>{title}</p>`(`:539`)。
  - **删除按钮**(`:540-548`):`<Trash2Icon size={12}>`,`className="invisible flex-shrink-0 group-hover:visible"`(悬停显示);色 `var(--t3)`,hover 变 `var(--red)`(`:544`);点击 `e.stopPropagation(); onDelete()`(打开删除确认)。
- 第二行 `mt-1 flex items-center gap-2`(`:550`):
  - `<StatusBadge status={session.status} />`(状态徽标,见 3.6)。
  - 时间 `<span className="text-[10px]" style={{ color: 'var(--t3)' }}>{formatTime(session.created_at)}</span>`(`:552`)。`formatTime` 用 `zh-CN` 本地化为 `MM/DD HH:mm`(2 位月日时分,见 `frontend-desktop/src/lib/utils.ts:8-18`)。

---

### 3.2 NewSessionDialog(新建会话弹窗)

文件:`frontend-desktop/src/components/NewSessionDialog.tsx`(183 行)。

> 注意:本弹窗**不含模板选择,也不含 prompt 输入框**。它只采集工作目录(必填)与可选模型(provider/model),然后产出一个 `PendingSession` 草稿;真正的首条消息(prompt)在主聊天区里发出。任务描述中的"模板选择 / prompt 输入 / 默认模型"在当前实现里,只有"模型(可选,即默认模型)"成立;模板字段 `template_id` 仅存在于类型与 API 请求中,UI 未提供选择(需确认:可能在其它版本/后续迭代)。

#### 3.2.1 Window.electronAPI 类型声明(`NewSessionDialog.tsx:11-28`)

文件顶部 `declare global { interface Window { electronAPI?: {...} } }`,这是全局 Electron 预加载 API 的 TS 声明:

| 方法 | 签名 | 含义 |
|---|---|---|
| `selectDirectory` | `() => Promise<string \| null>` | 打开系统目录选择器 |
| `openPath` | `(p: string) => Promise<void>` | 用系统默认方式打开路径 |
| `getVersion?` | `() => Promise<string>` | 取应用版本 |
| `checkForUpdates?` | `() => Promise<void>` | 触发检查更新 |
| `installUpdate?` | `() => Promise<void>` | 安装(重启)更新 |
| `onUpdateStatus?` | `(cb: (p:{status;version?;percent?;message?}) => void) => (() => void)` | 订阅更新状态,返回反订阅函数 |
| `convertEmf?` | `(items:{key;b64}[]) => Promise<{key;png:string\|null}[]>` | EMF 图转 PNG |
| `login?` | `() => Promise<{id;username;role}>` | 浏览器 OAuth 登录 |
| `logout?` | `() => Promise<void>` | 登出 |
| `getSession?` | `() => Promise<{id;username;role}\|null>` | 取当前登录会话 |
| `reportSession?` | `(sessionId, note) => Promise<{ok;error?}>` | 举报/反馈会话 |

#### 3.2.2 Props(`NewSessionDialog.tsx:30-36`)

| Prop | 类型 | 含义 |
|---|---|---|
| `open` | `boolean` | 是否显示 |
| `initialWorkingDir?` | `string`(默认 `''`) | 从项目"新建会话"时预填目录 |
| `recentSessions?` | `Session[]`(默认 `[]`) | 用于按工作目录套用最近用过的 provider/model |
| `onClose` | `() => void` | 关闭 |
| `onCreated` | `(pending: PendingSession) => void` | 创建草稿回调 |

#### 3.2.3 state / hooks(`:38-48`)

- `{ t } = useI18n()`(`:39`)。
- `workingDir: string`(`:40`,初值 `''`)。
- `selProvider: string`(`:41`,初值 `''`)。
- `selModel: string`(`:42`,初值 `''`)。
- `appliedFromSession: string`(`:44`,初值 `''`)——套用了哪个会话设置的提示(其 id)。
- `providerTouched: boolean`(`:46`,初值 `false`)——用户是否手动改过模型,避免自动套用覆盖手选。
- providers 查询(`:48`):`useQuery({ queryKey: ['llms'], queryFn: llmsApi.list })`,默认 `[]`。即 `GET /api/v1/llms`(`@/api/llms`)。

#### 3.2.4 逻辑函数

- `applyDefaultsFor(wd)`(`:51-66`):若 wd 为空清空提示并返回;调 `pickDefaultsFromRecentSession(recentSessions, wd)`(见 3.5);若有匹配且 `!providerTouched`,把 `pick.defaults.llm_account/llm_model` 写入 `selProvider/selModel`,并 `setAppliedFromSession(pick.session.id)`。
- **打开重置 effect**(`:69-88`):依赖 `[open, initialWorkingDir]`(故意忽略 `recentSessions` 以免引用变化反复重置,`:86-88`)。`open` 为真时:把 `workingDir` 设为 `initialWorkingDir`,清空 provider/model、`providerTouched`、`appliedFromSession`;若有 `initialWorkingDir`,立即调 `pickDefaultsFromRecentSession` 套用最近模型并设提示。
- `pickDirectory()`(`:90-100`):若有 `window.electronAPI`,`await selectDirectory()`,选中则 `setWorkingDir(dir)` + `applyDefaultsFor(dir)`;否则 `alert(t('newSession.dirNeedsElectron'))`(中:"目录选择需要在 Electron 客户端中使用")。
- `handleProviderModelChange(p, m)`(`:102-107`):`setProviderTouched(true)`、写入 provider/model、清空套用提示。
- `handleCreate()`(`:109-117`):若 `workingDir.trim()` 为空直接 return;调 `onCreated({ workingDir: trim, provider: selProvider, model: selModel })`,然后清空所有 state。

`if (!open) return null`(`:119`)——关闭时不渲染。

#### 3.2.5 UI 结构(`:121-181`)

- **遮罩**(`:122`):`fixed inset-0 z-50 flex items-center justify-center`,背景 `rgba(15,31,61,.35)` + `backdropFilter:'blur(4px)'`。
- **卡片**(`:123`):`w-[420px]`,背景 `var(--bg1)`,边框 `1px solid var(--border)`,`borderRadius:16`,阴影 `0 24px 80px rgba(15,31,61,.18)`。
- **Header**(`:125-130`):`flex items-center justify-between px-4 py-3`,底边线 `1px solid var(--border)`。左标题 `<h2 className="text-sm font-semibold">` 色 `var(--t1)`,文案 `t('newSession.title')`(中"新建会话")。右关闭 `<XIcon size={16}>`,色 `var(--t3)`,点击 `onClose`。
- **Body**(`:133-170`,`flex flex-col gap-4 p-4`):
  - **工作目录(必填)**(`:135-151`):
    - label(`:136`):`text-xs font-medium` 色 `var(--t2)`,`t('newSession.workingDir')`(中"工作目录")+ 红色星号 `<span className="text-red-500">*</span>`。
    - 选择条(`:137-150`):`flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm`,边框 `1px solid var(--border)`,背景 `var(--bg2)`,过渡 `background var(--tr)`;hover 背景 `var(--bg3)`(`:141`)。点击整体 `pickDirectory`。
    - 图标 `<FolderOpenIcon size={14} className="flex-shrink-0 text-yellow-500">`(`:144`)。
    - 已选目录时:`<span className="min-w-0 flex-1 truncate" style={{ color: 'var(--t1)' }}>{workingDir}</span>`(`:146`);未选:占位 `<span style={{ color: 'var(--t3)' }}>{t('newSession.selectDir')}</span>`(中:"点击选择目录…")(`:148`)。
  - **模型选择**(`:154-169`):
    - label(`:155`):`text-xs font-medium` 色 `var(--t2)`,`t('newSession.model')`(中:"模型(可选)")。
    - `<ModelPickerButton variant="field" providers={providers} selectedProvider={selProvider} selectedModel={selModel} onChange={handleProviderModelChange} placeholder={t('newSession.useDefault')} />`(`:156-163`)。占位文案 `t('newSession.useDefault')`(中"使用默认")。详见 3.3。
    - 套用提示(`:164-168`,仅当 `appliedFromSession`):`<p className="text-[11px]" style={{ color: 'var(--blue)' }}>`,`t('newSession.appliedRecent', { id: appliedFromSession.slice(0, 12) })`(中:"已套用此目录最近会话的模型({id}…)")。
- **Footer**(`:173-178`):`flex justify-end gap-2 px-4 py-3`,顶边线 `1px solid var(--border)`。
  - **取消**:`<Button variant="outline">` 文案 `t('common.cancel')`("取消");点击 `onClose`。
  - **创建**:`<Button disabled={!workingDir.trim()}>` 文案 `t('newSession.create')`("创建会话");`disabled` 时(无目录)半透明且不可点(见 Button 的 `disabled:opacity-50`);点击 `handleCreate`。

> 说明:此弹窗只生成草稿(`PendingSession`),**不直接调用** `sessionsApi.create`。实际 `POST /api/v1/sessions`(`sessions.ts:11`,body 为 `CreateSessionRequest`)在主聊天区发出首条消息时才触发。(需确认:确切触发点在聊天区组件,不在本章范围。)

---

### 3.3 ModelPickerButton(模型选择下拉)

文件:`frontend-desktop/src/components/ui/ModelPickerButton.tsx`(178 行)。

#### 3.3.1 Props(`:7-16`)

| Prop | 类型 | 含义 |
|---|---|---|
| `providers` | `LLMProvider[]` | 可选的 LLM 提供方列表 |
| `selectedProvider` | `string` | 已选 provider 名 |
| `selectedModel` | `string` | 已选 model 名 |
| `onChange` | `(provider: string, model: string) => void` | 选择回调 |
| `disabled?` | `boolean` | 禁用 |
| `variant?` | `'pill' \| 'field'`(默认 `'pill'`) | `pill`=聊天输入区紧凑胶囊;`field`=表单全宽字段 |
| `placeholder?` | `string` | 占位文案,默认 `t('chat.defaultModel')`("默认模型") |

#### 3.3.2 state / 计算(`:22-46`)

- `ph = placeholder ?? t('chat.defaultModel')`(`:23`)。
- `btnRef`(`:24`)、`open: boolean`(`:25`,初值 false)、`pos: {top?;bottom?;left?;right?} | null`(`:26`,菜单浮层定位)。
- `label`(useMemo,`:28-32`):无 `selectedProvider`→`null`;有 provider 无 model→显示 provider 名;有 model→显示 model 名。
- `options`(useMemo,`:34-46`):构造下拉项数组。首项固定 `{ provider:'', model:'' }`(即"默认"项);遍历 `providers`:若某 provider 的 `models.length===0`,推 `{provider:p.name, model:''}`;否则每个 model 推 `{provider:p.name, model:m.name}`。

#### 3.3.3 交互逻辑

- `toggle(e)`(`:48-62`):`stopPropagation`;打开前用 `btnRef.getBoundingClientRect()` 计算 `pos`:
  - `variant==='field'`:菜单在触发器**下方**,`top: rect.bottom + 4`,`left: rect.left`,`right: window.innerWidth - rect.right`(`:55`)。
  - 否则(pill):菜单在**上方**,`bottom: window.innerHeight - rect.top + 6`,`right: window.innerWidth - rect.right`(`:57`)。
  - 然后 `setOpen(v => !v)`。
- **点击外部关闭 effect**(`:64-69`):`open` 时给 `document` 绑 `click` → `setOpen(false)`;卸载移除。
- `chevronStyle`(`:71-75`):`flexShrink:0 color:var(--t3) transition:'transform .15s'`;`transform: open ? 'rotate(180deg)' : 'rotate(0deg)'`(开时箭头翻转)。

#### 3.3.4 触发器样式(`triggerStyle`,`:77-93`)

- **field 变体**(`:77-84`):`display:flex alignItems:center gap:6 width:100% height:32 padding:'0 10px'`,`borderRadius:6` 边框 `1px solid var(--border)`,背景 `var(--bg2)`,色 `label ? var(--t1) : var(--t3)`,`fontSize:14 cursor:pointer outline:none`,过渡 `border-color .15s`,`opacity disabled?0.45:1`。hover(非禁用):`borderColor` 变 `var(--blue)`(`:105`);移出还原 `var(--border)`(`:110`)。
- **pill 变体**(`:85-92`):`display:flex alignItems:center gap:4 padding:'4px 10px' borderRadius:20`(胶囊),边框 `1px solid var(--border)`,背景 `var(--bg2)`,色 `var(--t2)`,`fontSize:11.5 cursor:pointer outline:none maxWidth:180 whiteSpace:nowrap`,过渡 `background var(--tr), border-color var(--tr)`,`opacity disabled?0.45:1`。hover:背景 `var(--bg3)`、边框 `var(--border2)`(`:106`);移出还原(`:111`)。

#### 3.3.5 触发器内容(`:113-124`)

- 仅 `variant==='field' && label && selectedProvider` 时(`:114-119`)显示一个 provider 小标签:`fontSize:11 flexShrink:0 padding:'1px 6px' borderRadius:4` 背景 `var(--blue-dim)` 色 `var(--blue)`,内容 `selectedProvider`。
- 主文字(`:120-122`):`flex:1 overflow:hidden textOverflow:ellipsis whiteSpace:nowrap textAlign:left`,内容 `label ?? ph`。
- 箭头(`:123`):`<ChevronUp size={variant==='field'?12:10} style={chevronStyle}>`。

#### 3.3.6 下拉浮层(`createPortal` → `document.body`,`:126-175`)

仅 `open && pos` 时渲染。容器(`:127-138`):`position:fixed zIndex:9999`;按 `pos` 用 `top` 或 `bottom`、`left`/`right`;`minWidth: variant==='field' ? (btnRef.offsetWidth ?? 200) : 200`,`maxWidth:300 maxHeight:240 overflowY:auto`;背景 `#fff`,边框 `1px solid var(--border)`,`borderRadius:10`,阴影 `var(--shadow2)`(`0 4px 16px rgba(15,31,61,.1)`),`padding:4`。点击浮层内 `stopPropagation`(`:128`,避免触发外部关闭)。

每个 `options.map`(`:140-172`):
- `selected = opt.provider===selectedProvider && opt.model===selectedModel`(`:141`)。
- 按钮(`:143-154`):`display:flex alignItems:center gap:6 width:100% padding:'7px 10px' borderRadius:7 cursor:pointer border:none textAlign:left`,背景 transparent,过渡 `background .1s`,色 `selected ? var(--blue) : var(--t1)`。hover 背景 `var(--bg2)`(`:153`);移出 transparent。
- 点击:`onChange(opt.provider, opt.model); setOpen(false)`(`:145`)。
- provider 小标签(`:156-161`,仅 `opt.provider` 非空):`fontSize:11 padding:'1px 6px' borderRadius:4`;背景 `selected ? 'rgba(37,99,235,.1)' : var(--bg2)`,色 `selected ? var(--blue) : var(--t3)`;内容 `opt.provider`。
- 主文字(`:163-168`):`fontSize:13 flex:1 overflow:hidden textOverflow:ellipsis whiteSpace:nowrap`,`fontWeight selected?500:400`;内容 `opt.model || (opt.provider ? opt.provider : ph)`(即:有 model 显 model;否则显 provider;首项空项显占位 ph)。
- 选中勾(`:169`,仅 `selected`):`<Check size={11}>` 色 `var(--blue)` `flexShrink:0`。

---

### 3.4 useProjectGroups(项目分组 hook)

文件:`frontend-desktop/src/hooks/useProjectGroups.ts`(112 行)。

> 设计说明(`:1-6`):桌面端"Smart B"方案——前端聚合,无后端项目实体;未来升级方案 C 时改为调 `/api/v1/projects` 而 UI 不变。

#### 3.4.1 常量与类型

- `NO_PROJECT_ID = '_no_project'`(`:11`)——"未指定目录"分组的虚拟 id。
- `ProjectDefaults`(`:13-16`):`{ llm_account?: string | null; llm_model?: string | null }`。
- `Project`(`:18-29`):
  - `id: string` — Smart B 下 = working_dir 或 `NO_PROJECT_ID`;C 阶段为 UUID。
  - `display_name: string` — Smart B 下为路径尾段;C 阶段用户可改。
  - `working_dir: string` — 工作目录。
  - `sessions: Session[]` — 该项目下会话。
  - `session_count: number` — 会话数。
  - `last_accessed_at: string` — 最近访问时间(取组内最新 `updated_at`)。
  - `description?: string` / `pinned?: boolean` / `defaults?: ProjectDefaults` — C 阶段预留,Smart B 下恒 `undefined`。

#### 3.4.2 内部函数

- `pathParts(wd)`(`:31-33`):`wd.split(/[\\/]/).filter(Boolean)`——按正/反斜杠拆分并去空。
- `buildDisplayName(wd, allWds)`(`:41-53`):
  - 空 wd → `'未指定目录'`(`:42`,硬编码中文,非 i18n)。
  - 否则从尾段开始逐级加深(`depth 1..myParts.length`),取尾部 `depth` 段 join `/`;若该尾段在其它目录里不冲突,直接返回(`:47-51`);全冲突则返回完整 `wd`(`:52`)。即"basename 唯一则用 basename,冲突则逐级往上消歧"。

#### 3.4.3 useProjectGroups(sessions)(`:55-88`)

`useMemo` 依赖 `[sessions]`:
1. 用 Map 按 `s.workspace || NO_PROJECT_ID` 分组(`:57-63`)。
2. `allWds` = 非 NO_PROJECT_ID 的所有目录 Set(`:64-66`,用于消歧)。
3. 每组构造 Project(`:68-79`):`wd = id===NO_PROJECT_ID ? '' : id`;组内会话按 `updated_at` 降序排序(`b.updated_at.localeCompare(a.updated_at)`,`:70`);`last_accessed_at = sorted[0]?.updated_at ?? ''`。
4. 项目排序(`:81-85`):`NO_PROJECT_ID` 永远排最后,其余按 `last_accessed_at` 降序(最近访问在前)。

#### 3.4.4 pickDefaultsFromRecentSession(sessions, workingDir)(`:94-111`)

- 空 `workingDir` → `null`(`:98`)。
- 过滤 `s.workspace === workingDir`,按 `updated_at` 降序,取第一个(`:99-102`)。
- 无匹配 → `null`;否则返回 `{ session, defaults: { llm_account: session.llm_account, llm_model: session.llm_model } }`。
- 用途:新建会话弹窗里,选定目录后自动套用该目录最近一次用过的 provider/model。

---

### 3.5 useOnboarding(新手引导,driver.js)

文件:`frontend-desktop/src/hooks/useOnboarding.ts`(119 行)。依赖 `driver.js` 及其样式 `driver.js/dist/driver.css`(`:2-3`)。

#### 3.5.1 机制与常量

- 每个页面一组步骤、各自一个 localStorage 标志,每机只引导一次;目标用 `data-tour="..."` 选择器定位(`:6-7`)。
- `PREFIX = 'onboarding.'`(`:9`),`VERSION = 'v1'`(`:10`),`key(tour) = `onboarding.${tour}.v1``(`:11`)。
- `TourKey = 'main' | 'workspace' | 'llm' | 'skills'`(`:13`);`ALL_TOURS`(`:14`)= 这四个。
- `_active = false`(模块级,`:17`)——同一时刻只允许一个引导在跑,避免叠加。

#### 3.5.2 标志读写

- `tourSeen(tour): boolean`(`:19-21`):`localStorage.getItem(key(tour)) === '1'`。
- `markTourSeen(tour): void`(`:22-24`):`localStorage.setItem(key(tour), '1')`,try/catch 吞配额错误。

#### 3.5.3 useFirstVisitTour(tour, steps, opts)(`:31-66`)

- 入参:`tour: TourKey`,`steps: DriveStep[]`,`opts: { enabled?: boolean; delayMs?: number }`。
- `enabled = opts.enabled ?? true`(`:36`)。
- effect 依赖 `[tour, enabled]`(`:65`,steps/lang 在运行时读取)。
- 若 `!enabled || tourSeen(tour)` 直接返回(`:39`)。
- 设 `setTimeout`(`opts.delayMs ?? 400` ms,`:40/61`):
  - 再次判 `tourSeen`、`_active`——已看过或已有引导在跑则不弹(`:41-42`)。
  - `present` = 过滤出当前 DOM 真实存在的步骤(`!s.element || document.querySelector(...)`,`:43-45`);全不存在则 return 且**不标记**已看(等下次满足再引导,`:46`)。
  - `_active = true`(`:47`);按 `lang==='en'` 构造 driver 实例(`:48-59`):
    - `showProgress: true`、`allowClose: true`、`overlayColor: 'rgba(15,31,61,0.55)'`。
    - 按钮文案:`nextBtnText` 英 `Next`/中 `下一步`;`prevBtnText` 英 `Back`/中 `上一步`;`doneBtnText` 英 `Done`/中 `完成`(`:52-54`)。
    - `progressText: '{{current}} / {{total}}'`(`:55`)。
    - `steps: present`。
    - `onDestroyed`(`:58`,走完或中途关闭都触发):`_active = false; markTourSeen(tour)`。
  - `d.drive()` 启动。
- 清理:`clearTimeout(timer)`(`:62`)。

#### 3.5.4 各页步骤定义

`tr(lang, zh, en)`(`:70`)= `lang==='en' ? en : zh`。

- **mainTourSteps(lang)**(`:73-85`)——进入主界面即引导(此时无会话,聊天/工作区未出现):
  1. `[data-tour="new-session"]` — 标题 新建会话/New Session;描述 中:"点这里新建会话、选择工作目录,开始一个任务。"
  2. `[data-tour="session-list"]` — 标题 会话列表/Sessions;描述 中:"你的历史会话都在这里,点击即可切换。"
  3. `[data-tour="user-menu"]` — 标题 设置/Settings;描述 中:"大模型配置、Skill 管理都在设置里。"
- **workspaceTourSteps(lang)**(`:88-97`)——有会话/草稿后引导:
  1. `[data-tour="chat-area"]` — 对话区/Chat;中:"在这里输入需求,和 AI 一步步协作完成任务。"
  2. `[data-tour="workspace"]` — 工作区/Workspace;中:"AI 产出的文件会出现在这里,可直接预览。"
- **llmTourSteps(lang)**(`:99-108`):
  1. `[data-tour="llm-add"]` — 添加大模型/Add Model;中:"点这里添加一个大模型账号。"
  2. `[data-tour="llm-list"]` — 大模型列表/Models;中:"已配置的模型在这里,可以管理你自己配置的模型。"
- **skillsTourSteps(lang)**(`:110-119`):
  1. `[data-tour="skills-tabs"]` — 本地 Skill / Skill 市场;中:"可以在 Skill 市场下载安装更多 Skill 到本地。"
  2. `[data-tour="skills-import"]` — 导入 Skill;中:"可以从这里导入自己的 Skill(zip 文件)。"

> 对应 SessionList 中埋的锚点:`data-tour="session-list"`(`SessionList.tsx:125`)、`data-tour="new-session"`(`:130`)、`data-tour="user-menu"`(`:181`)。

---

### 3.6 状态徽标 StatusBadge

文件:`frontend-desktop/src/components/ui/badge.tsx`(25 行)。

容器 span(`:20`):`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium` + 状态样式 + className。文字 = `t('status.' + status)`(`:21`)。

`STATUS_STYLES`(`:5-15`,Tailwind 类),逐项颜色:

| 状态 | 类 | 背景 | 文字 | 动画 | 中文文案(i18n) |
|---|---|---|---|---|---|
| `QUEUED` | `bg-[#eaf0fb] text-[#8aa3bf]` | `#eaf0fb`(=bg3) | `#8aa3bf`(=t3) | 无 | 等待中 |
| `RUNNING` | `bg-[rgba(37,99,235,0.09)] text-[#2563eb] animate-pulse` | `rgba(37,99,235,0.09)`(=blue-dim) | `#2563eb`(=blue) | `animate-pulse` 脉冲 | 运行中 |
| `WAITING_INPUT` | `bg-amber-50 text-amber-600 animate-pulse` | amber-50 `#fffbeb` | amber-600 `#d97706` | `animate-pulse` | 等待输入 |
| `PAUSED_HITL` | `bg-amber-50 text-amber-600` | `#fffbeb` | `#d97706` | 无 | 等待输入 |
| `PAUSED` | `bg-[#eaf0fb] text-[#8aa3bf]` | `#eaf0fb` | `#8aa3bf` | 无 | 暂停 |
| `SUCCEEDED` | `bg-emerald-50 text-emerald-600` | emerald-50 `#ecfdf5` | emerald-600 `#059669` | 无 | 完成 |
| `FAILED` | `bg-red-50 text-red-600` | red-50 `#fef2f2` | red-600 `#dc2626` | 无 | 失败 |
| `CANCELED` | `bg-[#eaf0fb] text-[#8aa3bf]` | `#eaf0fb` | `#8aa3bf` | 无 | 已取消 |
| `INTERRUPTED` | `bg-[#eaf0fb] text-[#8aa3bf]` | `#eaf0fb` | `#8aa3bf` | 无 | 已中断 |

> Tailwind 调色板 hex(amber/emerald/red 50/600)为 Tailwind 默认值,确认值。i18n 文案见 `i18n.tsx:84-92`。
> 注意 `WAITING_INPUT` 与 `PAUSED_HITL` 中文均为"等待输入"(`i18n.tsx:86-87`)。

`SessionStatus` 联合类型与 `TERMINAL_STATUSES` 见 3.7。

---

### 3.7 Button 组件(取消/删除/创建等公用按钮)

文件:`frontend-desktop/src/components/ui/button.tsx`(31 行)。

Props(`:4-8`):`variant?: 'default' | 'ghost' | 'danger' | 'outline'`(默认 `'default'`)、`size?: 'sm' | 'md' | 'icon'`(默认 `'md'`)、`loading?: boolean`,其余继承 `ButtonHTMLAttributes`。

`disabled = disabled || loading`(`:13`)。基础类(`:15`):`inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2563eb] disabled:pointer-events-none disabled:opacity-50`。

- size:`sm`→`h-7 px-2.5 text-xs`;`md`→`h-8 px-3 text-sm`;`icon`→`h-7 w-7 p-0`(`:16-18`)。
- variant(`:19-22`):
  - `default`:`bg-[#2563eb] text-white hover:bg-[#1d4ed8]`(蓝底白字,hover 深蓝)。
  - `ghost`:`hover:bg-[#eaf0fb]`(透明,hover 浅蓝)。
  - `outline`:`border border-[#dde6f3] text-[#3d5a80] hover:bg-[#eaf0fb] hover:border-[#c6d5eb]`。
  - `danger`:`bg-red-50 text-red-600 hover:bg-red-100`(浅红底红字,hover 加深)。

本章用到:删除确认的"取消"(`outline/sm`)、"删除"(`danger/sm`);新建弹窗的"取消"(`outline/md`)、"创建会话"(`default/md`,可 disabled)。

---

### 3.8 LoginGate(启动登录门)

文件:`frontend-desktop/src/components/LoginGate.tsx`(80 行)。

> 注释(`:5-8`):未登录时显示;点"登录"→ 调 Electron 主进程打开浏览器走 OAuth,成功 resolve user 后通知上层切到常规界面。

#### 3.8.1 Props / state

- props:`{ onLogin: (user: AuthUser) => void }`(`:9`)。
- `{ lang } = useI18n()`,`en = lang === 'en'`(`:10-11`)。
- `loading: boolean`(`:12`,初值 false)、`error: string`(`:13`,初值 '')。

#### 3.8.2 doLogin()(`:15-25`)

`setError(''); setLoading(true)`;`try` 中 `await window.electronAPI!.login!()`(非空断言,假定 Electron 提供),成功 `onLogin(user)`;`catch` 设 `error = e?.message ?? (en ? 'Login failed' : '登录失败')` 并 `setLoading(false)`。
> 注意:成功路径不复位 loading(随后上层切走该界面);失败才复位。

#### 3.8.3 UI(`:27-79`)

- **全屏容器**(`:28-31`):`flex h-screen flex-col items-center justify-center`,背景 `var(--bg2)`,色 `var(--t1)`。
- **卡片**(`:32-38`):`flex flex-col items-center`,`width:320 padding:'40px 32px'`,背景 `var(--bg1)`,边框 `1px solid var(--border)`,`borderRadius:12`,阴影 `var(--shadow)`。
  - **Logo**(`:39`):`<img src="/icon.svg" alt="" style={{ width:56, height:56, marginBottom:16 }}>`。
  - **品牌名**(`:40-42`):`fontSize:18 fontWeight:700 letterSpacing:'0.5px' marginBottom:6`,文字 `IPMaster-Cowork`。
  - **副标题**(`:43-47`):`fontSize:13 color:var(--t3) marginBottom:28 textAlign:center lineHeight:1.6`;`loading` 时 中:"正在浏览器中登录…"/英:"Logging in via your browser…";否则 中:"请登录以继续使用"/英:"Sign in to continue"。
  - **错误**(`:49-51`,仅 `error`):`fontSize:12 color:var(--red) marginBottom:14 textAlign:center`,显示 `error`。
  - **登录按钮**(`:53-64`):`width:100% padding:'10px 0' borderRadius:8 border:none`,背景 `var(--btn-primary-bg)` 色 `var(--btn-primary-fg)`(见 3.0 注:这两变量未在 index.css :root 定义,需确认),`fontSize:14 fontWeight:600`;`cursor: loading?'not-allowed':'pointer'`,`opacity: loading?0.6:1`,过渡 `var(--tr)`;`disabled={loading}`。文案:`loading` 时 中:"等待浏览器授权…"/英:"Waiting for browser…";否则 中:"登录"/英:"Sign in"。点击 `doLogin`。
  - **取消按钮**(`:66-76`,仅 `loading`):`marginTop:10 fontSize:12 color:var(--t3)`,透明无边框;点击 `setLoading(false); setError('')`。文案 中:"取消"/英:"Cancel"。

---

### 3.9 类型定义 types/index.ts(逐字段)

文件:`frontend-desktop/src/types/index.ts`(87 行)。

#### 3.9.1 SessionStatus(`:1-3`)

联合类型:`'QUEUED' | 'RUNNING' | 'WAITING_INPUT' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'INTERRUPTED' | 'PAUSED_HITL' | 'PAUSED'`。

#### 3.9.2 TERMINAL_STATUSES(`:5`)

`SessionStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELED', 'INTERRUPTED']`——终态集合。

#### 3.9.3 AuthUser(`:7-12`)——桌面端浏览器登录后的云端用户(来自 `/api/oauth/token` 的 user 字段)

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | `string` | 用户 id |
| `username` | `string` | 用户名 |
| `role` | `string` | 角色 |

#### 3.9.4 Session(`:14-31`)

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | `string` | 会话 id |
| `user_prompt` | `string` | 用户首条提示 |
| `goal` | `string` | 会话目标(列表标题优先用它) |
| `status` | `SessionStatus` | 状态 |
| `template_id` | `string \| null` | 模板 id |
| `root_agent_id` | `string \| null` | 根 agent id |
| `token_budget` | `number` | token 预算 |
| `input_tokens_used` | `number` | 已用输入 token |
| `output_tokens_used` | `number` | 已用输出 token |
| `context_tokens` | `number` | 上下文 token |
| `failure_counter` | `number` | 失败计数 |
| `llm_account` | `string \| null` | 使用的 LLM 提供方(provider 名) |
| `llm_model` | `string \| null` | 使用的模型名 |
| `workspace` | `string` | 工作目录(分组键) |
| `created_at` | `string` | 创建时间(ISO) |
| `updated_at` | `string` | 更新时间(ISO,排序用) |

#### 3.9.5 CreateSessionRequest(`:33-40`)

| 字段 | 类型 | 含义 |
|---|---|---|
| `user_prompt` | `string` | 首条提示(必填) |
| `template_id?` | `string \| null` | 模板 id |
| `token_budget?` | `number` | token 预算 |
| `llm_account?` | `string \| null` | provider |
| `llm_model?` | `string \| null` | 模型 |
| `workspace?` | `string \| null` | 工作目录 |

#### 3.9.6 LLMStyle(`:42`)

`'openai' | 'anthropic'`。

#### 3.9.7 ModelConfig(`:44-47`)

`{ name: string;  context_limit: number }`——模型名 + 上下文上限。

#### 3.9.8 LLMProvider(`:49-56`)

| 字段 | 类型 | 含义 |
|---|---|---|
| `name` | `string` | 提供方名 |
| `style` | `LLMStyle` | 接口风格(openai/anthropic) |
| `base_url` | `string` | API 基址 |
| `models` | `ModelConfig[]` | 模型列表 |
| `default_model` | `string` | 默认模型名 |
| `timeout_sec` | `number` | 超时(秒) |

#### 3.9.9 RegisterLLMRequest(`:58-66`)

| 字段 | 类型 | 含义 |
|---|---|---|
| `name` | `string` | 提供方名 |
| `style` | `LLMStyle` | 风格 |
| `api_key` | `string` | 密钥 |
| `base_url?` | `string` | 基址 |
| `models?` | `{ name: string; context_limit?: number \| null }[]` | 模型 |
| `default_model?` | `string` | 默认模型 |
| `timeout_sec?` | `number` | 超时 |

#### 3.9.10 PendingSession(`:68-72`)——草稿(NewSessionDialog 产出)

| 字段 | 类型 | 含义 |
|---|---|---|
| `workingDir` | `string` | 工作目录 |
| `provider` | `string` | LLM 提供方 |
| `model` | `string` | 模型 |

#### 3.9.11 WorkspaceEntry(`:74-79`)

| 字段 | 类型 | 含义 |
|---|---|---|
| `name` | `string` | 文件/目录名 |
| `path` | `string` | 路径 |
| `is_dir` | `boolean` | 是否目录 |
| `size` | `number \| null` | 大小(目录为 null) |

#### 3.9.12 WorkspaceListing(`:81-86`)

| 字段 | 类型 | 含义 |
|---|---|---|
| `root` | `string` | 根目录 |
| `path` | `string` | 当前路径 |
| `parent` | `string` | 父路径 |
| `entries` | `WorkspaceEntry[]` | 条目列表 |

---

### 3.10 sessions API 速查(本章相关)

文件:`frontend-desktop/src/api/sessions.ts`。基址经 Vite 代理 `/api` → 后端 `:15926`,`http` 实际前缀为 `/api/v1`(需确认确切版本前缀,但路径相对 `/sessions`)。

| 方法 | HTTP | 路径 | 返回 |
|---|---|---|---|
| `list` (`:9`) | GET | `/sessions` | `Session[]` |
| `get` (`:10`) | GET | `/sessions/{id}` | `Session` |
| `create` (`:11`) | POST | `/sessions`(body `CreateSessionRequest`) | `Session` |
| `interrupt` (`:12`) | POST | `/sessions/{id}/interrupt` | `Session` |
| `resume` (`:14`) | POST | `/sessions/{id}/resume`(续跑 INTERRUPTED) | `Session` |
| `delete` (`:15`) | DELETE | `/sessions/{id}` | `void` |
| `sendMessage` (`:16-26`) | POST | `/sessions/{id}/messages`(body `{content, llm_account, llm_model}`) | `Session` |
| `answerInput` (`:28-29`) | POST | `/sessions/{id}/messages`(body `{content}`,HITL 应答) | `Session` |
| `getBashReviewMode` (`:30`) | GET | `/sessions/{id}/bash-review-mode` | `{mode:'auto'\|'manual'}` |
| `setBashReviewMode` (`:32`) | PUT | `/sessions/{id}/bash-review-mode` | `{mode:'auto'\|'manual'}` |

本章直接用到的是 `list`(列表轮询)与 `delete`(删除会话);`create` 在聊天区首条消息时触发(不在本章组件内)。`MessageContent`/`TextPart`/`ImagePart` 类型见 `sessions.ts:4-6`。


---

## 4. LLM 账号设置 与 技能(Skills)管理

本章覆盖 IPMaster-Cowork 桌面前端(`frontend-desktop`,React 19 + Vite + Tailwind v4)中两大配置页面及其底层 API 封装:

- LLM 账号(大模型供应商 / Provider)设置:`src/components/LLMSettingsPage.tsx`(508 行,当前线上使用的"页面版")与 `src/components/LLMSettingsDialog.tsx`(203 行,旧的"弹窗版",简化、无 ping、无 i18n)。
- 技能(Skills)管理:`src/components/SkillsPage.tsx`(500 行,本地/市场两 Tab、导入、安装、删除)。
- API 封装:`src/api/llms.ts`(41 行)、`src/api/skills.ts`(44 行),底层走 `src/api/client.ts`。

所有 `/api/...` 请求经 Vite 代理转发到后端 `:15926`(见全局配置);本章 API 路径均为 `client.ts` 中 `BASE = '/api/v1'` 之后的相对路径,实际请求 URL = `/api/v1` + 路径。

> 文中所有"行号"均指对应源文件当前内容的行号。读不准之处标注"(需确认)"。

---

### 4.0 底层 HTTP 客户端与设计令牌(贯穿全章)

#### 4.0.1 `src/api/client.ts`

- `BASE = '/api/v1'`(`client.ts:1`)。
- `request<T>(method, path, body?)`(`client.ts:3-15`):
  - `fetch(\`${BASE}${path}\`, { method, headers, body })`。
  - 仅当 `body !== undefined` 时设置 `Content-Type: application/json` 并 `JSON.stringify(body)`(`client.ts:6-7`)。
  - 失败(`!res.ok`):尝试 `res.json()`,取错误信息优先级为 `err.detail?.message ?? err.message ?? res.statusText`,`throw new Error(...)`(`client.ts:9-12`)。这是页面里 `mut.error?.message` / `setAddError(e.message)` 文案的来源。
  - `res.status === 204` 返回 `undefined as T`(`client.ts:13`);否则 `res.json()`。
- `upload<T>(path, file, fieldName='file')`(`client.ts:17-26`):构造 `FormData`,`form.append('file', file)`,`POST`,无 `Content-Type`(由浏览器自动带 multipart 边界)。错误处理同上。注意:`upload` 失败抛错,但**成功路径未判断 204**,直接 `res.json()`。
- 导出 `http`(`client.ts:28-34`):`get/post/put/delete/upload`。其中 `delete` 也支持可选 `body`(`client.ts:32`),`llms.ts` 的 `removeModel` 用到了这一点。

#### 4.0.2 设计令牌(CSS 变量,`src/index.css:5-28`)

两个页面大量以内联 `style` 引用以下变量(浅色主题):

| 变量 | 值 | 用途 |
|---|---|---|
| `--bg0` | `#f0f4fa` | 页面根背景 |
| `--bg1` | `#ffffff` | 卡片/Header/弹窗背景 |
| `--bg2` | `#f5f8fe` | 输入框/模型 chip/卡片 footer 背景 |
| `--bg3` | `#eaf0fb` | 关闭按钮 hover 背景、版本号徽标背景 |
| `--border` | `#dde6f3` | 默认边框 |
| `--border2` | `#c6d5eb` | hover 边框、分隔竖线 |
| `--blue` | `#2563eb` | 主色:标题图标、默认模型、Tab 激活、链接 |
| `--blue-dim` | `rgba(37,99,235,.09)` | 高亮卡片背景、触发词 chip、Skill 图标底 |
| `--blue-glow` | `rgba(37,99,235,.2)` | (本章未直接用) |
| `--amber` | `#d97706` | 星标(默认模型)图标色、Anthropic 徽标文字 |
| `--red` | `#dc2626` | 删除、错误文字/边框 |
| `--green` | `#16a34a` | ping 成功、已安装 |
| `--t1` | `#0f1f3d` | 主文字 |
| `--t2` | `#3d5a80` | 次文字 |
| `--t3` | `#8aa3bf` | 弱文字/占位/图标 |
| `--shadow` | `0 1px 4px rgba(15,31,61,.07)` | 卡片阴影 |
| `--shadow2` | `0 4px 16px rgba(15,31,61,.1)` | 卡片 hover 阴影 |
| `--tr` | `.15s ease` | 通用过渡 |

注意 `--green` 在 LLMSettingsPage 里被写成带回退的 `var(--green, #16a34a)`(`LLMSettingsPage.tsx:234,435`),回退值与变量定义相同。

#### 4.0.3 通用 `Button`(`src/components/ui/button.tsx`)

- Props:`variant?: 'default'|'ghost'|'danger'|'outline'`(默认 `default`)、`size?: 'sm'|'md'|'icon'`(默认 `md`)、`loading?`(`button.tsx:4-8`)。
- `disabled = disabled || loading`(`button.tsx:13`)。注意:组件**不渲染 spinner**,`loading` 仅用于禁用与降低不透明度;视觉上"加载中"= 按钮变灰不可点。(需确认是否有更上层的 spinner 注入——此文件内没有。)
- 基类(`button.tsx:14-15`):`inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2563eb] disabled:pointer-events-none disabled:opacity-50`。
- 尺寸:`sm` → `h-7 px-2.5 text-xs`;`md` → `h-8 px-3 text-sm`;`icon` → `h-7 w-7 p-0`(`button.tsx:16-18`)。
- 变体(`button.tsx:19-22`):
  - `default`:`bg-[#2563eb] text-white hover:bg-[#1d4ed8]`
  - `ghost`:`hover:bg-[#eaf0fb]`
  - `outline`:`border border-[#dde6f3] text-[#3d5a80] hover:bg-[#eaf0fb] hover:border-[#c6d5eb]`
  - `danger`:`bg-red-50 text-red-600 hover:bg-red-100`

#### 4.0.4 通用 `Input` / `Select`(`src/components/ui/input.tsx`)

- `Input`(`input.tsx:9-27`):外层 `div.flex flex-col gap-1`;可选 `label`(`text-xs`,`color: var(--t2)`);`input` 基类 `h-8 rounded-md border px-3 text-sm focus:outline-none focus:ring-1 focus:ring-[#2563eb] disabled:opacity-50`,`error` 时追加 `border-red-400`;内联 `style` `borderColor: var(--border)`、`background: var(--bg2)`、`color: var(--t1)`;`error` 文案 `text-xs text-red-500`。
- `Select`(`input.tsx:29-47`):同结构,`select` 基类 `h-8 rounded-md border px-2 text-sm focus:ring-[#2563eb]`,同样的内联颜色。

---

### 4.1 LLM 账号设置页 — `LLMSettingsPage.tsx`(508 行,线上使用)

#### 4.1.1 组件结构与顶层状态

`LLMSettingsPage({ onClose }: { onClose?: () => void })`(`:11`)是导出主组件。内含三个文件内子组件:`CloseButton`(`:107`)、`ProviderCard`(`:126`)、`AddProviderForm`(`:313`)。

顶层 hooks / state(`:12-20`):
- `qc = useQueryClient()`。
- `{ t, lang } = useI18n()`(中英文案,见 §4.0.5 文案表)。
- `view: 'list' | 'add'`,`useState('list')`(`:14`)。控制"列表视图"与"添加供应商视图"切换。
- `confirmDelete: string | null`,`useState(null)`(`:15`)。存放待删除 provider 的 `name`,非空即弹出删除确认框。
- `useFirstVisitTour('llm', llmTourSteps(lang), { enabled: view === 'list' })`(`:18`):首次进入仅在 list 视图触发新手引导(引导步骤来自 `@/hooks/useOnboarding`)。
- React Query:`useQuery({ queryKey: ['llms'], queryFn: llmsApi.list })`,解构 `data: providers = []`(`:20`)。**React Query key:`['llms']`**,全章 provider 列表统一用此 key,增删改后 `invalidateQueries(['llms'])` 刷新。
- `deleteMut`(`:22-25`):`mutationFn: (name) => llmsApi.delete(name)`;`onSuccess` → `invalidateQueries(['llms'])` 且 `setConfirmDelete(null)`(关闭弹窗)。

`LLMProvider` 类型(`@/types`)在本页用到的字段:`name`、`style`(`'openai'|'anthropic'`)、`base_url?`、`models: ModelConfig[]`、`default_model`。**完整逐字段定义以 §3.9.8(`types/index.ts:49-56`)为准**——此处为本页用到字段的速写,省略了 `timeout_sec`;`ModelConfig` 仅含 `name`/`context_limit`(§3.9.7,`:44-47`,前端类型**无** `max_output_tokens`)。

#### 4.1.2 整页布局

- 根 `div.flex h-full flex-col`,`style={{ background: 'var(--bg0)' }}`(`:28`)。
- Header(`:30-54`):`background: var(--bg1)`,`borderBottom: 1px solid var(--border)`;内层 `px-6 pt-5 pb-4`。
  - list 视图(`:32-37`):若有 `onClose` 渲染 `CloseButton`;`Wand2Icon size={16} color=var(--blue)`;`h1.text-base font-semibold`(`color: var(--t1)`)文案 `t('llm.title')`(中:"LLM 配置")。
  - add 视图(`:38-52`):返回按钮(`<button>` `text-xs`,`color: var(--t3)`,hover 变 `var(--t1)`,内含 `ChevronLeftIcon size={14}` + `t('common.back')`"返回")→ 竖线分隔符 `|`(`color: var(--border2)`,`fontSize: 12`)→ `h1` 文案 `t('llm.addProvider')`"添加大模型"。
- Content(`:57-82`):`div[data-tour="llm-list"].flex-1 overflow-y-auto p-5`。
  - `view==='add'` → 渲染 `<AddProviderForm onDone={()=>setView('list')} />`(`:59`)。
  - 否则(list):
    - 右对齐"添加大模型"按钮区 `div[data-tour="llm-add"].flex justify-end mb-4`(`:62`):`<Button size="sm" style={{ width: 150 }} onClick={()=>setView('add')}>` 含 `PlusIcon size={13}` + `t('llm.addProvider')`(`:63-65`)。
    - `providers.length === 0`(空态,`:67-72`):垂直居中 `py-16 gap-3`;`Wand2Icon size={32}`(`color: var(--t3)`,`opacity: .4`);`t('llm.emptyTitle')`"尚未配置任何大模型"(`text-sm font-medium`,`var(--t2)`);`t('llm.emptyDesc')`"添加大模型后即可在对话中使用"(`text-xs`,`var(--t3)`)。
    - 否则渲染 `div.flex flex-col gap-2.5`,`providers.map` → `<ProviderCard key={p.name} provider={p} onDelete={()=>setConfirmDelete(p.name)} />`(`:74-78`)。

#### 4.1.3 删除确认弹窗(`:85-102`)

`confirmDelete` 非空时渲染:
- 遮罩 `div.fixed inset-0 z-50 flex items-center justify-center`,`style={{ background: 'rgba(15,31,61,.4)', backdropFilter: 'blur(4px)' }}`(`:86`)。
- 弹窗体 `div.w-80 p-5`:`background: var(--bg1)`、`border: 1px solid var(--border)`、`borderRadius: 16`、`boxShadow: 0 24px 80px rgba(15,31,61,.2)`(`:87`)。
- 标题行(`:88-91`):`Trash2Icon size={14} color=var(--red)` + `t('llm.deleteTitle')`"删除大模型"(`text-sm font-semibold`,`var(--t1)`)。
- 正文(`:92-95`):`text-xs leading-relaxed`(`var(--t2)`);拼接 `t('llm.deleteConfirmPre')`("确认删除 ")+ `<span class="font-mono font-semibold" color=var(--t1)>{confirmDelete}</span>` + `t('llm.deleteConfirmPost')`("?")+ `<br/>` + `t('llm.deleteConfirmNote')`("关联的模型配置将一并删除,此操作不可撤销。")。
- 操作区(`:96-99`):右对齐 `gap-2`;
  - `<Button variant="outline" size="sm" onClick={()=>setConfirmDelete(null)}>` = `t('common.cancel')`"取消"。
  - `<Button variant="danger" size="sm" loading={deleteMut.isPending} onClick={()=>deleteMut.mutate(confirmDelete)}>` = `t('common.delete')`"删除"。点击触发 `DELETE /llms/{name}`。

#### 4.1.4 `CloseButton`(`:107-120`)

`w-7 h-7 flex items-center justify-center rounded-md` 透明按钮,`color: var(--t3)`;hover:`background: var(--bg3)`、`color: var(--t1)`(JS `onMouseEnter/Leave` 切换)。图标 `ChevronLeftIcon size={18}`。`title` 来自传入(此处为 `t('common.close')`"关闭")。

#### 4.1.5 `ProviderCard`(`:126-309`) — 单个供应商卡片

类型别名 `ModelPingMap = Record<string, { state:'idle'|'loading'|'ok'|'error'; latency?: number; error?: string }>`(`:124`)。

子组件 state / mutation(`:127-170`):
- `qc`、`{ t }`。
- `newModel`(`useState('')`,`:129`):新增模型输入框值。
- `addError`(`useState('')`,`:130`):新增模型时的错误文案。
- `modelPings: ModelPingMap`(`useState({})`,`:131`):每个模型的 ping 状态。

四个 mutation:

1) **`addMut`(验证并添加模型,`:134-148`)** —— "先 ping 再持久化"两步:
   - `mutationFn(modelName)`:先 `await llmsApi.pingRegistered(p.name, modelName)`;若 `!pingResult.ok` 抛 `new Error(pingResult.error || t('llm.connectFailed'))`;否则 `await llmsApi.addModel(p.name, modelName)`,返回 `{ provider, latency: pingResult.latency_ms }`(`:135-140`)。
   - `onMutate`:`setAddError('')`。
   - `onSuccess({latency}, modelName)`:`invalidateQueries(['llms'])`、`setNewModel('')`、`setModelPings[modelName] = { state:'ok', latency }`(`:142-146`)。
   - `onError(err)`:`setAddError(err.message || t('llm.connectFailed'))`(`:147`)。
   - 涉及 API:`POST /llms/{name}/ping?model=...`(pingRegistered) + `POST /llms/{name}/models`(addModel)。

2) **`removeModelMut`(删除模型,`:149-155`)**:`mutationFn(model) => llmsApi.removeModel(p.name, model)`;`onSuccess(_, model)` → `invalidateQueries(['llms'])` 并从 `modelPings` 删除该键。API:`DELETE /llms/{name}/models`(body `{ model }`)。

3) **`setDefaultMut`(设为默认模型,`:156-159`)**:`mutationFn(model) => llmsApi.setDefault(p.name, model)`;`onSuccess` → `invalidateQueries(['llms'])`。API:`PUT /llms/{name}/default_model`(body `{ model }`)。

4) **`pingMut`(测试连通性,`:160-170`)**:
   - `mutationFn(model) => llmsApi.pingRegistered(p.name, model)`。
   - `onMutate(model)`:`setModelPings[model] = { state:'loading' }`。
   - `onSuccess(data, model)`:`data.ok ? { state:'ok', latency: data.latency_ms } : { state:'error', error: data.error || t('llm.connectFailed') }`。
   - `onError(err, model)`:`{ state:'error', error: err.message || t('llm.connectFailed') }`。
   - API:`POST /llms/{name}/ping?model=...`。

`isOpenAI = p.style === 'openai'`(`:172`)。

卡片 DOM:
- 容器 `div.rounded-xl`(`:175`):`border: 1px solid var(--border)`、`background: var(--bg1)`、`boxShadow: var(--shadow)`、`overflow: hidden`。
- **卡头**(`:177-202`):`flex items-center justify-between gap-3 px-4 py-3`。
  - 左:`p.name`(`text-sm font-semibold`,`var(--t1)`)+ 类型徽标 `span.rounded-full px-2 py-0.5 text-xs font-medium`(`:180-186`):
    - OpenAI 时 `background: rgba(37,99,235,.09)`、`color: var(--blue)`,文案 `t('llm.openaiCompat')`"OpenAI 兼容";
    - Anthropic 时 `background: rgba(217,119,6,.1)`、`color: var(--amber)`,文案字面量 `'Anthropic'`。
  - 若 `p.base_url`:`span` 含 `ServerIcon size={10}` + `base_url`(`text-xs truncate`,`var(--t3)`)(`:187-191`)。
  - 右:删除按钮(`:193-201`)`w-6 h-6 rounded-md`,默认 `color: var(--t3)`;hover → `color: var(--red)`、`background: rgba(220,38,38,.06)`;图标 `Trash2Icon size={12}`;`onClick={onDelete}`(冒泡到顶层 `setConfirmDelete(p.name)`,弹确认框)。
- **模型区**(`:205-306`):`px-4 pb-3`,`borderTop: 1px solid var(--border)`。
  - 小标题 `p.text-[11px] font-semibold mt-2.5 mb-2`(`color: var(--t3)`,`textTransform: uppercase`,`letterSpacing: .07em`)= `t('llm.models')`"模型"。
  - **已有模型 chips**(`p.models.length>0` 时,`:208-269`),容器 `flex flex-wrap items-start gap-1.5 mb-2`。每个模型:
    - `isDefault = m.name === p.default_model`(`:211`)。
    - `ping = modelPings[m.name] ?? { state:'idle' }`(`:212`)。
    - `isPinging = ping.state==='loading' && pingMut.variables===m.name && pingMut.isPending`(`:213`)。
    - 外层 `div.flex flex-col gap-1`,固定 `width: 184, flexShrink: 0`(`:215`)。
    - chip `div.group flex items-center gap-1 rounded-md px-2 py-1 text-xs w-full min-w-0`(`:216-223`):
      - 背景:`isDefault ? 'rgba(37,99,235,.07)' : 'var(--bg2)'`。
      - 边框色优先级(`:220`):`ping.state==='ok'` → `rgba(22,163,74,.25)`(绿);`'error'` → `rgba(220,38,38,.25)`(红);否则 `isDefault` → `rgba(37,99,235,.18)`(蓝);否则 `var(--border)`。
      - 文字色:`isDefault ? var(--blue) : var(--t2)`。
    - **星标(设为默认)**(`:224-230`):`StarIcon size={9}`,`fill={isDefault?'currentColor':'none'}`,`cursor-pointer`;`color: isDefault ? var(--amber) : var(--t3)`;`onClick={() => !isDefault && setDefaultMut.mutate(m.name)}`(已是默认则不响应)。→ `PUT /llms/{name}/default_model`。
    - 模型名:`span.font-mono text-xs truncate flex-1`,`title={m.name}`(`:231`)。
    - **ping 成功展示**(`ping.state==='ok'`,`:233-238`):`span` 含 `CheckCircle2Icon size={9}` + `{ping.latency}ms`(`fontSize:10`),色 `var(--green,#16a34a)`。
    - **ping 失败标记**(`ping.state==='error'`,`:239-241`):`AlertCircleIcon size={9}`,色 `var(--red)`。
    - **ping 按钮(测试连通性)**(`:243-251`):`WifiIcon size={9}`;类 `opacity-0 group-hover:opacity-100 transition-opacity`(平时隐藏,hover chip 才显);`disabled={isPinging}`;`title={t('llm.testConnection')}`"测试连通性";`onClick={()=>pingMut.mutate(m.name)}`;loading 时 `opacity:0.4`、`cursor:default`。
    - **删除模型按钮**(`:252-258`):`XIcon size={9}`,同 `opacity-0 group-hover:opacity-100`;`onClick={()=>removeModelMut.mutate(m.name)}`(无二次确认,直接删)。→ `DELETE /llms/{name}/models`。
    - **失败原因行**(`ping.state==='error' && ping.error`,`:260-264`):`p.text-xs rounded px-2 py-1 ml-1`,`color: var(--red)`、`background: rgba(220,38,38,.06)`、`border: 1px solid rgba(220,38,38,.12)`,显示 `ping.error`。
  - **添加模型输入区**(`:271-305`):
    - `div.flex flex-col gap-1.5` → 内 `div.flex gap-1.5`。
    - 原生 `<input>`(`:273-286`):`value={newModel}`;`onChange` 同时 `setNewModel` 与 `setAddError('')`;`onKeyDown` Enter:取 `newModel.trim()`,若 `name && 不重名 && !addMut.isPending` 则 `addMut.mutate(name)`(`:276-282`);`placeholder={t('llm.modelNamePlaceholder')}`"输入模型名称,验证后添加";类 `h-7 flex-1 rounded-md border px-2.5 text-sm focus:ring-1 focus:ring-blue-400`;`borderColor: addError ? 'rgba(220,38,38,.5)' : 'var(--border)'`、`background: var(--bg2)`、`color: var(--t1)`。
    - **验证并添加按钮**(`:287-295`):`<Button size="sm" variant="outline" loading={addMut.isPending}`;`disabled={!newModel.trim() || p.models.some(重名)}`;`onClick={()=>addMut.mutate(newModel.trim())}`;内容 `PlusIcon size={11}` + `t('llm.verifyAndAdd')`"验证并添加"。
    - **错误条**(`addError` 非空,`:297-304`):`div.flex items-start gap-2 text-xs rounded px-2 py-1`,`color/background/border` 同红色错误样式;左 `span` 显示 `addError`(`break-words`),右 `XIcon size={12}` 关闭按钮 `onClick={()=>setAddError('')}`(`title=t('common.close')`,`opacity:0.7`)。

> 备注:`llms.ts` 暴露了 `listAvailableModels` / `listAvailableModelsOf`(获取可用模型列表),i18n 也有 `llm.fetchModelsList`("从接口获取可用模型列表")与 `llm.availableModels`("可用模型")文案,但 **`LLMSettingsPage.tsx` 当前并未渲染"获取可用模型"按钮/下拉,也未调用这两个 API**(全文 grep 无引用)。该能力疑似已预留或下线(需确认)。

#### 4.1.6 `AddProviderForm`(`:313-508`) — 添加供应商表单

state(`:316-320`):
- `form`:`{ name:'', style:'openai'|'anthropic'(默认 'openai'), api_key:'', base_url:'' }`。
- `models: { name:string; isDefault:boolean }[]`(本地暂存,尚未持久化)。
- `newModel`、`modelPings`、`addError`(同 ProviderCard 含义)。

辅助函数:
- `set(k, v)`(`:322-329`):更新 `form[k]`;**若 k 为 `api_key`/`base_url`/`style` 则重置** `models=[]`、`modelPings={}`、`addError=''`(因凭证变更后此前 ping 通过的模型不再可信)。
- `removeModel(name)`(`:331-338`):从 `models` 过滤;若删后无任何 `isDefault` 且仍有模型,则把 `next[0].isDefault=true`(自动转默认);同步删 `modelPings[name]`。
- `setDefault(name)`(`:340-341`):把 `models` 各项 `isDefault` 置为 `m.name===name`。
- `defaultModel = models.find(m=>m.isDefault)?.name || models[0]?.name`(`:366`)。

mutation:
- **`addMut`(ping 后入本地列表,`:344-364`)**:
  - `mutationFn(modelName) => llmsApi.ping({ style: form.style, api_key: form.api_key.trim(), base_url: form.base_url.trim()||undefined, model: modelName })`。注意此处用**未注册** ping(`POST /llms/ping`,带完整凭证),因 provider 尚未保存。
  - `onMutate`:`setAddError('')`。
  - `onSuccess(data, modelName)`(`:352-362`):若 `!data.ok` → `setAddError(error)` 且 `modelPings[modelName]={state:'error',error}` 然后 return(不入列);否则 `models.push({ name:modelName, isDefault: prev.length===0 })`(首个自动默认)、`modelPings[modelName]={state:'ok',latency:data.latency_ms}`、`setNewModel('')`。
  - `onError(err)`:`setAddError(err.message || t('llm.connectFailed'))`。
- **`mut`(保存供应商,`:368-378`)**:`mutationFn => llmsApi.register({ name, style, api_key, base_url||undefined, models: models.map(m=>({name:m.name})), default_model: defaultModel })`;`onSuccess` → `invalidateQueries(['llms'])` + `onDone()`(回到 list)。API:`POST /llms`。

DOM(`:380-507`):
- 根 `div.flex flex-col gap-4 max-w-lg`。
- 卡片 `div.rounded-xl overflow-hidden`(`border/background/shadow` 同标准卡)。三段以 `borderTop: 1px solid var(--border)` 分隔(`:394,406`):
  1. **基本信息**(`:384-392`):`grid grid-cols-2 gap-3`:`<Input label=t('llm.name') placeholder=t('llm.namePlaceholder')>`("名称" / "供应商名称,如:OpenAI")+ `<Select label=t('llm.type')>`("类型"),选项 `t('llm.openaiCompat')`"OpenAI 兼容" / 字面量 `'Anthropic'`(`:387-390`)。
  2. **认证与端点**(`:397-404`):小标题行 `KeyRoundIcon size={11}` + `t('llm.authEndpoint')`"认证与端点"(`text-[11px] font-semibold uppercase tracking-wider`,`var(--t3)`);`<Input label="API Key" type="password" placeholder="sk-...">`;`<Input label=t('llm.baseUrlOptional') placeholder="https://api.openai.com/v1">`("Base URL(可选)")。
  3. **模型**(`:409-489`):小标题 `t('llm.models')`"模型"。
     - 已添加 chips(`models.length>0`,`:411-450`):同 ProviderCard 的 184px chip,但**始终显示 `CheckCircle2Icon` + `{ping.latency}ms`**(因能进列表即已 ping 通,`:435-438`),星标设默认走本地 `setDefault`(`:432`),删除走本地 `removeModel`(`:440`)。无 ping 按钮(本地表单不需要重测)。
     - 添加输入区(`:451-485`):同 ProviderCard,但 Enter / `disabled` 额外要求 `form.api_key.trim()` 非空(`:459,471`),`onClick` 走 `addMut.mutate`(即 `POST /llms/ping`)。错误条同前。
     - `models.length>0` 时底部提示 `t('llm.defaultHint')`"点击 ★ 设为默认;首个模型自动设为默认。"(`text-xs`,`var(--t3)`,`:486-488`)。
- `mut.isError` 时显示 `mut.error?.message`(`text-xs`,`var(--red)`,`:492-494`)。
- 底部操作(`:496-505`):右对齐;`<Button variant="outline" onClick={onDone}>`=`t('common.cancel')`"取消";`<Button disabled={!form.name.trim() || !form.api_key.trim() || models.length===0 || mut.isPending} loading={mut.isPending} onClick={()=>mut.mutate()}>`=`t('llm.saveProvider')`"保存大模型"。即保存需:名称非空、API Key 非空、至少一个已验证模型。

#### 4.1.7 加载 / 空 / 错误态小结(本页)

- 列表加载:`useQuery` 默认 `data = []`,无显式 loading 骨架;数据到达前即渲染空态(短暂)。
- 空态:见 §4.1.2(`Wand2Icon` + 两行提示)。
- provider 列表读取错误:本页未渲染 `isError` 分支(需确认是否依赖全局错误边界)。
- 模型操作错误:`addMut` → `addError` 行;`pingMut` → chip 内红边 + `AlertCircleIcon` + 失败原因行;保存错误 → `mut.error?.message`。

---

### 4.2 LLM 配置弹窗 — `LLMSettingsDialog.tsx`(203 行,旧版/简化版)

> ⚠️ **已确认为死代码(重构须知)**:全仓库检索 `LLMSettingsDialog` **无任何 import**(只有 `LLMSettingsDialog.tsx` 内部的 `export function` 自身),即它**从未被挂载/使用**,线上主路径完全走 `LLMSettingsPage`(§4.1)。重构时可放心将其视作可删除的遗留文件,无需为其保功能。下文仍保留其实现说明仅供参考(它是早期纯 Tailwind 灰白弹窗:**硬编码中文、无 i18n、无 ping/连通性测试、无错误高亮**,功能是 §4.1 的子集;共享同一 `['llms']` query key 与同一组 `llmsApi`)。

#### 4.2.1 主组件 `LLMSettingsDialog({ open, onClose })`(`:11-56`)

- Props:`{ open: boolean; onClose: () => void }`(`:9`)。`if (!open) return null`(`:21`)。
- state:`view: 'list'|'add'`(`:13`);`useQuery(['llms'], llmsApi.list)` → `providers`(`:14`);`deleteMut`(`:16-19`):`llmsApi.delete(name)`,`onSuccess` 仅 `invalidateQueries(['llms'])`(**无确认弹窗,直接删**)。
- 遮罩 `div.fixed inset-0 z-50 flex items-center justify-center bg-black/40`(`:24`)。
- 面板 `div.w-[500px] max-h-[80vh] flex flex-col rounded-xl border border-gray-200 bg-white shadow-xl`(`:25`)。
- 头部(`:26-38`):`border-b border-gray-200 px-4 py-3`;标题 `h2.text-sm font-semibold text-gray-900` 字面量 `"LLM 配置"`;右侧:list 视图显示 `<Button size="sm" onClick=setView('add')>` `PlusIcon size={13}` + `" 添加 Provider"`;`<button onClick={onClose}>` `XIcon size={16}`(`text-gray-400 hover:text-gray-700`)。
- 内容区 `flex-1 overflow-y-auto p-4`(`:40-52`):`view==='add'` → `<AddProviderForm>`;空列表 → `<p>"尚未配置任何 LLM Provider"</p>`(`text-center text-sm text-gray-400 py-8`);否则 `providers.map` → `<ProviderCard onDelete={()=>deleteMut.mutate(p.name)} />`(直接删,无确认)。

#### 4.2.2 `ProviderCard`(`:58-111`)

- state:`newModel`;`addModelMut`(`:61-64`):`llmsApi.addModel(p.name, newModel.trim())`(**注意:旧版直接 addModel,不先 ping**),`onSuccess` invalidate + 清空;`removeModelMut`(`:65-68`);`setDefaultMut`(`:69-72`)。
- 卡片 `rounded-lg border border-gray-200 bg-gray-50 p-3`(`:75`)。
- 头部:`p.name`(`text-sm font-medium text-gray-900`)+ 副行 `p.style · (p.base_url||'默认端点')`(`text-xs text-gray-500`);右删除按钮 `Trash2Icon size={13}`(`text-gray-400 hover:text-red-500`)(`:76-84`)。
- 模型 chips(`:85-98`):`flex flex-wrap gap-1`,每个 `rounded bg-white border border-gray-200 px-2 py-0.5 text-xs text-gray-700`;默认模型前 `StarIcon size={10} text-amber-500`;hover 出现两个按钮:设默认(`StarIcon size={10}`,`title="设为默认"`,`hover:text-amber-500`,`invisible group-hover:visible`)与删除(`XIcon size={10}`,`hover:text-red-500`)。
- 添加模型(`:99-108`):原生 input `h-7 flex-1 rounded border border-gray-300 ... focus:ring-gray-400`,`placeholder="添加模型名称,回车确认"`,Enter 且 `newModel.trim()` → `addModelMut.mutate()`;`<Button size="sm" variant="outline" disabled={!newModel.trim()}>"添加"`。

#### 4.2.3 `AddProviderForm`(`:113-203`)

- state:`form`(同字段)、`models`、`newModel`(`:115-117`)。`set(k,v)`(`:118`)**不**重置 models(与页面版不同)。
- `addModel()`(`:120-125`):本地校验非空且不重名 → push(首个 `isDefault`),清空;`removeModel`(`:127-133`)与 `setDefault`(`:135-136`)逻辑同页面版;`defaultModel = models.find(isDefault)?.name`(`:138`)。
- `mut`(`:140-150`):`llmsApi.register({...})`,`onSuccess` invalidate + `onDone()`。
- DOM(`:152-202`):`grid-cols-2` 的 `<Input 名称>` + `<Select 类型>`(选项 "OpenAI 兼容"/"Anthropic");`<Input "API Key" type=password placeholder="sk-...">`;`<Input "Base URL(可选)">`;模型块 `<label>"模型"`,chips(同上,本地)+ 原生 input(`placeholder="输入模型名称,回车添加"`,Enter → `addModel`)+ `<Button>"添加"`;`mut.isError` → `text-red-500` 错误;底部 `<Button variant=outline>"取消"` + `<Button disabled={!name||!api_key||mut.isPending} loading>"保存"`。**保存不要求已添加模型**(与页面版 `models.length===0` 限制不同)。

---

### 4.3 LLM API 封装 — `src/api/llms.ts`(41 行)

类型(`:4-25`):
- `PingRequest`:`{ style:string; api_key:string; base_url?:string; model?:string }`。
- `PingResponse`:`{ ok:boolean; latency_ms:number; error?:string }`(`error` 仅 `ok=false` 时供 UI 展示)。
- `ListModelsRequest`:`{ style:string; api_key:string; base_url?:string }`。
- `AvailableModelsResponse`:`{ models: string[] }`。

`llmsApi`(`:27-41`),实际 URL 前缀 `/api/v1`:

| 方法 | HTTP + 路径 | 入参 | 返回 | 使用处 |
|---|---|---|---|---|
| `list()` | `GET /llms` | — | `LLMProvider[]` | `['llms']` query |
| `register(data)` | `POST /llms` | `RegisterLLMRequest`(速写 `{name,style,api_key,base_url?,models:{name}[],default_model?}`;**完整字段以 §3.9.9 / `types/index.ts:58-66` 为准**,含可选 `timeout_sec`,`models?` 为 `{ name; context_limit?: number \| null }[]`) | `LLMProvider` | AddProviderForm 保存 |
| `delete(name)` | `DELETE /llms/${name}` | `name` | (204/无) | 删除供应商。**name 未 encode**(需确认含特殊字符时行为) |
| `addModel(name, model, context_limit?)` | `POST /llms/${name}/models` | body `{ model, context_limit }`(`context_limit` 可选 `number|null`) | `LLMProvider` | 添加模型(UI 未传 context_limit) |
| `removeModel(name, model)` | `DELETE /llms/${name}/models` | body `{ model }` | `LLMProvider` | 删除模型(DELETE 带 body) |
| `setDefault(name, model)` | `PUT /llms/${name}/default_model` | body `{ model }` | `LLMProvider` | 设默认 |
| `ping(data)` | `POST /llms/ping` | `PingRequest`(完整凭证) | `PingResponse` | AddProviderForm 验证未注册模型 |
| `pingRegistered(name, model)` | `POST /llms/${encodeURIComponent(name)}/ping?model=${encodeURIComponent(model)}` | 路径/query | `PingResponse` | ProviderCard 测试/验证已注册 provider 的模型(**无 body**) |
| `listAvailableModels(data)` | `POST /llms/available-models` | `ListModelsRequest` | `AvailableModelsResponse` | 当前 UI 未调用 |
| `listAvailableModelsOf(name)` | `GET /llms/${encodeURIComponent(name)}/available-models` | `name` | `AvailableModelsResponse` | 当前 UI 未调用 |

注意 `pingRegistered` / `listAvailableModelsOf` 对 `name`、`model` 做了 `encodeURIComponent`,而 `delete` / `addModel` / `removeModel` / `setDefault` 的路径段 **未 encode**(`:30-36`)(需确认后端是否限制名称字符集)。

---

### 4.4 技能管理页 — `SkillsPage.tsx`(500 行)

#### 4.4.1 顶层结构 `SkillsPage({ onClose })`(`:12-43`)

- `{ t, lang } = useI18n()`;`tab: 'local'|'remote'`(`useState('local')`,`:14`)。`type Tab = 'local'|'remote'`(`:10`)。
- `useFirstVisitTour('skills', skillsTourSteps(lang))`(`:17`,无 enabled 条件,任意 tab 都可触发)。
- 根 `div.flex h-full flex-col`(`background: var(--bg0)`,`:20`)。
- Header(`:22-35`):`background: var(--bg1)`、`borderBottom: 1px solid var(--border)`;`px-6 pt-5 pb-0`;
  - 标题行(`:24-28`):可选 `CloseButton`(`title=t('common.close')`)+ `ZapIcon size={18} color=var(--blue)` + `h1.text-base font-semibold`(`var(--t1)`)字面量 `"Skills"`。
  - **Tabs**(`div[data-tour="skills-tabs"].flex gap-0`,`:30-33`):`<TabButton active={tab==='local'}>` = `t('skills.localTab')`"本地 Skills";`<TabButton active={tab==='remote'}>` = `t('skills.marketTab')`"Skill 市场"。
- 内容 `div.flex-1 overflow-y-auto`(`:38-40`):`tab==='local' ? <LocalPanel/> : <RemotePanel/>`。

`TabButton`(`:45-61`):`button.relative px-1 pb-3 mr-6 text-sm font-medium transition-colors`;激活 `color: var(--blue)` + `borderBottom: 2px solid var(--blue)`;非激活 `color: var(--t3)` + `borderBottom: 2px solid transparent`。

> 备注:章节需求提到的"添加源 / 远程技能源"在当前 `SkillsPage.tsx` 中**没有独立的"添加源"UI**。市场数据源固定为 cowork 与 mythos 两个,由后端 `pull-server/catalog` 聚合,前端不可增删源(数据源切换是隐式的,见 §4.4.3)。如确有"添加源"入口需另行确认(本文件内不存在)。

#### 4.4.2 本地 Skills 面板 `LocalPanel`(`:65-161`)

state / refs(`:66-72`):`qc`、`{t}`;`confirmId: string|null`(删除确认目标 skill_id);`importError: string|null`;`highlightId: string|null`(新导入后高亮 3s);`fileInputRef`(隐藏 `<input type=file>`);`highlightRef`(滚动定位)。

- `useQuery({ queryKey: ['skills'], queryFn: skillsApi.list })` → `{ data: skills = [], isLoading }`(`:74-77`)。**Query key:`['skills']`**。
- `useEffect`(`:79-83`):当 `highlightId` 且 `highlightRef.current` 存在,`scrollIntoView({ behavior:'smooth', block:'nearest' })`。依赖 `[highlightId, skills]`。
- `deleteMut`(`:85-88`):`skillsApi.delete(skillId)`;`onSuccess` → `invalidateQueries(['skills'])` + `setConfirmId(null)`。API:`DELETE /skills/{skillId}`。
- `importMut`(`:90-99`):`skillsApi.importLocal(file)`;`onSuccess(skill)` → `invalidateQueries(['skills'])`、`setImportError(null)`、`setHighlightId(skill.skill_id)`、3 秒后清除高亮;`onError(e)` → `setImportError(e.message)`。API:`POST /skills/import`(multipart)。
- `handleFileChange`(`:101-105`):取 `files[0]`,有则 `importMut.mutate(file)`,并 `e.target.value=''`(允许重复选同文件)。

DOM(`:107-159`):
- 工具栏 `div.p-5` → `flex items-center justify-between mb-4`(`:109-122`):左占位 `<span/>`;右 `div[data-tour="skills-import"].flex flex-col items-end gap-1`:
  - **导入 zip 按钮**:`<Button size="sm" style={{width:150}} loading={importMut.isPending} onClick={()=>{ setImportError(null); fileInputRef.current?.click() }}>` `UploadIcon size={13}` + `t('skills.importZip')`"导入 zip"。
  - `importError` 时 `<p class="text-[11px]" color=var(--red)>` 显示错误。
  - 隐藏 `<input ref={fileInputRef} type="file" accept=".zip" class="hidden" onChange={handleFileChange} />`(`:121`)。
- 主体:
  - `isLoading` → 3 个 `<SkeletonCard/>`(`flex flex-col gap-3`,`:123-126`)。
  - 空(`skills.length===0`,`:127-128`)→ `<EmptyState icon={<PackageIcon size={32}/>} title=t('skills.emptyLocalTitle') desc=t('skills.emptyLocalDesc')/>`("暂无本地 Skill" / "前往 Skill 市场下载 Skills 到本地使用")。
  - 否则 `div.flex flex-col gap-2`,`skills.map` → `<SkillCard skill highlighted={s.skill_id===highlightId} containerRef={匹配时=highlightRef} onDelete={()=>setConfirmId(s.skill_id)}/>`(`:130-136`)。
- **删除确认弹窗**(`confirmId` 非空,`:140-158`):遮罩与弹窗体样式同 §4.1.3(`rgba(15,31,61,.4)` + `blur(4px)`;`w-80 p-5`,`borderRadius:16`,`boxShadow:0 24px 80px rgba(15,31,61,.2)`)。标题 `Trash2Icon size={15} color=var(--red)` + `t('skills.deleteTitle')`"删除 Skill";正文拼接 `t('skills.deleteConfirmPre')`"确认删除 " + `<span font-mono font-semibold>{confirmId}</span>` + `t('skills.deleteConfirmPost')`"?" + `<br/>` + `t('skills.deleteConfirmNote')`"将同时删除对应目录,此操作不可撤销。";按钮 `取消`(outline) + `删除`(danger,`loading={deleteMut.isPending}`,`onClick=deleteMut.mutate(confirmId)`)。

`SkillCard`(`:163-239`):
- Props:`{ skill: LocalSkill; highlighted?; containerRef?; onDelete }`。
- state:`expanded`,初值 `highlighted`(`:167`)(新导入的自动展开)。
- 容器 `div.rounded-xl`(`:170-180`):`border: 1px solid ${highlighted?'var(--blue)':'var(--border)'}`、`background: highlighted?'var(--blue-dim)':'var(--bg1)'`、`boxShadow:var(--shadow)`、`transition: border-color .4s, background .4s`。
- 头部 `flex items-center justify-between gap-3 px-4 py-3 cursor-pointer`(`onClick`=切换 `expanded`,`userSelect:none`,`:181-198`):
  - 左:图标块 `w-7 h-7 rounded-lg`(`background:var(--blue-dim)`)内 `ZapIcon size={13} color=var(--blue)`;`skill.name`(`truncate text-sm font-medium`,`var(--t1)`)。
  - 右:版本徽标 `span.rounded-full px-2 py-0.5 text-[10px] font-mono`(`background:var(--bg3)`,`color:var(--t2)`)显示 `v{skill.version}`;展开箭头 `▲/▼`(`color:var(--t3)`,`fontSize:11`)。
- 展开体(`:200-236`)`px-4 pb-4`,`borderTop:1px solid var(--border)`:
  - `skill.description` → `<p class="mt-3 text-xs leading-relaxed" color=var(--t2)>`。
  - `skill.triggers.length>0` → `flex flex-wrap gap-1`,每个触发词 `span.rounded-full px-2 py-0.5 text-[10px] font-medium`(`background:var(--blue-dim)`,`color:var(--blue)`)含 `TagIcon size={9}` + 文本(`:205-213`)。
  - 删除按钮(`:214-234`):`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg`,默认 `color:var(--t3)`、透明边;hover → `color:var(--red)`、`background:rgba(220,38,38,.06)`、`borderColor:rgba(220,38,38,.2)`;`onClick={e=>{ e.stopPropagation(); onDelete() }}`(阻止冒泡避免折叠);`Trash2Icon size={12}` + `t('common.delete')`"删除"。

#### 4.4.3 Skill 市场面板 `RemotePanel`(`:243-386`)

state / refs(`:245-273`):`qc`、`{t}`;`search`(搜索词);`importError`;`highlightId`;`fileInputRef`、`highlightRef`;`pullError: { key:string; msg:string } | null`(以 `source:id` 复合键定位安装失败的卡片,`:273`)。

数据 query:
- `username`(`:254-258`):`useQuery({ queryKey:['auth-session'], queryFn: async()=>(await window.electronAPI?.getSession?.())?.username ?? '', staleTime: Infinity })`。当前登录用户名,**mythos 市场请求头需要它**;浏览器调试(无 electron)时为 `''`,mythos 降级只显示 cowork。
- `catalog`(`:260-264`):`useQuery({ queryKey:['skill-catalog', username], queryFn:()=>skillsApi.catalog(username), retry:1 })` → `{ data: catalog = [], isLoading, isError, error }`。**Query key:`['skill-catalog', username]`**。
- `useEffect`(`:266-270`):高亮滚动,依赖 `[highlightId, catalog]`。

mutation:
- **`pullMut`(安装,`:275-284`)**:`mutationFn(item: RemoteCatalogItem) => skillsApi.pull(item, username)`(整条 item 含 `source` 一并传后端,由后端派发到对应数据源下载接口);`onMutate` → `setPullError(null)`;`onSuccess` → `invalidateQueries(['skills'])` + `invalidateQueries(['skill-catalog'])`(刷新本地列表与市场的 `is_pulled` 状态);`onError(e, item)` → `setPullError({ key:\`${item.source}:${item.id}\`, msg:e.message })`。API:`POST /skills/pull-server/catalog/{id}/pull`。
- **`importMut`(上传到远端,`:286-296`)**:`mutationFn(file)=>skillsApi.importRemote(file)`;`onSuccess(result)` → `invalidateQueries(['skill-catalog'])`、`setImportError(null)`、`setHighlightId(\`cowork:${result.skill_id}\`)`(上传只走 cowork,高亮键对齐 `cowork:<id>`)、3s 后清除;`onError(e)` → `setImportError(e.message)`。API:`POST /skills/pull-server/import`(multipart)。
- `handleFileChange`(`:298-302`):同本地面板(`accept=".zip"`,重置 value)。

`filtered`(`useMemo`,`:304-312`):`search` 为空返回全部 catalog;否则按 `search.toLowerCase()` 过滤 `item.name` / `item.description?` / `item.updater?`(任一 `includes`)。

DOM(`:314-385`)`div.p-5`:
- 工具栏(`:317-328`)`flex items-center justify-end gap-2 mb-4`:右 `div.flex flex-col items-end gap-1`:**上传到远端按钮** `<Button size="sm" style={{width:150}} loading={importMut.isPending} onClick={()=>{ setImportError(null); fileInputRef.current?.click() }}>` `UploadIcon size={13}` + `t('skills.uploadRemote')`"上传到远端";`importError` 时 `<p class="text-[11px]" var(--red)>`;隐藏 `<input type="file" accept=".zip">`。
- **搜索框**(仅 `!isLoading && !isError && catalog.length>0` 时渲染,`:330-347`):`div.relative mb-4`;`SearchIcon size={14}` 绝对定位 `left-3` 居中(`pointer-events-none`,`color:var(--t3)`);`<input value={search} placeholder=t('skills.searchPlaceholder')>`("搜索 Skill 名称、描述或分类…");类 `w-full rounded-xl pl-9 pr-3 py-2.5 text-sm outline-none`;`background:var(--bg1)`、`border:1px solid var(--border)`、`color:var(--t1)`;`onFocus` 边框变 `var(--blue)`,`onBlur` 还原 `var(--border)`。
- 主体条件渲染(`:349-383`):
  - `isLoading` → `grid grid-cols-2 gap-3`,4 个 `<SkeletonCard tall/>`(`:349-352`)。
  - `isError` → `<EmptyState icon={<span style={{fontSize:32}}>⚠️</span>} title=t('skills.fetchFailed') desc={(error as Error)?.message ?? t('skills.fetchFailedDesc')} variant="error"/>`("获取失败" / 默认 "无法连接到 Skill 服务器,请检查网络连接",红色)(`:353-359`)。
  - `catalog.length===0` → `<EmptyState icon={<PackageIcon size={32}/>} title=t('skills.emptyRemoteTitle') desc=t('skills.emptyRemoteDesc')/>`("远端暂无可用 Skill" / "稍后再来查看")(`:360-361`)。
  - `filtered.length===0`(有数据但搜不到)→ `<EmptyState icon={<SearchIcon size={32}/>} title=t('skills.noMatchTitle') desc={t('skills.noMatchDesc', { q: search })}/>`("未找到匹配的 Skill" / "没有与 \"{q}\" 相关的结果")(`:362-363`)。
  - 否则 `grid grid-cols-2 gap-3`,`filtered.map` → 计算 `key = \`${item.source}:${item.id}\``(跨源同 id 防串台,`:369`),渲染 `<CatalogCard item highlighted={key===highlightId} containerRef={匹配=highlightRef} pulling={pullMut.isPending && pullMut.variables ? \`${pullMut.variables.source}:${pullMut.variables.id}\`===key : false} error={pullError?.key===key?pullError.msg:undefined} onPull={()=>pullMut.mutate(item)}/>`(`:371-379`)。

`CatalogCard`(`:388-454`):
- Props:`{ item: RemoteCatalogItem; highlighted?; containerRef?; pulling: boolean; error?: string; onPull }`。
- 容器 `div.rounded-xl flex flex-col`(`:393-413`):`border: 1px solid ${highlighted?'var(--blue)':'var(--border)'}`、`background: highlighted?'var(--blue-dim)':'var(--bg1)'`、`boxShadow:var(--shadow)`、`transition: box-shadow var(--tr), border-color .4s, background .4s`;hover:`boxShadow→var(--shadow2)`,非高亮时 `borderColor→var(--border2)`;leave 还原。
- 卡体 `flex-1 p-4`(`:415-425`):
  - 名称 `p.truncate text-sm font-semibold leading-snug mb-1.5`(`var(--t1)`)= `item.name`。
  - 描述:有则 `<p class="text-xs leading-relaxed" color=var(--t2)>`,固定高度 `height:4.875em` + 3 行截断(`display:-webkit-box; WebkitLineClamp:3; WebkitBoxOrient:vertical; overflow:hidden`);无则 `<p class="text-xs italic" color=var(--t3) height:4.875em>` 显示 `t('skills.noDescription')`"暂无描述"。
- 卡脚 `px-4 py-3`(`borderTop:1px solid var(--border)`,`background:var(--bg2)`,`:428-451`):
  - `flex items-center justify-between`:`item.create_time` 时左侧 `span.text-[10px]`(`var(--t3)`)显示 `formatDate(item.create_time)`(`zh-CN`,`{year:'numeric',month:'short',day:'numeric'}`,解析失败返回 `''`,见 `:494-500`)。
  - 右侧(`ml-auto`):若 `item.is_pulled` → **已安装徽标** `span.flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-full`(`color:var(--green)`,`background:rgba(22,163,74,.08)`)含 `CheckCircle2Icon size={12}` + `t('skills.installed')`"已安装";否则 **安装按钮** `<Button size="sm" variant="default" loading={pulling} onClick={onPull}>` `DownloadIcon size={11}` + `t('skills.install')`"安装"。
  - `error` 非空时 `<p class="mt-2 text-[11px] leading-snug" color=var(--red)>` 显示安装失败原因(如 mythos 某 skill 内容为空)(`:447-450`)。

> 说明:市场面板**没有"卸载/删除"按钮**(卸载在本地面板做),也**没有手动"刷新"按钮**;刷新依赖安装/上传成功后的 `invalidateQueries(['skill-catalog'])` 与 query 自身的重取。`retry:1` 表示加载失败自动重试一次。

#### 4.4.4 共享辅助组件(`:456-500`)

- `EmptyState({ icon, title, desc, variant='default' })`(`:458-471`):`flex flex-col items-center justify-center py-16 gap-3`;图标容器色 `variant==='error'?var(--red):var(--t3)`,`opacity:.6`;标题 `text-sm font-medium`(error 红 / 否则 `var(--t2)`);描述 `text-xs text-center max-w-xs`(`var(--t3)`)。
- `CloseButton`(`:473-486`):同 §4.1.4(`w-7 h-7 rounded-md`,hover `bg-3`+`t1`,`ChevronLeftIcon size={18}`)。
- `SkeletonCard({ tall=false })`(`:488-492`):`rounded-xl animate-pulse`,`background:var(--bg1)`、`border:1px solid var(--border)`,高度 `tall?140:72`。
- `formatDate(iso)`(`:494-500`):见上。

---

### 4.5 技能 API 封装 — `src/api/skills.ts`(44 行)

类型(`:3-28`):
- `LocalSkill`:`{ skill_id:string; name:string; description:string; version:string; triggers:string[] }`(`:3-9`)。
- `SkillSource = 'cowork' | 'mythos'`(`:13`):标明 skill 来自哪个市场,用户不感知,程序据此决定下载走哪个数据源。
- `RemoteCatalogItem`:`{ source:SkillSource; id:string; name:string; description:string|null; updater:string|null; create_time:string|null; is_pulled:boolean }`(`:15-23`)。
- `PullSkillResponse`:`{ skill_id:string; name:string }`(`:25-28`)。

`skillsApi`(`:30-44`),实际 URL 前缀 `/api/v1`:

| 方法 | HTTP + 路径 | 入参 | 返回 | 使用处 |
|---|---|---|---|---|
| `list()` | `GET /skills` | — | `LocalSkill[]` | LocalPanel `['skills']` |
| `delete(skillId)` | `DELETE /skills/${skillId}` | `skillId` | `void` | 本地删除(skillId 未 encode,需确认) |
| `importLocal(file)` | `POST /skills/import`(multipart, 字段 `file`) | `File` | `LocalSkill` | 导入 zip 到本地 |
| `catalog(username)` | `GET /skills/pull-server/catalog?username=${encodeURIComponent(username)}` | `username` | `RemoteCatalogItem[]` | 市场列表(聚合 cowork+mythos) |
| `pull(item, username)` | `POST /skills/pull-server/catalog/${item.id}/pull` | body `{ name:item.name, source:item.source, username }` | `PullSkillResponse` | 安装(后端按 source 派发) |
| `importRemote(file)` | `POST /skills/pull-server/import`(multipart) | `File` | `PullSkillResponse` | 上传到远端(只走 cowork) |

注意:`catalog` 对 `username` 做了 `encodeURIComponent`;`pull` 的路径段 `item.id` 未 encode(`:40`);`pull` 入参类型简化为 `{ id; name; source }`(`:39`)。

---

### 4.6 本章关键点速查

- **React Query keys**:`['llms']`(供应商列表)、`['skills']`(本地技能)、`['skill-catalog', username]`(市场)、`['auth-session']`(当前用户名,`staleTime:Infinity`)。
- **乐观更新**:本章基本**不做乐观更新**,均为"mutation 成功 → invalidateQueries 重取"。唯一近似乐观的是 ping 的 `onMutate` 把对应模型置 `loading`、AddProviderForm 的本地 `models` 暂存(但这是表单本地态,非缓存)。
- **二次确认**:删除供应商(§4.1.3)、删除本地技能(§4.4.2)有确认弹窗;删除模型、安装技能、上传/导入均无二次确认。`LLMSettingsDialog`(旧版)删除供应商也无确认。
- **"验证并添加"两步语义**:已注册 provider 走 `pingRegistered` 成功后才 `addModel`(§4.1.5);新建表单走未注册 `ping`,成功才入本地暂存列表(§4.1.6)。
- **状态色**:默认模型星标 `var(--amber)`(`#d97706`)实心;ping 成功 `var(--green)`(`#16a34a`)+ 绿边 `rgba(22,163,74,.25)`;ping 失败 `var(--red)`(`#dc2626`)+ 红边 `rgba(220,38,38,.25)`;已安装徽标绿底 `rgba(22,163,74,.08)`。
- **未接线能力(需确认)**:`llmsApi.listAvailableModels` / `listAvailableModelsOf` 及对应 i18n(`llm.fetchModelsList`/`llm.availableModels`)在当前页面未使用;`SkillsPage` 不含"添加技能源"UI(数据源固定 cowork/mythos)。
- **i18n**:`LLMSettingsPage` / `SkillsPage` 全量走 `useI18n()`,中英双语(`src/i18n.tsx`,中文键 `:193-239`、英文 `:410-456`);`LLMSettingsDialog` 为硬编码中文、无 i18n。


---

## 5. 工作区面板 与 文件预览框架(工具栏 / 目录 / 类型分发)+ 轻量查看器

本章覆盖 IPMaster-Cowork 桌面前端中"工作区文件浏览 → 文件预览"的完整链路:左侧/侧栏的 `WorkspacePanel`(文件树、面包屑、刷新、在资源管理器打开),预览弹窗外壳 `FilePreviewModal`,文件类型判定与查看器分发 `fileType.ts`,可插拔的预览工具栏框架(`PreviewToolbar` / `PreviewToolbarContext` / `capabilities.ts` / `TocSidebar`),以及一组"轻量查看器"(图片 / 文本 / 代码 / Markdown(含 Mermaid) / Excel)和它们共享的公共件 `common.tsx`。重型查看器(PDF / DOCX / PPTX / Worker 解析)在其他章节展开,本章仅在分发处标注其挂载点。

> 仓库根:`D:\IpMasterCoworkPy`。本章所有路径以 `frontend-desktop/` 为前缀(正文标注为 `文件路径:行号`)。
>
> 全局 CSS 变量取值(定义于 `frontend-desktop/src/index.css:6-28`),本章高频引用,先在此列出确切值,后文不再每次重复:
>
> | 变量 | 值 | 含义 |
> |---|---|---|
> | `--bg1` | `#ffffff` | 卡片/最上层背景 |
> | `--bg2` | `#f5f8fe` | 次级背景(工具栏/侧栏底) |
> | `--bg3` | `#eaf0fb` | hover 背景 |
> | `--border` | `#dde6f3` | 主分隔线 |
> | `--border2` | `#c6d5eb` | 次级分隔(面包屑分隔符等) |
> | `--blue` | `#2563eb` | 主蓝 |
> | `--blue-dim` | `rgba(37, 99, 235, .09)` | 蓝色淡底(激活态) |
> | `--blue-glow` | `rgba(37, 99, 235, .2)` | 蓝色光晕 |
> | `--teal` | `#0891b2` | 青(markdown/text 图标) |
> | `--amber` | `#d97706` | 琥珀(pptx 图标) |
> | `--red` | `#dc2626` | 红(pdf 图标 / 错误) |
> | `--green` | `#16a34a` | 绿(excel/image 图标) |
> | `--t1` | `#0f1f3d` | 主文字(最深) |
> | `--t2` | `#3d5a80` | 次文字 |
> | `--t3` | `#8aa3bf` | 弱文字/占位 |
> | `--tr` | `.15s ease` | 统一过渡时长 |
>
> 注意:文件夹图标色 `#f59e0b`(`WorkspacePanel.tsx:232` / `:235`)是硬编码的橙色,并非 CSS 变量。

---

### 5.0 模块地图与数据流总览

```
WorkspacePanel (workingDir)
  ├─ React Query: ['workspace-files', browsePath] → workspaceApi.listFiles(browsePath)
  ├─ 面包屑 / 返回上级 / 刷新 / 在资源管理器打开 / 关闭
  ├─ FileRow(目录)→ navigateTo(entry.path)  (改 browsePath,重新拉列表)
  └─ FileRow(文件)→ setPreviewFile(entry.path)
        └─ FilePreviewModal (path, onClose, onNavigate)
             ├─ getExt(path) → fileType(ext) → 选择查看器
             ├─ <PreviewToolbarProvider>  (caps + tocOpen 上下文)
             │     ├─ <PreviewToolbar />   读取 caps 渲染工具栏(无 caps 则返回 null)
             │     ├─ <TocSidebar />        读取 caps.toc + tocOpen 渲染左侧目录
             │     └─ 主内容区:按 type 挂载具体 Viewer
             │           每个 Viewer 通过 usePreviewToolbar(caps, deps) 反向注册能力
             └─ 各 Viewer 取数:
                   useFileText(path)        → GET /api/v1/workspace/file (JSON .content)
                   rawUrl(path)             → /api/v1/workspace/file/raw (二进制/图片/下载)
```

关键架构点:**查看器与工具栏解耦**。工具栏不知道任何具体查看器;查看器在挂载时通过 `usePreviewToolbar(caps, deps)` 把自己"能做什么"(缩放 / 复制 / 下载 / 目录 / 搜索 / 分页)写入 Context,工具栏读取后渲染对应按钮,卸载时自动清空(避免切换文件后残留旧控件)。详见 5.4。

---

### 5.1 后端 API 封装:`api/workspace.ts`

文件:`frontend-desktop/src/api/workspace.ts`(共 9 行)。

```
export const workspaceApi = {
  listFiles: (path = '') =>
    http.get<WorkspaceListing>(`/workspace/files?path=${encodeURIComponent(path)}`),
  readFile: (path: string) =>
    http.get<{ path: string; content: string }>(`/workspace/file?path=${encodeURIComponent(path)}`),
}
```

- `listFiles(path = '')`(`workspace.ts:5-6`):`GET /workspace/files?path=<encodeURIComponent(path)>`。`path` 默认空串。返回 `WorkspaceListing`。
- `readFile(path)`(`workspace.ts:7-8`):`GET /workspace/file?path=<encodeURIComponent(path)>`,返回 `{ path, content }`。**注意**:`WorkspacePanel`/查看器实际上很少用这个封装去读正文——轻量查看器走的是 `common.tsx` 里的 `useFileText`(直接 `fetch('/api/v1/workspace/file?...')`)和 `rawUrl`(`/api/v1/workspace/file/raw?...`),见 5.6。`readFile` 在本章范围内未被各查看器调用(需确认其它模块用途)。
- `http` 来自 `./client`(`workspace.ts:1`),即统一的 HTTP 客户端;`http.get` 的路径前缀(`/api/v1` 还是 `/api`)由 client 决定(需确认,本章不展开;但注意它与 `common.tsx` 中手写的 `/api/v1/...` 形式存在前缀差异,见 5.6 说明)。

类型定义 `frontend-desktop/src/types/index.ts:74-86`:

```
export interface WorkspaceEntry {
  name: string
  path: string
  is_dir: boolean
  size: number | null
}
export interface WorkspaceListing {
  root: string
  path: string
  parent: string
  entries: WorkspaceEntry[]
}
```

- `WorkspaceEntry.size`:目录为 `null`,文件为字节数(`types/index.ts:78`)。`FileRow` 用 `size !== null && size !== undefined` 判定是否显示大小(`WorkspacePanel.tsx:262`)。
- `WorkspaceListing` 含 `root`/`path`/`parent`,但 `WorkspacePanel` 当前未使用后端返回的 `parent`(它在前端自行计算父目录,见 5.2),只用了 `entries`(`WorkspacePanel.tsx:72`)。

---

### 5.2 工作区面板:`components/WorkspacePanel.tsx`

文件:`frontend-desktop/src/components/WorkspacePanel.tsx`(共 302 行)。

#### 5.2.1 Props / State / 派生量

Props 接口(`WorkspacePanel.tsx:16-19`):
- `workingDir: string` —— 工作区根目录绝对路径。
- `onClose?: () => void` —— 可选关闭回调;存在时才渲染右上角关闭按钮(`:98-102`)。

State / hooks(`:25-42`):
- `const { t } = useI18n()`(`:26`)—— 国际化。
- `browsePath`(`useState`,初值 `workingDir || ''`,`:27`)—— 当前浏览目录。
- `previewFile`(`useState<string | null>`,初值 `null`,`:28`)—— 当前预览文件路径;非 null 时挂载 `FilePreviewModal`。
- `rootPath = workingDir || ''`(`:30`)。
- `sep`(`:31`)—— 路径分隔符:`rootPath.includes('\\') ? '\\' : '/'`(Windows 反斜杠优先)。
- `useEffect([workingDir])`(`:33-36`)—— 当 `workingDir` 变化:`setBrowsePath(workingDir || '')` 且 `setPreviewFile(null)`(切换工作区时重置浏览位置并关闭预览)。

React Query(`:38-42`):
- `queryKey: ['workspace-files', browsePath]`(`:39`)。
- `queryFn: () => workspaceApi.listFiles(browsePath)`(`:40`)。
- `staleTime: 5000`(5 秒)(`:41`)。
- 解构出 `data: listing`、`isLoading`、`refetch`。

路径计算(纯前端,均基于把 `\` 统一替换为 `/` 的归一化形式):
- 工具函数 `normalizeSep(p)`(`:21-23`):`p.replace(/\\/g, '/')`。
- `navigateTo(path)`(`:44-46`):`setBrowsePath(path)`(触发新的 query)。
- `normalizedBrowse` / `normalizedRoot`(`:48-49`)。
- `relPath`(`:51-56`):若浏览路径等于根 → `''`;若以 `root + '/'` 开头 → 截掉根前缀的相对路径;否则 `''`(越界保护)。
- `relParts`(`:58`):`relPath.split('/').filter(Boolean)`。
- `rootName`(`:60-62`):根目录名(归一化后取最后一段),取不到则 `'/'`。
- `isAtRoot = relPath === ''`(`:64`)。
- `parentPath`(`:65-70`):根目录时为 `null`;否则把 `normalizedBrowse` 按 `/` 切分、`pop()` 掉最后一段,再用 `sep` 还原分隔符;空则回退 `rootPath`。
- `entries = listing?.entries ?? []`(`:72`);`dirs = entries.filter(e => e.is_dir)`(`:73`);`files = entries.filter(e => !e.is_dir)`(`:74`);`totalCount = entries.length`(`:75`)。

#### 5.2.2 整体布局与容器

根容器(`:78`):`<div className="flex h-full flex-col text-xs">`。全面板基准字号 `text-xs`(12px / line-height 1rem)。

#### 5.2.3 头部(Header,`:80-104`)

容器:`<div>`(无边框)包一层 `flex items-center justify-between px-4 pt-4 pb-3`(`:81`)——左右两端对齐,左 padding/上 padding 16px、下 padding 12px。

**左侧标题块**(`:82-85`):
- `FolderOpenIcon`(lucide),`size={16}`,`style={{ color: 'var(--blue)' }}`(`:83`)。
- 文案 `t('workspace.title')`:中文 "工作区" / 英文 "Workspace"(i18n `:181`/`:398`)。样式 `text-sm font-semibold`,`color: var(--t1)`(`:84`)。
- 二者用 `flex items-center gap-2`。

**右侧操作区**(`:86-103`,`flex items-center gap-1`):
1. **项数徽标**(`:87-89`):仅 `!isLoading && listing` 时显示。文案 `t('workspace.items', { count: totalCount })` → "{count} 项" / "{count} items"(i18n `:182`/`:399`)。样式 `text-[10px] mr-1`,`color: var(--t3)`。
2. **在资源管理器中打开**按钮(`:90-94`):条件 `window.electronAPI?.openPath && rootPath`。用 `IconBtn`,`title=t('workspace.openInExplorer')`("在文件管理器中打开" / "Open in file explorer",i18n `:183`/`:400`)。图标 `FolderInputIcon` `size={12}`。点击 → `window.electronAPI!.openPath!(rootPath)`(Electron 主进程在系统文件管理器中打开根目录;副作用,无 state 变更)。
3. **刷新**按钮(`:95-97`):`IconBtn`,`title=t('workspace.refresh')`("刷新" / "Refresh",i18n `:184`/`:401`)。图标 `RefreshCwIcon` `size={12}`。点击 → `refetch()`(重新执行当前 `browsePath` 的 query)。
4. **关闭**按钮(`:98-102`):仅 `onClose` 存在时渲染。`IconBtn`,`title=t('workspace.close')`("关闭工作区" / "Close workspace",i18n `:185`/`:402`)。图标 `XIcon` `size={13}`。点击 → `onClose()`。

`IconBtn` 子组件(`:269-282`):`<button>`,类 `w-6 h-6 flex items-center justify-center rounded-md transition-colors`(24×24px,圆角 `rounded-md`=6px)。默认样式 `color: var(--t3)`、`background: none`、`border: none`、`cursor: pointer`。hover(`onMouseEnter`):`background = var(--bg3)`(#eaf0fb)、`color = var(--t2)`;离开(`onMouseLeave`)还原 `background = none`、`color = var(--t3)`。

#### 5.2.4 面包屑(Breadcrumb,`:106-129`)

容器 `relative px-3 pb-2.5`(`:107`),内层 `flex items-center gap-0.5 overflow-x-auto`,内联 `scrollbarWidth: 'none'`(隐藏滚动条,可横向滚动)(`:108`)。

- **根片**(`:109-113`):`BreadcrumbChip`,`label={rootName}`,`active={relParts.length === 0}`,点击 → `navigateTo(rootPath)`。
- **各层片**(`:114-126`):对 `relParts` 逐项渲染。每项前置一个分隔符 `ChevronRightIcon` `size={9}`,`color: var(--border2)`(#c6d5eb)(`:116`)。`BreadcrumbChip` 的 `active = (i === relParts.length - 1)`(仅末段高亮)。点击(`:120-123`):构造目标 `normalizedRoot + '/' + relParts.slice(0, i+1).join('/')`,再 `.replace(/\//g, sep)` 还原分隔符后 `navigateTo`。
- **加载指示**(`:127`):`isLoading` 时在末尾追加 `<Spinner className="ml-1 flex-shrink-0 w-2.5 h-2.5" />`(10×10px)。

`BreadcrumbChip` 子组件(`:205-222`):`<button>`,类 `flex-shrink-0 truncate max-w-[90px] rounded-md px-1.5 py-0.5 text-[11px] font-medium transition-colors`(最大宽 90px、超出截断、圆角 6px、内边距 6px/2px、字号 11px、半粗)。
- 激活态:`background: var(--blue-dim)`、`color: var(--blue)`、`cursor: default`(`:212-214`)。
- 非激活:`background: 'none'`、`color: var(--t3)`、`cursor: pointer`。hover(仅非激活):`color = var(--t2)`;离开还原 `var(--t3)`(`:216-217`)。
- `border: 'none'`。

#### 5.2.5 文件树主体(`:132-182`)

容器 `flex-1 overflow-y-auto py-1.5`(`:133`,纵向滚动,上下 padding 6px)。

**返回上级行**(`:135-146`):条件 `!isAtRoot && parentPath`。`<div>` 类 `flex cursor-pointer items-center gap-2 px-3 py-1.5 mx-2 rounded-lg mb-1 transition-colors`(左右内边距 12px、上下 6px、外边距左右 8px、圆角 `rounded-lg`=8px、底边距 4px)。默认 `color: var(--t3)`。hover(`onMouseEnter`,`:140`):`background = var(--bg3)`、`color = var(--t2)`;离开(`:141`)还原 `background = ''`、`color = var(--t3)`。内容:`ArrowLeftIcon` `size={12}` + `<span className="text-xs">` 文案 `t('workspace.backToParent')`("返回上级" / "Back to parent",i18n `:186`/`:403`)。点击 → `navigateTo(parentPath)`。

**空 / 未配置状态**(互斥两种):
- 目录为空(`:149-154`):条件 `!isLoading && listing && entries.length === 0`。居中列布局 `flex flex-col items-center justify-center py-10 gap-2`。`FolderOpenIcon` `size={28}`,`color: var(--t3)`,`opacity: .5`。文案 `t('workspace.empty')`("目录为空" / "Directory is empty",i18n `:187`/`:404`),`color: var(--t3)`。
- 工作区未配置(`:155-160`):条件 `!listing && !isLoading`。同上布局,图标改 `FolderIcon` `size={28}` 半透明,文案 `t('workspace.notConfigured')`("工作区未配置" / "Workspace not configured",i18n `:188`/`:405`)。

**目录条目优先渲染**(`:163-170`):`dirs.map` → `<FileRow key={entry.path} name isDir onNavigate={() => navigateTo(entry.path)} />`。

**文件条目**(`:173-181`):`files.map` → `<FileRow key isDir={false} size={entry.size} onOpen={() => setPreviewFile(entry.path)} />`。点击文件即把该路径写入 `previewFile`,触发预览弹窗。

#### 5.2.6 `FileRow` 子组件(`:224-267`)

Props(`:224-230`):`name`、`isDir`、`size?`、`onNavigate?`、`onOpen?`。

图标与配色(`:231-235`):
- 目录:`Icon = FolderIcon`,`color = '#f59e0b'`(`:232`)。
- 文件:`getFileStyle(name)`(见 5.2.7)返回 `{ Icon, color }`。
- `accentColor`(左侧装饰条颜色):目录 `#f59e0b`,文件 `var(--blue)`(`:235`)。

容器(`:238-254`):`<div>`,类 `group relative flex cursor-pointer items-center gap-2 px-3 py-1.5 mx-2 rounded-lg`(同返回行的尺寸基线:左右内边距 12px、上下 6px、外边距 8px、圆角 8px)。内联 `transition: background var(--tr)`(0.15s)。
- 点击(`:239`):`if (isDir) onNavigate?.(); else onOpen?.()`。
- hover(`onMouseEnter`,`:242-247`):背景设为 `var(--bg3)`;并把内部 `.accent-bar` 元素 `opacity` 设为 `1`。
- 离开(`onMouseLeave`,`:248-253`):清空背景;`.accent-bar` `opacity` 归 `0`。

子元素:
- **左侧装饰条**(`:256-259`):`<div className="accent-bar absolute left-0 top-1 bottom-1 rounded-full">`,内联 `width: 2`(2px 宽)、`background: accentColor`、`opacity: 0`、`transition: opacity var(--tr)`。仅 hover 时显现。
- **类型图标**(`:260`):`<Icon size={13} className="flex-shrink-0" style={{ color }} />`。
- **文件名**(`:261`):`<span className="min-w-0 flex-1 truncate text-sm" style={{ color: 'var(--t2)' }}>`(字号 14px、截断)。
- **大小**(`:262-264`):仅 `size !== null && size !== undefined` 时显示;`<span className="flex-shrink-0 text-[10px]" style={{ color: 'var(--t3)' }}>{formatBytes(size)}</span>`。

`formatBytes`(`frontend-desktop/src/lib/utils.ts:20-25`):`null`→`''`;`<1024`→`"{n} B"`;`<1MB`→`"{KB,保留1位} KB"`;否则 `"{MB,保留1位} MB"`。

#### 5.2.7 文件图标映射:`FILE_ICONS` / `getFileStyle`(`:284-302`)

`getFileStyle(name)`(`:300-302`):`return FILE_ICONS[fileType(getExt(name))]`——复用 5.3 的类型判定,把 `PreviewType` 映射到图标+色。

`FILE_ICONS: Record<PreviewType, { Icon; color }>`(`:288-298`,图标来自 lucide-react):

| PreviewType | Icon 组件 | color |
|---|---|---|
| `pdf` | `FileTypeIcon` | `var(--red)` `#dc2626` |
| `docx` | `FileTextIcon` | `var(--blue)` `#2563eb` |
| `excel` | `FileSpreadsheetIcon` | `var(--green)` `#16a34a` |
| `pptx` | `PresentationIcon` | `var(--amber)` `#d97706` |
| `image` | `FileImageIcon` | `var(--green)` `#16a34a` |
| `code` | `FileCodeIcon` | `var(--blue)` `#2563eb` |
| `markdown` | `FileTextIcon` | `var(--teal)` `#0891b2` |
| `text` | `FileTextIcon` | `var(--teal)` `#0891b2` |
| `binary` | `FileIcon` | `var(--t3)` `#8aa3bf` |

设计注释(`:284-287`)说明:工作区图标与预览平台共用同一套 `PreviewType` 键,新增格式只需在此加一行,扩展名清单集中在 `fileType.ts`。

#### 5.2.8 底部统计(Footer,`:184-194`)

条件 `listing && entries.length > 0`。`<div className="flex items-center justify-center gap-2 px-3 py-2 text-[10px]" style={{ color: 'var(--t3)' }}>`。内容:`t('workspace.folders', { count: dirs.length })`("{count} 个文件夹" / "{count} folder(s)",i18n `:189`/`:406`)+ 分隔点 `·`(`color: var(--border2)`)+ `t('workspace.files', { count: files.length })`("{count} 个文件" / "{count} file(s)",i18n `:190`/`:407`)。

#### 5.2.9 预览弹窗挂载(`:196-198`)

条件 `previewFile`(非 null):`<FilePreviewModal path={previewFile} onClose={() => setPreviewFile(null)} onNavigate={setPreviewFile} />`。`onNavigate` 直接绑到 `setPreviewFile`——Markdown 内的工作区内链点击会调用它来"原地换文件"(见 5.7)。

---

### 5.3 文件类型判定与分发:`preview/fileType.ts`

文件:`frontend-desktop/src/preview/fileType.ts`(共 37 行)。

类型集合(`:1-3`):
```
PreviewType = 'image' | 'markdown' | 'docx' | 'excel'
            | 'code' | 'text' | 'pdf' | 'pptx' | 'binary'
```

扩展名集合(均小写,`:5-11`):
- `IMAGE_EXTS`(`:5`):`jpg, jpeg, png, gif, webp, bmp, ico, svg`
- `MD_EXTS`(`:6`):`md, markdown`
- `DOCX_EXTS`(`:7`):`docx`
- `EXCEL_EXTS`(`:8`):`xlsx, xls, csv`
- `PDF_EXTS`(`:9`):`pdf`
- `PPTX_EXTS`(`:10`):`pptx`
- `TEXT_EXTS`(`:11`):`txt, log, rst, xml, html, htm, less, vue, php, rb, swift`

代码语言映射 `CODE_LANGS: Record<string, string>`(扩展名 → highlight.js language id,`:14-20`):

| ext | hljs lang | ext | hljs lang |
|---|---|---|---|
| `py` | python | `css` | css |
| `js` | javascript | `scss` | scss |
| `ts` | typescript | `go` | go |
| `jsx` | javascript | `rs` | rust |
| `tsx` | typescript | `java` | java |
| `sh` | bash | `cpp` | cpp |
| `bash` | bash | `c` | c |
| `json` | json | `kt` | kotlin |
| `yaml` | yaml | `toml` | ini |
| `yml` | yaml | | |

`getExt(p)`(`:22-25`):取路径最后一段(按 `/` 或 `\` 切分),含 `.` 则取最后一段后缀并转小写,否则返回 `''`(无扩展名)。

`fileType(ext)`(`:27-37`)判定**顺序**(短路):
1. `IMAGE_EXTS` → `image`
2. `MD_EXTS` → `markdown`
3. `DOCX_EXTS` → `docx`
4. `EXCEL_EXTS` → `excel`
5. `PDF_EXTS` → `pdf`
6. `PPTX_EXTS` → `pptx`
7. `ext in CODE_LANGS` → `code`
8. `TEXT_EXTS` → `text`
9. 兜底 → `binary`

---

### 5.4 预览弹窗外壳:`components/FilePreviewModal.tsx`

文件:`frontend-desktop/src/components/FilePreviewModal.tsx`(共 79 行)。

#### 5.4.1 Props 与派生

Props(`:18-23`):`path: string`、`onClose: () => void`、`onNavigate?: (path: string) => void`(切换到另一份工作区文档,用于 Markdown 内链)。

派生(`:27-29`):`ext = getExt(path)`、`type = fileType(ext)`、`name = path.split(/[/\\]/).pop() ?? path`(显示文件名)。

ESC 关闭(`:31-35`):`useEffect`,监听 `window` 的 `keydown`;`e.key === 'Escape'` → `onClose()`;依赖 `[onClose]`,卸载时移除监听。

#### 5.4.2 遮罩与弹窗容器

遮罩(`:38-42`):`<div className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm">`,内联 `background: 'rgba(15,31,61,.35)'`(深蓝半透明)。`onClick`(`:41`):仅当 `e.target === e.currentTarget`(点击遮罩本体而非内部)时 `onClose()`——即点击空白处关闭。

弹窗(`:43-44`):`<div className="relative flex flex-col rounded-xl">`,内联尺寸/外观:`width: '82vw'`、`height: '85vh'`、`maxWidth: 1200`、`background: var(--bg1)`(#ffffff)、`boxShadow: '0 24px 80px rgba(15,31,61,.22)'`、圆角 `rounded-xl`(12px)。

整个弹窗内容被 `<PreviewToolbarProvider>` 包裹(`:45-75`)——提供 caps + tocOpen 上下文(见 5.5)。

#### 5.4.3 弹窗头部(`:46-51`)

`<div className="flex items-center gap-2 px-4 py-3 flex-shrink-0">`,内联 `borderBottom: '1px solid var(--border)'`。
- `FileIcon` `size={15}`,`color: var(--t3)`(`:48`)。
- 文件名(`:49`):`<span className="min-w-0 flex-1 truncate text-sm font-medium" style={{ color: 'var(--t2)' }}>{name}</span>`。
- 关闭按钮(`:50`):`<Button variant="ghost" size="icon" onClick={onClose}><XIcon size={16} /></Button>`。`Button`(`ui/button.tsx`)`ghost`+`icon`:`h-7 w-7 p-0`、`rounded-md`、`hover:bg-[#eaf0fb]`、`transition-colors`、focus ring `#2563eb`。点击 → `onClose()`。

#### 5.4.4 工具栏与内容行

- `<PreviewToolbar />`(`:54`)——若当前查看器未声明任何能力则渲染 null(见 5.5.2)。
- 内容行(`:57-74`):`<div className="flex-1 flex flex-row overflow-hidden">`,内含:
  - `<TocSidebar />`(`:58`)——左侧目录(条件渲染,见 5.5.4)。
  - 主内容容器(`:59`):`<div className="flex-1 overflow-auto">`。

#### 5.4.5 查看器分发(`:60-72`)

按 `type` 条件挂载(互斥):

| 条件 | 渲染 | 传参 | 本章节 |
|---|---|---|---|
| `type === 'image'` | `<ImageViewer />` | `path, filename={name}` | 5.6.2 |
| `type === 'markdown'` | `<MarkdownViewer />` | `path, filename, onNavigate` | 5.7 |
| `type === 'docx'` | `<DocxViewer />` | `path, filename` | 其他章节 |
| `type === 'excel'` | `<ExcelViewer />` | `path, filename` | 5.8 |
| `type === 'code'` | `<CodeViewer />` | `path, lang={CODE_LANGS[ext]}, filename` | 5.6.4 |
| `type === 'text'` | `<TextViewer />` | `path, filename` | 5.6.3 |
| `type === 'pdf'` | `<PdfViewer />` | `path, filename` | 其他章节 |
| `type === 'pptx'` | `<PptxViewer />` | `path, filename` | 其他章节 |
| `type === 'binary'` | 不支持提示 | — | 下条 |

不支持态(`:68-72`):`<div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--t3)' }}>`,文案 `t('filePreview.unsupported', { ext: ext || t('filePreview.unknownExt') })`——"不支持预览此文件类型（{ext}）" / "Preview not supported for this file type ({ext})";扩展名为空时 `{ext}` 用 `t('filePreview.unknownExt')`("未知" / "unknown")(i18n `:36-37`/`:253-254`)。

注:`DocxViewer`/`PdfViewer`/`PptxViewer` 的 import 在 `:13/:15/:16`,实现不在本章范围;它们与轻量查看器一样通过 `usePreviewToolbar` 注册能力。

---

### 5.5 预览工具栏框架

#### 5.5.1 能力契约:`preview/toolbar/capabilities.ts`

文件:`frontend-desktop/src/preview/toolbar/capabilities.ts`(共 28 行)。定义查看器可声明的能力接口:

- `SearchCapability`(`:1-8`):`run(query)`、`next()`、`prev()`、`clear()`,可选 `count?`、`current?`。
- `ZoomCapability`(`:9-15`):`in()`、`out()`、`reset()`、`fit()`、`scale`(当前缩放比,1 = 100%)。
- `PagesCapability`(`:16`):`count`、`current`、`goto(n)`。
- `TocItem`(`:17`):`{ id; label; level? }`。
- `TocCapability`(`:18`):`{ items: TocItem[]; goto(id) }`。
- `DownloadCapability`(`:19`):`{ url; filename }`。
- `ViewerCapabilities`(`:21-28`):聚合上述全部为可选字段——`search? / zoom? / pages? / toc? / download? / copy?`;其中 `copy?: () => string`(返回要复制的文本)。

#### 5.5.2 上下文与 hooks:`preview/toolbar/PreviewToolbarContext.tsx`

文件:`frontend-desktop/src/preview/toolbar/PreviewToolbarContext.tsx`(共 53 行)。

Context 形状 `Ctx`(`:4-9`):`caps`、`setCapabilities`、`tocOpen`、`setTocOpen`。`PreviewToolbarContext`(`:10`)初值 `null`。

`PreviewToolbarProvider`(`:12-25`):
- `caps`(`useState<ViewerCapabilities>`,初值 `{}`,`:13`)。
- `tocOpen`(`useState`,初值 `false`,`:17`)——目录侧栏开关,**跨文件粘连**(Acrobat 风格;注释 `:14-16` 说明侧栏自身会用 `caps.toc?.items.length > 0` 守卫,故残留的 `tocOpen` 对无目录查看器无害)。
- `setCapabilities`(`useCallback`,`:18`)、`setTocOpen`(`useCallback`,`:19`)。

读侧 hooks:
- `usePreviewToolbarState()`(`:28-32`):返回 `ctx.caps`(工具栏读取);Provider 外调用抛错。
- `useTocSidebar()`(`:36-40`):返回 `{ open: ctx.tocOpen, setOpen: ctx.setTocOpen }`(工具栏的目录按钮切换、Modal 的 TocSidebar 读取)。

写侧 hook(查看器用):
- `usePreviewToolbar(caps, deps)`(`:44-53`):`useEffect` 依赖 `deps`;每次 `setCapabilities(caps)` 注册能力,**返回清理函数 `setCapabilities({})`**——卸载或依赖变化时先清空,保证切换查看器后旧控件不残留。`deps` 由各查看器自行给(通常含内容 / path / filename / scale 等)。

#### 5.5.3 工具栏组件:`preview/toolbar/PreviewToolbar.tsx`

文件:`frontend-desktop/src/preview/toolbar/PreviewToolbar.tsx`(共 137 行)。

本地 state(`:22-25`):`caps = usePreviewToolbarState()`、`{ open: tocOpen, setOpen: setTocOpen } = useTocSidebar()`、`copied`(useState false)、`query`(useState '')、`searchInputRef`(useRef)。

**渲染守卫**(`:27-29`):`hasAny = caps.zoom || caps.pages || caps.search || caps.download || caps.copy || caps.toc`;若全无 → `return null`(工具栏整体不渲染——例如 `binary` 态)。

**`keepFocus(e)`**(`:17`):`e.preventDefault()`,绑在每个按钮 `onMouseDown`。注释(`:10-16`)解释:阻止点击时浏览器把焦点从搜索框转移到按钮——否则后续按 Enter 会重复触发该按钮(如一直放大),且 Enter 不再驱动搜索循环;`click` 仍正常触发,Tab 键焦点不受影响。

工具栏容器(`:39-40`):`<div className="flex items-center gap-1 px-3 py-1.5 flex-shrink-0">`,内联 `borderBottom: '1px solid var(--border)'`、`background: var(--bg2)`(#f5f8fe)。

所有按钮均为 `ui/button.tsx` 的 `<Button variant="ghost" size="icon">`(24.5px? 实际 `h-7 w-7`=28×28px、`p-0`、`rounded-md`、hover `#eaf0fb`、focus ring `#2563eb`)。

**(a) 缩放组**(`caps.zoom`,`:41-56`):
- 缩小 `ZoomOut` `size={15}`,`title=t('preview.zoomOut')`("缩小"/"Zoom out",i18n `:43`/`:259`),`onMouseDown=keepFocus`,`onClick=() => caps.zoom!.out()`。
- 比例显示(`:46-48`):`<span className="text-xs tabular-nums w-10 text-center" style={{ color: 'var(--t2)' }}>{Math.round(caps.zoom.scale * 100)}%</span>`(等宽数字、固定宽 40px、居中)。
- 放大 `ZoomIn` `size={15}`,`title=t('preview.zoomIn')`("放大"/"Zoom in",i18n `:42`/`:260`),`onClick=() => caps.zoom!.in()`。
- 适应窗口 `Maximize` `size={15}`,`title=t('preview.zoomFit')`("适应窗口"/"Fit to window",i18n `:45`/`:262`),`onClick=() => caps.zoom!.fit()`。

**(b) 目录按钮**(`caps.toc && caps.toc.items.length > 0`,`:58-70`):图标 `ListTree` `size={15}`,`title=t('preview.toc')`("目录"/"Contents",i18n `:51`/`:268`)。`onClick=() => setTocOpen(!tocOpen)`(切换侧栏)。激活态(`tocOpen` 为真,`:66`)内联 `background: var(--blue-dim)`、`color: var(--blue)`(Acrobat 风格选中底)。

**(c) 分页指示**(`caps.pages`,`:72-76`):`<span className="text-xs px-2" style={{ color: 'var(--t2)' }}>` 内容 `t('preview.page')`("页"/"Page",i18n `:50`/`:267`)+ `{current} / {count}`。**仅展示,无翻页交互**(本章范围查看器均未声明 `pages`;PDF 等可能用到)。

**(d) 搜索组**(`caps.search`,`:78-119`,容器 `flex items-center gap-1 ml-1`):
- `Search` 图标 `size={14}`,`color: var(--t3)`。
- 输入框(`:81-96`):`ref=searchInputRef`,受控 `value={query}`。`onChange`(`:84`):`setQuery(e.target.value)` 并 `caps.search!.run(e.target.value)`(即时搜索)。`onKeyDown`(`:85-92`):Enter → `preventDefault`;`Shift+Enter` → `prev()`,否则 `next()`(Word/Acrobat/Chrome 习惯)。`placeholder=t('preview.searchPlaceholder')`("在文件中搜索…"/"Search in file…",i18n `:47`/`:264`)。类 `text-xs px-2 py-1 rounded outline-none`,内联 `background: var(--bg1)`、`border: 1px solid var(--border)`、`color: var(--t1)`、`width: 160`。
- 命中计数(`:97-101`):仅 `typeof caps.search.count === 'number'` 时显示;`<span className="text-xs tabular-nums" style={{ color: 'var(--t3)' }}>{count}</span>`。
- 上一个(`:102-110`):`ChevronUp` `size={15}`,`title=t('preview.prevMatch')`("上一个"/"Previous",i18n `:48`/`:265`),`onClick=() => { caps.search!.prev(); searchInputRef.current?.focus() }`(循环后把焦点还给输入框)。
- 下一个(`:111-117`):`ChevronDown` `size={15}`,`title=t('preview.nextMatch')`("下一个"/"Next",i18n `:49`/`:266`),`onClick=() => { caps.search!.next(); searchInputRef.current?.focus() }`。

**(e) 弹性占位**(`:121`):`<div className="flex-1" />`——把后续按钮推到右端。

**(f) 复制**(`caps.copy`,`:123-127`):图标 `copied ? <Check> : <Copy>`(均 `size={15}`),`title` 在 `t('preview.copied')`("已复制"/"Copied")与 `t('preview.copy')`("复制"/"Copy")间切换(i18n `:40-41`/`:257-258`)。`onClick=doCopy`。`doCopy()`(`:30-36`):若无 `caps.copy` 直接返回;否则 `navigator.clipboard.writeText(caps.copy())`,成功后 `setCopied(true)` 并 `setTimeout(()=>setCopied(false), 1200)`(1.2 秒回弹)。

**(g) 下载**(`caps.download`,`:128-134`):用 `<a href={caps.download.url} download={caps.download.filename} title={t('preview.download')}>`("下载"/"Download",i18n `:39`/`:256`)包一个 `<Button variant="ghost" size="icon">` 内含 `Download` `size={15}`。点击为浏览器原生下载(走 `rawUrl`,见 5.6.1),无 JS 处理。

#### 5.5.4 目录侧栏:`preview/toolbar/TocSidebar.tsx`

文件:`frontend-desktop/src/preview/toolbar/TocSidebar.tsx`(共 51 行)。

渲染守卫(`:16`):`if (!open || !caps.toc || caps.toc.items.length === 0) return null`——必须同时:用户已开 + 当前查看器声明了 `toc` + 至少 1 项。

容器(`:18-22`):`<div className="flex flex-col flex-shrink-0 overflow-hidden">`,内联 `width: 260`、`background: var(--bg2)`、`borderRight: '1px solid var(--border)'`。

标题栏(`:23-28`):`<div className="px-3 py-2 text-xs font-semibold flex-shrink-0">`,内联 `color: var(--t2)`、`borderBottom: '1px solid var(--border)'`,文案 `t('preview.toc')`("目录"/"Contents")。

列表(`:29-48`):`<div className="flex-1 overflow-auto py-1">`,对 `caps.toc.items` 逐项渲染 `<button>`:
- `key={item.id}`,`onClick=() => caps.toc!.goto(item.id)`(跳到对应位置/标题)。
- 类 `ipm-toc-item block w-full text-left text-xs py-1 truncate`。
- 内联缩进:`paddingLeft: 12 + (item.level ?? 0) * 12`(每级缩进 12px),`paddingRight: 12`,`color: var(--t2)`,`background: transparent`,`border: none`,`cursor: pointer`。
- `title={item.label}`,文本 `{item.label}`。
- hover 样式由 CSS `.ipm-toc-item:hover { background: var(--bg1); }`(定义于 `frontend-desktop/src/preview/viewers/pdf/pdf.css:24`)提供。

> 注:本章范围内的轻量查看器(image/text/code/markdown/excel)均**未**注册 `toc` 能力,故目录按钮与侧栏对它们不出现;`toc` 主要由 PDF/DOCX 等重型查看器提供(需确认)。

---

### 5.6 查看器公共件:`preview/viewers/common.tsx`

文件:`frontend-desktop/src/preview/viewers/common.tsx`(共 58 行)。

#### 5.6.1 URL 构造

- `rawUrl(path)`(`:5-7`):`/api/v1/workspace/file/raw?path=<encodeURIComponent(path)>`——原始二进制流,用于图片 `src`、Excel arrayBuffer、所有"下载"按钮。
- `textUrl(path)`(`:9-11`):`/api/v1/workspace/file?path=<encodeURIComponent(path)>`——返回 JSON `{ content }`。

> 这两处是**硬编码 `/api/v1` 前缀**的裸 `fetch`,与 `api/workspace.ts` 经 `http` 客户端的调用路径(`/workspace/...`)走的是不同入口(client 自带前缀)。开发态由 Vite 代理 `/api` → 后端 `:15926`(见环境说明)。

#### 5.6.2 `fetchOrThrow(url)`(`:16-28`)

`fetch(url)`;若 `!r.ok`:读 body 文本,尝试 `JSON.parse` 取 FastAPI 的 `detail` 字段,否则用原始 body;抛 `Error('HTTP {status}: {detail 前 200 字}')`。目的(注释 `:13-15`):让 mammoth/xlsx 等不会把 HTML/JSON 错误体当成期望的二进制格式去解析。

#### 5.6.3 `useFileText(path)`(`:30-45`)

- state:`content`(`string | null`,初值 null)、`error`(`string | null`)。
- `useEffect([path])`:`cancelled` 闭包标志;进入即 `setContent(null); setError(null)`;`fetchOrThrow(textUrl(path)).then(r=>r.json()).then(d => !cancelled && setContent(d.content)).catch(e => !cancelled && setError(String(e)))`;清理函数置 `cancelled = true`(注释 `:40-42`:`path` 在 fetch settle 前变化时丢弃过期结果,防止旧文件内容覆盖新文件)。
- 返回 `{ content, error }`。

#### 5.6.4 `Loading` / `ErrorMsg`

- `Loading`(`:47-54`):`<div className="flex h-full items-center justify-center gap-2" style={{ color: 'var(--t3)' }}>`,内含 `<Spinner className="h-4 w-4" />` + `<span className="text-sm">{t('common.loading')}</span>`。`Spinner`(`ui/spinner.tsx`)= `inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-300`(旋转环)。
- `ErrorMsg`(`:56-58`):`<div className="flex h-full items-center justify-center p-6 text-red-500 text-sm">{msg}</div>`(Tailwind `text-red-500`,非 CSS 变量)。

---

### 5.7 图片查看器:`preview/viewers/ImageViewer.tsx`

文件:`frontend-desktop/src/preview/viewers/ImageViewer.tsx`(共 60 行)。

常量(`:5-7`):`STEP = 1.25`(每步 ×/÷1.25)、`MIN = 0.1`、`MAX = 8`。

State(`:10-12`):`scale`(useState 1)、`offset`(useState `{x:0,y:0}`,拖拽平移量)、`drag`(useRef,拖拽起点 `{x,y,ox,oy}` 或 null)。

工具:`clamp(s) = min(MAX, max(MIN, s))`(`:14`);`reset() = setScale(1); setOffset({0,0})`(`:15`)。

能力注册(`:17-26`):`usePreviewToolbar({ zoom: { in, out, reset, fit, scale }, download: { url: rawUrl(path), filename } }, [scale, path, filename])`。
- `zoom.in`:`setScale(s => clamp(s * STEP))`。
- `zoom.out`:`setScale(s => clamp(s / STEP))`。
- `zoom.reset` 与 `zoom.fit` 都 = `reset`(适应窗口=复位到 1× 且居中)。
- `download` 指向原图 `rawUrl(path)`,文件名 `filename`。
- 故图片查看器在工具栏出现:缩小/比例/放大/适应 + 复制(无)/下载。无 `copy`。

交互:
- `onWheel`(`:28-31`):`preventDefault`;向上滚(`deltaY<0`)放大 ×STEP,否则缩小 ÷STEP,经 `clamp`。
- `onDown`(`:32-34`):记录拖拽起点与当前 offset 到 `drag.current`。
- `onMove`(`:35-38`):有 `drag.current` 时按鼠标位移更新 `offset`(平移)。
- `onUp`(`:39`):`drag.current = null`(`onMouseUp` 与 `onMouseLeave` 都绑它)。

容器(`:42-50`):`<div className="flex h-full items-center justify-center overflow-hidden p-4">`,内联 `background: var(--bg2)`、`cursor: scale > 1 ? 'grab' : 'default'`(放大后显示抓手)。绑 `onWheel/onMouseDown/onMouseMove/onMouseUp/onMouseLeave`。

图片(`:51-57`):`<img src={rawUrl(path)} alt={path} draggable={false} className="max-h-full max-w-full object-contain rounded shadow select-none">`,内联 `transform: translate({offset.x}px,{offset.y}px) scale({scale})`、`transformOrigin: 'center'`。无独立 loading/error 态(由浏览器原生加载;失败显示破图)。

---

### 5.7b 文本查看器:`preview/viewers/TextViewer.tsx`

文件:`frontend-desktop/src/preview/viewers/TextViewer.tsx`(共 17 行)。

- `{ content, error } = useFileText(path)`(`:5`)。
- 能力(`:6-9`):`usePreviewToolbar({ copy: () => content ?? '', download: { url: rawUrl(path), filename } }, [content, path, filename])`——工具栏出现"复制"+"下载"。
- 错误态(`:10`):`<ErrorMsg msg={error} />`。
- 加载态(`:11`):`content === null` → `<Loading />`。
- 正常(`:12-16`):`<pre className="px-6 py-4 text-xs leading-relaxed whitespace-pre font-mono" style={{ color: 'var(--t1)' }}>{content}</pre>`(等宽、保留原始空白、不换行 `whitespace-pre`、内边距 24px/16px)。

---

### 5.7c 代码查看器:`preview/viewers/CodeViewer.tsx`

文件:`frontend-desktop/src/preview/viewers/CodeViewer.tsx`(共 36 行)。

依赖:`highlight.js/lib/common`(`:2`)与样式 `highlight.js/styles/github.css`(`:3`,GitHub 浅色高亮主题)。

Props(`:7`):`path`、`lang`(由 Modal 传入 `CODE_LANGS[ext]`)、`filename`。

- `{ content, error } = useFileText(path)`(`:8`)。
- 高亮 `html`(`useMemo([content, lang])`,`:10-19`):`content === null` → `''`;否则:若 `lang && hljs.getLanguage(lang)` 用 `hljs.highlight(content, { language: lang }).value`,否则 `hljs.highlightAuto(content).value`;`catch` 返回 `null`(高亮失败标记)。
- 能力(`:21-24`):同 TextViewer——`copy: () => content ?? ''` + `download`。
- 错误态(`:26`)/加载态(`:27`,`content === null`)同上。
- 正常(`:29-35`):`<pre className="hljs text-xs leading-relaxed m-0 p-4 overflow-auto h-full" style={{ background: 'transparent' }}>`。内部:`html === null`(高亮抛错)→ 退化为纯文本 `<code>{content}</code>`;否则 `<code dangerouslySetInnerHTML={{ __html: html }} />`(注入高亮 HTML)。

---

### 5.7d Markdown 查看器:`preview/viewers/MarkdownViewer.tsx`

文件:`frontend-desktop/src/preview/viewers/MarkdownViewer.tsx`(共 118 行)。

依赖:`react-markdown`(`:1`)+ `remark-gfm`(`:2`,GFM 表格/任务列表等)+ 自研 `Mermaid`(`:5`)。

Props(`:42-53`):`path`、`filename`、`onNavigate?`(打开另一份工作区文档;缺省时内链被吞掉而非导航主框架)。

取数与能力:
- `{ content, error } = useFileText(path)`(`:54`)。
- 能力(`:55-58`):`copy: () => content ?? ''` + `download: { url: rawUrl(path), filename }`。无缩放/目录。
- 错误态(`:60`)/加载态(`:61`)同其他查看器。

**路径解析辅助**:
- `normalizePath(p)`(`:9-22`):折叠 `.` / `..` 段(支持绝对 `/` 前缀),把 `ws/docs/../other.md` 规约为后端可接受的路径。
- `resolveWorkspacePath(ref, mdPath)`(`:27-31`):`ref` 以 `/` 开头则按绝对处理 `normalizePath(ref)`;否则相对 md 文件所在目录拼接后 `normalizePath`。
- `resolveImgSrc(src, mdPath)`(`:33-36`):空 / `http(s):` / `data:` / `//` 协议 URL 原样返回;否则 `rawUrl(resolveWorkspacePath(src, mdPath))`(相对图片转 raw 接口)。
- `isExternalHref(href)`(`:38-40`):匹配 `^(https?:|mailto:|tel:|//)` 视为外链。

**渲染容器**(`:64`):`<div className="prose prose-sm max-w-none px-8 py-6 md-doc">`(Tailwind Typography `prose-sm`,内边距 32px/24px,自定义类 `md-doc`)。`.md-doc pre` / `.md-doc pre code` 在 `index.css:88-98` 把代码块底色改 `#f6f8fa`、文字 `var(--t1)`。

**`<ReactMarkdown>` 自定义组件**(`:65-113`,`remarkPlugins={[remarkGfm]}`):

1. **`img`**(`:68-70`):`<img src={resolveImgSrc(src ?? '', path)} alt={alt ?? ''} {...rest} className="max-w-full rounded" />`(相对图片走工作区 raw 接口)。
2. **`code`**(`:74-79`):若 `className?.includes('language-mermaid')` → 渲染 `<Mermaid chart={String(children).replace(/\n$/, '')} />`(去尾换行);否则默认 `<code className={className} {...rest}>{children}</code>`。
3. **`pre`**(`:84-88`):检测源 hast 节点首子是否 `language-mermaid`(因为渲染时内层 `<code>` 已变 `<Mermaid>`),是则去掉 `<pre>` 包裹直接返回 `<>{children}</>`(避免图被代码底色框住);否则默认 `<pre {...rest}>{children}</pre>`。
4. **`a`**(`:89-111`)—— 链接三分支:
   - 空 / `#` 开头(页内锚点/目录链)(`:92`):`<a href={h}>{children}</a>`(原样,仅改 fragment 无害)。
   - 外链(`isExternalHref`)(`:95`):`<a href={h} target="_blank" rel="noreferrer">{children}</a>`——经 Electron `setWindowOpenHandler`(`target=_blank` → new-window 请求)在系统浏览器打开。
   - 工作区内链(`:100-109`):渲染 `<a href={h}>`,但 `onClick` 里 `e.preventDefault()`,若有 `onNavigate` 则 `onNavigate(resolveWorkspacePath(h.split(/[?#]/)[0], path))`(去掉 query/hash 后解析为工作区路径,原地换预览文件)。注释(`:96-99`)强调:**绝不让主框架导航**——裸 `<a href="other.md">` 会解析到 SPA origin、后端 404、整页被 `{"detail":"not found"}` 替换且无法返回(菜单栏已移除)。
- 正文(`:114`):`{content}`。

#### 5.7d-1 Mermaid 子组件:`preview/viewers/Mermaid.tsx`

文件:`frontend-desktop/src/preview/viewers/Mermaid.tsx`(共 76 行)。

- **动态导入**:mermaid 约 500KB,仅在文档含 ```mermaid 块时 `import('mermaid')`(`:38`),不进初始包(注释 `:3-5`)。
- 模块级 `initialized`(`:6`)与 `ensureInit(mermaid)`(`:8-24`):首次调用 `mermaid.initialize({ startOnLoad:false, theme:'default', securityLevel:'strict', suppressErrorRendering:true, fontFamily:'system-ui, -apple-system, sans-serif' })`。
  - `securityLevel:'strict'`:对工作区文件来源的图表文本视为不可信,渲染前消毒 SVG。
  - `suppressErrorRendering:true`(注释 `:17-21`):**关键**——否则解析错误会把 mermaid 的"炸弹"错误 SVG 注入 `<body>` 且不移除,黏在整个 app 底部;开启后 `render()` 改为 reject 走 catch,失败被限制在本组件内。
- 模块级 `seq`(`:26`,自增 id)。
- 组件 state(`:30-31`):`svg`(useState '')、`err`(useState '')。
- `useEffect([chart])`(`:33-64`):
  - `cancelled` 标志;`id = 'mermaid-' + seq++`(注释 `:34-36`:每次渲染唯一 id,避开 StrictMode 双调用在残留节点上冲突)。
  - `import('mermaid')` → `ensureInit` → `await mermaid.parse(chart, { suppressErrors: true })`,`!ok` 则 `throw new Error('图表语法无效')`(注释 `:41-43`:先验证,无效输入不进 render/不碰 DOM);通过则 `await mermaid.render(id, chart)`,未取消则 `setSvg(svg); setErr('')`。
  - `.catch`(`:52-54`):未取消则 `setErr(e.message ?? String(e))`。
  - `.finally`(`:55-60`):移除 mermaid 可能追加到 `<body>` 的临时测量节点(`'d'+id` 或 `id`)——防泄漏到 app 框架。
  - 清理:`cancelled = true`。
- 渲染:
  - 错误态(`:66-72`):`<pre className="not-prose" style={{ background:'#fff5f5', color:'var(--red)', border:'1px solid var(--border)', borderRadius:8, padding:'12px 14px', fontSize:12, whiteSpace:'pre-wrap' }}>` 显示 ``Mermaid 渲染失败: ${err}`` + 原始源码(降级让坏图仍可读)。该硬编码串确切为 `` `Mermaid 渲染失败: ${err}\n\n${chart}` ``(`Mermaid.tsx:70`)。
  - 加载态(`:74`):`<div className="not-prose" style={{ color:'var(--t3)', fontSize:12, padding:'8px 0' }}>渲染图表中…</div>`(中文硬编码,未走 i18n)。
  - 正常(`:75`):`<div className="not-prose" style={{ display:'flex', justifyContent:'center', overflowX:'auto', margin:'12px 0' }} dangerouslySetInnerHTML={{ __html: svg }} />`(居中、可横向滚动)。

---

### 5.8 Excel 查看器:`preview/viewers/ExcelViewer.tsx`

文件:`frontend-desktop/src/preview/viewers/ExcelViewer.tsx`(共 72 行)。

依赖:`parseInWorker`(`../worker/parseClient`,`:4`)与类型 `SheetData`(`../worker/protocol`,`:5`,`{ name: string; rows: string[][] }`,见 `protocol.ts:28`)。解析在 Web Worker 中进行(xlsx 重,避免阻塞 UI;Worker 框架属其他章节)。

State(`:9-12`):`t = useI18n()`、`tables`(`SheetData[] | null`,初值 null)、`error`(`string | null`)、`activeSheet`(useState 0,当前 sheet 索引)。

能力(`:14`):`usePreviewToolbar({ download: { url: rawUrl(path), filename } }, [path, filename])`——仅"下载"(无复制/缩放)。

加载(`useEffect([path])`,`:16-25`):
- `AbortController ac`;进入即 `setTables(null); setError(null); setActiveSheet(0)`。
- `fetchOrThrow(rawUrl(path)).then(r=>r.arrayBuffer()).then(buf => parseInWorker('xlsx', buf, { signal: ac.signal })).then(sheets => !ac.signal.aborted && setTables(sheets)).catch(e => e?.name !== 'AbortError' && setError(String(e)))`。
- 清理:`ac.abort()`(切换文件时取消进行中的解析)。

渲染态:
- 错误(`:27`):`<ErrorMsg msg={error} />`。
- 加载(`:28`,`tables === null`):`<Loading />`。
- 空(`:29`,`tables.length === 0`):`<div className="p-6 text-sm" style={{ color: 'var(--t3)' }}>{t('filePreview.empty')}</div>`("文件为空"/"File is empty",i18n `:38`/`:255`)。

正常(`:31-70`):`sheet = tables[activeSheet]`。容器 `flex flex-col h-full`。
- **Sheet 标签页**(`:34-52`):仅 `tables.length > 1` 时显示。容器 `flex gap-1 px-4 pt-2 flex-shrink-0`,内联 `borderBottom: '1px solid var(--border)'`。每个 `<button key={tbl.name} onClick={() => setActiveSheet(i)}>`,类 `px-3 py-1.5 text-xs rounded-t transition-colors`。激活态(`i === activeSheet`)内联:`color: var(--blue)`、`background: var(--blue-dim)`、`borderBottom: 2px solid var(--blue)`;非激活:`color: var(--t2)`、`background: transparent`、`borderBottom: 2px solid transparent`;`border: none`、`cursor: pointer`。文本 `{tbl.name}`。点击 → `setActiveSheet(i)`。
- **表格**(`:54-68`):`<div className="flex-1 overflow-auto">` 内 `<table className="w-full text-xs border-collapse">`。`sheet.rows.map((row, ri) => <tr>)`:**首行**(`ri === 0`)内联 `background: var(--bg2)`、`fontWeight: 600`(当表头处理)。单元格 `<td key={ci} className="px-2 py-1 whitespace-nowrap max-w-[200px] truncate" style={{ border: '1px solid var(--border)', color: 'var(--t1)' }}>{String(cell ?? '')}</td>`(单行不换行、最大宽 200px 截断、`null`→`''`)。

---

### 5.9 交互元素速查表(本章范围)

| 元素 | 位置(文件:行) | 文案/图标 | 点击行为 |
|---|---|---|---|
| 在资源管理器打开 | WorkspacePanel:90-94 | FolderInputIcon(12) | `window.electronAPI.openPath(rootPath)` |
| 刷新 | WorkspacePanel:95-97 | RefreshCwIcon(12) | `refetch()`(重拉当前目录) |
| 关闭工作区 | WorkspacePanel:98-102 | XIcon(13) | `onClose()` |
| 面包屑根/段 | WorkspacePanel:109-126 | 文本 chip | `navigateTo(目标目录)` → 改 browsePath |
| 返回上级 | WorkspacePanel:135-146 | ArrowLeftIcon(12) | `navigateTo(parentPath)` |
| 目录行 | WorkspacePanel:163-170 | FolderIcon(#f59e0b) | `navigateTo(entry.path)` |
| 文件行 | WorkspacePanel:173-181 | 类型图标 | `setPreviewFile(entry.path)` → 开预览 |
| 遮罩空白 | FilePreviewModal:41 | — | `onClose()` |
| ESC 键 | FilePreviewModal:31-35 | — | `onClose()` |
| 弹窗关闭 | FilePreviewModal:50 | XIcon(16) | `onClose()` |
| 缩小/放大/适应 | PreviewToolbar:41-56 | ZoomOut/ZoomIn/Maximize(15) | `caps.zoom.out/in/fit()` |
| 目录开关 | PreviewToolbar:58-70 | ListTree(15) | `setTocOpen(!tocOpen)` |
| 搜索输入 | PreviewToolbar:81-96 | input | `run(q)`;Enter=next,Shift+Enter=prev |
| 上/下一个匹配 | PreviewToolbar:102-117 | ChevronUp/Down(15) | `prev()/next()`+回焦输入框 |
| 复制 | PreviewToolbar:123-127 | Copy/Check(15) | `navigator.clipboard.writeText(caps.copy())`,1.2s 回弹 |
| 下载 | PreviewToolbar:128-134 | Download(15) | `<a download>` 原生下载 `caps.download.url` |
| 目录项 | TocSidebar:31-46 | 文本按钮 | `caps.toc.goto(item.id)` |
| 图片滚轮缩放 | ImageViewer:28-31 | — | `setScale(clamp(...))` |
| 图片拖拽平移 | ImageViewer:32-39 | — | `setOffset(...)` |
| Markdown 外链 | MarkdownViewer:95 | `<a target=_blank>` | 系统浏览器打开 |
| Markdown 内链 | MarkdownViewer:100-109 | `<a>` | `onNavigate(resolveWorkspacePath(...))` |
| Excel sheet 标签 | ExcelViewer:36-51 | 文本按钮 | `setActiveSheet(i)` |

---

### 5.10 实现要点与边界

- **能力解耦/自清理**:`usePreviewToolbar` 的 `useEffect` 返回 `setCapabilities({})`,切换文件/查看器时旧能力被清空,工具栏 `hasAny` 守卫使其在无能力时整体不渲染(`PreviewToolbar.tsx:27-29`)。
- **路径分隔符**:工作区面板对 Windows(`\`)与 POSIX(`/`)双适配——内部统一归一为 `/` 计算,导航前用 `sep` 还原(`WorkspacePanel.tsx:31,69,122`)。
- **请求竞态防护**:`useFileText`(common.tsx)用 `cancelled` 标志、`ExcelViewer` 用 `AbortController`,避免旧文件结果覆盖新文件。
- **Markdown 内链安全**:严防主框架被导航到后端 404 把整页 SPA 顶掉(`MarkdownViewer.tsx:96-109`)。
- **Mermaid 隔离**:`suppressErrorRendering` + `parse(suppressErrors)` 预校验 + `<body>` 残留节点清理,三重防护把渲染失败限制在组件内(`Mermaid.tsx`)。
- **i18n 缺口**:Mermaid 的"图表语法无效""渲染图表中…""Mermaid 渲染失败: …"为中文硬编码,未走 `useI18n`(`Mermaid.tsx:45,69,74`)。
- **API 前缀不一致(需确认)**:查看器走裸 `fetch('/api/v1/workspace/...')`(common.tsx),而 `workspaceApi` 走 `http.get('/workspace/...')`(client 自带前缀);两者最终命中同一后端,但前缀拼接位置不同,新增接口时需注意一致性。
- **`workspaceApi.readFile` 未被本章查看器使用**(轻量查看器统一用 `useFileText`/`rawUrl`);其调用方需确认。


---

## 6. 重型查看器(PDF / PPTX / DOCX)与解析 Worker

本章覆盖 IPMaster-Cowork 桌面前端中三种"重型"文档查看器(PDF、PPTX、DOCX),以及为表格类文件服务的解析 Web Worker 管线。这三种查看器与前面章节的轻量查看器(文本 / 图片 / 表格)最大的差异在于:它们各自依赖一个体量很大的第三方解析栈(pdfjs / 自研 PPTX→HTML 引擎 / docx-preview),并且都要在"保真还原原始版式"和"在 Electron 渲染进程里不卡死、不崩溃"之间做工程取舍。

阅读约定:
- 凡引用源码处统一标注 `文件路径:行号`。文件路径相对仓库根 `D:\IpMasterCoworkPy`,但在正文中省略盘符前缀,以 `frontend-desktop/...` 形式给出。
- 颜色尽量给出确切 hex / `var(--xx)` / `rgba(...)`;间距 / 尺寸尽量给出确切 px 或 Tailwind 类名。
- PPTX 解析引擎 `pptx.ts`(2413 行)是本章体量最大的部分。本章对其**能力清单**(支持哪些 shape / 几何 / 文本 / 表格 / 图片 / 主题色)力求穷尽;但对其内部纯算法(HSL 颜色变换、贝塞尔/弧线坐标换算、连接器折线点位计算等)**只按模块与职责概述,不逐行抄录数学公式**——这是刻意的取舍,目的是让文档聚焦"能力与边界"而非"重抄一遍代码"。

---

### 6.0 三种查看器的共同底座

三个查看器都从 `frontend-desktop/src/preview/viewers/common.tsx` 复用同一组工具(common.tsx:1-58):

- `rawUrl(path)`(common.tsx:5-7):构造后端原始字节下载地址 `\`/api/v1/workspace/file/raw?path=${encodeURIComponent(path)}\``。三个查看器都用它取原始二进制(PDF/PPTX/DOCX 都是二进制容器),也都把它原样作为工具栏"下载"能力的 `url`。
- `textUrl(path)`(common.tsx:9-11):`/api/v1/workspace/file?path=...`,返回 JSON 文本——重型查看器**不用**它(它是文本类查看器用的)。
- `fetchOrThrow(url)`(common.tsx:16-28):封装 `fetch`,当 `!r.ok` 时把 FastAPI 的 `detail` 字段(或原始 body)截断到 200 字符塞进 `Error("HTTP {status}: {detail}")`,避免把 HTML/JSON 错误体当作二进制解析。三个查看器的加载链首步都是 `fetchOrThrow(rawUrl(path))`。
- `Loading`(common.tsx:47-54):居中 flex 容器,`gap-2`,文字色 `var(--t3)`,内含 `<Spinner className="h-4 w-4" />` + `<span className="text-sm">{t('common.loading')}</span>`。PDF、DOCX 用它;PPTX 自己另起了一个带进度文案的加载态(见 6.2)。
- `ErrorMsg`(common.tsx:56-58):`flex h-full items-center justify-center p-6 text-red-500 text-sm`,纯文本错误信息。三个查看器的错误态都返回 `<ErrorMsg msg={error} />`。

三个查看器都通过 `usePreviewToolbar(capabilities, deps)` 向上注册"工具栏能力"(zoom / pages / search / toc / download / copy),能力契约定义在 `frontend-desktop/src/preview/toolbar/capabilities.ts`(capabilities.ts:1-28):

- `SearchCapability`: `run(query)` / `next()` / `prev()` / `clear()` / 可选 `count` / `current`。仅 PDF 提供。
- `ZoomCapability`: `in()` / `out()` / `reset()` / `fit()` / `scale: number`。三者都提供。
- `PagesCapability`: `{ count, current, goto(n) }`。PDF、PPTX 提供;DOCX 不提供(无分页跳转能力)。
- `TocItem`: `{ id, label, level? }`;`TocCapability`: `{ items, goto(id) }`。PDF、PPTX 提供。
- `DownloadCapability`: `{ url, filename }`。三者都提供。
- `copy?: () => string`:三者都未提供(无"复制全文"能力)。

> 说明(需确认):工具栏 UI 本身(按钮文案、图标、各按钮的 hover/disabled 配色)由 `PreviewToolbarContext` 与工具栏组件渲染,属于另一章范畴;本章只记录三个查看器**注册了哪些能力、每个能力的回调做了什么副作用**。下文"可交互元素"指的是查看器自身或它注册的能力。

---

### 6.1 PDF 查看器(PdfViewer)

文件:
- `frontend-desktop/src/preview/viewers/PdfViewer.tsx`(252 行)
- `frontend-desktop/src/preview/viewers/pdf/pdfSetup.ts`(21 行)
- `frontend-desktop/src/preview/viewers/pdf/outline.ts`(36 行)
- `frontend-desktop/src/preview/viewers/pdf/pdf.css`(24 行)

底层栈:`pdfjs-dist`,直接复用其预编译的"完整查看器"组件 `pdf_viewer.mjs`(`EventBus` / `PDFViewer` / `PDFLinkService` / `PDFFindController`,见 PdfViewer.tsx:6),因此 PDF 是三者中唯一拥有**原生连续滚动 + 文本层 + 全文检索 + 大纲跳转**的查看器。

#### 6.1.1 pdfSetup.ts —— 必须先于一切的初始化

pdfSetup.ts 做三件事(pdfSetup.ts:1-20):
1. 导入 `pdfjs-dist`,并把 worker 资源 URL 通过 Vite 的 `?url` 后缀解析为打包后的 worker 文件,赋给 `pdfjsLib.GlobalWorkerOptions.workerSrc`(pdfSetup.ts:4-6)。注释强调 worker 与主包同包,版本天然一致,避免 "version mismatch"。
2. **关键副作用**:`globalThis.pdfjsLib = pdfjsLib`(pdfSetup.ts:14)。因为 `pdf_viewer.mjs` 在**模块加载期**就从 `globalThis.pdfjsLib` 解构 `AbortException`/`PDFViewer` 等;若不先赋值,生产构建会崩 `Cannot destructure property 'AbortException' of 'globalThis.pdfjsLib'`。PdfViewer.tsx:2-5 的注释再次强调:**import 顺序不能换**——必须先 import `pdfSetup` 再 import `pdf_viewer.mjs`。
3. 导出 CMap 配置:`CMAP_URL = \`${import.meta.env.BASE_URL}cmaps/\``、`CMAP_PACKED = true`(pdfSetup.ts:17-18)。CMaps 由 `vite-plugin-static-copy` 拷到 `<base>/cmaps/`,供 CJK 等需要字符映射的 PDF 使用。

#### 6.1.2 outline.ts —— 大纲扁平化(纯函数)

`flattenOutline(outline)`(outline.ts:20-36)把 pdfjs `doc.getOutline()` 返回的嵌套大纲树展平为:
- `items: TocItem[]`:每项 `{ id: \`o${seq++}\`, label: node.title?.trim() || '(untitled)', level }`,`level` 自 0 起按层递增用于缩进。
- `dests: Map<string, OutlineDest>`:id → 目的地(命名字符串或显式 destination 数组,`OutlineDest = string | unknown[]`,outline.ts:4)。目的地稍后交给 `PDFLinkService.goToDestination` 解析。

纯函数、无 pdfjs 调用(outline.ts:19 注释)。空大纲返回空 items + 空 dests。

#### 6.1.3 组件结构、props、state、refs

`PdfViewer({ path, filename })`(PdfViewer.tsx:25)。

常量(PdfViewer.tsx:14-16):`ZOOM_STEP = 0.2`、`ZOOM_MIN = 0.25`、`ZOOM_MAX = 5`。

Refs(PdfViewer.tsx:26-35):
- `containerRef`:滚动容器 `<div class="ipm-pdf-container">`。
- `viewerElRef`:`<div class="pdfViewer">`(pdfjs 渲染目标)。
- `apiRef: PdfApi | null`:保存 `{ viewer, linkService, eventBus, dests }`(接口 PdfViewer.tsx:18-23),供工具栏回调随时取用。
- `lastQuery`:上次检索词(用于"下一个/上一个"复用)。
- `fitModeRef = useRef(true)`:是否处于"适配模式"(随容器尺寸变化重新适配 page-width)对"固定用户缩放"。用 ref 而非 state,因为 `ResizeObserver` 回调需要稳定引用,且重建 observer 会丢失在途 `ro.observe`(PdfViewer.tsx:30-34)。
- `setTocOpen`:来自 `useTocSidebar()`,控制 TOC 侧栏开合。

State(PdfViewer.tsx:37-42):
- `error: string | null`、`ready: boolean`(初次 `pagesinit` 后置 true)、`scale`(当前缩放,初值 1)、`page: { current, count }`、`matches: { current, total }`(检索命中)、`toc: TocItem[]`。

#### 6.1.4 加载与 pdfjs 栈构建(主 useEffect,依赖 `[path, setTocOpen]`)

PdfViewer.tsx:45-164。流程:
1. 重置态:`setError(null); setReady(false); setToc([]); setMatches({0,0})`(PdfViewer.tsx:51)。
2. 构建 pdfjs 四件套:`EventBus` → `PDFLinkService` → `PDFFindController` → `PDFViewer`,并 `linkService.setViewer(viewer)`(PdfViewer.tsx:53-57)。
3. **两处针对检索抖动的 monkey-patch**(本查看器的精髓所在):
   - 禁掉 `findController.scrollMatchIntoView`(置空函数,PdfViewer.tsx:62):pdfjs 自带的内联滚动每次都 `parent.scrollTop = absoluteOffset`,即便命中已可见也会推一下页面。
   - 改写 `linkService` 原型上的 `page` setter(PdfViewer.tsx:75-88):`PDFFindController` 每次切换选中命中都会 `linkService.page = idx+1`,链路 `currentPageNumber → _setCurrentPageNumber → #resetCurrentPageView → #scrollIntoView`,即使页面没变也会把页面强拉回容器顶部,造成同页步进时的闪动。改写后:`if (get.call(this) === v) return`——页码未变则跳过赋值,跨页跳转仍正常。
4. 事件订阅(PdfViewer.tsx:90-100):
   - `pagesinit` → `fitModeRef.current = true; viewer.currentScaleValue = 'page-width'; setReady(true)`(进入"按页宽适配"且标记就绪)。
   - `scalechanging` → `setScale(e.scale)`。
   - `pagechanging` → `setPage(p => ({...p, current: e.pageNumber}))`。
   - `updatefindmatchescount` / `updatefindcontrolstate` → `setMatches(e.matchesCount)`。
5. **自研的"命中可见性兜底"**`ensureSelectedVisible`(PdfViewer.tsx:111-122):取 `.highlight.selected`,计算其相对容器的可见性(上下各留 `MARGIN = 40px`),仅当**不在视口内**时才 `el.scrollIntoView({ block: 'center', behavior: 'auto' })`。这避免了"先向上再向下"的二次纠正抖动。触发时机:
   - `updatefindcontrolstate` 后 `setTimeout(ensureSelectedVisible, 80)`(等文本层渲染,80ms,PdfViewer.tsx:123-129)。
   - `textlayerrendered` 后 `setTimeout(ensureSelectedVisible, 0)`(PdfViewer.tsx:130-134)。
6. 文档加载链(PdfViewer.tsx:136-156):`fetchOrThrow(rawUrl(path))` → `r.arrayBuffer()` → `pdfjsLib.getDocument({ data, cMapUrl, cMapPacked }).promise` → 拿到 `doc` 后:`viewer.setDocument(doc)`、`linkService.setDocument(doc, null)`、`setPage({current:1, count: doc.numPages})`;再 `doc.getOutline()`(失败兜底 null)→ `flattenOutline` → 写入 `apiRef.current = { viewer, linkService, eventBus, dests }`;若有大纲则 `setToc(flat.items)` 并 **`setTocOpen(true)`**(模仿 Acrobat:有大纲就自动展开 TOC 侧栏,且每次加载都重新应用,PdfViewer.tsx:148-154)。`catch` → `setError(String(e))`。
7. 清理(PdfViewer.tsx:158-163):`destroyed = true; apiRef.current = null; viewer.setDocument(null); pdfDoc?.destroy()`。

#### 6.1.5 容器尺寸自适配(第二 useEffect,依赖 `[]`)

PdfViewer.tsx:170-180:对 `containerRef` 挂 `ResizeObserver`,回调里**仅当 `fitModeRef.current` 为真**时执行 `viewer.currentScaleValue = 'page-width'`。覆盖两种尺寸变化:TOC 侧栏开合(改变可用宽度)、用户拖拽窗口。用户显式缩放会把 `fitModeRef` 置 false,从而保留其缩放不被重置。

#### 6.1.6 检索分发与工具栏能力注册

`dispatchFind(again, findPrevious)`(PdfViewer.tsx:184-189):向 `eventBus` 派发 `'find'` 事件,字段 `{ source:null, type: again?'again':'', query: lastQuery.current, caseSensitive:false, entireWord:false, highlightAll:true, findPrevious }`。注释指出:pdfjs 每次 `'find'` 都整体替换检索状态,因此"下一个/上一个"必须重发 query+flags,否则会清空当前检索。

`usePreviewToolbar({...}, deps)`(PdfViewer.tsx:192-240)注册的能力——逐项的**点击行为/副作用**:

- **zoom**(PdfViewer.tsx:193-215):
  - `in()`:`fitModeRef.current = false`;`v.currentScale = Math.min(ZOOM_MAX=5, currentScale + 0.2)`。
  - `out()`:`fitModeRef.current = false`;`v.currentScale = Math.max(ZOOM_MIN=0.25, currentScale - 0.2)`。
  - `reset()`:`fitModeRef.current = false`;`v.currentScale = 1`(100%)。
  - `fit()`:`fitModeRef.current = true`;`v.currentScaleValue = 'page-width'`(按页宽适配)。
  - `scale`:当前 state `scale`,供工具栏显示百分比。
- **pages**(PdfViewer.tsx:216-220):`count = page.count`、`current = page.current`、`goto(n)` → `viewer.currentPageNumber = n`(直接跳页)。
- **search**(PdfViewer.tsx:221-228):
  - `run(query)`:`lastQuery.current = query; dispatchFind(false, false)`(首次检索)。
  - `next()`:`dispatchFind(true, false)`;`prev()`:`dispatchFind(true, true)`。
  - `clear()`:`lastQuery.current=''` 并派发 `'findbarclose'` 关闭检索高亮。
  - `count = matches.total`、`current = matches.current`。
- **toc**(条件注册,仅当 `toc.length > 0`,PdfViewer.tsx:229-238):`items = toc`;`goto(id)` → 从 `apiRef.current.dests.get(id)` 取目的地,非空则 `linkService.goToDestination(dest)`。
- **download**(PdfViewer.tsx:239):`{ url: rawUrl(path), filename }`。

依赖数组 `[scale, page.current, page.count, matches.total, matches.current, toc, path, filename]`(PdfViewer.tsx:240)——任一实时态变化即重新注册能力,保证工具栏读到的是最新值。

#### 6.1.7 渲染与各状态

PdfViewer.tsx:242-251:
- 错误态:`<ErrorMsg msg={error} />`(直接返回,不渲染容器)。
- 正常态:外层 `<div className="relative h-full w-full">`;当 `!ready` 时叠加 `<div className="absolute inset-0 z-10"><Loading /></div>`(加载浮层,层级 z-10);始终渲染 `<div ref={containerRef} className="ipm-pdf-container"><div ref={viewerElRef} className="pdfViewer" /></div>`。
- 无独立"空态":空文档由 pdfjs 自身处理。

#### 6.1.8 pdf.css 逐条说明

`frontend-desktop/src/preview/viewers/pdf/pdf.css`(24 行):
- pdf.css:2 `@import 'pdfjs-dist/web/pdf_viewer.css'`:引入 pdfjs 预编译查看器**必需的结构样式**(文本层定位、page 布局等)。
- `.ipm-pdf-container`(pdf.css:5-10):`position:absolute; inset:0; overflow:auto; background: var(--bg2)`——绝对铺满、可滚动、背景用主题二级背景色。
- `.ipm-pdf-container .pdfViewer .page`(pdf.css:11-14):每页 `margin: 12px auto`(上下 12px、水平居中),`border: 1px solid var(--border)`(每页一圈主题边框)。
- 文本层选区/高亮配色(pdf.css:19-21,注释说明 textLayer 是 canvas 之上的透明覆盖层,故全部用半透明,遵循 Acrobat/Word 习惯——全部命中=柔黄,选中命中=偏橙):
  - `::selection` → `rgba(59, 130, 246, 0.30)`(蓝,选区)。
  - `.highlight` → `rgba(250, 204, 21, 0.35)`(黄,所有命中)。
  - `.highlight.selected` → `rgba(251, 146, 60, 0.55)`(橙,当前命中)。
- `.ipm-toc-item:hover` → `background: var(--bg1)`(pdf.css:24):TOC 侧栏项 hover 反馈(侧栏组件用 `.ipm-toc-item` 类)。

---

### 6.2 PPTX 查看器(PptxViewer + 渲染层 + 解析引擎)

文件:
- 查看器与虚拟化:`frontend-desktop/src/preview/viewers/PptxViewer.tsx`(288 行)
- 渲染层:`pptx/slideToHtml.ts`、`pptx/extractTitle.ts`、`pptx/pptx.css`、`pptx/ported/shapeBuilder.ts`、`pptx/ported/presetGeomPaths.ts`
- 解析引擎:`frontend-desktop/src/preview/worker/parsers/pptx.ts`(2413 行)

整体架构(三段):**parsePptx(解析 zip/xml → 结构化 SlideData[])→ slideToHtml/_buildShapeParts(每张幻灯片结构 → {css, html})→ PptxViewer(虚拟化挂载 + 缩放 + 翻页 + TOC)**。`pptx.ts`、`shapeBuilder.ts`、`presetGeomPaths.ts` 三者都标注为 NID(VS Code 扩展 `pptxViewerPanel.ts`)的**逐行移植(verbatim port),禁止重构**(shapeBuilder.ts:1-5、presetGeomPaths.ts:1-9)。重要历史:该解析器**曾经跑在 Web Worker 里**(用 xmldom),但 xmldom 的 `getElementsByTagName` 是 O(子树) 无索引,重版式下慢到 13s,于是改回**主线程跑(用原生 `DOMParser`)**——原生 DOM 有缓存索引,快 10 倍以上,但 `DOMParser` 仅 Window 作用域可用,这就是它必须离开 worker 的原因(pptx.ts:11-20 注释)。

#### 6.2.1 SlideData 数据模型(解析输出契约)

`parsePptx` 返回 `{ slides: SlideData[]; themeFonts: Map<string,string> }`(pptx.ts:230-236)。核心类型(pptx.ts:29-169):

- `SlideData`(pptx.ts:159-169):`{ index, width, height, shapes, masterShapes, layoutShapes, suppressMasterShapes, bgColor?, bgImage? }`。`width/height` 为 px(由 EMU 换算);三组 shapes 对应母版/版式/正文三层 z 序;`suppressMasterShapes` 来自版式 `showMasterSp="0"`。
- `SlideShape = TextShape | ImageShape | TableShape | ConnectorShape`(pptx.ts:137)。四类 shape 的字段:
  - `TextShape`(pptx.ts:60-77):位置/尺寸 + `rotation?` + `paragraphs[]` + 可选 `fill / border{color,widthPx} / shadow / shapeGeom / borderRadius / insets[t,r,b,l] / anchor('top'|'ctr'|'b') / verticalText / autoFit('sp'|'norm') / customSvgPath / bgImage / isTitle`。
  - `TextParagraph`(pptx.ts:45-58):`runs[] / align / bullet` + 可选 `indentLevel / marginLeftPt / indentPt / lineHeight / lineHeightPt / spaceBefore / spaceAfter / bulletColor / bulletSizePct`。
  - `TextRun`(pptx.ts:29-43):`text / bold / italic / underline / strikethrough / fontSize(pt) / fontFamily / color / spacing(pt) / href / baseline(上下标,千分%) / highlight / glow(CSS text-shadow)`。
  - `ImageShape`(pptx.ts:79-85):位置/尺寸 + `rotation? / dataUri / crop?{l,t,r,b}`(裁剪百分比)。
  - `TableShape`(pptx.ts:111-122):`colWidths[]%`、`rowHeights[]%`、`rows: TableCell[][]`,以及 `bandRow / bandCol / firstRow / lastRow / accentColor`(表头底色取主题 accent1)。`TableCell`(pptx.ts:99-109):`text / colspan / rowspan / skip(被合并吃掉)/ bgColor / align / vAlign / borders{top,right,bottom,left} / runs[]`。
  - `ConnectorShape`(pptx.ts:124-135):位置/尺寸 + `flipH/flipV / strokeColor / strokeWidth(px) / dashStyle(SVG dasharray) / headArrow / tailArrow / connectorType / adjustValues[]`。
- 辅助:`PlaceholderTransform`(占位符几何 + 默认文本样式,pptx.ts:139-146)、`GroupTransform`(组合 shape 的坐标映射,pptx.ts:148-157)。

#### 6.2.2 parsePptx 处理管线(pptx.ts:230-478)

输入:`ArrayBuffer | Uint8Array`(整个 .pptx 即一个 zip),可选 `onProgress(done,total)`。步骤:

1. `JSZip.loadAsync(data)` 解压;`new DOMParser()`(pptx.ts:237-238)。
2. **EMF/WMF 预转换**`_prefetchMetafiles(zip)`(pptx.ts:201-213, 242):浏览器 `<img>` 无法渲染 Windows 元文件,故一次性把 zip 内所有 `.emf/.wmf` 批量交给注入的转换器转 PNG,缓存为 `media路径 → data:image/png;base64,...`(`_emfCache`,pptx.ts:188-189)。转换器由查看器层通过 `setEmfConverter` 注入(pptx.ts:185-187),其实现是 Electron 主进程的 GDI+(System.Drawing)桥 `window.electronAPI.convertEmf`(PptxViewer.tsx:17-20)。无转换器(纯浏览器/测试/dev)时元文件不转,后续渲染为占位/跳过。
3. 载入默认主题 `ppt/theme/theme1.xml` 的配色与字体方案作为兜底(`_loadThemeColors`/`_loadThemeFonts`,pptx.ts:244-252)。
4. 读 `ppt/presentation.xml` 的 `<p:sldSz cx cy>` 得幻灯片尺寸(EMU),默认 9144000×6858000(10"×7.5"),换算成 px(pptx.ts:254-267)。
5. 发现并按数字序排序所有 `ppt/slides/slideN.xml`(pptx.ts:270-276)。
6. 母版缓存 `_loadMaster(masterPath)`(pptx.ts:288-337):解析母版 → 收集占位符几何(`_collectPlaceholderTransforms`)→ 经母版 rels 找到 theme 并重载该母版的真实主题色/字体 → `_applyMasterTxStyles` 把 `titleStyle/bodyStyle` 默认样式叠加到占位符 → `_extractShapes(..., nonPhOnly=true)` 抽取母版**非占位符**装饰 shape → `_extractBg` 抽母版背景。整个结果按 masterPath 缓存。
7. 版式缓存 `layoutCache`(pptx.ts:348-355, 422-457):同一版式的非占位 shape 只抽取一次(注释:这是不换 XML 库前提下最大的稳态性能收益,因为企业模板常有 30+ 张共用同一内容版式)。冷路径解析版式 doc、rels、shapes、bg、`suppressMasterShapes`;热路径仍每次跑便宜的 `_collectPlaceholderTransforms` + `_applyLayoutLstStyles` 合并到 per-slide phMap。
8. 逐张幻灯片(pptx.ts:362-475):读 slide.xml 与其 rels(rId→target,并解析出 layoutPath);沿 layout→master rels 链确定 masterPath(默认 `slideMaster1.xml`);合并出 per-slide `phMap`;`_extractShapes(doc, ..., nonPhOnly=false)` 抽正文 shape;背景按 **slide → layout → master** 继承(pptx.ts:462-465);组装 `SlideData` 入列。
9. **主线程让步**:每解析一张 `onProgress?.(i+1, total)`;每 16 张(`(i & 15) === 15`)`await setTimeout(0)` 让出事件循环,避免大 deck 主线程解析时卡死 UI、加载 spinner 与关闭按钮无响应(pptx.ts:469-474)。
10. 返回 `{ slides, themeFonts: lastThemeFonts }`(pptx.ts:477)。

#### 6.2.3 解析引擎能力清单(穷尽向)

下列为 `pptx.ts` 实际支持的 OOXML 能力(算法细节按职责概述):

**容器与递归**:`<p:spTree>` 与 `<p:grpSp>` 递归处理(`_processShapeContainer`,pptx.ts:499-548)。组合 shape 通过 `GroupTransform` 做子坐标系→幻灯片坐标系映射(`_getGroupTransformInfo` / `_applyGroupTransform`,pptx.ts:1865-1916),支持**任意层级嵌套组合**(父组先映射到 slide space 再算子组)。识别的子元素:`sp`(文本/形状)、`pic`(图片)、`graphicFrame`(表格 / SmartArt / Chart / OLE 回退)、`cxnSp`(连接线)、`grpSp`(组合)。

**几何/坐标**:`_emuToPx` EMU→px@96DPI(pptx.ts:174-176);`_getTransform`/`_getTransformEmu` 读 `a:xfrm`/`p:xfrm` 的 `off`/`ext`/`rot`(旋转 60000 分之一度→度,pptx.ts:550-567, 1846-1862)。

**形状几何(shapeGeom)**:
- 预设矩形类:`rect`(默认不画 SVG)、`roundRect`(转 `borderRadius`%,默认圆角 16.67%,pptx.ts:596, 970-977)。
- 其它命名预设(`prst≠rect/roundRect/__custom__`)存 `shapeGeom`,渲染时查 `_presetGeomPaths` 表(见 6.2.7,presetGeomPaths.ts)。
- **参数化预设**`_parametricPresetBuilders`(pptx.ts:2401-2413):目前实现 `corner`、`foldedCorner` 两种,读 `avLst` 的 `gd@fmla="val N"` 调整值生成 SVG path(其余参数化形状落到静态表)。
- **自定义几何**`<a:custGeom>`(`_extractCustomGeomPath`,pptx.ts:2315-2394):支持 `moveTo/lnTo/cubicBezTo/quadBezTo/arcTo/close`,坐标归一化到 0–100 viewBox(arcTo 做椭圆弧端点换算,数学略)。

**填充/描边/阴影/发光**:
- 实色填充 `solidFill`、渐变填充 `gradFill`→CSS `linear-gradient`(`_resolveGradFill`,pptx.ts:2204-2231,读 `gsLst` 各 `gs@pos` 与角度 `lin@ang`)、`noFill`(直接子,区分 `<a:ln><a:noFill>` 仅去边框,pptx.ts:1788-1791)、图片填充 `blipFill`→`bgImage`(pptx.ts:619-639)。
- `<p:style>` 引用回退:`fillRef`/`lnRef` idx>0 时取主题色填充/描边(pptx.ts:1002-1020)。
- 描边 `<a:ln>`:取 `solidFill` 颜色与 `w` 宽,无显式色但有 `w` 时回退 tx1 主题色(pptx.ts:979-1000)。
- 阴影 `<a:effectLst><a:outerShdw>`→CSS `box-shadow`(`_extractShadow`,pptx.ts:1801-1834;由 `dist/dir/blurRad/alpha` 算 dx/dy/blur,单位全部 `calc(... * var(--pt,1pt))` 以随幻灯片缩放)。
- 发光 `<a:glow>`→CSS `text-shadow`(`_resolveGlow`/`_resolveGlowColor`,pptx.ts:1666-1709;堆叠三层相同阴影加粗光晕,处理"白字+彩色光晕"的标题习惯)。

**主题色映射与颜色变换**(能力很全):
- 配色方案 `<a:clrScheme>`:`dk1→tx1, lt1→bg1, dk2→tx2, lt2→bg2, accent1–6, hlink, folHlink`(`_loadThemeColors`,pptx.ts:1501-1516)。
- 颜色来源:`srgbClr`(直值)、`schemeClr`(查主题)、`sysClr`(用 `lastClr` 兜底)、`prstClr`(预设名表 `PRESET_COLORS`,pptx.ts:1657-1662,含 black/white/red/blue/green/yellow/cyan/magenta/gray/grey/darkGray/lightGray/orange/purple/dkBlue/ltBlue)。
- 颜色变换 `_applyColorModifiers`(pptx.ts:1594-1650):支持 `lumMod / lumOff / satMod / tint / shade`,经 RGB↔HSL 互转实现(`_hexToRgb/_rgbToHex/_rgbToHsl/_hslToRgb`,pptx.ts:1544-1588,纯算法,公式略)。
- 透明度 `alpha`→`rgba(...)`(pptx.ts:1716-1720)。

**字体**:主题字体方案 `majorFont/minorFont` 的 `latin/ea/cs`→token `+mj-lt/+mj-ea/+mj-cs/+mn-...`(`_loadThemeFonts`,pptx.ts:1522-1540)。`_resolveFont`(pptx.ts:1759-1776)读 `rPr` 的 `latin/ea/cs typeface`,`+` 前缀的解析为主题字体,输出带引号的 CSS `font-family` 列表(去重)。标题占位符默认用 major 字体(pptx.ts:707-718)。

**文本/段落/run**(`_extractTextShape` 主体,pptx.ts:569-1026):
- bodyPr:文本内边距 `lIns/tIns/rIns/bIns`(默认 0.1"/0.05")、垂直锚点 `anchor(ctr/b)`、垂直文本 `vert`、自动适配 `spAutoFit→'sp'` / `normAutofit→'norm'`(占位符无显式设置时默认 norm,pptx.ts:642-682)。
- 段落 pPr:对齐 `algn(l/ctr/r/just)`、缩进 `lvl/marL/indent`、项目符号 `buNone/buChar(+buFont 经 Wingdings 映射)/buAutoNum(自动编号,占位 \`__autonum__type__startAt\`)`、`buClr`(符号色)、`buSzPct/buSzPts`(符号大小)、行距 `lnSpc(spcPct→倍数 / spcPts→绝对 pt)`、段前段后 `spcBef/spcAft(spcPts→pt / spcPct→近似)`、段落默认 run 属性 `defRPr`(pptx.ts:755-869)。
- run rPr:`b/i/u/strike/sz/spc(字距)/baseline(上下标)/hlinkClick(超链接,经 rels 解析 href)/highlight/solidFill(色)/font/glow`(pptx.ts:872-910)。run 缺省值回退到段落 `defRPr`、再到占位符默认(pptx.ts:938-949)。
- 字段文本 `<a:fld>`(如幻灯片页码)按普通 run 收入(pptx.ts:912-936)。
- 即便段落为空也保留(占一行高度,pptx.ts:951-964);即便 shape 无文本但有 fill/bgImage/customSvgPath 也保留(色块/背景矩形,pptx.ts:967-968)。
- 占位符体系:`_getPhKey`(pptx.ts:2016-2033,按 OOXML 规则 idx 优先、单实例类型 dt/ftr/sldNum/hdr 按 type)、`_collectPlaceholderTransforms`(几何)、`_applyMasterTxStyles`(母版 titleStyle/bodyStyle)、`_applyLayoutLstStyles`(版式 lstStyle/lvl1pPr)三层叠加,实现 master→layout→slide 的样式继承。标题占位符额外标 `isTitle`(供 TOC 提取标题用)。

**图片**(`_extractImageShape`,pptx.ts:1028-1089):`blip r:embed`→rels→zip 媒体→base64 data URI(mime 由扩展名映射,`_imageDataUri`,pptx.ts:219-228,支持 png/jpg/jpeg/gif/bmp/svg/tiff;emf/wmf 取缓存);裁剪 `<a:srcRect l/t/r/b>`(千分%→%)。未转换的元文件返回空 → 跳过该 shape(不渲染坏图)。

**表格**(`_extractTableShape`,pptx.ts:1091-1321):列宽 `tblGrid/gridCol@w`→百分比;行高 `tr@h`→百分比;单元格合并 `hMerge/vMerge/gridSpan/rowSpan`(被合并者 `skip`);单元格底色 `solidFill`/`gradFill`;垂直对齐 `tcPr@anchor`;水平对齐取首段 `pPr@algn`;**单元格边框** `lnL/lnR/lnT/lnB`(注释 pptx.ts:1272-1278 特别说明:这是 DrawingML 直接子元素,原 NID 误用了 WordprocessingML 的 `tcBorders` 约定导致 PPTX 边框从未被提取——此处已修正);单元格文本按 run 收集并带格式回退;表格属性 `bandRow/bandCol/firstRow/lastRow`,表头底色取主题 accent1。

**连接线**(`_extractConnectorShape`,pptx.ts:1380-1482):读 `flipH/flipV`、`connectorType`(line / straightConnector1 / bentConnector2–5 / curvedConnector2–5)、调整值、描边色/宽、虚线 `prstDash`(dash/dot/lgDash/dashDot/lgDashDot → SVG dasharray,pptx.ts:1453-1457)、箭头 `headEnd/tailEnd`。实际折线/曲线点位计算在渲染层 `_buildShapeParts` 的 `connector` 分支完成(见 6.2.6)。

**SmartArt / Chart / OLE 回退**(`_extractGraphicFrameFallback`,pptx.ts:1327-1374):当 graphicFrame 不是表格时,在其子树里**用 DOM 查询(非字符串匹配)**找内嵌预览图 `blip r:embed`(注释强调 xmldom 序列化 OLE/SmartArt 子树会失败,所以必须走 DOM 而非 `toString().includes`),命中可渲染图片格式则当作图片 shape 渲染。

> 取舍声明:以上颜色 HSL 变换、custGeom 弧线端点换算、连接器各类型折线点位、组合坐标映射等**纯几何/算术算法**,文档只交代"做什么、输入输出",不抄录其逐行公式(它们是 NID 的逐行移植,且与本章"UI/能力"主旨关系不大)。需要核对具体公式时请直接阅读对应行号。

#### 6.2.4 slideToHtml.ts —— 每张幻灯片 → {css, html}

`slideToHtml(slide, slideIdx)`(slideToHtml.ts:80-136),镜像 NID `_buildHtml` 的内层(母版 → 版式 → 正文,三个堆叠 z 层):
1. 计算 `--pt`:pt→cqi 换算因子 `(400/(3*slide.width)).toFixed(5)`(slideToHtml.ts:86),写入 `.sld-N{--pt:...cqi; ...}`。配合 `container-type: inline-size`,所有 `var(--pt,1pt)` 都随幻灯片卡片宽度按容器查询(cqi)缩放。
2. 背景规则(slideToHtml.ts:88-98):`bgImage` → `background-image:url(...);background-size:cover;background-position:center`;否则 `bgColor`:含 `gradient` 则直接作 `background`,否则 `background:#hex`,若 `_isDark(hex)` 则补 `color:#eee`(深底浅字)。
3. 三轮 `_buildShapeParts`:`masterShapes`(除非 `suppressMasterShapes`,前缀 `m{idx}`)→ `layoutShapes`(前缀 `l{idx}`)→ `shapes`(前缀 `{idx}`),把各自 css/html 累加(slideToHtml.ts:103-130)。
4. **selector 作用域隔离**:`prefixSelectors(css, '.ipm-pptx-root ')`(slideToHtml.ts:22-62, 133),给每条规则头部加前缀,防止样式泄漏到全局。该函数用 `indexOf` 逐规则线性扫描(O(N))——注释 slideToHtml.ts:23-30 记录了一个重要性能事故:旧正则 `/([^{}]+)\{/g` 在 107KB data URL 背景值上灾难性回溯,O(N²) 单张 10+ 秒;改 `indexOf` 后微秒级。

#### 6.2.5 extractTitle.ts —— TOC 标题提取

`extractTitle(slide)`(extractTitle.ts:19-31):
- 优先用解析器标记的标题占位符 `isTitle`,按 slide→layout→master 顺序找(`titleFromFlagged`,extractTitle.ts:34-41)。
- 回退启发式:按 `top` 升序取最靠上的非空文本 shape(标题在上、页脚在下,`extractFromShapes`,extractTitle.ts:43-59)。
- `shapeText`(extractTitle.ts:73-89):拼接**所有段落所有 run**(混合中英标题会被 PowerPoint 拆成多 run,只取首 run 会丢中文),`\s+`→单空格,按 `MAX_TITLE_CHARS=50` 个码点(`Array.from`,CJK 安全)截断并加 `…`。

#### 6.2.6 shapeBuilder.ts —— _buildShapeParts(shape → css+html)

`frontend-desktop/src/preview/viewers/pptx/ported/shapeBuilder.ts`(553 行),NID `pptxViewerPanel.ts:2430–2842` 的逐行移植。`_buildShapeParts(shape, slideW, slideH, slideIdx, shapeIdx)`(shapeBuilder.ts:137-552)为每个 shape 生成类名 `sh-{slideIdx}-{shapeIdx}` 及百分比定位(left/top/width/height 各 toFixed(2)%),按 `shape.type` 分四支:

- **text**(shapeBuilder.ts:148-299):决定是否用 SVG 形状背景(`useShapeSvg`,有 customSvgPath/preset geom 且有 fill/border 时);设置 overflow、背景、bgImage、边框(`calc(bwPt * var(--pt,1pt))`)、box-shadow、border-radius、rotate、垂直文本 writing-mode、垂直锚点 flex 居中/底对齐、内边距 insets。逐段输出 `.sh-..-pN`(对齐/上下 margin/字号/行高/缩进/项目符号缩进),逐 run 输出 `.sh-..-pN-rM`(粗斜体/字号/字体/色/glow→text-shadow/下划线删除线/字距/上下标),自动编号项目符号在此结算(`_formatAutoNum`,见下);超链接包 `<a target=_blank rel=noopener>`;空段输出 `<br>`;非矩形 shape 前置内联 SVG(`ellipse` 用原生 `<ellipse>`,其余用 `<path>`,`vector-effect=non-scaling-stroke`);`autoFit==='norm'` 时外包 `<div class="autofit-inner" data-autofit="norm">`。
- **image**(shapeBuilder.ts:300-318):定位 + 可选 rotate;有 `crop` 时用 `object-fit:fill` + 负 margin + 放大百分比实现 srcRect 裁剪,否则 `img{width:100%;height:100%}`;输出 `<div class="cls"><img src="dataUri"/></div>`。
- **connector**(shapeBuilder.ts:319-448):全幻灯片满铺 SVG(viewBox 0 0 100 100,preserveAspectRatio=none),按 flipH/flipV 决定起止端点;箭头用 `<marker>` defs;按 connectorType 计算:直线 `<line>`、bentConnector2–5 `<polyline>`(按 verticalFirst 与 adjustValues 算拐点)、curvedConnector2/3 三次贝塞尔 `<path>`(4/5 退化为直线);虚线用 `stroke-dasharray`。
- **table**(shapeBuilder.ts:449-548):输出 `<colgroup>` 列宽、各行 `.cls-rN` 行高;首行加粗(firstRow)、隔行底色 `rgba(0,0,0,0.04)`(bandRow);逐单元格输出 colspan/rowspan、底色(无显式底色但 firstRow 时用 `accentColor ?? '#4472C4'` 配白字)、对齐、四边边框(`calc(w*0.75 * var(--pt,1pt))`);单元格内按 run 渲染(`\n`→`<br>`)。

辅助(也在此文件):`escapeHtml`(仅 4 替换,与 NID 一致,**不转义单引号**,shapeBuilder.ts:18-20);`_isDark`(感知亮度<0.5,shapeBuilder.ts:24-29);Wingdings/Wingdings2/Wingdings3/Symbol 符号字体→Unicode 映射(`_resolveSymbolText`/`_resolveSymbolChar`,shapeBuilder.ts:40-89);自动编号 `_formatAutoNum`(arabicPeriod/ParenR/ParenBoth/Plain、roman 大小写、alpha 大小写多种,shapeBuilder.ts:94-110)+ `_toRoman`/`_toAlpha`。

#### 6.2.7 presetGeomPaths.ts —— 预设几何 SVG 路径表

`frontend-desktop/src/preview/viewers/pptx/ported/presetGeomPaths.ts`(84 行),NID `pptxViewerPanel.ts:2320–2395` 移植。`_presetGeomPaths: Record<string,string>`,值为 100×100 viewBox 的 SVG path data。覆盖类别(presetGeomPaths.ts:11-84):基础形(ellipse/triangle/rtTriangle/diamond/parallelogram/trapezoid/pentagon/hexagon/octagon)、星形(star4/5/6)、箭头(right/left/up/down/leftRight/upDown/notchedRight/bent/stripedRight/chevron/homePlate)、标注气泡(wedgeRoundRectCallout/wedgeRectCallout/wedgeEllipseCallout/cloudCallout)、横幅(ribbon2)、流程图(flowChartProcess/Decision/Terminator/PredefinedProcess/Document/ManualInput/ManualOperation/Connector/AlternateProcess)、杂项(heart/lightningBolt/sun/cloud)、括号(leftBracket/rightBracket/leftBrace/rightBrace)、加号(mathPlus)、切角/圆角矩形(snip1Rect/snip2DiagRect/round1Rect/round2DiagRect/round2SameRect)、corner/foldedCorner、frame/plaque、donut/noSmoking/blockArc/can。

#### 6.2.8 PptxViewer.tsx —— 虚拟化挂载、缩放、翻页、TOC

常量(PptxViewer.tsx:22-24):`ZOOM_STEP=0.2`、`ZOOM_MIN=0.5`、`ZOOM_MAX=4`。

**EMF 转换器注册**(模块加载期,PptxViewer.tsx:17-20):取 `window.electronAPI?.convertEmf`,有则 `setEmfConverter(items => bridge(items))`,无则 `setEmfConverter(null)`。

**SlideItem(虚拟化单元,React.memo)**(PptxViewer.tsx:41-96):每张幻灯片**仅在滚动到接近视口时**才执行 `slideToHtml(slide, idx)` 渲染,随后保持挂载。原因(注释 PptxViewer.tsx:26-40):368 张/48MB 的 deck 若全量渲染会产出 ~84MB HTML+CSS(数千张内联 base64 图)直接卡死/崩溃。机制:
- 占位 `<div class="ipm-pptx-slide-page" data-idx={idx}>` 内套 `<div class="ipm-pptx-slide sld-{idx}" style="--slide-aspect: width/height">`;占位 div 先按宽高比预留竖直空间,保证滚动条长度与位置稳定(PptxViewer.tsx:74-92)。
- `IntersectionObserver`(`rootMargin: '600px 0px'`,提前一屏渲染)命中后 `disconnect()` 并 `setRendered(slideToHtml(...))`(PptxViewer.tsx:54-72);渲染后注入 `<style dangerouslySetInnerHTML>` + `<div class="slide-inner" dangerouslySetInnerHTML>`。
- memo 比较器:`prev.slide===next.slide && prev.idx===next.idx && prev.registerRef===next.registerRef`(PptxViewer.tsx:94-95),避免兄弟幻灯片渲染时互相触发重渲染。

**主组件 state/refs**(PptxViewer.tsx:98-114):`error / slides / scale(1) / current(1) / toc / loading(true) / progress([done,total],total=0 未知) / containerSize({w,h})`;refs:`containerRef`、`slideRefs[]`(各占位 div)、`currentRef`/`slideCountRef`(给键盘导航用的稳定引用)。`registerSlideRef`(PptxViewer.tsx:118-120)是稳定回调,供 SlideItem 上报 DOM ref。

**加载 useEffect(依赖 `[path, t]`)**(PptxViewer.tsx:127-159):重置态 → `fetchOrThrow(rawUrl(path))` → `arrayBuffer()` → `parsePptx(buf, (done,total)=>setProgress(...))` → 用 `extractTitle` 为每张生成 TOC 项(`{ id:\`slide-${i}\`, label: title ? \`${i+1}. ${title}\` : t('preview.slideN',{n:i+1}) }`)→ `setSlides/setToc/setLoading(false)`。错误且非 `AbortError` 时 `setError`。

**容器 ResizeObserver(callback ref)**(PptxViewer.tsx:165-179):`setContainer` 在容器挂载/卸载时建/拆 observer,实时把 `clientWidth/clientHeight` 写入 `containerSize`。注释解释为何用 callback ref 而非 `deps=[]` useEffect:容器只在 `!loading` 时挂载,普通 effect 会在 spinner 阶段 ref 还是 null 时跑、永远 attach 不上,导致 fit-page CSS 计算永远拿 0。

**键盘导航 useEffect(依赖 `[]`)**(PptxViewer.tsx:182-204):监听 `window` keydown;输入框/textarea/contentEditable 聚焦时忽略;`PageDown/ArrowRight/ArrowDown` → 下一张,`PageUp/ArrowLeft/ArrowUp` → 上一张,`Home` → 第 1 张,`End` → 末张;跳转用 `slideRefs.current[n-1].scrollIntoView({ block:'start', behavior:'smooth' })`。

**当前页跟踪 IntersectionObserver(依赖 `[slides]`)**(PptxViewer.tsx:209-230):`root=container`,`rootMargin:'-40% 0px -40% 0px'`,`threshold:[0,0.25,0.5,0.75,1]`;取交叉比例最大者的 `data-idx` → `setCurrent(best+1)`,驱动工具栏当前页指示。

**工具栏能力注册**`usePreviewToolbar(...)`(PptxViewer.tsx:232-259):
- **pages**:`count=slides.length`、`current`、`goto(n)` → `slideRefs.current[n-1].scrollIntoView({block:'start', behavior:'auto'})`。
- **zoom**:`scale`;`in()` → `min(4, s+0.2)`;`out()` → `max(0.5, s-0.2)`;`fit()`/`reset()` → `setScale(1)`。
- **toc**(仅 `toc.length>0`):`items=toc`;`goto(id)` → `idx=Number(id.replace('slide-',''))`,`slideRefs.current[idx].scrollIntoView({block:'start', behavior:'auto'})`。
- **download**:`{ url: rawUrl(path), filename }`。
- 依赖:`[slides.length, current, scale, toc, path, filename]`。

**渲染与各状态**(PptxViewer.tsx:261-287):
- 错误:`<ErrorMsg msg={error} />`。
- **加载态(自定义,带进度)**:`total>0` 时文案 `t('preview.parsingN',{n:done,total})`,否则 `t('preview.parsing')`;容器 `flex h-full items-center justify-center gap-3 text-sm`,色 `var(--t3)`,内含 `<Spinner className="h-4 w-4" />` + 文案。
- 正常:`<div className="ipm-pptx-root">`,内联 CSS 变量 `--pptx-zoom=scale`、`--pptx-container-w/h=${size}px`,且 `scrollSnapType = scale===1 ? 'y mandatory' : 'none'`(仅 100% 时启用整页吸附,缩放时关闭);子节点为 `slides.map` 出的 `<SlideItem>`。

#### 6.2.9 pptx.css 逐条说明

`frontend-desktop/src/preview/viewers/pptx/pptx.css`(121 行)。注释(pptx.css:1-11)说明:渲染器是 NID 的逐行移植,NID 的 `<style>` 里有 `_buildShapeParts` 引用但**不自行 emit** 的全局辅助类(`.slide-inner`、`.shape-text`、`.slide-table`、`.autofit-inner`),必须放在此处;全部 scope 在 `.ipm-pptx-root` 下;shape CSS 用 `var(--pt,1pt)`,实际 `--pt` 由 slideToHtml 按 `slide.width` 每张 emit,从而字号/内边距/边框/行高随卡片宽度经 cqi 缩放。

- `.ipm-pptx-root`(pptx.css:13-23):`position:relative; width/height:100%; overflow:auto; background: var(--bg2); --pptx-zoom:1; scroll-snap-type: y mandatory`(滚轮/触控板停在整张幻灯片,模仿 PowerPoint 阅读视图)。
- `.ipm-pptx-slide-page`(pptx.css:29-39):页包裹,`min-height:100%; width:100%; display:flex; align-items:center; justify-content:center; scroll-snap-align:start; scroll-snap-stop:always; padding:16px 24px; box-sizing:border-box`。每个恰好占一屏高、幻灯片居中;`scroll-snap-align:start` 保证下一页正好从一屏下方开始、无上页残影。
- `.ipm-pptx-slide`(pptx.css:41-68):fit-page 计算 `width: max(200px, calc(min(var(--pptx-container-w,100vw) - 48px, (var(--pptx-container-h,100vh) - 32px) * var(--slide-aspect,1.778)) * var(--pptx-zoom,1)))`——取"容器宽-48px"与"容器高-32px 乘宽高比"的较小者,再乘用户缩放;外层 `max(200px, ...)` 是防御性下限(ResizeObserver 还没报尺寸时 calc 为负会渲染成 0 宽空盒)。其余:`aspect-ratio: var(--slide-aspect,1.778)`;`background:white`;`border:1px solid var(--t3)`;`box-shadow:0 6px 20px rgba(15,31,61,0.18)`;`position:relative; container-type:inline-size; overflow:hidden`。
- `.ipm-pptx-root .slide-inner`(pptx.css:73-79):`position:absolute; top:0; left:0; width/height:100%`——shape 的绝对定位基准盒(NID 结构)。
- `.ipm-pptx-root .shape-text`(pptx.css:83-88):`padding: calc(3.6*var(--pt,1pt)) calc(7.2*var(--pt,1pt)); line-height:normal; word-wrap:break-word; font-size: calc(14*var(--pt,1pt))`。注释(pptx.css:89-94)明确**不要**加 `.shape-text p{margin:0}` 重置——其 (0,2,1) 特异性会压过 `.sh-X-pN` 的 (0,2,0),会清掉段前/段后间距。
- `.ipm-pptx-root .autofit-inner`(pptx.css:95):`transform-origin: top left`。
- `.ipm-pptx-root .slide-table`(pptx.css:99-104):`border-collapse:collapse; width/height:100%; font-size: calc(8*var(--pt,1pt))`。
- 表格 th/td(pptx.css:105-119):边框 `calc(0.75*var(--pt,1pt)) solid #ccc`(注释强调 `#ccc` 只是回退,有 lnL/lnR/lnT/lnB 的单元格会用更高特异性的 per-cell 规则覆盖);`padding: calc(0.4*var(--pt,1pt)) calc(2.5*var(--pt,1pt)); line-height:1.0; vertical-align:middle`(注释说明刻意采用 PPT 的紧凑行度量,否则多行表格会超出固定行高、与下方表格重叠)。
- `.ipm-pptx-root .slide-table th`(pptx.css:120):`font-weight:600`。

---

### 6.3 DOCX 查看器(DocxViewer)

文件:
- `frontend-desktop/src/preview/viewers/DocxViewer.tsx`(381 行)
- `frontend-desktop/src/preview/viewers/docx/docx.css`(65 行)

底层栈:`docx-preview`(动态 import),它解析 OOXML 并复现 Word 页面版式(字体、间距、页眉页脚、脚注、分页),比旧的 mammoth(把一切压成语义 HTML、丢版式)保真得多。`docx-preview` 直接渲染进 DOM 容器(DOM 绑定),故**跑在主线程,不走 worker**(DocxViewer.tsx:294-304 注释)。已知限制:内嵌 EMF/WMF 元文件会渲染成坏 `<img>`(浏览器画不了,且 docx-preview 自己掌管图片抽取,PPTX 那套 GDI+ 转换器钩不进来)。

#### 6.3.1 inlineWpsTextBoxes —— 浮动文本框预处理(本查看器的核心增强)

`inlineWpsTextBoxes(buf)`(DocxViewer.tsx:47-288)是一个独立的预处理函数:`docx-preview` 既渲染不了 `wps:txbx`(DrawingML 文本框)又渲染不了 `mc:Fallback` 里的 VML `<v:textbox>`,所以把 `mc:AlternateContent` 里 `mc:Choice Requires` 含 `wps/wpg/wpc`(`UNSUPPORTED_REQUIRES`,DocxViewer.tsx:16)的文本框段落抽出来注入到文档正文流,让封面页/浮动文本框可见。要点:

- 命名空间常量(DocxViewer.tsx:7-13):`MC_NS / W_NS / WPS_NS / WP_NS`。
- 用 JSZip 打开,遍历 `word/*.xml`(非目录),`!src.includes('AlternateContent')` 快速跳过(DocxViewer.tsx:51-58)。
- 用 `DOMParser` 解析,有 `parsererror` 则跳过(DocxViewer.tsx:60-63)。
- 算列宽 EMU(由 `pgSz`/`pgMar`,twip→EMU 系数 635,A4 兜底)用于判断文本框是否水平居中(DocxViewer.tsx:66-79)。
- 对每个含 wps Choice 的 AlternateContent:找锚段(`w:p`)与锚 run(`w:r`)、段在兄弟中的序号;读 `wp:positionV/posOffset` 估算竖直位置 `sortKey = paraIndex*228600 + posOffsetV`(228600 EMU≈18pt 一空段高);从 `wps:txbx/txbxContent` 抽出 `w:p` 克隆;推断水平对齐(优先 `wp:positionH/align`,否则用 box 中心 vs 列中心 ±200000 EMU≈15pt 判居中)(DocxViewer.tsx:90-155)。
- 按 `sortKey` 升序排;映射每个文本框到一个正文段作"占位锚",并 clamp 到首个 `sectPr`(分节符)之前——超过分节边界的统一堆在分节符前(DocxViewer.tsx:159-211)。
- 对越界条目用 `w:spacing w:before`(twip,封顶 13920≈696pt)补足竖直间距,把它推向封面页大致位置(DocxViewer.tsx:218-246)。
- 把推断的水平对齐通过 `w:jc` 传播到没有显式 `jc` 的段(保留原有 jc)(DocxViewer.tsx:248-266)。
- 把抽出的段插入正文 `insertPt` 前;移除锚 run(或 AlternateContent)(DocxViewer.tsx:268-281)。
- `zip.file(name, serialize)` 写回,最后 `zip.generateAsync({type:'arraybuffer', compression:'DEFLATE'})` 返回新 buffer(DocxViewer.tsx:283-287)。

#### 6.3.2 组件结构、props、state、加载

常量(DocxViewer.tsx:290-292):`ZOOM_STEP=0.1`、`ZOOM_MIN=0.5`、`ZOOM_MAX=3`。

`DocxViewer({ path, filename })`(DocxViewer.tsx:305)。refs/state:`containerRef`(始终挂载,即便 loading,确保异步 render 落点存在,DocxViewer.tsx:307-308)、`loading(true)`、`error`、`scale(1)`。

加载 useEffect(依赖 `[path]`,DocxViewer.tsx:313-354):`setLoading(true); setError(null)` → `fetchOrThrow(rawUrl(path))` → `arrayBuffer()` → 取容器、`container.innerHTML=''`(清上一篇)→ 动态 `import('docx-preview')` → `inlineWpsTextBoxes(buf)` 预处理 → `docx.renderAsync(processedBuf, container, undefined, options)`。`renderAsync` 选项(DocxViewer.tsx:331-343):`className:'docx'`、`inWrapper:true`、`ignoreWidth/ignoreHeight/ignoreFonts:false`、`breakPages:true`、`useBase64URL:true`、`renderHeaders/renderFooters/renderFootnotes/renderEndnotes:true`(即页眉、页脚、脚注、尾注全渲染)。成功 `setLoading(false)`;失败 `setError(String(e))`。全程 `cancelled` 守卫,path 变更时不让旧渲染落地。

工具栏能力(DocxViewer.tsx:356-365):
- **zoom**:`scale`;`in()` → `min(3, round((s+0.1)*100)/100)`(round 防浮点误差);`out()` → `max(0.5, round((s-0.1)*100)/100)`;`fit()`/`reset()` → `setScale(1)`。
- **download**:`{ url: rawUrl(path), filename }`。
- 依赖 `[scale, path, filename]`。
- **不提供** pages / search / toc / copy(DOCX 无分页跳转、无检索、无大纲、无复制能力)。

渲染与各状态(DocxViewer.tsx:367-380):错误 → `<ErrorMsg>`;否则 `<div className="ipm-docx-root">`,`loading` 时叠加 `<div className="ipm-docx-loading"><Loading /></div>`,再 `<div className="ipm-docx-scroll"><div ref={containerRef} className="ipm-docx-container" style={{ transform: \`scale(${scale})\` }} /></div>`。缩放以 CSS transform 施加于内层容器。无独立空态。

#### 6.3.3 docx.css 逐条说明

`frontend-desktop/src/preview/viewers/docx/docx.css`(65 行)。注释(docx.css:1-4):仿 NID 的灰色阅读面 + 白色页"纸张"(带阴影、居中,像 Word/Acrobat);所有覆盖 scope 在 `.ipm-docx-root` 下,防止 docx-preview 自身 `.docx` 样式与本壳样式互相泄漏。

- `.ipm-docx-root`(docx.css:6-10):`position:relative; width/height:100%`。
- `.ipm-docx-loading`(docx.css:13-21):`position:absolute; inset:0; z-index:2; flex 居中; background: var(--bg2)`——盖在(初始为空的)渲染容器之上的加载浮层。
- `.ipm-docx-scroll`(docx.css:24-30):`width/height:100%; overflow:auto; background:#525659; padding:20px 0`——灰色(#525659)可滚动阅读面,上下 20px 留白。
- `.ipm-docx-container`(docx.css:34-36):`transform-origin: top center`(缩放时页面以顶部中心为锚,保持居中)。
- `.ipm-docx-root .docx-wrapper`(docx.css:41-48):`background:transparent !important; padding:0 !important; display:flex; flex-direction:column; align-items:center; gap:16px`——docx-preview 的外层 wrapper 设透明,页 section 纵向居中排列、页间距 16px。
- `.ipm-docx-root .docx-wrapper > section.docx`(docx.css:49-53):`background:#fff !important; box-shadow:0 2px 8px rgba(15,31,61,0.25); margin:0 auto`——每页白色纸张卡片、带阴影、居中。
- `.ipm-docx-root [style*="vertical-lr"]`(docx.css:63-65):`writing-mode: horizontal-tb !important`——修正 docx-preview 的一个 bug:它把表格单元格的 `lrTb`(正常水平文本)错误映射成 `writing-mode: vertical-lr`,使本该正常的单元格文字竖排。注释解释:`vertical-lr` 只由那个错误映射产生(真正的竖排用 `vertical-rl`),故强制 `horizontal-tb` 既修了 bug 又不影响合法竖排单元格;因 docx-preview 用内联 style 设置,故用 `[style*=]` 属性选择器 + `!important`。

---

### 6.4 解析 Worker 与解析管线(xlsx)

文件:
- 客户端:`frontend-desktop/src/preview/worker/parseClient.ts`(102 行)
- worker 入口:`frontend-desktop/src/preview/worker/fileParser.worker.ts`(35 行)
- 协议:`frontend-desktop/src/preview/worker/protocol.ts`(35 行)
- 解析器:`frontend-desktop/src/preview/worker/parsers/xlsx.ts`(17 行)

重要范围说明(protocol.ts:1-6):**DOCX(docx-preview,DOM 绑定)与 PDF(pdfjs 自带 worker)不走这个 worker;PPTX 也曾走、后因 xmldom 太慢迁到主线程**。所以这个共享 worker 目前**只服务 xlsx**——`ParseKind = 'xlsx'`(protocol.ts:6)。本章把它列在重型查看器之后,是因为它是 preview 模块统一的"后台解析"基础设施,且其设计预留了未来扩展。

#### 6.4.1 protocol.ts —— 消息协议

- `ParseKind = 'xlsx'`(protocol.ts:6)。
- `ParseProgress`(protocol.ts:8-12):`{ phase: string; loaded?; total? }`。
- 请求消息 `ParseRequestMsg`(protocol.ts:14-20):`{ type:'parse'; id; kind; buffer: ArrayBuffer; options? }`。
- worker→主线程消息 `WorkerOutMsg = ParseProgressMsg | ParseResultMsg | ParseErrorMsg`(protocol.ts:21-25):
  - `progress`:`{ type:'progress'; id; progress }`。
  - `result`:`{ type:'result'; id; kind; data }`。
  - `error`:`{ type:'error'; id; error }`。
- 结果载荷:`SheetData = { name: string; rows: string[][] }`(protocol.ts:28);`ParseResultData = { xlsx: SheetData[] }`(protocol.ts:32-34),用于客户端按 kind 推导返回类型。

#### 6.4.2 parseClient.ts —— 客户端单例与请求生命周期

- `WorkerLike` 接口(parseClient.ts:5-10)抽象 worker(便于测试替身),`Pending`(parseClient.ts:12-17)保存 `resolve/reject/onProgress/cleanup`。
- 单例 worker `_worker`、自增序号 `_seq`、`_pending: Map<id, Pending>`(parseClient.ts:24-26)。`defaultFactory`(parseClient.ts:19-21)用 `new Worker(new URL('./fileParser.worker.ts', import.meta.url), {type:'module'})` 创建模块 worker。
- `__setWorkerFactory(f)`(parseClient.ts:29-33):测试缝,换 factory(传 null 恢复默认并 terminate 现有 worker)。
- `ensureWorker()`(parseClient.ts:44-68):懒创建并挂 `onmessage`(progress→回调;result→resolve;error→reject,均经 `settle(id)` 出表并跑 cleanup)与 `onerror`(parseClient.ts:58-65:worker 崩溃/加载失败时 `preventDefault`、置 `_worker=null`、把所有在途 pending 全部 reject 成 `Parse worker crashed: ...`,下次调用会重生新 worker——避免崩溃导致 UI 永挂)。
- `parseInWorker<K>(kind, buffer, opts?)`(parseClient.ts:74-101):返回 `Promise<ParseResultData[K]>`。`opts` 含 `onProgress / signal(AbortSignal) / options`。若 `signal` 已 abort 立即 reject `DOMException('Aborted','AbortError')`;否则分配 `id=\`p${++_seq}\``,挂 abort 监听(abort 时仅删本地 pending 并 reject,**不停止 worker 内已运行的工作**——注释 parseClient.ts:70-73 指出当前 xlsx 是同步解析故无害,但未来异步解析需实现 worker 侧取消);`w.postMessage(req, [buffer])`——**用 transferable 转移 buffer 所有权**(零拷贝)。

#### 6.4.3 fileParser.worker.ts —— worker 入口与 dispatch

- `ctx`(fileParser.worker.ts:6-9)是 worker 全局作用域的最小视图(避免引入与 DOM lib 冲突的 WebWorker lib)。
- `ctx.onmessage`(fileParser.worker.ts:11-21):非 `'parse'` 忽略;否则先 `post({type:'progress', progress:{phase:'parsing'}})`,`await dispatch(msg)` 得结果 `post({type:'result', kind, data})`;异常 `post({type:'error', error})`。
- `dispatch`(fileParser.worker.ts:25-34):`case 'xlsx'` → `parseXlsx(buffer, options)`;`default` 用 `const _never: never = msg.kind` 做**编译期穷尽性检查**(新增 ParseKind 而漏 case 即 TS 报错)。

#### 6.4.4 xlsx.ts —— 表格解析

`parseXlsx(buffer, options)`(xlsx.ts:6-16),依赖 `xlsx` 库(SheetJS):
- `XlsxParseOptions = { csv?: boolean }`(xlsx.ts:4)。
- `isCsv` 时 `XLSX.read(TextDecoder().decode(buffer), {type:'string'})`,否则 `XLSX.read(new Uint8Array(buffer), {type:'array'})`(xlsx.ts:7-10)。
- 遍历 `wb.SheetNames`,对每个工作表 `XLSX.utils.sheet_to_json(ws, { header:1, defval:'', raw:false })` 得二维字符串数组(`header:1` 取行数组、`defval:''` 空单元格补空串、`raw:false` 取格式化后的显示文本),返回 `{ name, rows }[]`(xlsx.ts:11-15)。

> 说明:消费 `parseInWorker('xlsx', ...)` 的具体表格查看器组件不在本章列举范围内(本章四个 worker 文件聚焦协议与解析本身)。其调用方应位于 preview 的表格查看器,详见对应章节。

---

### 6.5 本章小结(设计要点回顾)

1. **三套独立重型栈,三种线程策略**:PDF 用 pdfjs 自带 worker;PPTX 解析被迫回到主线程(原生 DOMParser 比 xmldom 快 10×)并靠"每 16 张让步事件循环 + 每幻灯片虚拟化渲染"维持流畅;DOCX 因 docx-preview 是 DOM 绑定也在主线程,并在渲染前做一次 zip 级 wps 文本框预处理。
2. **保真 vs 性能的反复权衡**贯穿全章:pdfjs 检索抖动的两处 monkey-patch + 可见性兜底;`prefixSelectors` 从灾难性回溯正则改 `indexOf`;PPTX 虚拟化避免 84MB DOM;DOCX 表格竖排 bug 的针对性 CSS 修正。
3. **能力暴露统一走 `usePreviewToolbar`**:PDF 提供 zoom/pages/search/toc/download;PPTX 提供 pages/zoom/toc/download;DOCX 仅 zoom/download。三者都不提供 `copy`。
4. **PPTX 解析引擎能力极广**:文本(段落/run 全套格式、自动编号、符号字体映射、超链接、上下标、glow)、图片(裁剪、EMF/WMF→PNG)、表格(合并/边框/banding/主题表头)、连接线(直/折/曲、箭头、虚线)、形状几何(预设表 + 参数化 + custGeom)、主题色(scheme + 5 种颜色变换 + alpha + 渐变)、母版/版式/正文三层继承与背景继承。纯几何/颜色算法按职责概述,未逐行抄录公式(刻意取舍)。


---


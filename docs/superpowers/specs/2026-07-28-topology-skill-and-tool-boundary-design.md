# 拓扑能力的 skill/tool 边界与工具收敛设计

## 背景与定位

拓扑绘图能力此前的形态是 **subagent（`topology-agent`）+ 三个 capability 工具**。本轮讨论重新划定了
「什么该是 skill、什么该是 tool」的边界，并据此把工具从三个收敛为两个、把 subagent 改成 skill。

本文档记录**已拍板的决定和它们的依据**，以及调研得到的事实（含推翻先前判断的部分）。
未拍板的部分明确标注。

---

## 一、subagent → skill

### 决定

`topology-agent` 改为 `resources/skills/topology-drawing/`，`default` agent 的 `subagents:`
声明删除。已落地。

### 依据：subagent 有一个静默失效模式

subagent 必须由父 agent 在 SOUL.md 的 `subagents:` 里显式声明才会被发现。这条接线**在移植到
upstream 时真的断了**——upstream 的 `default/SOUL.md` 被重写成英文、`subagents:` 字段一并消失，
于是拓扑代理注册成功、日志正常、什么都不报错，**但没有任何 agent 会调用它**。

skill 走 `CapabilityResolver` 的 `retrieve()` 阶段自动召回（provider 未覆写 `retrieve()` 时
回落到 `list()`），零接线，不存在这个失效模式。

验证：`git diff upstream/master -- resources/agents/default/SOUL.md` 为空——default agent
与 upstream 原版逐字节一致。

### 代价：接受工具白名单丢失

SKILL.md 的 frontmatter 只认 `name` / `description` / `triggers` / `version` 四个键
（见 vendored wheel 的 `capability_skill_local/_parser.py`），**没有 `tools` 字段**。
subagent 的 `tools.required` 除了「要什么」还隐含「不给什么」（拓扑代理原本没有 shell、没有联网）。
改成 skill 后，执行它的子任务带着调用方的全套工具。

> **补充（2026-07-31）：`triggers` 被解析，但没有任何消费者。** 追踪路径：`_parser.py:56`
> 解析 → `protocols/capability.py:80` 存进 `Capability` → `capability_skill_local/provider.py:130`
> 赋值一次，**ctx_weft 里再没有地方读它**。决定模型看到什么的
> `core/assembler/sources/capability.py` 用的是 `cap.description`，`triggers` 在整个 assembler
> 里一次都没出现；IPMC 侧 `src/` 的六处引用全是列表展示与持久化（skills API、本地/市场服务、
> 迁移回填、云端引用 provider），不参与匹配。它也**不是 Anthropic 官方 Agent Skills 规范的字段**
> ——官方 frontmatter 只有 `name` + `description`。
>
> 所以**技能能不能被召回，完全取决于 `description`**。实测本技能原来的 8 条 `triggers` 里，
> `topology` 和 `spine-leaf` 两个词在 description 里根本没有——它们只活在没人读的字段里。
> v1.5 已把 `triggers` 整块删掉，把这两个词（外加此前遗漏的 `pptx`）并进 description。
>
> 跟 `meta.layoutDirection`（12.9）是同一类：字段存在、被解析、写了不报错、没有消费者。
> 区别是 `layoutDirection` 会让作者以为改了方向（有害），`triggers` 只是让人以为在调触发（冗余）。

用户已明确接受这个代价。理由：拓扑工作全程只读写工作目录里的 `.topo.json` 和导出文件，
破坏面小；权限门仍在，危险命令照样拦。

`verify-icon-reference.js` 的第 ⑤ 组断言专门钉住「frontmatter 不许出现引擎不认识的键」——
在 SKILL.md 里写 `tools:` 不会报错、只会被静默忽略，那正是「以为自己声明了、其实没有」的
沉默失败。

### 图标技能合并为 reference 文件

原 `topology-icon-picker` 技能（约 2000 token）拆开：**判断规则并入主 SKILL.md，
目录表沉为 `references/icon-catalog.md`**（约 900 token，由 `gen-icon-reference.js` 从
`topology-icons/catalog.json` 生成）。

为什么判断规则不能一起沉下去：它要解决的是「什么时候该读这份表、读了怎么判断」。沉下去
agent 就想不起来去读——这是本项目反复验证过的模式（**agent 只做被信号驱动的事**）。

为什么目录表要生成而不是手写：两处维护同一份认知必然漂移，本项目已经因此出过事
（`style-report` 自己臆断哪些 glyph 画得出来，给出了假的全清）。`verify-icon-reference.js`
用 `--check` 把「参考页 = catalog 的投影」钉死。

---

## 二、tool 与 skill 的边界准则

### 准则：能算的进 tool，要判断的进 skill

| | tool（Node 原生） | skill（指令） |
|---|---|---|
| 布局 | 算坐标（`regions.js`） | 选哪种布局、tier 怎么排 |
| 走线 | 算路径（libavoid / 直线） | 选 orthogonal 还是 direct |
| 渲染 | 生成 SVG / HTML | — |
| 审核 | **测量**：重叠多少、净空多少、哪些角色没图标 | **判读**：这个重叠要不要管、是不是用户故意钉的 |
| 纠错 | — | 改哪个字段、怎么改 |
| IR | 解析 + 校验引用完整性 | 词汇含义、写法约束、反滥用规则 |
| 图标 | 按 key 取 svg 嵌进图 | 按语义挑哪个 key |

「审核」横跨两层：**测量必须跑引擎**（"两个 zone 框相交了 12.3px" 靠读 JSON 算不出来，
需要布局后的坐标），但**工具只报数字、不下结论**。判断留在 SKILL.md，因为「用户是不是故意
把两个框摆重叠」引擎不知道。

这条准则不是新发明，`geometry-report.js` 的文件头早就写着「这是测量不是规则……判断留给 agent」。
本轮只是把它显式化，作为后续所有决策的判据。

### 这条准则的推论（举例）

- 要不要在引擎里加「自动修复重叠」？**不要**——那是判断，会剥夺 agent 的选择权
- 要不要把「角色数超过 8 个必然撞色」写成 DRC error？**不要**——撞色不是错误，是可接受的取舍
- 要不要加 `layout: "ring"`？**要**——那是计算，引擎该提供的能力

反过来也成立：2026-07-27 修的四个沉默失败里，三个的根因都是**该报的数字没报**
（连线没 stroke、缺图标没报、routing 不一致没报）。工具的职责是把事实摆全，判断才轮得到 skill。

---

## 三、工具收敛：3 → 2

### 现状的问题：分类轴不统一

```
observe_topology   ← 按意图（诊断）
render_html        ← 按传输方式（返回文本）
export_diagram     ← 按传输方式（写磁盘）
```

`render_html` 和 `export_diagram` 做同一件事，只是出口不同。这是演进痕迹：`render_html`
早就存在（那时它是唯一产出方式），`export_diagram` 是 2026-07-25 才加的，加完没回头收拾旧的。

后果不是理论问题——**2026-07-28 的真实 agent 跑动中，`render_html` 返回的 163KB HTML 触发
spill 机制落到 `tool_outputs/`，agent 只好用 `Copy-Item` 搬成 `.html`，弹出权限审批**。
这是设计导致的必然，不是意外。

### 决定：改为 draw + export，`observe` 消失

```
topology:draw(model, preview_path)
  → HTML 落盘（人在预览 tab 看）
  → 返回 {path, score, findings, geometry, style}（agent 读诊断）

topology:export(model, output_path, format=svg|…)
  → 确认后出成品
```

两个工具对应两个时刻：**迭代中 / 确认后**。

关键改动是 `draw` 一次调用**同时服务两个受众**——人看图、agent 看数。此前这两件事要分两次调用，
而且人在 agent 的循环里完全看不到中间状态（2026-07-28 那次跑用了 24 万 token，用户全程看不到
它画成什么样）。

### `observe` 为什么完全消失，而不是保留

保留一个「只诊断不出图」的入口，agent 大概率会一直走它——人还是看不到，回到原问题。
本项目已反复验证 **agent 只做被信号驱动的事**，留后门等于没改。

代价实测：每轮迭代多跑一次走线，**281ms vs 173ms（+108ms）**，外加写一个 163KB 文件
（同路径覆盖）。相比一个 LLM 往返，可忽略。

### 依赖前提：应用内 HTML 预览

「对外 HTML 呈现」要真的到达人眼，依赖 upstream 的 `d2f7bb1`（应用内浏览器 + 可停靠预览 tab，
明确支持 HTML 文件预览）。该提交已在 `upstream/master`，前提成立。

---

## 四、为什么不把布局/走线/渲染拆成独立工具

讨论中提出过这个流程：

```
agent描述 → 布局渲染工具 → 观察工具 → agent修改 → 布局渲染工具 → 观察工具 → 出图工具
```

**不采用。** 依据如下。

### 中间产物必须落在某处，两条路都不好

**路线 A：坐标穿过 agent 的上下文。** 违背「agent 不碰坐标」这条核心原则，而且数据中心那张图
就有 5-10KB 的坐标 JSON，agent 完全用不上。一旦坐标进了上下文，agent 迟早会去改它。

**路线 B：引擎侧缓存 + handle 引用。** 技术可行，但 provider 现在明确是无状态的
（`TopologyCapabilityProvider` 的注释：「无状态：每次调用起一个子进程」）。引入缓存要管
生命周期、淘汰、内存，多一类「handle 失效/过期」的错误。

### 更要命的是往返成本

agent 每改一次模型，布局结果就作废。所以循环变成 `改 → layout → observe → 改 → layout → observe`，
**每轮迭代从 1 次工具调用变成 2 次**。一次工具调用意味着一个 LLM 往返——那才是贵的（几秒 +
几千 token），布局本身才 170ms。用 170ms 的计算换一个 LLM 往返，是亏的。

### 前提：布局是确定性的（已实测）

不需要 handle 的根据是「同一个模型 → 同一份布局」。2026-07-28 实测（`demo-dc-spine-leaf`，
19 设备 26 链路）：

| 验证 | 结果 |
|---|---|
| `observe` 跑两遍 | 逐字节一致 |
| `export --routing=orthogonal` 跑两遍 | 逐字节一致（**libavoid 是确定性的**） |
| observe 的节点坐标 vs export 的节点坐标 | **19 个设备零偏差**，bbox 也一致 |

第三条是关键：两条路径走不同代码（observe 用 hand 布局跳过走线，export 走 elk 路径），但节点
坐标完全相同——因为坐标全部委托给 `regions.js`，两边只在走线上分岔（这是 `regions.js` 重构时
刻意做到的，见 2026-07-25 设计文档）。

所以 **agent 在诊断里读到的几何测量，描述的就是最终出图的那张图**。重跑一遍换来无状态、
纯函数、无缓存失效，划算。

### 已知边界

`observe`（未来的 `draw` 的诊断部分）**测量不覆盖走线质量**。几何测量的是设备和 zone 的位置关系
（重叠、越界、净空），不包括「线有没有绕远、有没有穿过不相干的设备」。

改成 `draw` 后每次都会跑走线，**这个缺口从「原理上做不到」变成「还没做」**——走线结果已经在手边了。
待办：给几何测量加走线质量检查（端口方位自洽、连线穿越设备）。

---

## 五、HTML 作为存档：已经成立，但有一处要修

`render.js` 已经把完整模型嵌进 HTML：

```js
window.TOPO = ${JSON.stringify(model)}
```

实测可以完整提取回来（19 设备 / 26 链路 / 2 zone 全对）。所以**这份 HTML 既是交付物也是存档**——
下次打开它，agent 从 `window.TOPO` 取出模型接着改，不需要 `.topo.json` 在手边。

### 待修：嵌入的是补全后的模型，往返不幂等

提取出的 `encoding` 比原文件**多了派生字段**（`normalizeEncoding()` 在布局阶段补的 fill/stroke）。
后果：原本「没写颜色、由引擎自动配」的角色变成「显式指定了颜色」，以后加新角色时配色算法看到的
已占用槽位不同，**自动配色结果会跟第一次不一样**。

不是错误，但应该处理。**决定：嵌入原始模型（剥掉派生字段），让往返幂等。**

---

## 六、调研结论（事实，含推翻先前判断的部分）

### libavoid 没有 Python 替代——去 Node 化不可行

[libavoid](https://www.adaptagrams.org/) 是 Adaptagrams 项目的 C++ 库，PyPI 上**没有**可
`pip install` 的绑定。现有封装全在 JS 侧（`libavoid-js` WASM，即我们在用的）。搜到的其它开源实现
是 C#（Bukk94/OrthogonalConnectorRouting）和 JS（schteppe/smart-signal-routing）。

算法有公开论文（Wybrow et al., GD 2009；Marriott et al., Diagrams 2014），理论上可自行实现，
但那是实现一篇图形算法论文的工作量。

**结论：88MB 的 Node 运行时省不掉**，只要还要正交避障走线。此前提出的「重写成 Python 实现独立
分发」这条路**不成立**。

### 布局能力：Python 基本够用，缺的部分自己写更合适

| 能力 | Python | 说明 |
|---|---|---|
| 力导向 | ✅ 成熟 | fa2/fa2-modified（Gephi ForceAtlas2 移植）、igraph、networkx |
| 径向/同心圆 | ✅ 基础版 | `networkx.shell_layout`、`igraph.layout_reingold_tilford_circular` |
| 网格 | ✅ | `igraph.layout_grid` |
| 分层（Sugiyama） | ⚠️ 弱 | `igraph.layout_sugiyama` 不支持端口/嵌套；grandalf 更弱 |
| 参数化领域布局 | — | 谁都没有，本来就得自己写 |
| **正交避障走线** | ❌ **完全空白** | 唯一真正非 Node 不可的 |

### elkjs：当前未使用，但**不要删**

实测把 `node_modules/elkjs` 整个移走，`observe` 和 `orthogonal 导出`照常工作——我们只用
`@mr_mint/elkjs-libavoid` 的 `routeEdges` 绕线，节点坐标全部来自 `regions.js`，elk 的 layered
算法早就不跑了。elkjs 占 7.7MB / 9.3MB。

**先前建议删除，本轮推翻。** 理由：[ELK](https://eclipse.dev/elk/reference/algorithms.html) 的
layered/mrtree/radial 正是流程图、依赖图、组织架构图需要的，而这些是拓扑之外最可能的扩展方向。
它现在闲置只是因为第二个用例还没来。

**行动：留着，并在 `package.json` 里注明保留理由**——否则下一个人看到「声明了但没人 import」
一定会删掉。

### 通用化：等第二个用例再抽象

`regions.js`（递归盒式布局）、libavoid 绕线、`geometry-report.js`（矩形关系测量）三者**与拓扑
语义无关，是通用的**；语义模型、`draw-core.js`、`drc.js` 是拓扑专用的。`_run_node_cli` 本身也
几乎完全通用（参数是 node 可执行文件 + 引擎目录 + 子命令 + JSON payload）。

**决定：现在不做抽象。** 拓扑的语义词汇磨了数周才对（tier 是纯序数、净空距而非中心距、
`satelliteOf`、zone 递归、`column` 里 tier 是列号），每条都是踩坑改出来的。从**一个**用例提炼
通用模型是造错抽象的经典配方。等第二种图要做时，两个用例的共性才看得清。

成本上现在不做是零代价的：`_run_node_cli` 已通用、`regions.js` 已不依赖拓扑语义，第二个用例来时
抽取工作量与现在相当，但正确率高得多。

### 布局能力缺口（待办，不阻塞）

用两张真实参考图（Dragonfly 拓扑、知识图谱、聚簇/网格层布局示意）验证，发现 `regions.js` 的
`layout` 现在只有 `row`/`column`，缺：

- **`ring`** —— 环形组网（SDH/RPR 环、Dragonfly、Torus）
- **`grid`** —— zone 内成员按 m×n 排（机柜网格、展开的子节点组）
- **`radial`** —— 两级径向（中心 → 簇心 → 各簇自己的卫星环）。这也是 `project_alignment_gap`
  里记的老问题的一部分

三者都是给 `regions.js` 加布局模式，跟引入新引擎无关。注意：**Dragonfly 那类图不是任何通用布局
算法的输出**（完美等分圆周 + 组内成弧 + 全局链路为弦），是参数化摆放；ELK 的完整算法清单里没有
能直接产出它的。这类图正确的做法就是自己写几十行三角函数。

---

## 七、为未来的视觉检查预留（本轮不实现）

用户明确：视觉检查将来是**结合多模态模型的独立工具**，暂不考虑，只要求当前方案未来能支撑。

### 为什么这一层有独立价值

2026-07-27 的四个沉默失败——连线隐形、图标全无、颜色雷同、glyph 假全清——**没有一个是自动检查
抓到的**，而 DRC 100、几何全清、style 全清同时成立。视觉检查覆盖的是「**看起来对不对**」，
这是几何测量和规则检查在原理上覆盖不到的一层。

| 检查 | 覆盖 | 能抓到哪类缺陷 |
|---|---|---|
| DRC + 几何 + style | 数据/结构/测量 | routing 未回写、引用未定义、框重叠 |
| 视觉（未来，多模态） | 看起来对不对 | 连线隐形、图标全无、颜色雷同 |
| 人 | 意图对不对 | 布局形态不符合真实工程图 |

### 当前方案对它的支撑

`draw` 每轮产出一份可视产物、且诊断与产物同源（确定性已验证），视觉检查工具将来读同一份产物即可，
不需要改动 `draw` 的契约。

**硬依赖：多模态模型要位图，不是 HTML。** PNG 导出目前是二期、未实现（`format=png` 会明确报
`UNSUPPORTED_FORMAT`）。SVG 光栅化需要单独选型（sharp / resvg-js / headless Chromium），
体积和跨平台打包是主要约束——见 2026-07-25 设计文档的「依赖选型准则」。

---

## 八、本轮的落地范围

### 已完成

- subagent → skill（`topology-drawing`），default SOUL.md 回到 upstream 原版
- 图标技能合并为 `references/icon-catalog.md` + 生成器 + 防漂移测试
- 12 个 JS verify + 20 个 Python 测试通过

### 待做（本轮）

1. `cli.js` 三个子命令合并为 `draw` + `export`
2. provider 三个工具改两个
3. HTML 嵌入原始模型（剥派生字段），使往返幂等
4. SKILL.md 工作流重写
5. `package.json` 注明 elkjs 保留理由
6. pytest 调整
7. 打包冒烟 + 端到端验证

### 推迟

- PNG/PDF/vsdx 导出（二期/三期）
- 视觉检查工具（需多模态模型 + PNG 前置）
- `layout: ring/grid/radial`
- 走线质量检查
- 通用化抽象（等第二个用例）
- 实时预览（见九）
- 非拓扑图种支持（见十）

---

## 九、实时预览：本轮走文件预览，实时留待后续

**本轮决定：按文件预览模式做**——`draw` 落盘 HTML，用户在预览 tab 里看。已知它不会自动刷新，
接受这个限制。以下是为后续实现记录的调研结论（2026-07-28 实测）。

### 现状：预览 tab 不会自动刷新

`draw` 每次写的是**同一个路径**（覆盖写），所以不存在"每次生成新文件"的问题。问题出在查看器：

```tsx
// frontend-desktop/src/preview/viewers/HtmlViewer.tsx —— srcDoc + sandbox iframe
const { content } = useFileText(path)
// preview/viewers/common.tsx
useEffect(() => { fetchOrThrow(textUrl(path))… }, [path])   // ← 只依赖 path
```

**路径不变就不重新拉取。** 用户要看到更新，得关掉预览再打开（或切到别的文件再切回来）。

顺带确认两件有利的事：我们生成的是自包含 HTML，不受 HtmlViewer「相对路径资源加载不出来」的
限制；`sandbox="allow-scripts"` 让内嵌的 pan/zoom 脚本能正常跑。

### 没有现成的文件监听通道

后端 `_setup_watcher`（`api/startup.py`）只监听 `agents_dir` / `skills_dir`，用于开发时热重载
agent 模板和 skill，**不管工作区文件**。工作区面板的刷新是手动按钮（`onClick={() => refetch()}`），
没有轮询。

### 后续方案：本地 HTTP + 应用内浏览器 tab（推荐）

比在 `HtmlViewer` 里加轮询更合适。零件基本齐了：

| 零件 | 现状 |
|---|---|
| 应用内浏览器 tab | Electron `<webview>`，`App.tsx` 的 `openUrl()` 驱动（upstream `d2f7bb1`） |
| 怎么触发打开 | **agent 回复里写 http 链接，用户点一下就在应用内打开**——ChatPanel 的 markdown 链接渲染器判 `/^https?:\/\//i` 后走 `openUrl` |
| 自动打开通道 | **没有**。SSE 里只有 `webview_content_request`（抓当前页内容回传），没有「让前端打开某 URL」的事件 |
| 本地服务 | `drawing-engine/serve.js` 已随整目录进包，但服务的是**启动时加载的固定模型**，且没有任何东西会启动它 |

走 HTTP 的关键优势：`file://` 的限制全没了——页面可以 `fetch` 轮询或接 SSE，而且**pan/zoom 状态
能自然保持**（不重载整页，只换 SVG 内容）。在 `HtmlViewer` 里加轮询做不到这点：每次都要重建
iframe，用户的缩放和平移位置必丢。

要解决的三件事：

1. `serve.js` 改成服务 agent 当前的模型，不是启动时固定那份
2. 谁启动它、何时启动（lifespan 常驻？还是 `draw` 首次调用时懒启动）、端口怎么分配并告知 agent
3. 没有自动打开通道——但**不一定要做**：agent 给链接、用户点一次、之后一直实时，体验上够用

### 定位区分

走 HTTP 之后，`draw` 落盘的 HTML 定位会变清楚：它是**存档 + 离线交付物**（双击能看、可发给别人、
嵌着模型可下次接着改），实时观看走 HTTP。两种产物各司其职，而不是让一个静态文件同时承担实时
预览的职责。

---

## 十、其它图种（流程图等）：机制上已开放，缺两处词汇

用户问：别的 skill 能不能调这两个工具画非拓扑的图？

### 机制上可以，无需任何改动

topology provider 没有自定义 `retrieve()`，回落到 `list()`，所以两个工具**发给每一个 agent**。
任何 skill 的指令里写「调 `topology__draw_topology`」都能调到。

### 模型骨架是通用的

`devices`（盒子）+ `links`（连线）+ `zones`（分组）+ `encoding`（样式表）——画流程图、依赖图、
模块框图结构上都套得进去（`devices[].label`=步骤名，`deviceRoles`=框的样式类别，`links`=流转
箭头，`zones`=阶段/泳道，`tier`=第几步）。`regions.js` 布局、libavoid 走线、`draw-core.js` 渲染、
DRC 的引用完整性检查、几何测量都是领域中立的。

### 两处硬伤

1. **没有形状词汇。** 流程图要菱形判断、圆角起止，现在只有矩形；`glyph` 只认 `cloud` 和
   `ellipsis`（见 `draw-core.js` 的 `RENDERED_GLYPHS`），`icon` 那 35 个 key 全是网络设备。
   非拓扑图只能画成清一色圆角矩形靠颜色区分。
2. **`style.rolesWithoutIcon` 会误报。** 它会把流程图的每个角色都报成「缺图标」，催 agent 去配
   设备图标——agent 会认真照做，给「库存充足?」这个判断框配上一个交换机图标。这是会误导
   agent 的假警报。

### 最小改动（真要支持时）

不是抽象出通用引擎，而是两个具体的口子：`glyph` 扩成形状词汇（`rect`/`diamond`/`round`/
`cylinder`…，`RENDERED_GLYPHS` 跟着扩）；`style` 的图标检查加一个「这张图不需要图标」的开关
（`meta.kind` 或由 skill 声明）。

命名上的别扭（流程图作者要写 `deviceRoles`）先忍着——改名要动模型、引擎、SKILL.md 和所有测试，
而它不影响任何功能，等真有第三种图了再一起考虑。

**注意：以上「结构上套得进去」是推断，没有实测。** 需要真跑一个流程图模型确认三件事：DRC 会不会
误报、zones 分组在非拓扑语义下布局对不对、style 具体会怎么抱怨。

---

## 十一、vsdx 端口粘连：实测不可用（2026-07-29）

### 背景

vsdx 里「线连在端口上」是自然的期望：SVG 侧已经有可见的端口图元（`draw-core.js` 的
`drawPort` 白色小圆 r=2.1，`drawConn` 按 connType 画的圆/方 r=3.6），而 vsdx 里这些端口
**一个都没有**——`export-vsdx.js` 只生成 zone + 设备 + 连线三类形状，连接器用
`ToPart="3"`（整形粘连），具体粘哪一点由 Visio 自己决定，我们算好的端口分布进 vsdx 就丢了。

要让线粘在端口上，需要连接点粘连：给形状加 `<Section N="Connection">`，连接器改用
`ToPart = 100 + 行号`，BeginX/EndX 用 `PAR(PNT(Sheet.N!Connections.X1,Sheet.N!Connections.Y1))`。

### 探针设计

不能只做「想要的那一种」——失败时分不清是哪个因素。做成四组，每组只变一个因素：

| | 结构 | 粘连方式 |
|---|---|---|
| A | group → 子group（图标+端口）→ 端口 | 粘到端口子形状（深度 2）|
| B | 连接点在最外层 group 上，端口只是视觉 | 粘到 group 的连接点 |
| C | 普通形状，无 group | 整形动态粘连（现行做法，对照基准）|
| D | 普通形状 + 连接点 | 粘到连接点 |

生成脚本 `probe-vsdx.js`（探针，未进仓库）；结构自检覆盖 OPC 完整性、嵌套深度、
悬空引用、`ToPart=100` 的目标是否真有 Connection 段、公式写法——全部通过。

### 实测结果（EdrawMax）

**只有 C 跟随。A / B / D 全部不跟随。**

D 与 C 只差「连接点粘连」这一个因素，D 失败 → **失败原因是连接点粘连本身不被支持，
与分组无关**。A、B 的失败被这一条解释掉了，它们没有提供关于分组的独立信息。

### 结论与影响

1. **连接器继续用整形动态粘连**（`ToPart="3"` + `_WALKGLUE` + `_XFTRIGGER`）。这是目前
   唯一实测可用的粘连方式。
2. **端口在 vsdx 里只能是「画上去的标记」，不能是粘连目标。** 线的落点由 Visio 决定，
   我们算的端口分布在 vsdx 里不保真——SVG 和 vsdx 在这一点上表现不一致，这是已知差异，
   要在 SKILL.md 里对 agent 说清楚，别让它以为两边一样。
3. **仍未验证：group 形状能否作为整形粘连的目标。** 四组里没有「group + 整形粘连」这个
   组合——C 用的是普通形状。而多色图标必须拆成多个子形状（Visio 的填充色是形状级的，
   不是 Geometry 段级的），所以**图标进 vsdx 就一定要用 group**，这条必须补验。

### 待办

- [ ] 补一组探针 E：group + 整形动态粘连，确认 group 能否作为粘连目标
- [ ] 连接点粘连在真 Visio（非 EdrawMax）里是否可用，未测。若可用，可考虑按目标软件分流

---

## 十二、两项待办（2026-07-29 记录，尚未实现）

### 12.1 能力边界：画的是网络架构，不是网络实况

**先纠正一个说法。** 最初记成"逻辑拓扑 vs 物理拓扑"，不准确——真正的分界不是逻辑/物理，
是**抽象层级**：

- 本方案画的是**网络架构拓扑**——节点代表的是**层次里的一个角色**（接入层的接入交换机、
  核心层的核心交换机），一个图标站在那儿说明"这一层有这么个角色，它这样连"。
- 撑不住的是**网络实况拓扑**——有一台设备就画一个图标，48 台接入交换机就是 48 个图标。

这不是"规模大了会难看"的问题。**一张图的目的变了**：架构图讲结构，实况图是台账。
拿讲结构的工具去做台账，即使画得出来也答非所问。

**设计里其实早就假定了这一点，只是没写成边界**：
- `encoding.deviceRoles` 是一等概念，设备是角色的实例；图例按角色列，不按设备列。
- 已经有 `ellipsis` 角色（`decorative: true`，图例文案就是"省略（同组更多设备）"），
  参考图里用了 2 个——**"不逐台画、用省略号表示还有更多"本来就是内置画法**。
- DRC 明确把 decorative 排除在命名规则之外（drc.js:46），因为它不代表任何网络实体。

**所以要补的不是一个规模阈值，是一条"用途边界"**，外加一个能提前发现跑偏的信号。

*用途边界（写进 skill）*
用户要的是"把我机房里 200 台设备都画出来"时，如实说明这个工具是画架构的，
并给出可行的替代：按角色抽象 + `ellipsis` 表示同组还有更多。**不要硬画**——
跟环形组网那条（不支持 `layout: ring` 时不要用 row/column 凑近似形状）是同一种处理。

*跑偏信号（进 geometry-report，只出事实不下结论）*
最有判别力的不是设备总数，而是**同一 role 的实例数**：作者开始给一个 role 堆 24 个实例时，
他已经在枚举而不是抽象了。参考图的分布是 access×6 / router×2 / core×2 / agg×2，
其余各 1——6 是当前见过的最大值。这个数字比"设备总数超过 N"有意义得多，因为它直接
对应"这张图正在从架构图滑向台账"。

同时仍要报几个纯几何事实（它们是"画出来能不能看"的约束，跟抽象层级无关）：
单边最大端口数（当前参考图最大 3）、预估产物体积（14 台带图标 → vsdx 1.15 MB /
11,265 个几何顶点）。

**没实现的原因**：具体从几个实例开始算"枚举"，没有实测依据，现在写死数字是猜的。
要测就构造 role 实例数 4/8/16/24 的模型，看可读性和"这还算架构图吗"从哪里开始变味。

### 12.2 把常用脚本作为 skill 的 script 提供

**背景**：加了 `model_path` 之后（见工具签名），agent 在实跑中会自己写 Python 脚本生成
/ 修改 `.topo.json`——这正是绕开工具参数输出上限的用法。既然这个动作会反复出现，
可以把其中通用的部分固化成 skill 自带的脚本。

**机制上没有障碍**：upstream 的 skill 本来就带脚本（docx 60 个、pptx 56 个、pdf 9 个、
xlsx 3 个），`validate_skill_zip` 只要求根目录下有 SKILL.md，子目录不受限。

**值得固化的候选**
- 规则性结构的生成器：spine-leaf（给 spine/leaf 数量和上联数）、接入层扇出、
  双核心双上联这类反复出现的骨架
- 编码表脚手架：按用到的 role 生成 `encoding.deviceRoles` 骨架，避免漏 legend/icon
- 调用前自检：在本地先跑一遍结构校验，把明显错误挡在起 Node 子进程之前

**风险，而且是本项目反复踩过的那一类**：脚本会变成模型语义的**第二份实现**。引擎的
schema 一改，脚本就悄悄过期——而"脚本过期不会导致构建失败"，跟手工白名单、skill 两份
副本是同一个病根。真要做，必须同时给出同步机制（比如脚本产出的模型在 CI 里跑一遍
`draw`，schema 变了就红），不能只把脚本扔进去。

**还需要确认的**：agent 跑这些脚本用哪个 Python。随包有 python-runtime 和 workspace
venv，但 skill 脚本的执行路径没验证过——如果依赖第三方库就更要先确认。

### 12.3 pptx 导出提前（2026-07-29）

**优先级变更**：pptx 导出从"后续"提到前面。

**用户给出的理由**：vsdx 虽然能打开，但**斜线不可编辑**——稍微调一下设备位置，原本的斜线
就走成折线了。

**但这条根因我判断很可能不是"斜线不可编辑"，而是连接器的路由样式，且尚未验证**：
我们生成的连接器只给了直线几何（Geometry 段两个点），可是 `_WALKGLUE` 让 Visio 在设备
移动时自行重算路径，它会按**默认的直角路由**走。Visio 的连接器有 `ShapeRouteStyle`
单元格控制这件事，设成直线路由应当能保持斜线。

**建议的先后**：先花十几分钟验 `ShapeRouteStyle`。若成立，vsdx 这个问题只是加一个 Cell，
不必靠 pptx 绕开。pptx 本身仍值得做（它是另一种交付场景：塞进汇报材料、用 PowerPoint
直接改），但不该是为了绕开一个可修的问题才做。

**pptx 的已知形态**（未开工，先记）：OOXML 包，结构上跟 vsdx 同为 OPC（ZIP + XML part），
zip-writer.js 可直接复用；形状是 `<p:sp>`，连线是 `<p:cxnSp>` 带 `stCxn`/`endCxn` 指向
形状 id——**PowerPoint 的连接是真连接，移动形状时线会跟随**，这点跟 vsdx 的诉求一致。
图标可以复用 svg-geometry.js 的几何（`a:custGeom` 的 `a:path`），不必再走一遍调研。

### 12.4 设备标签溢出 zone 边界（2026-07-29，已量化，未修）

**现象**：设备的文本标识经常超出 zone 虚线框。

**实测**（参考图 topo-data.js，两个 zone 各 3 台带图标的接入交换机）：

```
zone ZONE_SVR  bbox 底 536.0
   Acc-1 / Acc-2 / Acc-3   方框底 518.0   文字下缘 536.9   超出 +0.9
zone ZONE_STG  同上（Acc-4 / Acc-5 / Acc-6）
```

**是系统性的，不是个例**：位于 zone 底部的带图标设备**全部**超出。

**根因**：`ZONE_PAD = 18`（topo.js CFG）是相对**设备方框**外扩的，而有图标时标签画在
**方框外下方**——`roleY = n.bottom + labelSize * 1.9`（draw-core.js:130），对这批设备
是 `n.bottom + 18.9`，刚好比 18 的留白多出 0.9。**标签高度从来没算进设备的视觉占位。**
参考图里只超 0.9px 不明显，但字号一大、长宽比一变就会明显超出。

**结论：布局和检查都要做，但分工不同。**

*布局是修复点*。标签本来就是设备视觉占位的一部分，而且它可算：`labelSize = n.h * 0.27`，
两行文字整块约 `2.5 × labelSize ≈ 0.675 × n.h`，完全确定。

**修的时候必须避开一个坑**：标签位置现在算在 draw-core.js，zone 包围盒算在 topo.js，
两处各算各的。直接在 topo.js 里再抄一遍 `n.h * 0.27 * 2.5` 就是本项目反复踩的那类隐患
（两份公式，改一处不改另一处不会失败）。正确做法是把"标签块高度"抽成一个派生函数，
两边都调它。

*检查是护栏*，理由不是双保险，而是布局修完之后**仍有别的路径能把它带回来**：elk 引擎
那条、meta 覆盖、agent 手写 w/h。而这类缺陷的特征正是"图画得出来、文件也合法、只有量
一下才发现"——geometry-report 就是为这个存在的。按既定原则只出事实：
`labelOverflows: [{device, zone, overflowPx}]`，判断留给 skill。

*影响面*：修在布局层对所有渲染路径都生效。vsdx 里 zone 同样是独立矩形、标签同样在
group 盒外（负 y），现在一样会超。

#### 12.4 更正与落地（2026-07-29，当天完成）

**上面 12.4 里"纵向系统性超出 +0.9px"这个结论是错的**，更正如下：

那个数字是用 `roleY + labelSize*0.6` 估字体下缘算出来的。而 SVG 用的是
`dominant-baseline: middle`，下缘应为 `roleY + roleSize/2`——按这个算，纵向是
**在框内 0.9px**，不是超出 0.9px。两种估法结论相反，说明当时的量法不够扎实就下了结论。

**真正的问题是横向。** 参考图本身不复现（各方向余量都很大）。构造用例才复现：
把三台接入交换机的标签改成 `Access-Switch-Building-A/B/C`、角色图例改成
"园区接入层交换机（千兆）"，靠 zone 左右边缘的两台**横向伸出 14.8px**。
触发条件是「文字比方框宽的量超过 ZONE_PAD(18)」，跟设备数量无关。

**修法：布局层引入"占位宽"，检查层留护栏。**

- `regions.js` 新增 `labelMetrics` / `labelOffsets` / `estimateTextWidth` /
  `footprintWidth`，公式**只此一份**。`footprintWidth = max(方框宽, 标签宽, 角色文字宽)`；
  标签水平居中于方框，所以占位相对方框对称，方框中心即占位中心，不需要额外偏移。
- `regions.js` 的列宽、行内游标、容器范围一律改用 `fw`（缺省回退到 `w`，不设时行为不变）。
  于是列宽和 zone 包围盒**自动**含标签，不必在第二处再写一遍公式。
- `topo.js` 算 `sizeById` 时带上 `fw`。
- `draw-core.js` 改为调用 `labelMetrics`/`labelOffsets`，删掉它自己那份 `n.h*0.27` 公式。
- `geometry-report` 新增 `labelOverflows`（设备/zone/方向/溢出量，只报事实）。

*为什么修完了还要留检查*：布局层的文本宽度只能**估**（没有字体度量），而 elk 引擎那条、
meta 覆盖、agent 手写 w/h 都能绕过占位计算。这类缺陷"图画得出来、文件也合法，只有量
一下才发现"。测试里刻意做了反向验证——人为缩窄 zone 框，断言必须报出 4 条，否则这条
检查是摆设。

*效果*：复现用例 +14.8px → −18.0px（正好等于 ZONE_PAD，说明标签现在定义了成员包围盒
边缘）；参考图坐标完全不变（它的标签都比方框窄）；长标签用例里设备横向让位
（cx −276.5 → −398.9）。

**纵向暂不处理**：实测行间净空还有 46.9~51px 余量（ROW_GAP=78 减去标签约 19）。纵向的
占位是不对称的（标签只往下挂），处理起来复杂得多，等真出现纵向溢出再动。

#### 12.3 更正与进展（2026-07-29）

按 12.3 的建议先验了 `ShapeRouteStyle` 那条假设，**给连接器补了三个单元格**：

```
ConFixedCode    = 2   从不重新布线（visLOConFixNever，判断是决定性的那个）
ShapeRouteStyle = 16  中心到中心直连
ConLineRouteExt = 1   路径取直线不取曲线
```

推断的根因：我们只给了两点的直线几何，但 `_WALKGLUE` 让 Visio 在设备移动时自行重算
路径，重算用的是**页面默认的直角路由**——斜线就没了。

**这三个值在 Visio/亿图里的实际效果本地无法验证**，只能验文件结构（verify-vsdx 已钉住
每条连线都带这三个）。跟连接点粘连那次一样，必须人工在软件里拖一下才算数，已交付
测试文件待验。若成立，pptx 就不再是"为了绕开一个可修的问题"，可按它自身价值排期。

### 12.5 走线压设备的信号在 geometry 段、不进 score（2026-07-30 记录）

**现象**：用户报"agent 对走线与设备重叠没有任何反应"。

**核对结果**：检查**存在**，但位置和分量都不足以驱动 agent。

- `linkCrossings` 在 `geometry-report.js`（3 处），**不在 `drc.js`**（0 处）。
  当初的设计决定：DRC 只查图纸规范性（编码表/图例完整性、命名），只有它进 `score`；
  走线压设备属几何测量，走 `geometry` 段，**不影响分数**。
- SKILL.md 第 123 行确实写了 `linkCrossings`，措辞不弱（讲了成因和后果）。
- **但参考图上它是 0 条**——`direct` 是端口到端口的直线，当前这些图的拓扑下确实没压到
  无关设备。

所以"没反应"有三种可能，仅凭现有信息无法区分：① 那张图真有压线但检查漏报（`segIntersectsBox`
的 bug）；② 那张图没有压线，看到的是别的现象（线之间交叉、或贴边过但没压上）；
③ 检查报了但 agent 没当回事。**定位需要那张图的模型**（`.topo.json`，或 HTML 里嵌的
`window.TOPO`）。

**但不管是哪种，有一件事本身就该重新考虑**：按"agent 只做被信号驱动的事"这条反复验证过的
规律，**把一项放在不影响分数的段落里，等于告诉 agent 它不重要**。
`linkCrossings` / `zoneOverlaps` / `containmentViolations` 都是"图上肉眼可见的错"，
跟"图例少写一条"不是一个量级——但后者扣分、前者不扣。

待决策：要不要把这几项接进 `findings`（warning 级，扣分但不致命）。这会模糊
"DRC 只查图纸规范性"这条边界，所以是个设计决定，不是顺手改。

### 12.6 端口出线边不认识横向布局（2026-07-30 已复现，未修）

**现象**：画两个数据中心互联的左右结构（蝴蝶形），布局本身是对的，但设备出线仍然只从
上下两边走，不符合实际绘图习惯。

**已复现**。构造 `layout: "column"` 的 zone（tier 横向推进），四台设备两两互联：

```
DC-A-1 cx=-49 cy=21     DC-B-1 cx=49 cy=21
DC-A-2 cx=-49 cy=141    DC-B-2 cx=49 cy=141

A1→B1（同排）  right / left    ✓
A1→B2（错排）  bottom / top    ✗  应当 right/left
A2→B1（错排）  top / bottom    ✗
A2→B2（同排）  right / left    ✓
```

`layout: "column"` **确实把两个 DC 摆成了左右**，只有蝴蝶形的那两条交叉链路走错了边。

**根因**在 `topo.js` 的 `sideToward()`：

```js
if (Math.abs(dy) > 1e-6) return dy > 0 ? "bottom" : "top";   // 只要 y 有差就走上下
return dx > 0 ? "right" : "left";                            // 只有同排(dy===0)才走左右
```

它把"分层方向是纵向"**写死**了：只要两台设备不在同一排，就一律上下出线。函数只读 cx/cy，
**压根不知道所在 zone 的 `layout` 是 `column`**——而 column 的语义正是"tier 横向推进"。

那段注释解释了当初为什么这么写：跨层连接固定走上下边是为了"遵循分层方向，不受左右偏移
影响，否则布局越靠外侧、越容易被 dx 主导误判成侧边"。这个理由对**纵向分层**成立，
横向分层时结论正好相反。

**修的方向**：让 `sideToward` 知道分层方向。信息是现成的——zone 的 `layout` 字段，
以及全局的 `meta.layoutDirection`。纵向分层时保持现在的规则；横向分层时对调
（只要 x 有差就走左右，同列才走上下）。

**要注意的**：`sideToward` 现在只接 `(na, nb)` 两个节点，拿不到 zone 归属。要么给节点带上
"所属 zone 的分层方向"，要么把这个方向作为 `computeLayout` 的上下文传下去。
**两个引擎（topo.js 与 geometry-elk.mjs）都要改**——这正是 regions.js 那段注释里说的
"两个引擎各写一份同类推导、悄悄不同步"栽过三次的地方，端口边的规则不能只改一处。

#### 12.6 更正与落地（2026-07-30 当天）

**12.6 的第一版只修了一半，已重做。**

第一版（`layeringAxis`）按**设备的直接父 zone** 取轴。它只覆盖"设备直接放在 column zone
里"这一种建模；而更自然的建模是**每个 DC 各自一个 zone、外面套一个横排父 zone**——那时
设备的直接父都是 `row`，跨 DC 链路又变回上下出线。已实测确认过这个缺陷。

中间讨论过一条纯几何的规则（同行→左右、不同行→上下、不同列→左右）。它在只差一个维度时
完全正确，但**既不同行又不同列时规则互相冲突**，而蝴蝶形的交叉链路全落在这一类。
实测数据也不利：那种情形下 y 向间隙 78（`ROW_GAP`）> x 向间隙 46（`H_GAP`），
"取间隙大的轴"会判成上下——正是要修掉的现象，而且这不是巧合，是两个缺省常量的关系决定的。

**真正的根源是一处结构性不对称**：布局本来就是按 zone 递归做的（`regions.js` 的
measure/place），而端口判定是**平的**——只看裸坐标，没有"我跨的是哪一层的分层"这个概念。
前面那些"几何 vs 声明""比大小""加字段"的讨论，都是在给这个缺失打补丁。

**最终规则**（`regions.layeringAxisFor`）：

> 一条链路的出线轴，由它两端设备的**最近公共祖先 zone** 的 `layout` 决定。

是"链路的轴"而不是"设备的轴"——同一台设备的不同链路跨越的是不同层级的分层：

```
A1 在 DC-A 内(row)，DC-A 与 DC-B 被父 zone 横排(column)：
  A1→A2（同 DC 内跨层）公共祖先 DC-A(row)      → 上下
  A1→B1（跨 DC）      公共祖先 父zone(column)  → 左右
```

没有歧义、没有 tiebreak、没有新字段，两种建模方式都对。没有 zone、或 zone 未声明
`layout` 时退化成隐式根区域的 `row`，与改这条之前**完全一致**——参考图端口边分布
bottom 16 / top 16 / right 3 / left 3，与基线一字不差。

**范围**：`sideToward` 只在 `topo.js`，`geometry-elk.mjs` 不用它。重开 orthogonal 时要
确认 elk 那条路的端口推导遵循同一规则。

### 12.7 走线按 zone 分层（2026-07-30 记录，大改动，未开工）

12.6 落地时确认了一件事：**布局已经是分层递归的，走线还是平的。** 端口出线边那个问题
之所以绕了几轮，就是这个不对称。端口边现在按公共祖先解决了，但**走线本身仍然是全局的**。

**分层走线会长成什么样**（用户提出的方向）：不同层级用不同的走线规则，例如
**zone 内走直线、zone 间走折线**——这在真实网络图里很常见（区域内部连接简洁，区域之间
沿主干走正交折线）。再往下还可以按 zone 类型区分（安全区内部一种画法、DCI 之间另一种）。

**这是个大改动，不是 12.6 那种量级**：
- `meta.routing` 现在是**整张图一个值**。分层走线要求它变成"每一层可以不同"，
  也就是 zone 级的 `routing` 字段 + 继承/覆盖规则。而 per-zone 的间距覆盖当初刻意**不做
  继承**（继承链让"这个数从哪来的"难回答），走线要不要继承是同一类设计问题，得重新想。
- 走线引擎要能分层调用。libavoid 是一次性喂全图障碍物求解的；分层意味着先在 zone 内求解、
  再把 zone 当成障碍物在上层求解，**跨层的接缝怎么对齐**是新问题（zone 内那段的端点必须
  正好接上 zone 间那段）。
- 校验也要跟着分层。`linkCrossings` 现在是全图两两判；分层之后"穿越"的含义要按层重定义
  （一条 zone 间的线从某个 zone 上方掠过，算不算穿越？）。
- 而 orthogonal 目前是关着的（多线汇聚共线重叠，见前文），分层走线的收益要等它重开才看得到。

**结论：记档，与重开 orthogonal 一并规划。** 现在做的话是在一个关着的功能上加复杂度。

### 12.8 tool 侧四项（2026-07-30 记录，发版前不改）

真实使用中暴露出来的，都在 tool 侧，都已定位到代码。发版临近，**只记录不改**。

**① `draw_topology` 不返回任何布局坐标。**
返回的 `geometry` 七项全是"关系/违规"测量（`zoneOverlaps` / `containmentViolations` /
`rowClearances` / `satelliteOverflows` / `linkCrossings` / `columnFanouts` /
`labelOverflows`），**一个坐标都没有**。于是"Internet 是不是在正中间""两个 DC 是否对称"
这类问题 agent 根本无从回答——实测中它开始**写 Python 去解析 HTML 里的 SVG 坐标**。

那不是笨，是被逼的：没有信号的地方 agent 只能自己造工具。而抠 HTML 是坏路——那是渲染
产物，格式随渲染改动而变。数据本来就现成（`layout.nodes` 有 `cx/cy/left/top/right/bottom`），
只是没往外传。**这一项是下面几项的共同解**：有了坐标，即使文档没写全，agent 也能看出自己
放错了并自己纠正。

**② 顶层左右顺序由 `devices[]` 数组顺序决定，而这条规则没有任何对外说明。**
`regions.js` 的 `buildRegionTree` 末尾按 `minDeviceIndex` 排序——zone 的排序键是它成员
设备里在 `devices[]` 中最早出现的那个的下标。实测：Internet 声明在数组最后 → 跑到最右
（cx=97）；夹在两组设备之间 → 正中（cx=0）。调整 `zones[]` 顺序无效。

agent 最自然的写法（先写完 A 的设备、再 B 的、最后 Internet）必然把它甩到最右。
**skill v1.2 已补这条说明**；但机制本身也可议：顺序信息藏在数组的物理位置里很脆，而数组
顺序同时还被 `makePaletteAllocator` 用来分配颜色——一个数组顺序承担两件事。
可能该给显式的 `order` 字段。

**③ 行内成员的纵向位置写死为"居中"，没有 per-device 偏移。**
`measureRow` 里 `cy.set(c.id, mid)`——同 tier 成员一律对齐行中线。用户要"把中间那个
Internet 图标往上挪一点"做不到。三条绕法都不对路：套个隐藏 zone 用 `position`（脆，且
`dx` 要手算）、单独给一个 tier（变成上面一层，不是中间偏上）、`satelliteOf`（偏移是左右向，
且会挂到某一侧）。

真正缺的是"行内纵向对齐/偏移"这个能力。这跟 12.6 是同一个形状：`measureRow` 把"垂直居中"
写死了，就像它原来把"分层方向是纵向"写死一样。改动点也集中——`cy.set` 那一处 + 两个引擎。

**④ `devices[].position` 会被静默忽略。**
`place()` 的覆盖分支条件是 `if (c.zone && c.zone.position)`，**只有 zone 能用**。
写在设备上不报错、不生效。而 `2026-07-30-topology-authoring-surface.md` 最初把它列在
`devices[]` 字段下——**文档错了**（已更正）。这比不写更糟：照文档写会得到一个静默失败。

### 12.9 方位（上下左右）表达不出来，且画错了没有任何信号（2026-07-30 已复现，未修）

用户报的现象：想画「三个数据中心，一个在上、两个在下；上面那个 DC 内部服务器在上、防火墙在
下」，**agent 每次都画成左右结构**。用户的判断是"agent 对上下左右没有概念"。

#### 先说结论：模型能表达，是"写对"和"写错"无法区分

复现脚本把 agent 最可能写出的六种建模各跑一遍（三个 DC 各 2 服务器 + 1 防火墙）：

| # | 建模写法 | 三 DC 一上两下 | DC-A 内部服务器在上/防火墙在下 |
|---|---|---|---|
| ① | 什么都不写（zone 无 `tier`、内部无 `layout`） | ✗ 三个并排 | ✓ |
| ② | 只给内部写 `layout:"column"`（想要"上下堆叠"） | ✗ 三个并排 | ✗ 分成左右两列 |
| ③ | zone 写 `tier`（A=0，B=C=1），内部默认 `row` | **✓** | **✓** |
| ④ | 同③ + 设备 `tier` 全图连续编号（0/1、2/3、2/3） | ✓ | ✓ |
| ⑤ | zone 写 `tier` + 内部 `layout:"column"` 且成员同 `tier` | ✓ | ✗ 三台竖成一柱 |
| ⑥ | zone 写 `tier`，但内部设备都没写 `tier`（全 0） | ✓ | ✗ 三台并排一行 |

③ 就是用户要的图，**一行代码都不用改**。所以这不是表达力缺口（跟 `ring`/`radial` 那类不同），
是**可发现性**问题。

#### 根因：方向从来不是被声明的，是 `layout` × `tier` 分布的乘积

没有任何字段的含义是"这几个东西上下排"。方向是两件事算出来的：

- `layout` 决定**主轴方向**：`row` 的主轴是纵向（tier=第几行），`column` 的主轴是横向（tier=第几列）；
- `tier` 的**分布**决定实际摆成几排——同一个 `layout` 下，成员 tier 全相同和各不相同，
  出来的方向正好相反。

于是同一个意图有两条正确路径（`row`+不同 tier ＝ `column`+同 tier），而每条路径都有一个
恰好反过来的近邻。三个独立的坑，用户这一张图同时踩了两个：

1. **顶层 zone 不写 `tier`**（①②）。隐式根区域固定 `layout:"row"`，而 `tier == null` 兜底成 0
   （`measureRow`：`const t = c.tier == null ? 0 : c.tier`）。**三个顶层 zone 全落在同一行 → 左右并排。**
   这就是"一上两下"变成"左右三个"的全部原因。
2. **zone 内设备不写 `tier`**（⑥）。同上，同一行并排 → "防火墙在下面"落空。
3. **`layout:"column"` + 不同 tier**（②）。名字读起来像"竖排"，实际 tier 是"第几列"，
   分出左右两列。

第 3 条 SKILL.md 早就写了（含正例代码块和两种错法，v1.1 就有），**agent 还是错**——
因为前两条既没写在任何文档里，也没有任何信号。

#### 关键证据：画错了拿不到任何反馈

同一个复现脚本跑 `buildGeometryReport` + `runDRC`：

| 画错的情形 | geometry 报出的东西 | DRC |
|---|---|---|
| ① 顶层没写 tier（用户的症状） | **七项全空** | score=100，findings=[] |
| ⑥ zone 内没写 tier | 只有 `rowClearances`（正常量）和 `linkCrossings`（间接） | score=100 |
| ② `column` + 不同 tier | **`columnFanouts` 命中**，`columns:2` 并列出每列成员 | score=100 |

**① 是完全静默的**：一张彻底不符合用户要求的图，所有信号都说"没问题"。

这解释了为什么"多写文档"这次不管用。② 之所以是三种里唯一被文档覆盖的，是因为它**同时**有
`columnFanouts` 这个信号——文档和信号是配套落地的。①③ 两条既无文档也无信号，
而本项目反复验证的那条规律仍然成立：**agent 只做被信号驱动的事。**

#### 附带发现：`meta.layoutDirection` 是名存实亡的，而它就长在"我要控制方向"的路上

引擎**从来不读**这个字段（`grep` 全仓：只出现在样例数据、注释和文档里；
`2026-07-10-topology-recursive-region-layout-design.md` 已记录 elk 档重构时丢掉了它）。
但两个随包样例 `sample-dual-core.topo.json` / `demo-dc-spine-leaf.topo.json` 的 `meta` 里
**都写着 `"layoutDirection": "TB"`**，而 `2026-07-30-topology-authoring-surface.md` 的
`meta.*` 表里也列了它一行（"分层方向"）。

于是一个想控制方向的 agent 抄样例 + 查字段表，会自然写出 `layoutDirection: "LR"` —— 
**不生效、不报错**。这跟 `devices[].position` 是同一类静默失败，而且更容易撞上，
因为它的名字正好就是 agent 要找的那个东西。已从能力面文档里删掉该行并注明现状。

#### 可选的改法（按性价比排序，均未实施）

1. **把"某个容器在主轴上只分了一格"变成一条事实信号。** 把 `columnFanouts` 泛化成覆盖
   *所有*容器（含隐式根区域）的 `axisGroups`：每个容器报 `{zone, layout, axis: "纵向"|"横向",
   groups: N, byTier: [...]}`。agent 想要两行、看到根区域 `groups:1 / members:[DC-A,DC-B,DC-C]`
   就当场知道写错了。纯事实、不含判断，符合"能算的进 tool"。改动集中在 `geometry-report.js`，
   `columnFanouts` 的逻辑可以直接复用。
2. **12.8 ① 返回坐标。** 又一次是共同解——有了 `cx/cy`，agent 自己就能看出三个 DC 的 cy 相同。
3. **让 `meta.layoutDirection` 要么实现、要么硬报错。** 现状（静默忽略）是三者里最差的。
   最小动作是在入口门禁里对它报 `BAD_ARGS`，成本极低。
4. 文档侧补前两条坑的说明。**单独做这一条预期收效有限**（第 3 条坑的前车之鉴），
   应当与信号配套。

### 12.10 `verify-icon-reference.js` 名不副实，已经是 skill 体检脚本（2026-07-31 记录，未改）

这个脚本现在有五组断言，**只有前三组跟图标有关**：

| | 查什么 | 跟图标有关吗 |
|---|---|---|
| ① | 参考页 = `catalog.json` 的投影（`gen-icon-reference.js --check`） | ✓ |
| ② | 每个 icon key 都在参考页里 | ✓ |
| ③ | SKILL.md 真的指向参考页、且说清用哪个工具读 | ✓ |
| ④ | skill 单一来源 + 打包脚本路径没漂 | ✗ 打包 |
| ⑤ | frontmatter 只用引擎认识的键 | ✗ 元数据 |

④⑤ 都是后来贴上去的：④ 是 2026-07-30 删掉 skill 副本时补的（那次改动**没有同步这个脚本**，
它拿着不存在的路径 `readdirSync` 直接抛异常，把 `npm run verify` 的 `&&` 链后面四个脚本一起
带挂了）；⑤ 是 subagent→skill 那次补的，怕有人照搬 SOUL.md 在 SKILL.md 里写 `tools:`。

两条都属于「跟 skill 有关，但没有别的地方放」，就近塞进了这个脚本。**它事实上已经是 skill 的
体检脚本，只是名字还叫 icon-reference。**

**建议改名 `verify-skill.js`。** 理由不是洁癖：下一个要加「跟 skill 有关」断言的人，按名字
找不到它，多半会再建一个新脚本——那就又是一处「多处各写一份、不同步不会失败」，正是本文档
反复记录的那个失败模式。改动面：文件名 + `package.json` 的 verify 脚本列表 + 本文档第一节
和 12.10 的引用。

（顺带：`KNOWN` 集合是**白名单**，`unknown = keys.filter(k => !KNOWN.has(k))`。所以 v1.5 删掉
`triggers` 时这个脚本一个字都不用改——少写一个已知键，`unknown` 照样是空。）

---

## 十三、下一个大迭代的候选范围（2026-07-31 记录，未开工、未设计）

用户提出把 **bug 与迭代分开**：第十二节里的条目性质混杂，有些是"现在就该修的缺陷"，
有些是"要立项设计的能力"。本节只记录迭代候选，**不做设计、不排期**。

拟定三项（用户原话）：**① 工具支持返回坐标；② 支持折线和环形布局；③ skill 进一步完善，
明确布局、走线、渲染、修改等各种场景如何处理。**

### 13.1 核实到的现状（这决定了它们的真实大小）

| | 现状 | 性质 |
|---|---|---|
| **① 返回坐标** | `layout.nodes[id]` 已有 `cx`/`cy`/`left`/`right`/`top`/`bottom`/`w`/`h`；`zones[].bbox`；`links[].aAnchor`/`bAnchor`。**数据全在，只是没序列化出去** | 小。是 12.8 ②③④ 与 12.9 的共同解 |
| **② a 折线** | 引擎**在**（`geometry-elk.mjs` 走 libavoid `routeEdges`）。是 `cli.js` 的 `OPEN_ROUTINGS = { direct: true }` 把入口关了，原因写在 `CLOSED_ROUTINGS`：多线汇聚同一设备时共线重叠 | **修缺陷 + 重开**，不是从零建。与 12.7（走线按 zone 分层）纠缠 |
| **② b 环形** | `MEASURERS = { row, column }`，需要新增一个 measurer | 最大，且打破四条现有假设 |
| **③ skill 完善** | — | 依赖 ①②落地后产生的新信号 |

### 13.2 环形布局会打破的四条假设

不是"再写一个 measurer"那么简单，`regions.js` 现有词汇是围绕**主轴**建立的：

1. **`tier` 是"主轴上第几格"**——环上没有主轴，tier 该表达什么需要重新定义；
2. **`satelliteOf` 只在 `row` 可用**（`measureColumn` 里遇到直接硬报错），环形同理要么设计
   要么报错；
3. **出线轴 `layeringAxisFor` 只返回 `vertical`/`horizontal`**，环形需要径向；
4. **zone bbox 由成员包围盒派生**，环形的自然包围是外接圆，矩形包围盒会留大片空白。

### 13.3 依赖关系与拆分建议

依赖是 **① → (②a, ②b) → ③**。

③ 排在最后有具体依据，不是排期偏好：本项目反复验证 **agent 只做被信号驱动的事**
（12.9 的实测最直接——方位画错时 geometry 七项全空、DRC 100 分，光补文档没用）。
①②落地会产出新的坐标与信号，③ 要覆盖的"布局/走线/渲染/修改各场景"届时才有东西可依托。

这四块是**四个独立子系统**，建议各自走一遍 spec → plan → 实现，不要合成一份 spec——
合起来会写不清楚，而且 ②b 的设计不确定性会拖住 ① 这种确定性很高的小改动。

### 13.4 待用户决定的问题（未讨论）

- **环形的需求来源**：是已经有真实用户在要（画环网/SDH 环/城域环、被 skill 如实回绝过），
  还是预判？这决定 ②b 要不要放进本轮——它是四块里最大、最打破假设的一块。
- ②a 与 12.7（zone 内直线 / zone 间折线）是不是同一次做。
- ③ 的"修改场景"与已有的 `references/change-recipes.md` 是什么关系（扩写还是重构）。

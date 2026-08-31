# 几何计算前移到 Node + 图纸导出（图片/PDF/Visio）设计

## 背景与定位

两件事合并成一个设计，因为它们是同一个前提的两面：

1. **几何计算前移**——现在布局是在"打开 HTML 的那个浏览器"里算的（`render.js` 把 `topo.js`/`regions.js` 的源代码内嵌进 HTML，浏览器打开时现场跑 `computeLayout()`）。Node 侧只跑一遍布局做校验，算出来的坐标直接丢掉。这导致 **libavoid 的正交走线进不了产出物**——它是 WASM，只能在 Node 跑。而用户提供的两张真实参考图（校园网、VLAN 组网）**都是正交走线**。

2. **图纸导出**——需要导出图片、PDF、Visio(.vsdx)、亿图(.eddx)。

合并的理由：**几何一旦在 Node 侧是纯数据，所有导出格式就都变成"同一份几何数据的不同序列化"**，跟两个布局引擎共用 `regions.js` 是同一个模式。反过来，不做前移就没法做导出。

**位置澄清**（讨论中确认过一次）：这里说的"Node 侧"是**后端**——`provider.py` 用 `asyncio.create_subprocess_exec` 拉起 `node cli.js` 子进程，走 stdin/stdout 收发 JSON。跟 Electron 前端（`frontend-desktop`）无关，拓扑渲染当初就刻意从前端剥离（`serve.js` 头注释：「体外渲染服务，Electron 前端目前没有动态展示能力」）。`config.py`/`paths.py` 里 `IPMC_DRAWING_ENGINE_DIR` 等也都是后端配置项。**本设计不改动这条边界。**

## 前置调研结论（有事实依据，不是推测）

### .vsdx —— 风险已排除

找到 [svgtovisio](https://github.com/McMarius11/svgtovisio)（MIT 许可）：纯 JavaScript、无服务端、无 Java，只依赖 JSZip(MIT) + pako(MIT/Zlib)，产出的 Shape/Connector 在 Microsoft Visio 里**真正可编辑**。它证明了「纯 JS 按 MS-VSDX / Open Packaging Convention 规范生成可编辑 vsdx」这条路走得通，可作为 OOXML 结构的参考实现。

**排除的方案**：[Aspose.Diagram for Node.js](https://products.fileformat.com/diagram/nodejs/aspose-diagram-nodejs-java/) 是「via Java」、需要 JVM，跟本项目「只塞一个 node.exe」的打包方式完全不兼容，且为商业授权。

### .eddx —— 本轮推后（用户决定）

确认 `.eddx` 是 [ZIP 压缩包内含 XML](https://fileinfo.com/extension/eddx)（2013 年 Edraw Max 7.3 起取代 .edx 格式），内部存 shapes/layouts/text/connectors。但：**没有公开规范、没有任何可用的开源库**（[GitHub 上无相关项目](https://github.com/topics/edrawmax)），内部 schema 只能靠逆向真实样本。

用户决定：**先做 vsdx，eddx 推后单独立项**。理由是亿图(EdrawMax)支持打开 Visio 文件并保持可编辑，vsdx 可以先覆盖亿图用户。真要做原生 eddx 时，前置条件是拿到样例 `.eddx` 文件（最好包含：几个设备图形 + 连线 + 一个虚线区域框 + 文字标签）做逆向。

## 方案选择

用户明确要求 Visio/eddx 导出后是**真正可编辑的原生图形对象**（每个设备是独立 Shape、连线是真 Connector，拖动设备时连线跟随），不是矢量图元、更不是包着图片的容器。这个要求直接否掉了纯 SVG 路线。

**方案 A：几何 → N 个独立序列化器。** 每种格式各写一个模块直接从几何生成。vsdx 语义保真最好，但「设备框+图标+文字+图例」的绘制逻辑要在 4 个序列化器里各写一遍——重复且必然不一致（本项目已在这个模式上栽过多次）。

**方案 B：SVG 作唯一中间格式，其余从 SVG 转。** 绘制逻辑零重复，PNG/PDF 几乎白送。**但 vsdx 会丢语义**——SVG 里只剩矩形和折线，生成的 Visio 形状不是"设备"、连线不是"连接器"，拖动设备时连线不跟随。与用户的可编辑性要求直接冲突。

**方案 C：按目的分两条路线（采纳）。**

关键判断：**这几种格式不是一类东西。**

- **视觉快照类（PNG/PDF）**——用户要的是"看起来对"，语义无所谓 → 走 SVG 中间格式，零重复劳动
- **可编辑文档类（vsdx，将来 eddx）**——用户要的是"结构对、能接着改" → 从几何+语义直接生成 Shape/Connector

用同一条路线同时服务这两种目的，必然在某一头妥协：走纯 SVG 就丢 vsdx 语义，走纯直生成就在 PNG/PDF 上白写一堆绘制代码。

## 一、核心架构与分期

### 架构

```
现在:  cli.js render → 把 topo.js + regions.js 源码内嵌进 HTML
                     → 【浏览器打开时现场算布局】→ 用两份拷贝之一的绘制代码画

改后:  cli.js → Node 侧算几何(layout)
              → draw-core.js（唯一一份绘制逻辑）
                   └─ SVG 字符串 ─┬→ HTML（内嵌 SVG + 平移缩放脚本）
                                  ├→ .svg（直接落盘）
                                  ├→ PNG（光栅化）
                                  └→ PDF（转换）
              → export-vsdx.js（旁路，从几何+语义直生成 Shape/Connector）
```

### 概念简化：「引擎」降级为「走线方式」

经过 `regions.js` 重构后，两个布局引擎的**节点坐标已经完全一致**（都委托给 `regions.js`），唯一区别只剩走线：`topo.js` 是端口锚点直线，`geometry-elk.mjs` 是 libavoid 正交折线。所以对外不该再叫"引擎"，就是一个选项：

```
routing: "orthogonal"（默认） | "direct"
```

**默认改为 orthogonal**。依据：用户提供的两张参考图都是正交走线；实测 elk+libavoid 在 29 设备/28 链路的校园网模型上耗时 145ms、**正交率 100%**（74/74 段全部轴对齐）、27/28 条链路带折点。这正是"补走线缺口"的落点。

### 分期（三个独立计划，每期都交付可用的东西）

| 期 | 内容 | 状态 | 交付价值 |
|---|---|---|---|
| **一（地基）** | 几何前移 + `draw-core.js` 抽取 + SVG 导出 + 打包修复 | **✅ 已完成（2026-07-25）** | 正交走线真正进入产出物；消灭绘制代码双份拷贝；HTML 空白类 bug 从根上消失 |
| **二（视觉格式）** | PNG + PDF（都从一期的 SVG 来） | 未开始 | 用户能贴进 PPT/Word、能打印 |
| **三（可编辑格式）** | vsdx（从几何直生成 Shape/Connector） | 未开始 | 用户能在 Visio 里接着改 |

理由：每期产出物独立可用；二、三期的风险不会拖住一期；一期是纯地基改造，风险最低但价值已经很实。

**文档组织**：三期**共用本设计文档**（架构、数据契约、工具契约、打包准则是三期共同的地基，拆成三份 spec 只会重复），但**各自单独出实现计划**。本轮先出一期的计划，二、三期在前一期落地后再出。

#### 一期落地记录（2026-07-25）

实现计划见 `docs/superpowers/plans/2026-07-25-topology-geometry-in-node-phase1.md`，六个任务全部落地。

- **回归**：`drawing-engine && npm run verify` 7 个脚本全绿（新增 `verify-draw-core.js` 进链）。
- **参考图验收**（校园网 29 设备 / 28 链路）：orthogonal 版 28 条 `<polyline>` / 74 段全部轴对齐（**正交率 100%**）、27/28 条带折点；direct 版 0 条 polyline、29 条 `<line>`。两份导出的 `.svg` 单独打开即自包含：无 `var(--…)`、除 `xmlns` 的 w3.org 外零外部 http(s) 引用、20 个 `<image>` 全是 `data:` URI。`cli.js render` 产出的 HTML 内嵌的 SVG 与导出的 `.svg` **逐字节相同**（只差 `id="svg"` 与去掉固定 width/height 这两处已写明的改写）。
- **打包**：`packaging/build_electron.ps1` 里的手工文件白名单（`cli.js`/`topo.js`/`drc.js` 三件套）已废除，改为整目录拷贝 + 排除开发产物 + 带 `node_modules`；冒烟从只跑 `observe` 扩到 `observe` + `render --routing=direct` + `export --format=svg` + `render --routing=orthogonal`（最后一条专门证明 `node_modules` 真进了包）。
- **破坏性验证**（证明"漏文件会在构建期暴露"这个目标真的达成）：把打好的包里 `regions.js` 改名 → 冒烟第一条 `observe` 即失败，构建退出码 1，日志直接给出 `MODULE_NOT_FOUND: Cannot find module './regions.js'`；恢复后重跑 → 退出码 0。另测把包里 `node_modules` 改名 → 前三条冒烟照样通过、**只有** `render --routing=orthogonal` 失败（`Cannot find package '@mr_mint/elkjs-libavoid'`），退出码 1；恢复后通过。这条也反过来说明：冒烟里那条 orthogonal 是不可省的。
- 顺带修掉两个打包脚本的既有缺陷：(1) `topology-icons/` 原先排在拓扑块**之后**，而 `icons.js` 要读 `../topology-icons/catalog.json`，冒烟必然 ENOENT——已把图标块提前；(2) 冒烟原用 PowerShell 管道喂 stdin，PS 5.1 在 UTF-8 代码页下会写入 BOM，`JSON.parse` 直接失败——已改成临时文件 + `Start-Process` 重定向。

## 二、数据契约与 draw-core 抽取

### 不发明新数据结构

`computeLayout()` / `computeElkLayout()` 的返回值本身就是几何契约（`nodes`/`links`/`zones`/`bbox`/`legend`），加上 `model`（提供 `encoding` 样式表）和 `icons`（`resolveIconsForModel()` 已解析成 base64 data URI）就够了。新造一个 `geometry` schema 是没必要的抽象。

```js
// draw-core.js —— 纯函数，只在 Node 跑
buildSVG(model, layout, icons) → "<svg …>…</svg>"   // 自包含，可直接落盘当 .svg
```

图标已经是 base64 data URI（`icons.js:24`），所以导出的 SVG **天然自包含**，不依赖任何外部文件。

### 浏览器彻底不再绘制

既然 SVG 在 Node 就拼好了，HTML 里不需要任何绘制代码：

```
HTML = 内嵌的 SVG 字符串 + 平移缩放脚本（约 30 行，纯 viewBox 操作）
```

现有 HTML 的全部交互（滚轮缩放、拖拽平移、适应窗口、缩放百分比显示）都是 viewBox 操作，**没有一项需要模型或绘制代码**。

由此得到的结构性收益：

- 绘制逻辑从**三处**（`render.js` 内嵌字符串、`index.html`、将来的 SVG 导出）收敛成**一处**
- HTML 里的 SVG 和导出的 `.svg` **是同一串字节**——不可能不一致
- 「`regions.js` 没内嵌导致整页空白」那类 bug 从结构上不可能再发生（浏览器不跑任何布局/绘制代码）
- `index.html`（开发预览）改成从 `serve.js` 取渲染好的 SVG 注入，引擎切换按钮变成 `routing` 参数切换，行为不变

**HTML 仍内嵌源 model**（`window.TOPO`），但只作溯源用、不参与渲染——保持一份 HTML 自描述、能看出由哪份模型生成。

### 现存缺陷（本设计顺带修掉）

核实确认：`drawZones`/`drawEdges`/`drawNodes`/`drawPorts`/`drawLegend` 在 `render.js`（内嵌字符串）和 `index.html` 里**各有一份拷贝**。若不做抽取，加 SVG 导出就会变成三份——与本项目已多次发生的「多处各写一份然后悄悄不同步」是同一类问题。

## 三、工具契约与打包

### 新增 `export_diagram` 工具

```
export_diagram(topology_json, format, output_path, routing?) → {path, bytes, format}
   format  ∈ {svg, png, pdf, vsdx}
   routing ∈ {orthogonal(默认), direct}
```

**`side_effects=True`**（现有工具都是 `False`）。**二进制内容绝不回传**，只回路径和字节数。

理由：现有桥接是 JSON 走 stdout，`render_html` 把 HTML 内容塞进 `payload={"content": …}` 返回给 agent。PNG/PDF/vsdx 是二进制，塞不进 JSON；base64 编码后几百 KB 的文件会变成几十万 token 流经 agent 上下文，是灾难。所以必须由 Node 直接写盘。

`render_html` **对外契约不变**（HTML 是文本，返回内容没问题，现有 SOUL.md 说明与 Python 测试都依赖它），但内部改走同一条新管线，不再存在第二套渲染代码。

### 打包：改掉「手工维护文件白名单」这个做法本身

**现存 bug**：`build_electron.ps1:150` 硬编码 `@("cli.js", "topo.js", "drc.js")` 三个文件，注释写着「cli.js 零 npm 依赖（只 require 同目录的 topo.js/drc.js），不用带 node_modules」。这句话**已经不成立**：`cli.js` 实际 require 了 5 个文件（多出 `render.js`/`icons.js`/`geometry-report.js`），`topo.js` 还 require 了 `regions.js`。当前打出来的包一跑就会 MODULE_NOT_FOUND（构建脚本里的 `observe` 冒烟测试应当会失败）。

**这跟 memory 里记的 `project_topology_field_whitelist_pitfall`（手写节点字段白名单悄悄漏掉新字段）是同一类 bug**，只是换了个地方。本项目已在这个模式上栽过至少四次：iconTheme 字段白名单、图例字段白名单、两引擎各自手写 cfg 字面量、现在的打包文件清单。

所以修法不是「把清单从 3 个补到 6 个」，而是：

- **拷贝整个 `drawing-engine/` 目录**（排除 `verify-*.js` 与 `*.topo.json`/`*.html` 等样例产物），清单不再手工维护，新增文件自动进包
- **开始携带 `node_modules`**——elk + libavoid 已成必需（正交走线），后续再加 zip / 光栅化库。原有「零 npm 依赖、只塞一个 node.exe」的原则到此为止，这是本设计明确打破的约束。带的是生产依赖（`npm ci --omit=dev` 的结果；当前 `package.json` 没有 devDependencies，现状即全部为生产依赖，约 9.3MB）
- **冒烟测试加强**：现在只跑 `observe`，改成 `observe` + 每种 `export` 各跑一遍，任何一个挂了就构建失败——让「漏文件/漏依赖」必然在构建期暴露，而不是到用户手上才 MODULE_NOT_FOUND

### 依赖选型准则（约束后续所有格式）

**只接受纯 JS 或纯 WASM 依赖，不引入平台相关的原生二进制（`.node` 绑定）。**

理由：打包只塞一个 `node.exe`，原生绑定需要按平台分发，会把打包复杂度抬高一个量级。现有的 libavoid 已经是 WASM，与此准则一致。

这条准则直接排除：`sharp`（libvips）、`canvas`、`@resvg/resvg-js`（原生绑定版）、Aspose（需 JVM）。

## 四、各格式实现路径与验收

| 格式 | 路径 | 依赖 | 风险 |
|---|---|---|---|
| **SVG** | `draw-core.js` 直接产出 | 零新增 | 无 |
| **PNG** | 光栅化 SVG | 待选型（准则：纯 WASM），候选 `@resvg/resvg-wasm` | 嵌套 SVG 图标能否正确光栅化；**是否支持 `<defs>`/`<use>`**（见下方图标去重） |
| **PDF** | SVG → PDF | 待选型（纯 JS） | 同上 + 中文字体嵌入 |
| **VSDX** | 从几何+语义直生成 | `jszip` / `fflate`（纯 JS） | 坐标系换算；可编辑性只能人工验收 |

### 二期选型必须一并决定：图标去重（`<defs>`/`<use>`）

一期落地后实测：**SVG 里约 65% 的体积是重复的图标 base64**（16 设备样例图 98KB，其中 64KB 冗余——6 个不同图标被逐处内联成 20 份）。原因是几何前移后，图标 data URI 从浏览器端共享的 `window.ICONS` 映射变成了 SVG 里每处 `<image>` 各带一份完整拷贝。

**一期刻意不改**，理由有二：(1) `draw-core.js` 是从浏览器脚本逐字面量核验过的忠实移植，改变发射策略会作废这个已验证属性，需要重新做视觉等价验证；(2) `<use>`/`<symbol>` 的光栅化器兼容性必须跟二期的 PNG/PDF 选型一起定——选一个不支持 `<use>` 的光栅化器再回头改会更糟。

**二期选型时把「是否支持 `<defs>`/`<use>`/`<symbol>`」列为硬性筛选条件**，选定后同批改造 `draw-core.js`，并补一条"改造前后视觉等价"的验证。预期收益：SVG/PNG/PDF 体积降到约三分之一。

### vsdx 具体映射

- 每台设备 → 一个 `Shape`（矩形 + 图标 + 文字）
- 每条链路 → 一个 Connector Shape，用 `<Connect>` 元素**绑定两端设备 Shape**——这是「拖动设备时连线跟随」的关键，也是与 SVG 路线的本质区别
- 每个 zone → 一个虚线矩形 Shape，置于底层
- 图例 → 一组 Shape

**必须处理的坐标系差异**：Visio 使用**英寸、Y 轴向上**，我们使用**像素、Y 轴向下**。需要统一的单位换算 + Y 翻转，页面尺寸由 `bbox` 推导。这一步做错整张图会上下颠倒，必须有测试钉住。

### 验收策略

- **SVG**：结构断言（元素数量、bbox 正确、**自包含无外部引用**）
- **PNG/PDF**：校验文件头与尺寸；**图标是否正确渲染必须人眼核验**——这是上表列的「嵌套 SVG」风险，自动化测不出来
- **VSDX**：解压验证 XML 结构可以自动化；但**「在 Visio 里真的可编辑、拖动设备时连线跟随」只能人工验收**。这一条明确需要用户（或有 Visio 环境的人）在三期收尾时实际打开确认，不得以自动化测试冒充
- 现有 6 个 verify 脚本继续全绿

## 待办（用两张真实参考图验证后记录，2026-07-25）

用用户提供的校园网参考图（核心居中、汇聚四面辐射、正交走线）逐版逼近，记录如下。**先做了一轮自我纠错**：最初把差距全归给"引擎只有 tier 树"，是判断下早了——实测发现主要差距来自建模用错，而不是引擎能力：

| 版本 | 宽高比 | 说明 |
|---|---|---|
| v1 | 2.27:1 | 出口链建成 4 层纵向堆叠（原图是横向）；15 个楼栋平铺一行 |
| v2 | 4.27:1 | 修了出口链方向（`satelliteOf` 链式旁挂），但楼栋仍平铺，更扁 |
| v3 | 2.90:1 | 每分支做成 `column` zone，但 **tier 语义用反**（见下），汇聚与楼栋并排成两列 |
| **v4** | **1.52:1** | 同 tier + 声明顺序定上下，每分支成一根窄竖柱。**整图从 1640 宽收到 959 宽** |

（原图约 1.3:1。v4 已相当接近：核心在上、出口链横向右延、8 个分支各成紧凑竖柱、走线 100% 正交。）

### 1. `satelliteOf` 无法指定方向（小缺口，好补）

`regions.js` 的 `measureRow` 里 `const outward = anchorCx >= 0 ? 1 : -1;`——贴靠方向完全由锚点的 `cx` 符号决定。**锚点落在 x=0 时永远往右**，作者无法让某个元素挂到左侧。参考图里核心两侧都挂着东西，我们只能挂一侧。

建议：加 `satelliteSide: "left" | "right"` 作者化字段，不声明时沿用现有的按符号自动判定。

### 2. SOUL.md 对 `column` 的 tier 语义说明不足（措辞问题，非代码）

现在只写「`layout`（`row` 行铺 / `column` 竖排）」「`tier` 决定这个 zone 整体在父容器里排第几行/列」，**没说清 zone 内部**：在 `column` 布局里，成员的 `tier` 决定的是**第几列**，只有**同 tier** 的成员才纵向堆叠、顺序由声明顺序决定。

这一点实测极易用反（本轮 v3 就是这么错的：给汇聚 tier 0、楼栋 tier 1，期望"上下堆叠"，实际得到"并排两列"，zone 宽度从 72 涨到 200）。**agent 大概率会犯同样的错**，且错了以后图还能正常渲染、DRC 满分，只是形态不对——属于沉默失败，必须靠文档挡住。

建议：SOUL.md 补一句明确说明 + 一个"竖排一列"的正确写法示例。

### 4. 几何检查缺"端口方位自洽性"（沉默失败的共性对策）

2026-07-25 这一轮连续出现三个**沉默失败**——图能正常渲染、DRC 满分、`geometry` 的重叠/越界/净空全部为零，所有自动化信号都是绿的，只有人眼看图才发现不对：

1. `column` 布局里 `tier` 语义用反 → 期望竖排却得到并排两列（zone 宽度 72→200）
2. `sideToward()` 跨 zone 比较 `tier` 字段 → 端口挂错边，线从设备顶部绕出来造成交叉
3. `routing` 只是工具参数、存不住 → 用户的选择重新渲染就丢

其中第 2 类**是可以自动检测的**：对每条链路，比较锚点所在边的法线方向与该链路实际走向的夹角——正常情况下端口应该朝向对端（夹角 < 90°）；如果端口在顶边而对端在下方，夹角就会大于 90°，说明线是绕出来的。

建议给 `geometry-report.js` 加一项 `portDirectionAnomalies`：列出"锚点法线与实际走向背离"的链路。跟现有几项一样属于**测量不是规则**（不进 DRC 分数）——`position` 钉住等场景下可能是作者故意的。

价值不只在于这一个 bug：它把"端口判边"这类几何自洽性纳入 agent 能看见的范围，不必依赖人眼复核。

### 3b. 打包脚本把拓扑引擎耦合进了 `-SkipBackend`（小缺口，影响迭代效率）

`build_electron.ps1` 的 `if (-not $SkipBackend)` 块（第 54 行起）一直包到拓扑引擎复制那段，所以 `-SkipBackend` 会**连带跳过拓扑引擎和图标库的复制**。但拓扑引擎跟 PyInstaller 没有任何依赖关系——只改了 `drawing-engine/` 里的 JS 时，本来只需要重新复制目录 + 跑冒烟，却被迫全量重打（前端 npm build + PyInstaller + Python runtime，十几分钟）。

实测踩到过一次：改完 `draw-core.js` 用 `-SkipFrontend -SkipBackend` 重打，产物里还是旧引擎，验证白跑。

建议：把拓扑引擎/图标库那两块移出 `-SkipBackend` 的作用域，或加一个 `-OnlyTopology` 开关。注意**不能简单地让它们无条件执行**——`Write-Err` 的前置检查依赖 `$DistDir` 已存在，要一并处理。

### 3. 径向/环绕布局（大缺口，需单独决策）

父节点的孩子只能排成一行（`row`）或一列（`column`），**无法围绕父节点分布在二维四周**。这是"核心居中、汇聚四面辐射"这类 hub-and-spoke 图还原不了的根本原因，也是 v4 与原图剩余差距的全部来源。

属于布局层的新能力（`layout: "radial"` 之类），工作量与价值都需要单独评估，不在当前三期计划内。

## 打包产物端到端验证记录（2026-07-27）

打出安装包后实际启动应用验证，记录三件事：

### 已发布的安装版拓扑功能是坏的（本轮修复的现实影响）

对比 `%LOCALAPPDATA%\Programs\ipmaster-cowork` 的已安装版与新构建：

| | `resources/drawing-engine/` 内容 |
|---|---|
| 已安装版 | 只有 `cli.js` / `drc.js` / `topo.js` |
| 新构建 | 11 个 js/mjs + `node_modules`(9.2MB) |

已安装版正是硬编码 3 文件白名单打出来的——`cli.js` 实际 require 的 `render.js`/`icons.js`/`geometry-report.js` 和 `topo.js` require 的 `regions.js` 全都不在包里，一调用必然 MODULE_NOT_FOUND。**这条印证了打包白名单不是理论隐患，是已经发出去的实际缺陷。**

### 调试路径：绕过 Electron 直连后端，登录门天然跳过

`frontend-desktop/src/App.tsx` 的 `AuthGate` 本来就留了旁路：

```tsx
const hasElectron = !!window.electronAPI?.getSession
if (!hasElectron) { setUser(null); return }   // 浏览器调试：跳过
if (hasElectron && user === null) return <LoginGate .../>
```

所以**无需修改任何代码即可在无登录环境的机器上调试**：直接跑打包出的后端 exe（`resources/backend/ipmaster-cowork.exe serve`），浏览器打开它日志里打印的端口即可。后端自带前端 dist（PyInstaller 内嵌），UI 完整可用。

代价：原生目录选择框同样依赖 `electronAPI`，浏览器模式下点击无反应，**新建会话要走 REST API**：

```
POST /api/v1/sessions   {"working_directory": "...", "user_prompt": "..."}
```

（`working_directory` 用正斜杠，反斜杠会被 JSON 解析拒绝。）建出来的会话在 UI 里正常显示。

### 打包产物不含 LLM 账号，开箱跑不了 agent

构建脚本注释写明"resources 取自 `packaging/default_data`，未包含个人密钥"，实测确认：会话创建后立刻 `Failed`，后端日志 `RuntimeError: No LLM accounts registered`。这跟登录是**两个独立的前置条件**——跳过登录门不等于能跑 agent。在干净机器上做端到端验证时两者都要单独准备。

## 明确不做（本轮范围外）

- **`.eddx` 原生导出**——推后单独立项，前置条件是拿到样例文件做逆向（见「前置调研结论」）
- **④/⑤ 输出持久化**——继续搁置，理由见 `2026-07-24` 设计文档
- **浏览器端交互编辑**——HTML 只保留平移缩放，不做拖拽编辑
- **`meta.layoutDirection` 恢复**（BT/LR/RL，已单独记录为 TB-only）
- **交叉最小化排序**——独立线，memory `project_alignment_gap` 继续跟踪

## 验收基准

1. ✅ 一期：`cli.js render` 产出的 HTML 里**不含** `topo.js`/`regions.js` 源码，含预渲染 SVG；浏览器打开正常显示、平移缩放可用
2. ✅ 一期：`draw-core.js` 是绘制逻辑的**唯一**副本（`render.js`/`index.html` 内不再有 `drawNodes` 等函数定义）
3. ✅ 一期：默认 `routing: orthogonal`，用校园网参考模型验证正交率 100%（实测 74/74 段轴对齐）
4. ✅ 一期：打包冒烟测试覆盖 `observe` + `render`（direct 与 orthogonal 各一次）+ `export`，故意删掉一个源文件确实导致构建失败（见上文「一期落地记录」的破坏性验证）
5. 二期：PNG/PDF 在真实参考图上**图标正确渲染**（人眼核验）
6. 三期：生成的 `.vsdx` 在 Microsoft Visio 中打开，**拖动设备时连线跟随**（人工验收）
7. ✅ 全程：verify 脚本保持全绿（一期后为 7 个，新增 `verify-draw-core.js`）

# 拓扑绘图：对 agent 开放的能力面

> 2026-07-30。本文回答一个具体问题：**画一张拓扑图时，agent 能控制什么、不能控制什么。**
> 「不能控制什么」和「能控制什么」同样重要——不写清楚，agent 会去猜，而猜出来的字段
> 引擎不认、又不报错，就是本项目反复出现的那类沉默失败。

## 0. 一条贯穿的原则

**能算的进 tool，要判断的进 skill。** 落到这份能力面上：

- 引擎**不**开放「让图好看」的旋钮（自动排版、自动配色、自动分配端口位置都在引擎里）；
- 引擎开放的是**作者的意图**——那些没有唯一正确答案、必须由人或 agent 决定的东西：
  谁跟谁连、谁属于哪个区域、哪条链路更重要、这张图给谁看。

一个字段该不该开放，判据是：**它是不是一个没有正确答案的选择。** 是，就开放；
不是（比如"两条线不该重叠"），那是引擎该自己算对的事，开放它等于把责任推给调用方。

## 1. 三个入口

| 入口 | 作用域 | 谁写 |
|---|---|---|
| 工具参数 | 单次调用 | agent 调用工具时 |
| `meta.*` | 整张图 | 写进模型，**跟着模型走** |
| `encoding.*` / `devices` / `links` / `zones` | 每个条目 | 写进模型 |

`meta.*` 与工具参数的区别很关键：**工具参数只活在那一次调用里**。用户说"这张图用直线"，
写进 `meta.routing` 才能下次重新渲染时还在；只传 `routing="direct"` 的话，下次不带参数就
退回默认值了。引擎会在这种不一致时返回 `ROUTING_NOT_PERSISTED` 警告——真实 agent 踩过一次。

## 2. 工具参数

### `draw_topology`

| 参数 | 取值 | 说明 |
|---|---|---|
| `preview_path` | 绝对路径 `.html` | 必填。相对路径会写进引擎安装目录 |
| `topology_json` | 模型字典 | 与 `model_path` **二选一** |
| `model_path` | 绝对路径 `.topo.json` | 与 `topology_json` 二选一。设备多时用它 |
| `routing` | `direct` | 仅此一个值 |

### `export_diagram`

| 参数 | 取值 |
|---|---|
| `output_path` | 绝对路径 |
| `topology_json` / `model_path` | 二选一，同上 |
| `format` | `svg` / `vsdx` / `pptx` |
| `routing` | `direct` |

两个模型入口**必须且只能给一个**。同时给会有一个被静默忽略，而调用方无法从结果看出用的是
哪份——这类错查起来极费劲，所以直接报 `BAD_ARGS`。

`model_path` 解决的是**硬约束**：模型作为工具参数时必须由 LLM 逐字生成，受单次输出 token
上限约束。几十台设备展开成 JSON 就上万 token，而生成它的脚本可能只有几十行。

## 3. `meta.*`：整张图的作者化开关

| 键 | 类型 | 缺省 | 作用 |
|---|---|---|---|
| `routing` | `"direct"` | `"direct"` | 走线方式 |
| `rowGap` | 数 | 78 | 相邻行边缘之间的**净空距** |
| `hGap` | 数 | 46 | 同一行内相邻元素的水平净空 |
| `zonePad` | 数 | 18 | zone 虚框相对成员包围盒的外扩 |
| `shapeBuffer` | 数 | 12 | 正交走线绕行时与无关设备的最小间距（仅 `orthogonal` 生效） |
| `zoneCorner` | `"square"` / `"round"` | `"square"` | zone 边框圆角 |
| `showPorts` | 布尔 | `true` | 是否画端口小圆 |
| `strokeScale` | 正数 | 0.6 | 全局线宽系数 |
| `legendIconSize` | 数 | 12 | 图例图示的高度。图示按各自长宽比填满该高度（大小整齐），预留框按最宽的图标算（文字左缘对齐）；行高与文字位置跟着派生 |
| `showLegend` | 布尔 | `true` | `false` 时整个图例区域不存在（不是"算了但不画"，bbox 也不含它） |
| `legendPosition` | `left`/`right`/`top`/`bottom` | — | 图例摆放。左右走竖列排布，上下走横向流式换行，是两套算法 |
| `legendGroups` | 数组 | — | 图例只列出指定的编码表 |

注意 `rowGap`/`hGap` 是**净空距不是中心距**：行内内容多高都吃不掉这个留白。旧的中心距语义
会让高内容吃穿留白直到重叠，参考图重画时的「计算区域/存储区域框重叠 -8px」就是那个根因。

`showPorts` **只影响 SVG/HTML**。vsdx/pptx 本来就不画端口标记——它们在 SVG 里是装饰，
进不了「可编辑」的语义。

`strokeScale` 存在的原因：SVG 用 `vector-effect="non-scaling-stroke"`，线宽永远是**屏幕
像素**、不随图缩放；vsdx/pptx 是绝对单位，把同一个数如实换算过去就显粗。0.6 是照
「pptx 里看着跟 SVG 差不多」定的经验值。

## 4. 编码表：每类条目的视觉表达

四张表都支持 `legend`（图例文案，**必填**，DRC 会查）。样式字段不写就自动分配。

### `encoding.deviceRoles`

| 字段 | 说明 |
|---|---|
| `w` / `h` | 方框尺寸。设了 `icon` 时 `w` 会按图标长宽比自动覆盖 |
| `fill` / `stroke` | 颜色，不写自动分配 |
| `icon` | 图标 key，见图标参考页 |
| `glyph` | `cloud` / `ellipsis` 等内置图形 |
| `decorative` | 真则不是网络实体（如 `…` 省略标记），DRC 命名规则、导出形状都跳过它 |

### `encoding.linkTypes`
`stroke`、`width`（线宽，px）、`dash`、`bundle`（>1 画成双线）

### `encoding.connTypes`
`fill`、`shape`（`circle` / `square`）

### `encoding.zoneTypes`
`fill`、`stroke`

**颜色是自动的**：不写 `fill`/`stroke` 时按**声明顺序**轮转分配，撞了顺延。
早先是哈希取模，**会撞**——真实 agent 画的第一张图里接入交换机和 PC 拿到了一模一样的颜色。
代价是同一个角色在不同图里可能拿到不同颜色（取决于它在编码表里的位置），但图例跟着图走，
同一张图内稳定就够了。撞色撞满时 `style` 报告里的 `roleColorCollisions` 会说出来。

## 5. 结构与位置

### `devices[]`
`id`、`role`、`label`、`tier`（第几层，**纯序数**，数值间隔不产生空间效果）、
`satelliteOf`（旁挂到某个锚点的外侧）、`satelliteGap`、`iconTheme`（`yellow` 用黄色变体）

**更正（2026-07-30）**：本文最初把 `position` 也列在这里，**是错的**。`regions.js` 的 `place()` 里
覆盖分支的条件是 `if (c.zone && c.zone.position)`——**只有 zone 节点能用 `position`**，
写在设备上会被**静默忽略**。当时是按 `zones[]` 的行为想当然了，没有核对代码。

### `links[]`
`a`、`b`、`type`、`aConn` / `bConn`（两端的接口类型，引用 `connTypes`）

### `zones[]`
`id`、`type`、`label`、`members`（成员可以是设备 id 也可以是另一个 zone 的 id）、`tier`、
`layout`（`row` / `column`）、`rowGap` / `hGap` / `satelliteGap`（只作用于本 zone 这一层，
**不向子 zone 继承**）、`position`

zone 最多嵌套 **L1/L2** 两层（L0 是隐式的整图根区域）。超过是入口门禁硬错误。
per-zone 的间距覆盖不继承是刻意的：继承链让「这个数从哪来的」变得难回答。

### 方向不是被声明的，是 `layout` × `tier` 分布算出来的

**没有任何字段的含义是「这几个东西上下排」。** 方向由两件事共同决定：`layout` 给出主轴方向
（`row` 主轴纵向，tier=第几行；`column` 主轴横向，tier=第几列），`tier` 的**分布**决定摆成几排。
同一个 `layout` 下，成员 tier 全相同和各不相同，出来的方向正好相反。

三条必须记住的后果（2026-07-30 实测，详见设计文档 12.9）：

| 写法 | 实际效果 |
|---|---|
| 顶层 zone **不写 `tier`** | 全部兜底成 tier 0，隐式根区域固定 `row` → **所有顶层 zone 挤在同一行、左右并排** |
| zone 内设备**不写 `tier`** | 同上 → 该 zone 内全部并排一行 |
| `layout:"column"` + 成员**不同 `tier`** | tier 是「第几列」→ 分出左右多列（想上下堆叠就要**同一个 tier**，上下顺序靠声明顺序） |

要「一个 DC 在上、两个在下」就得显式给顶层 zone 写 `tier`（上=0，下面两个都=1）；
要「服务器在上、防火墙在下」就得给设备写不同的 `tier`。**前两条画错时七项 geometry 全空、
DRC score=100——没有任何信号**，这是 12.9 记录的主要缺陷。

## 6. **不**开放的，以及为什么

| | 为什么不开放 |
|---|---|
| **字号** | 它由设备高派生，而布局给标签留的位置（`footprintWidth` / `labelExtentBelow`）正是按它算的。开放字号就得让布局跟着字号走——那是 2026-07-30 连修两处（标签伸出 zone、zone 边框压住文字）的地方，不值得为一个选项再引一次风险。字族将来可以单独开（不影响尺寸）。 |
| **端口的具体位置** | 端口是布局时沿设备边均匀派生的锚点，没有 id、不能被引用。它是几何结果，不是作者决定。 |
| **连线的具体走法** | 同上。走线由引擎算，作者只能选*方式*（`meta.routing`）。 |
| **zone 的具体坐标** | 由成员包围盒派生。要挪就挪成员（zone 自己可用 `position` 覆盖，设备不行）。 |
| **图例的内部排布** | 位置、显隐、列哪几组、图示大小都可选（`legendPosition`/`showLegend`/`legendGroups`/`legendIconSize`），但条目怎么换行、每行放几个由引擎算。 |

## 7. 当前**不支持**的表达（会明确报错，不静默降级）

| | 状态 |
|---|---|
| 走线 `orthogonal`（正交折线） | 引擎在，但多线汇聚同一设备时会共线重叠，暂不开放。传了报 `BAD_ARGS` |
| 布局 `ring` / `radial`（环形、放射） | 表达不了。**不要用 `row`/`column` 硬凑近似形状**，如实告诉用户这是模型的表达力缺口 |
| 整图方向 `meta.layoutDirection` | **名存实亡**：引擎从来不读它，写了不生效也不报错。两个随包样例的 `meta` 里都留着 `"layoutDirection": "TB"`，容易让人以为它有用——**不要写它**。整图固定自上而下；要横向排布只能靠 `layout: "column"`（见 §5 与设计文档 12.9）|
| 导出 `png` / `pdf` | 未实现，报 `UNSUPPORTED_FORMAT` |
| pptx 的图例 | 不含。导出时返回 `PPTX_LEGEND_OMITTED` 警告 |
| pptx 的端口精度 | 连线粘在设备**边中点**，同一条边上的多条线会汇到一点，不像 SVG 沿边散开 |
| vsdx 的端口 | 只是画上去的标记，不能作为连线的粘连目标（连接点粘连在 EdrawMax 实测不可用） |

「明确报错而不是静默降级」是这一栏的重点。静默降级会让 agent 以为自己声明的东西生效了，
而实际没有——`layout: "ring"` 如果被默默当成 `row` 处理，画出来的图和作者的意图就南辕北辙，
而没有任何信号说这件事发生过。

## 8. 反馈信号：agent 怎么知道自己画得对不对

`draw_topology` 每次返回三份东西，**都只报事实、不下结论**：

- `findings` + `score`：DRC，查**图纸规范性**（编码表/图例完整性、id/label 命名）。
  它**不是**网络工程设计质量评分，不检查 HA/冗余/单点故障——那是 agent 自己对照用户需求
  做的语义判断。
- `geometry`：几何测量。zone 重叠、包含关系违规、行净空、旁挂溢出、连线穿越设备、
  同列扇出、**标签伸出 zone**。
- `style`：图示体检。缺图标的角色、渲染不出来的 glyph、不存在的 icon key、角色撞色。

这三份的共同点：**给出可量化的事实，判断留给 skill**。「两条线重叠了 275px」是事实；
「这张图能不能接受」是判断。

设计文档反复验证过一件事：**agent 只做被信号驱动的事**。文档里写"记得配图标"没有用，
`style` 报告里出现 `rolesWithoutIcon` 才有用。

## 9. 相关文档

- `2026-07-28-topology-skill-and-tool-boundary-design.md` —— 工具/技能边界、工具收敛、
  vsdx 粘连调研、待办清单（第十二节）
- `2026-07-25-topology-geometry-in-node-and-export-design.md` —— 几何前移到 Node、导出设计
- `2026-07-24-topology-layout-vocabulary-and-geometry-observe-design.md` —— 净空距语义、几何测量
- `2026-07-10-topology-recursive-region-layout-design.md` —— zone 递归布局

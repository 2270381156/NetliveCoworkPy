# 区域（zone）递归布局设计

## 背景

用一张贴近真实场景的数据中心安全域组网图（出口链路4级HA纵向串联、一个旁路的网络安全区、核心到多组接入交换机的小网状、接入交换机到计算区域十台设备的密集网状、存储区域）压力测试当前布局算法（`topo.js` 手写档 + `geometry-elk.mjs` 的 elk+libavoid 档），实测发现两类问题：

1. **对称居中布局不知道"谁该跟谁对齐"**：`computeLayout()` 里"1) 分带放置"只按 `devices` 数组声明顺序把同 tier 设备摆一排、整体居中，不会根据跨层连接关系优化左右次序以减少交叉。这不是走线引擎的问题——libavoid/elk 的绕线阶段只优化"线怎么绕开障碍物"，不会重新排列节点左右顺序，换引擎解决不了。呼应既有设计文档（`2026-07-08-topology-layered-authoring-model-design.md`）开放问题1"④层对齐提示字段的具体形状"和 memory `project_alignment_gap.md`。
2. **zone 从来不参与布局**：`computeLayout()` 第4步明确写着"纯派生——扫描 zone 成员的实际坐标，圈出边框，不作者化任何坐标"；`geometry-elk.mjs` 更彻底，`toElkGraph()` 把设备打平成一层，连 zone 的 bbox 都不算，elk 档现在根本不画 zone。嵌套 zone（压力测试里"计算区域"包5个两两一组的子分组）几何上算得对，但 `drawZones` 按 `zones` 数组声明顺序画——父 zone 声明在子 zone 后面时会整个盖住子 zone，没有任何报错提示这个顺序要求（已用实验验证：把外层 zone 的绘制顺序挪到最前，子框立刻全部显形）。

本次讨论聚焦第2类问题：让 zone 从"事后包围盒"升级成能真正表达复杂网络结构的布局单元。第1类问题（跨区域连线交叉最小化排序）明确不在这次范围内，见下面"范围边界"一节。

## 核心结论：zone 是一个统一、可递归嵌套的容器概念

现有的 `zones`、`haPair`、"整张图"这三个东西，其实是同一个概念在不同粒度上的实例：

- **`haPair`（一对设备贴在一起）现在完全没有结构支撑**：`grep haPair` 在 `topo.js`/`render.js`/`drc.js`/`geometry-elk.mjs` 里零命中——两台 HA 设备"贴在一起"纯粹是因为它们在 `devices` 数组里写得相邻、单层居中算法把它们摆一排；只要中间插进第三方设备或者数组顺序打乱，"贴在一起"就会散架，代码不报错也不纠正。
- **`zones`（现在唯一带可见边框的分组）**：纯派生包围盒，不参与布局。
- **整张图本身**：也是一个容器，只是没人把它当成"zone"看待。

统一之后：**zone 可以嵌套，可以有可见边框也可以没有**，`haPair` 的"贴在一起"不再侥幸依赖数组顺序，而是把这两台设备放进一个共享同一个 `tier`、不带可见边框的 zone 来真正保证相邻。

## Schema

沿用现有 `zones` 扁平数组（不改成深层嵌套 JSON），放开 `members` 的引用范围——成员可以是设备 id，也可以是另一个 zone 的 id：

```jsonc
zones: [
  {
    id: "ZONE_STORAGE", type: "storage", label: "存储区域",
    members: ["ZONE_FCSW", "ZONE_DSW"],   // 成员是两个子 zone 的 id（嵌套）
    layout: "row"                          // 测量阶段用哪条内部排布规则，默认 "row"
  },
  {
    id: "ZONE_FCSW", type: "storageSub", label: "FC交换机",
    members: ["FCSW1", "FCSW2"],
    layout: "row"
  },
  {
    id: "ZONE_SEC", type: "security", label: "网络安全区",
    members: ["DBAUDIT", "IDS", "WAF", "SECGW1", "SECGW2"],
    layout: "row",
    satelliteOf: "CORE1"    // 整个区域旁挂在某个兄弟（设备或区域）外侧，不参与父级居中
  }
]
```

新增/复用的字段：

- `layout: "row" | "column" | "ring" | "legend"`（可选，默认 `"row"`）—— 测量阶段用哪条内部排布规则。
- `tier: <number>`（可选）—— 这个 zone 作为一个整体，在**父级**的 row/column 排布里占第几位。跟 `device.tier` 是同一套语义、同一个比较范围规则：`tier` 依然是设备/zone 上的普通数值字段，不做"局部编号"之类的特殊化——排布时只是**只拿同一个父级下的直接孩子互相比较**，取值范围天然被父级限定，不需要改字段本身的存储或语义。设备从一个 zone 挪到另一个 zone，只是改它的 `zone` 归属，`tier` 数值不需要跟着重新编号。
- `satelliteOf: <sibling id>`（可选）—— 复用现有 `device.satelliteOf` 机制，放开给 zone 也能用：整个区域旁挂在父级里的某个兄弟（设备或区域）外侧，不参与父级的居中计算。
- `position: { dx, dy }`（可选）—— 显式钉住：有这个字段时，落位阶段跳过规则算出来的偏移量，直接用这个值（相对父级局部坐标系），只影响这一个孩子，不影响兄弟。

`haPair` 字段保留（两台设备间那条 HA 虚线的语义标注不变），但"贴在一起"这件事的支撑改为：把这两台设备放进一个共享同一个 `tier`、`type` 可以不声明可见样式（`stroke:"none"`）的 zone。

## 算法：测量（自底向上）+ 落位（自顶向下）

选择两段式而不是单一遍历，是因为我们的画布是**无限画布**——`bbox`/`viewBox` 是算完之后包出来的，不存在"父级先给定固定空间、子级必须收缩去适应"的强约束场景，所以不需要 top-down 强约束传递那一套；而"子级先测出自己实际需要多大空间，父级再据此摆放"，直接对应这个项目里已经在用的先例——`deriveLegend()`：`layoutLegendVertical`/`layoutLegendHorizontal` 先在局部坐标系里排完、算出 `panelW/panelH`（完全不知道自己最终会被摆在主图的左/右/上/下），`deriveLegend()` 才拿主图已经算好的 `mainBbox` 算偏移量、把局部坐标平移成世界坐标。

**建树**：从扁平的 `zones` 数组解析出一棵树——一个 zone 的 id 出现在另一个 zone 的 `members` 里，它就是那个 zone 的孩子；没被任何 zone 引用的设备/zone，都是根区域（整张图，隐式，L0）的直接孩子。

**测量阶段**（按树的深度从叶子往根走）：每个 zone 拿到自己的直接孩子列表（可能混合"设备"和"已经测量完的子 zone"，两者对这一步来说都只是"一个有 `w`/`h` 的方块"），按自己的 `layout` 字段选规则：

- `row`（默认）：`computeLayout()` 现在"1) 分带放置"那段代码原样复用，操作对象从"只有设备"泛化成"设备或子 zone 的方块列表"；`satelliteOf` 混排是同一段代码的一部分，同样泛化——同一层内 `row` 主组和 `satelliteOf` 旁挂可以混用。
- `column`：跟 `row` 逻辑一致，主轴换成纵向。
- `ring`：环形分布，新写。
- `legend`：专属于图例这个特殊 zone，见下节。

每种规则的接口一致：输入方块列表，输出每个方块的**局部坐标** + 这个 zone 自己的 `w`/`h`。

**落位阶段**（从根往叶子走）：根区域局部坐标系原点 = 世界原点；每往下一层，父级在测量阶段已经给每个孩子分配了局部偏移量，父偏移量 + 子局部坐标 = 子的世界坐标；孩子有 `position` 覆盖时，跳过规则算出来的偏移量，直接用覆盖值。

**顺带修复的 bug**：`drawZones` 现在画框顺序按 `zones` 数组声明顺序，导致父 zone 声明在子 zone 后面时会整个盖住子 zone。有了这棵树之后，画框顺序直接按"父先于子"确定，不再依赖作者声明顺序——bug 由结构自然解决，不需要单独加校验规则。

## 深度限制：最多3层，④层入口门禁硬错误

根区域（L0，整张图，隐式）+ 最多2层作者显式声明的 zone 嵌套（L1/L2），超过就在布局阶段直接拒绝（`buildRegionTree()` 报错），逼 agent 重新组织，不是警告、不是"汇总统计"里的软性提示。

理由：压力测试和真实参考图里最深都只需要2层显式嵌套（存储区域→FC交换机/分布式存储交换机；计算区域→5个子分组），没有见过需要第3层的场景；而且这不是纯审美偏好——虚线框嵌套超过3层，视觉上人眼真的分不清哪条框线属于哪一层（尤其相邻区域挨得紧凑时），够得上"破坏渲染结果"的标准，符合 DRC/入口门禁一贯的判断尺子。循环引用（zone A 的成员是 zone B，zone B 的成员又是 zone A）同样是入口门禁硬错误。

## 图例归入统一框架：作为特殊的 L1 zone

`deriveLegend()` 现在做的事——先局部排、算出面板自己的 `panelW`/`panelH`，再拿主图已经算好的 `mainBbox` 算偏移量贴上去——跟这次定的"测量+落位"两段式完全一致，只是现在是一套独立于 `zones` 之外的旁路实现。收进统一框架：

- **落位**：贴在主图哪一侧，本质上就是"一个 zone `satelliteOf` 根区域，side 由字段指定"——复用区域框架的落位机制，不用再单独维护一条平移逻辑。
- **测量**：图例内部是文字行+动态换行估宽，跟"设备/zone 方块"的 row/column/ring 完全是两码事，不硬套——做成 `layout` 的第四个取值 `"legend"`，测量算法还是现在的 `layoutLegendVertical`/`layoutLegendHorizontal`，只是"孩子列表"不是作者写的 `members: [...]`，而是 `usedEncodings(model)` 自动推导。

现有 `meta.showLegend`/`meta.legendPosition`/`meta.legendGroups` 三个字段迁移到这个特殊 zone 的声明上（具体映射规则留给实现计划）。这部分涉及改动已上线的图例功能（`2026-07-09-legend-layer-participation.md`），是这次设计的一块迁移工作，不是纯新增。

## 引擎共享架构

这个项目里"两个引擎各写一份同类推导逻辑、后来悄悄不同步"已经栽过三次坑（iconTheme、`aPort`、图标长宽比），区域递归这次范围更大（不是一个字段，是整个布局结构），所以结构层必须共享，不能重蹈覆辙。

新增独立模块 `regions.js`（不塞进已经不小的 `topo.js`，跟 `drc.js`/`icons.js` 一样按关注点分文件），对外暴露：

- `buildRegionTree(model)` —— 解析 `zones` 数组成树；深度>3层、循环引用两者都在这里报错（④层入口门禁）。
- `measure(node, sizeDevice)` —— 自底向上，按 `layout` 字段分发到 row/column/ring/legend 对应的测量函数。
- `place(node, offset)` —— 自顶向下把局部坐标摊开成世界坐标，遇到 `position` 覆盖就用覆盖值。

`topo.js` 的 `computeLayout()` 和 `geometry-elk.mjs` 的 `computeElkLayout()` 都改成：先调 `regions.js` 拿到每个设备/zone 的最终世界坐标，再各自跑自己原有的、不受这次改动影响的部分——档A的"2) 边归属/3) 端口排序"、档B的 libavoid 绕线，都还是照旧对着"已经有世界坐标的设备"操作。

## 范围边界（这次明确不解决什么）

- **跨区域连线交叉最小化排序**：区域解决的是"谁包着谁、谁该贴哪、图例往哪贴"这类容器归属问题，不解决"同一个 zone 内，设备具体按什么顺序排列才能让跨 zone 的连线交叉最少"——`row` 规则现在（以后大概率也）还是按作者声明顺序摆。压力测试图里"接入交换机↔计算区域"那片密集交叉，这次设计能让它被正确地圈进对应的 zone、贴在正确的位置，但线本身交不交叉、交叉多少，还是取决于 agent 有没有手动把设备顺序排对。自动交叉最小化排序（比如 barycenter 类启发式）不在这次范围内，是开放问题1的后续。
- **①-⑤ 整体持久化架构**：`position` 覆盖只解决"区域落位这一个点"上的显式钉住需求，不涉及更大范围的"整体持久化+增量恢复"讨论（那个讨论明确被搁置，见对话记录，优先级低于这次的"能不能画出复杂拓扑"）。

## 实现落地后发现的回归（2026-07-10，最终 code review 中发现）

`geometry-elk.mjs` 在这次改动之前，`meta.layoutDirection`（`TB`/`BT`/`LR`/`RL`）会通过 `DIRECTION` 映射表传给 `elk.direction` 布局选项，真正生效；`topo.js` 手写档则从来没有实现过这个字段（`grep` 确认过，`computeLayout()` 从未读取过方向相关的值，`n.cy = t * cfg.ROW_GAP` 一直是硬编码纵向）。这次把节点定位统一收进 `regions.js` 之后，`measureRow` 同样硬编码纵向（`t * rowGap`），`geometry-elk.mjs` 不再调用 `elk.layout()`，原来 elk 档对 `layoutDirection` 的支持随之丢失——目前两个引擎实际上都只支持 TB，`meta.layoutDirection` 字段名义上还在文档里（`2026-07-08-topology-layered-model-request-validation.md` 第61条），但已经名存实亡。

这不在这次设计批准的范围内（当时讨论完全没涉及 `layoutDirection`），按用户决定先记录、不在本次修复：后续如果有真实需要，应该给 `regions.js` 的 `measureRow`（以及未来的 `column`/`ring`）加方向感知的坐标轴互换逻辑，让 `layoutRegions()` 接收一个方向参数并统一分发给两个引擎，而不是像以前那样只在 elk 档单独接 `elk.direction`——避免重蹈"一个引擎有一个没有"的覆辙。

## 不做兼容

现有的扁平 zone 声明（`topo-data.js` 里的 `ZONE_SVR`/`ZONE_STG`，没有 `layout`/`tier` 字段，成员横跨多个 tier）**不做向后兼容**——明确决定：现在还在探索阶段，不为了兼容旧数据引入"新旧两条代码路径"的额外复杂度。所有 zone 统一走 `regions.js` 的递归测量+落位流程；现有样例数据（`topo-data.js`、`demo-dc-spine-leaf.topo.json`）作为实现计划的一部分同步更新，显式声明需要的 `layout`/`tier` 字段。

## 与既有开放问题的关系

- 部分回答开放问题1（④层对齐提示字段）：给出了容器归属/贴靠机制（`satelliteOf`/`position`/按 `tier` 排序），但"希望 X 对齐到 Y 正下方"式的像素级对齐提示、以及自动交叉最小化，仍未解决，见上面"范围边界"。
- memory `project_alignment_gap.md`：这次给了具体的、可落地的容器归属机制，但全网状拓扑的交叉最小化排序问题本身仍然存在，ememory 需要在实现完成后更新，指向这份文档并注明"未完全解决"。

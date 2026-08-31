# 拓扑设备图标库 — 设计

**日期:** 2026-07-07
**状态:** 已确认，待 writing-plans

## 背景与问题

`topology-agent` 目前把每个设备节点画成一个纯色圆角矩形（`drawNodes`），颜色由 `topo.js` 的 `normalizeEncoding()` 按角色名哈希自动分配（同名角色始终同色，不同名角色尽量不同色）。这解决了"agent 不配色也能看得清"的问题，但节点本身没有可识别的图形语义——核心交换机、防火墙、AP 在图上长得完全一样，只能靠文字标签区分。

用户提供了一批华为官方《企业网络常用图标》图标包（Enterprise Networking Product Icons，含 Switch/AR Router/Security 三个产品家族，各有蓝色/黄色两套配色），希望以此为基础建一个真实设备图标库，替换掉纯色矩形。

图标包原始格式是 `.vss`（Visio 老版二进制 stencil）、`.edt`（EdrawMax 私有格式）、`.pptx`（内嵌 PNG，分辨率低，约 130×106）。用户后续用 EdrawMax 把 `.edt` 导出为 EMF+PNG+SVG 三种格式；EdrawMax 自带的 SVG 导出只对约 20% 的图标给出真矢量（多为路由器/云/虚拟化类），交换机/防火墙/AP/AC 这些最常用的设备图标仍然只有 PNG。经验证，这些图标的 **EMF** 文件是真矢量（几百字节到几 KB，含真实 path 数据，不是内嵌位图）——用本机已安装的 LibreOffice 无头模式（`soffice --headless --convert-to svg`）转换，再裁剪到内容包围盒、去掉未引用的 `<defs>`，可以把全部 880 个图标转成干净的独立矢量 SVG。随机抽样 15 个（覆盖全部 6 个色×包组合）人工检查，颜色、形状、裁剪均正确，无损坏。

这次转换过程本身是一次性的数据准备工作，**不**作为项目工具链维护——只有转换产出的最终 SVG 文件进项目。

## 非目标（YAGNI）

- 不维护 EMF→SVG 转换脚本/流水线；只提交最终产出的干净 SVG。
- 不把全部 880 个图标（含大量非拓扑相关的机场/地铁/部门/城市类图标）都暴露给 agent；只挑选与网络拓扑真正相关的子集。
- 不做"按角色名模糊匹配图标"（曾考虑过、否决）：角色名是 agent 按用户当前拓扑现场起的自由文本（比如"EOR 交换机"），跟图标库固定词表做字符串/模糊匹配，匹配不上会静默退化，匹配错更危险——错误图标比纯色矩形更具误导性。
- 不要求 agent 必须用图标——`icon` 字段是可选的，不设就照旧画纯色矩形，行为不变、零回归风险。
- 不解决"合法拓扑图有多种画法"这类更深的语义层问题（见 memory `project_drc_scope_narrowed`），本设计只管图标这一层。

## 数据模型变更

对 `.topo.json` 语义模型新增两个**可选**字段，缺省时行为与今天完全一致：

1. **`encoding.deviceRoles[role].icon: string`** —— 这个角色用图标库里的哪个 key。值必须是图标目录 `catalog.json` 里登记的 key（比如 `"core-switch"`），不是文件名、不是模糊文本。
2. **`devices[i].iconTheme: "blue" | "yellow"`**（默认 `"blue"`）—— 单台设备级别的配色覆盖，用来表达"这台是现网/遗留设备、那台是目标网络的新设备"这类跟设备类型无关的语义（用户原话："legacy device / new device, that's semantic difference"）。**只有 `catalog.json` 里标了 `deviceType: true` 的角色才认这个字段**——Internet/云、人员、建筑/组织这类非设备图标永远用固定的一种配色，忽略 `iconTheme`。

两个字段都不参与 DRC 评分（DRC 只查图纸本身的图例/命名完整性，见 `project_drc_scope_narrowed`），也不影响 `topo.js` 的布局计算——纯渲染层信息。

## 图标资产与目录结构

已转换、已人工抽查过的干净 SVG 就位于 `D:\20_code\IPMasterCoworkDesktop\drawing-engine\icons\*/svg_clean\`，实现阶段从中挑选、整理最终要提交的子集（预计 30–50 个，覆盖交换机分层、路由器、防火墙/安全设备、AP/AC 无线、云与虚拟化、服务器/存储、少量非设备类如 Internet/云/人员）。

**入库范围（用户确认，2026-07-07）：**

1. **只入库 `.svg`**——中间产物（`.png`/`.emf`）和最初的原始素材（`.vss`/`.edt`/`.pptx` 及其压缩包）一律不进本仓库。仓库里只应该看到最终、干净、已裁剪的矢量 SVG 文件。
2. **图标库单独管理**，不混进 `drawing-engine/`（引擎代码目录）——独立成仓库根下的一个顶层目录，跟 `drawing-engine/` 平级：

```
topology-icons/
  catalog.json        # [{key, category, legend_zh, deviceType, blue: "svg/blue/<key>.svg", yellow: "svg/yellow/<key>.svg"|null}, ...]
  svg/
    blue/<key>.svg
    yellow/<key>.svg   # 只有 deviceType:true 且蓝黄两版都有真实素材的 key 才有这个文件
```

`catalog.json` 是**引擎侧**的图标登记表——不是 agent 要背的东西，agent 通过下面的技能拿到一份可读的参考材料。

`render.js`/`index.html`/`cli.js` 按相对路径引用 `../topology-icons/`（或实现阶段确定的等价相对路径）。独立成顶层目录是为了让它有自己的生命周期，且打包时（`packaging/build_electron.ps1`）作为独立一步拷进产物，跟"拷 Node 运行时""拷 drawing-engine 引擎代码"并列，而不是混在引擎代码的打包步骤里一起处理。

## 图标选择技能（topology-agent 独立技能空间）

`topology-agent` 是子 agent，有自己独立的工具/技能空间（不共享 `default` agent 的技能列表）。图标选择做成 `topology-agent` 名下的一个技能（后续还会给它加别的技能/工具，这是第一个）：

- **输入：** 当前正在定义/调整的某个 `deviceRoles` 角色（角色名 + 打算写的 `legend` 文案 + 大致用途描述）。
- **参考材料：** `catalog.json` 里筛出来的条目（key + category + legend_zh），供技能判断语义上是否真的匹配——不是拿角色名字符串去模糊对齐 key 字符串,而是理解"这个角色实际是什么"再决定选哪个 key（这样"EOR 交换机"这种没有直接同名条目的角色，也能因为语义上确实是汇聚层交换机而正确落到 `agg-switch`）。
- **输出：** 一个 `icon` key，或者明确"没有合适的，不设 `icon`"——不允许勉强凑一个不准确的匹配。
- 拿到 key 后，agent 自己把 `encoding.deviceRoles[role].icon = "<key>"` 写进 JSON，跟其他字段一样走 `fs__write_file` + `observe_topology` 复核的既有流程，不需要新工具。

## 渲染改动

`render.js` / `index.html` 的 `drawNodes()`：

- 若 `role.icon` 存在且能在 `catalog.json` 里解析到对应文件：按该设备的 `iconTheme`（或角色默认 `blue`）选中对应 SVG，内联进节点的 `<g>`，按现有 `n.w`/`n.h` 缩放适配，替换/叠加在纯色矩形之上。
- 若 `role.icon` 未设置，或 key 在 `catalog.json` 里找不到：完全走今天的路径（纯色矩形 + 文字），**不报错、不降级警告**——这是设计上允许的正常状态，不是异常。
- 非设备类角色（`deviceType:false`）忽略 `iconTheme`，始终用其固定配色版本。

## 测试

- `verify.js` 新增一例：给定一个设置了 `icon`/`iconTheme` 的模型，断言渲染结果里对应节点内联了正确的 SVG 内容（区分 blue/yellow 两个文件）。
- `verify.js` 保留一例：不设 `icon` 字段时行为与现状完全一致（回归保护）。
- Python 侧 `test_topology_capability_provider.py`：确认 `icon`/`iconTheme` 字段不会被 DRC 判定为任何 finding（这两个字段是纯渲染信息，DRC 完全不检查）。

## 后续/未决事项

- 具体挑选哪 30–50 个图标进最终 `catalog.json`，以及每个图标的 `category`/`legend_zh`/`deviceType` 标注，留到实现阶段逐条确认（不在这份 spec 里穷举）。
- 图标选择技能的具体形态（是否需要复用 ctx-weft 已有的 skill 调度机制、还是更轻量的参考文档+判断逻辑）留到实现计划里细化。
- 本设计只覆盖"画出来的图标对不对"，不覆盖"这套抽象拓扑画法本身是否表达了用户想要的语义"这一更深层的问题（该问题已记录在 memory `project_drc_scope_narrowed`，留待用户认为需要时再讨论）。

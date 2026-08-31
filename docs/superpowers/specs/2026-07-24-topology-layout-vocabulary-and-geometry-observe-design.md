# 布局决策词汇表补全 + 派生默认值修正 + 几何观测 设计

## 背景与定位

用参考图（数据中心安全域组网，42设备/80链路/15 zone）完整重画的过程暴露了一批问题：安全区竖排靠 `tier` 小数滥用、纵向间距减半靠压缩 tier 步长、计算区域与存储区域的 zone 框真实重叠（-8px）而 `observe` 报 score:100、网络安全区与安全接入交换机之间可视留白只剩 10。

由此引发对整体架构的重新审视，结论（用户已确认）：**"文件记决策、代码做派生、agent 做判断"的三分法本身不动**，这些坑全部归因于三个具体缺陷：

1. **决策词汇表不全**——没有对应字段的决策被迫写进错误的地方（滥用 `tier`、借道透明 zone、裸坐标 `position`），而滥用是不可读的：`tier: 0.5` 不会告诉下一个读者"这是个间距决策"。
2. **派生算法的默认定义有硬伤**——`ROW_GAP` 是中心距不是净空距，内容一高就吃穿留白直到重叠；satellite 贴靠借用为小图标设计的 `H_GAP`，再被两侧 `ZONE_PAD` 各啃一口。好的输入也产生坏的输出。
3. **agent 的"眼睛"缺失**——架构约束是 agent 不看渲染图、靠结构化数据推理，但 `observe` 只报 DRC/计数/bbox，几何质量（净空/重叠/包含）全盲，react 回路缺了必要一环（即既有设计文档开放问题 2 的④层几何检查——它不是可选优化）。

**关于"要不要保存④/⑤输出"的重申**：不保存。保存输出冻结的是症状（坐标值），不是意图（为什么在那）；一致性的正确来源是"决策不变 + 派生确定"，不是"输出被缓存"。①-⑤整体持久化解决的是中断恢复/大图增量这另一个问题，继续搁置。`position` 保留为泄压阀，但每个 `position` 都应视为"这里缺一个更好的字段"的信号。

## 一、派生默认值修正（纯代码，零新字段）

### 1a. 行距改净空距（clearance）语义

现状：`regions.js` 的 `measureRow` 用 `cy = tier * rowGap`——tier 差 1 的两行**中心点**相距 `rowGap`，行内内容越高，行间实际留白越小，直到负值（重叠）。

改为：按 tier 升序逐行铺放，**每行的顶边 = 上一行的底边 + rowGap**（行高 = 该行最高孩子的高度，行内孩子垂直居中）。`rowGap` 从此语义就是"相邻两行边缘之间保证的留白"，行内内容多高都吃不掉它。

三个连带效果，都是有意为之：
- **`tier` 变成纯序数**——tier 值只决定行的先后次序，数值间隔不再产生空间效果。`tier: 0.5` 这类小数依然合法（排序仍成立），但不再能当"间距倍数"用——滥用通道被结构性关闭。
- **空 tier 不再留出空白行**——之前 tier 0 和 tier 5 之间隔着 5×122 的空间，现在只是相邻两行。有意留白应该用间距字段表达，不是用空号段。
- **默认值要重调**——中心距 122 在设备高约 44 时实际净空约 78。为保持现有图的视觉密度，净空距默认值取 **78**（`CFG.ROW_GAP = 78`，语义变了但字段名沿用——本项目处于探索阶段，明确不做兼容，没有需要照顾的外部调用方）。

`H_GAP` 不动——它本来就是净空语义（`cursor += c.w + hGap`）。

### 1b. satellite 贴靠间距与 `H_GAP` 脱钩

现状：`measureRow` 的 satellite 分支用 `hGap`（46）做贴靠偏移；锚点和 satellite 若都是 zone，双方 `ZONE_PAD`（18×2=36）再吃掉大半，可视留白只剩 10。

改为：新增 `CFG.SATELLITE_GAP = 90` 作为贴靠偏移的独立默认值（90 − 36 = 54，两个带框区域之间仍有明显留白）。`hGap` 不再参与 satellite 定位。

## 二、决策词汇表补全（少量新字段，全部④层作者化提示）

| 字段 | 挂在哪 | 语义 | 缺省 |
|---|---|---|---|
| `rowGap` | zone / `meta` | 本 zone 内部（`meta` 则是根区域）行与行的净空距 | `CFG.ROW_GAP`(78) |
| `hGap` | zone / `meta` | 本 zone 内部（同上）同行相邻孩子的水平净空 | `CFG.H_GAP`(46) |
| `zonePad` | `meta` | zone 可视化框外扩距离（全局） | `CFG.ZONE_PAD`(18) |
| `satelliteGap` | 声明了 `satelliteOf` 的 zone/设备 | 贴靠偏移量 | `CFG.SATELLITE_GAP`(90) |
| `layout: "column"` | zone | 竖排：`tier` 决定第几**列**（从左到右），同 tier 孩子在列内纵向堆叠。`rowGap` 仍是垂直净空、`hGap` 仍是水平净空（两种 layout 里含义一致） | — |

设计决定（附理由）：
- **per-zone 间距不做父子继承**——一个 zone 要么自己声明、要么用全局默认，不从父 zone 继承。继承链会让"这个数从哪来的"变得难回答，agent 逐个显式设置的成本很低。
- **`column` v1 不支持 `satelliteOf` 成员**——行→列转置后旁挂语义（贴哪一侧）需要单独设计，遇到直接硬报错（本项目"宁可报错不可歪画"的一贯文化），有真实需求再补。
- **不做 per-tier-pair 细粒度间距**——没有具体场景证明需要；zone 粒度不够用时再议。
- **安全区竖排的正确写法**从此是 `layout:"column"` + 成员同 tier，5 台设备不再需要伪造 5 个不同的 tier 值。

`meta.rowGap`/`meta.hGap`/`meta.zonePad` 同时了结既有设计文档开放问题 12 高优先级那三项（`serve.js`/`cli.js`/`render.js` 调用点把 meta 值塞进 `opts` 即可，`computeLayout(model, opts)` 的覆盖机制早已存在）。

## 三、observe 增加几何测量（代码，agent 的眼睛）

新增独立纯函数模块 `geometry-report.js`（对既有开放问题 2"合并进 observe 还是独立工具"的裁决：**独立模块、并入 observe 输出**——它是测量不是规则，跟 DRC 的"违规"性质不同，不参与 DRC score，符合之前讨论定下的"汇总统计"概念：暴露数字+明细，判断留给 agent）：

```
observe 输出新增 "geometry" 字段：
{
  zoneOverlaps: [ { a, b, overlapX, overlapY } ],   // 非祖先/后代关系的 zone 对，可视化框(含 pad)相交
  containmentViolations: [ { zone, member } ],       // 成员图形超出所属 zone 可视化框
  rowClearances: [ { fromTier, toTier, clearance } ],// 根区域相邻行"主组"之间的净空（负数=重叠）
  satelliteOverflows: [ { satellite, intoTier, overlapX, overlapY } ] // 旁挂成员溢出并真的撞到别的行
}
```

判断性质说明：`position` 钉住的元素可能被作者**故意**摆得与别的东西重叠，所以这些是测量数据不是错误——agent 结合上下文决定要不要处理、要不要告诉用户。

**`rowClearances` 只量主组、旁挂另设 `satelliteOverflows` 的原因**（实现时用参考图验收才发现，最初的设计是把旁挂一起算进行包围盒）：把整行连旁挂压成一个全宽包围盒去做一维投影比较，会产生**假警报**——参考图里的"网络安全区"竖跨好几行、贴在最左边，垂直方向必然跟相邻行交叠，但水平方向离得远、根本不碰；而且合并后的行盒横跨全宽，连"水平方向重不重叠"都没法再区分出来（试过给 `rowClearances` 加 `xOverlap` 字段，无效，因为污染发生在行盒合并那一步）。所以拆成两个指标：`rowClearances` 只量主组（也就是 `rowGap` 真正控制的那个量，数值干净可信），旁挂是否真撞到别的行用**二维矩形求交**单独判定。这条修正让参考图的验收从"8 条里有 2 条负值"变成全部为正且无误报。

## 四、SOUL.md 同步（agent 只能使用它知道存在的字段）

现状核对结果：SOUL.md 的 `zones` 字段说明停在 `id`/`type`/`label`/`members` 四个字段——`regions.js` 的全部能力（嵌套、`layout`/`tier`/`satelliteOf`/`position`）agent 一概不知道；第 40 行"同层内谁在左谁在右由引擎按对称/**树形归属**规则派生"描述的是已退休的机制，是错的。

更新内容（`resources/` 和 `packaging/` 两份一起改，两份现在完全相同）：
1. `zones` 字段全集：嵌套（members 可引用 zone id，最多 L1/L2 两层显式）、`layout`(row/column)、`tier`、`satelliteOf`、`position`、`rowGap`/`hGap`/`satelliteGap`；`meta.rowGap`/`hGap`/`zonePad`。
2. 修正第 40 行：同层左右顺序由 devices 数组声明顺序决定（含裸设备/zone 混排）。
3. 新增行为准则：**禁止把决策写进语义不匹配的字段**（不许用 tier 小数造间距、不许用空 zone 借道排序）；表达优先级：关系字段 > 数值字段 > `position` 裸坐标；没有合适字段时上报缺口，而不是悄悄滥用。
4. `observe` 的 `geometry` 段说明：拿到测量数据后如何判断（重叠/越界通常要处理；`position` 故意造成的除外）。

## 明确不做（本轮范围外）

- ④/⑤输出持久化（继续搁置，理由见开头）
- per-tier-pair 细粒度间距
- 交叉最小化排序（独立线，memory `project_alignment_gap` 继续跟踪）
- 图例并入 zone 树（`layout:"legend"`，独立计划）
- `layoutDirection` 恢复（已单独记录为 TB-only）
- `ring` 布局（没有真实需求出现）

## 验收基准

用参考图的完整重画模型（`dc-full-v3`）验证：
1. 存储区域与计算区域不再重叠，`rowClearances` 全部为正、`satelliteOverflows` 为空；
2. 网络安全区竖排改用 `layout:"column"` 表达，模型里不再有伪造的小数/递增 tier；
3. 网络安全区与安全接入交换机的可视留白 ≥ 40（`satelliteGap` 默认值生效）；
4. `observe` 的 `geometry` 字段在故意构造的重叠/越界用例上能报出条目；
5. 全量回归（5 个 verify 脚本）通过，`sample-dual-core`/`demo-dc-spine-leaf` 两个样例图渲染正常。

---
name: skill-edit
description: 当用户想对一个【已有的 skill】做局部修复、微调、扩展时使用（保持 skill 的整体结构和定位不变）。触发场景：「帮我改这个skill」「给这个skill加一步/加个规则」「改一下这个skill的某段/描述/触发条件」「把这段挪到references」「我的skill有问题/没按预期工作」「skill输出不对/偶尔出错」，或用户贴出一个 skill 让你做小改。核心作用：改 skill 时守住结构、只改该改的地方——别把 frontmatter 写臃肿、别把正文写乱、别顺手重写别处。如果用户是要【从零创建一个全新 skill】，或要对已有 skill 做【结构性大改/推倒重构/定位重设】（步骤全重排、references 整体重组、skill 定位改变），那属于 skill-creator，请用 skill-creator、不要用这个，以免误触发。使用此 skill 时创建一个 interactive 类型的任务。
---

# 安全地修改已有 Skill

修改一个 skill 时，**最大的风险不是改错逻辑，而是把 skill 的结构写坏**——尤其当动手的模型并不真的清楚"skill 到底是什么"。这个 skill 的作用就是：动手前先把"合法 skill 长什么样"钉死，改的时候小而精准，改完用脚本校验没写坏。

不确定 skill 是什么，先读 `references/skill-intro.md`。

---

## ⛔ 编辑前必须守住的 5 条硬规则（先记牢，再动手）

**1. frontmatter 只有两个字段：`name` 和 `description`（顶多再加 `license`）。**
frontmatter 是文件开头用 `---` 和 `---` 包住的那一小段，它**只回答两件事**：这个 skill 叫什么、什么时候用它。**不要**往里加别的字段，不要把步骤、说明、规则、示例、注意事项塞进去。

**2. `name`：全小写 + 连字符，且和文件夹同名。** 例：`invoice-check`。不要大写、空格、下划线。

**3. `description`：一句到几句话，只说"何时触发"。** 列触发场景/关键词即可。它**不是说明书**——不要在这里写流程步骤、规则、代码。把它写长、写乱，是最常见、也最致命的错误。

> **交互型 skill 的处理（分两处，别混）：** 如果这个 skill 在执行时需要**向用户提问、和用户交互**（正文里有"问用户 / 让用户确认 / 用 ask_user"这类步骤），要分两处写：
> - **`description` 里**加一句「使用此 skill 时创建一个 interactive 类型的任务」——这是给 harness 在建任务时读的（决定任务类型），是允许出现在 description 里的、唯一一类"非纯触发说明"。
> - **「用 ask_user 工具向用户提问」这条属于运行时行为，写进正文（相关步骤/原则），不要塞进 description。**
>
> 改动时若发现它是交互型却没在 description 声明 interactive 任务、或正文没写"用 ask_user 提问"，补上；若你的改动让一个原本不交互的 skill 变成要问用户，也照此补上这两处。

**4. 正文（第二个 `---` 之后）只放"做什么的步骤"。** 其它一律不塞进 SKILL.md 正文：
- 领域知识 / 判断标准 → `references/`
- 固定输出格式 / 模板 → `templates/`
- 确定性计算、分支路由（如果 A 就 X、如果 B 就 Y）→ `scripts/`
- 脚本读取的数据表 → `assets/`

（细则见 `references/content-triage-rules.md`）

**5. metadata 就在 SKILL.md 开头，不要新建 `skill.yaml` / `metadata.yaml`；不要破坏 `---` 围栏。**

## 😵 最容易犯的错（逐条避开）

- ❌ 往 `description`／frontmatter 里塞一大段说明或步骤 → 只留一句触发说明，其余进正文或 references。
- ❌ frontmatter 加一堆非法字段（author、version、steps、notes……）→ 只留 `name` + `description`（+ `license`）。
- ❌ 正文里堆知识、写 if/else 决策树 → 知识进 references，确定性分支写成 scripts。
- ❌ 只想改一处，却顺手把整段或整个文件重写，把原有结构和风格冲乱 → 只改需要改的最小范围。
- ❌ 改动时删掉或写错 `---` 围栏，导致 frontmatter 失效、元数据和正文糊成一团。

---

## 工作流程

### 第一步：先看清现状，别急着改
读完整个 skill（SKILL.md + 相关 references / scripts）。搞清楚：frontmatter 现在长什么样、正文有哪些步骤、有哪些附带文件、用户到底想改什么。用户没给文件，就请他把 SKILL.md 和相关文件贴过来。

### 第二步：定位到"最小改动范围"
明确要改的是哪个文件、哪一段。
- 若是"skill 没按预期工作 / 输出不对 / 偶尔出错"这类问题，对照 `references/skill-diagnose-guide.md` 分四层定位（触发层 → 流程层 → 知识层 → 脚本层），给出**明确**结论，别模糊地说"可能是……"。
- 若用户就是要加/改一步、改描述、改规则，直接定位到对应位置。

**先判断改动性质——超出局部修复就转交。** 如果定位后发现这**不是局部修复/微调/扩展，而是结构性大改**（步骤要全重排、references 要整体重组、skill 定位变了、大半内容要推翻重写），那已经超出本 skill 的范围（本 skill 的纪律是"最小改动、不重构"）。**这时明确告诉用户"这属于结构性重构，本质上是重建，建议改用 skill-creator"，不要在这里硬着头皮大改。** 本 skill 只处理"保持 skill 整体结构和定位不变"的局部改动。

### 第三步：说清方案，确认后再动手
告诉用户：改哪个文件、改什么、为什么。**特别标明会不会动到 frontmatter**（动 frontmatter 要格外小心）。等用户确认再改。

### 第四步：小而精准地改
遵守 `references/coding-discipline.md`：改动小、不连带重写、保留原有结构与风格。若发现问题根源是正文里塞了复杂的确定性分支，主动说"这部分我改写成脚本"，对照 `references/script-trigger-patterns.md`。

### 第五步：改完必须校验（防写乱的最后一道闸）
运行结构校验脚本，把所有 `FAIL` 修掉，`WARN` 逐条核实：
```bash
python scripts/check_skill.py <被改的skill目录>
```
它检查：frontmatter 是否只有 name+description、name 是否合法且与文件夹同名、description 有没有被写成长篇/夹带正文、`---` 围栏是否完好、正文是否还在、有没有多余的 skill.yaml、引用的文件是否存在。

然后通读被改动的文件，确认没把别处写乱。改动较大时，再对照 `references/content-triage-rules.md` 全面复查（SKILL.md 只有步骤、references 里没有分支树、文件引用仍有效、触发条件仍准确）。

（可选）把这次改动写进 `evals/` 留作回归，参考 `references/evals-guide.md`。

---

## 核心原则
- 动手前先把上面 5 条硬规则记牢——这是不被写乱的前提。
- **凡是要向用户提问或征求确认（要文件、问清需求、确认改动方案），都用 `ask_user` 工具，别把问题写在普通回复里。**
- 定位优先，方案先说清，确认再改。
- 改动小，绝不"顺便"重构、绝不碰不需要碰的部分。
- **每次改完都跑 `scripts/check_skill.py` 校验结构**——这是不被写乱的保证。
- frontmatter 是重灾区：只留 `name` + `description`，一个字都别多塞。

## 参考文件
- `references/skill-intro.md` — 不懂 skill 是什么时先读。
- `references/skill-diagnose-guide.md` — "没按预期工作"类问题的四层定位法。
- `references/content-triage-rules.md` — 哪句话该放哪个文件（正文 / references / templates / scripts / assets）。
- `references/script-trigger-patterns.md` — 哪些逻辑必须写成脚本。
- `references/coding-discipline.md` — 改文件的行为准则（小而精准）。
- `references/directory-structure.md` — 标准目录结构。
- `references/evals-guide.md` — 回归用例怎么写。

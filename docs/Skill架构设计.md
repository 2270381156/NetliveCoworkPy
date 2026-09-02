# Skill 子系统设计

Skill（技能）是一份**可复用的能力包**：一个目录，装着给大模型看的说明书和可执行脚本。
它让 agent 用"读说明书 → 列文件 → 读资料 → 跑脚本"的方式完成结构化的专业任务
（如生成 docx/pdf/pptx、领域绘图等），而不必把这些知识硬编码进提示词或引擎。

![Skill 子系统架构图](./Skill架构设计.svg)

---

## 1. 一个技能是什么 · 三层模型

**技能 = 一个目录**：

```
<技能>/
  SKILL.md      说明书（正文）+ 元数据（frontmatter: name / description）
  references/   参考资料（可选）
  scripts/      可执行脚本（可选）
```

对大模型的暴露是**三层渐进披露**——用时才逐层展开，避免把整个技能塞进上下文：

| 层 | 做什么 | 谁在做 · 何时 |
|---|---|---|
| **L1 发现** | 把每个技能的 `name / description` 列进 system 提示的**可用能力清单**（与工具、子 agent 并列），大模型据此知道"有哪些技能可用" | **引擎自动** · 每轮装配提示词时 |
| **L2 加载** | 读该技能 `SKILL.md` 正文，作为"当前任务说明书"注入提示词 | **引擎自动** · 任务绑定到该技能时（云端此步才下载） |
| **L3 使用** | 列技能文件 / 读技能文件 / 跑技能脚本 | **大模型** · 调工具（见 §2） |

> **要点**：L1/L2 是**引擎自动**把"技能清单"和"说明书"装配进提示词，大模型**不调任何工具**；只有
> L3 才是大模型主动调工具。对**云端技能**：引用库只缓存 `name/description`（供 L1 列表），`SKILL.md`
> 正文与脚本**不入库**，故 L2/L3 时才**现下载**（用完即删，见 §3）；本地技能则整个目录常驻磁盘，无此步。

---

## 2. 大模型怎么用一个技能：进入 → 使用

分两步：

**第一步 · 进入技能**。大模型在能力清单里看到某技能后，派出一个**"绑定到该技能"的子任务**来使用它
（通过控制工具 `control__delegate_task`，带上要用的技能名）。这一步是进入技能的**入口**；之后引擎会
自动把该技能的 `SKILL.md` 说明书注入这个子任务的提示词（即 L2）。

**第二步 · 使用技能**。在这个绑定了技能的子任务里，大模型**不直接碰技能文件**（技能不在工作区，
云端技能更是临时的），而是用三个**技能无关**的通用工具操作它：

- `skill_executor__list_files` — 列当前技能目录文件
- `skill_executor__read_file` — 读当前技能目录文件
- `skill_executor__exec_script` — 跑当前技能脚本

**内核做了什么**：这三个工具由引擎的**技能执行器**统一提供；它维护一张"技能名 → 由哪个 provider 负责"
的路由表，按**当前子任务绑定的技能名**把调用派发到对应 provider（本地或云端），再由该 provider 完成
列/读/跑。若任务没绑定技能 → 报 `NO_SKILL_ASSIGNED`；路由表里查不到该技能 → 报 `SKILL_NOT_FOUND`。

> 注入说明书时还会附一段**运行时提示**，强制引导大模型："技能文件不在你的工作目录，读/跑技能文件
> 必须用上面三个工具，别自己 `python scripts/x.py`、别拼绝对路径。" ——把大模型从"用 bash 直接碰技能
> 文件"扳到正确工具上。

---

## 3. 技能系统的 provider 架构

技能系统建立在引擎的 **provider（可插拔实现单元）** 机制上——理解这层，就理解了整个设计。

**为什么用 provider**：引擎（`ctx_weft`）纯净、无 I/O——它不知道技能从哪来、怎么下载、放哪，只定义
**协议（接口）**，具体实现由 provider **注入**进来（经引擎的依赖注入容器 `ProviderRegistry`）。这是
"引擎纯净 + 依赖倒置"的落地方式。

技能系统由**两种角色**的 provider 组成：

| 角色 | 谁 | 职责 |
|---|---|---|
| **技能来源 provider**（实现 `SkillCapabilityProvider` 协议，**可有多个**） | `LocalSkillCapabilityProvider`（本地）、`ReferencedSkillCapabilityProvider`（云端） | 每个**负责一批技能**，自己知道怎么发现/加载/执行——本地扫磁盘、云端下载物化 |
| **技能执行器 provider**（`SkillExecutorCapabilityProvider`，引擎内置、**只有一个**） | — | 对大模型暴露那 3 个通用工具；**自己不存技能**，而是**汇总所有来源 provider**、建路由表、转发调用 |

**为什么要"技能名 → provider"路由表**：大模型的工具是**技能无关**的（`skill_executor__read_file(path)`
只带"读哪个文件"、不带"归谁管"），而技能**分散在多个来源 provider 里**。于是执行器在启动/失效后，
**逐个问来源 provider"你有哪些技能"**，汇成一张 `技能名 → provider` 表；运行时按当前任务绑定的
`skill_name` 查表，找到负责的 provider 转发过去。这张表就是**从"统一入口（3 工具）"到"分散实现（多个
provider）"之间的调度层**。

```
大模型  ── 只见 3 个通用工具 skill_executor__*
   │  按 skill_name
   ▼
技能执行器 provider ── 查"技能名 → provider"路由表（问各来源 provider 汇总而来）
   ├──────────────────┬──────────────────────────────┐
   ▼                  ▼
本地来源 provider        云端来源 provider（宿主实现）
   │                    │  借用—归还：临时起一个本地 provider 指向下载的临时目录
   ▼                    ▼
skills_dir/<技能>       引用库 + 市场（cowork / mythos）
```

**两条来源路线（同协议、对大模型无差别）**：
- **本地技能**：用户导入，永久存于 `skills_dir`。provider 直接读目录。
- **云端引用技能**：从市场"引用"过来，本地只存一条元数据（引用库）。用时走**借用—归还**：下载 zip →
  解压到系统临时目录 → 委托一个临时的本地 provider 执行 → **用完即删**。不常驻磁盘、隔离并发、跟市场更新。

**这么设计换来什么**：
- **可扩展**：要加第三种来源（另一个市场、git 同步的技能……）= 再写一个 `SkillCapabilityProvider` 注册进去，
  执行器与大模型**零改动**，路由表自动把它纳入。
- **关注点分离**：来源 provider 管各自技能的生命周期（磁盘扫描 / 下载清理）；执行器管路由 + 工具语义 +
  运行时提示；引擎管把技能装配进提示词、把任务绑定到技能。

---

## 4. 云端技能：两个市场源的整合（cowork + mythos）

云端技能来自**两个市场源**——`cowork` 与 `mythos`——被一个聚合层统一成"一个市场"，对上层
（前端展示、大模型执行）都无差别：

**① 展示（发现 / 引用）**：聚合层把两源目录**合并成一份列表**给市场页——每条带一个内部
`source` 标签（`cowork` / `mythos`，**仅供后端路由，UI 不展示**）+ `reference_id`（按当前页签
作用域算好的**确定性引用 ID**）+ `is_pulled`（是否已引用，按**精确身份**匹配）。任一源失败只记
日志、降级返回另一源；mythos 结果按用户名短时缓存。用户点"引用"后，本地**引用库**只写一条
L1 元数据，不下载内容。

**② 执行（大模型用技能时）**：大模型进入某云端技能、调 `skill_executor__*` 时，云端 provider
按引用里保存的 **`market_scope` + `source`** 把下载请求**派发到对应的服务器**（同一 source 在
通用页签和某个 cowork 专属页签下指向**不同的服务器**——"从哪个市场来"在引用时就记进身份里，
执行时据它自动选后端），带当前用户名鉴权，拉到 zip → 解压到临时目录 → 执行 → 用完即删。
大模型与执行器完全不感知两源差异，只看到"一个云端技能"。

**引用身份（v3）**：`(market_scope, source, remote_id, principal)` 四元组——市场页签、市场接口、
市场内条目、引用者主体（cowork 共享 `*`；mythos 按 W3 用户名）。对外只暴露不透明
`reference_id`（`ref:v3:<sha256>`），前端与 API 不拆 `source:remote_id` 猜身份。同一
source/remote_id 的通用与专属条目因此是**两条不同的引用**，`is_pulled` 互不串台；通配归属只
扩大可见范围，不改变"这条引用来自哪个市场"。v2 存量迁移按 `market_scope=general` 处理，
只点亮通用页签。

**profile 预置（`skills.presets`）**：cowork 套件可在清单里声明默认引用（完整 L1 元数据 +
数量/长度上限，见 `cowork/manifest.py` 的常量表；发布侧按同一契约严格拒绝）。协调器
`ProfileSkillPresetReconciler` 在**启动**（共享来源）、**W3 登录**（按用户来源）与
**`/coworks/recheck`** 三个入口做差量协调：新预置播种、profile 减预置/收回只撤自己的绑定、
引用无人认领（无手工归属且无绑定）才删。用户删除写 **opt-out**（profile/身份/主体三元组），
普通启动不复活；重新手工引用清掉匹配的 opt-out。协调不访问网络、先内存计算后
`store.mutate` 原子提交（引用 + 预置账本同一份 `skill_references.json`）。

**可见性因人而异**：mythos 技能按 `principal` 对**当前登录用户**过滤（cowork 公开不过滤）；下载带用户名防越权。
当前用户名由进程级 `current_user` 保存，登录 / 切账号时前端 `POST /skills/current-user` 写入。

**一致性要点**：`current_user` 或引用集变化时，必须**刷新执行器的路由索引**——否则登录后新可见的
云端技能不在旧索引里，大模型能进入却报 `SKILL_NOT_FOUND`。所以登录、拉市场目录、引用 / 删除引用后，都会主动让这份路由索引失效、下次用到时按当前状态重建；预置协调则只在
`ReconcileResult.changed`（原子提交成功且有变更）时失效索引。

---

## 5. 执行环境

跑一个技能脚本时，provider 并不自己闷头起进程，而是**拼一条命令**（如 `python <脚本路径>`）
**交给应用的 shell 工具 `fs:shell` 去启动**——`fs:shell` 就是**大模型跑 bash 命令用的那个工具**。
于是技能脚本和 bash 命令**共用同一套受控环境**，一处管、口径一致：

- **`fs:shell`（受控 shell）**：给命令套上授权（bash 策略）、超时、输出上限、限制在会话 workspace 内。
  > 技能脚本本身可以是 python（不是 shell 脚本）；这里的 shell 只是"启动器 + 受控外壳"，用 `python <脚本>` 把它拉起来。
- **共享 venv**：借此 `python`/`pip` 命中全应用共享虚拟环境（随包 Python 创建），**不碰用户本地 python**。
- **`SKILL_DIR`**：注入环境变量，脚本可据此定位自身目录。
- **超时**：空闲超时 `NLC_SKILL_IDLE_TIMEOUT_SEC`（无输出多久算卡死）+ 硬上限 `NLC_SKILL_HARD_CAP_SEC`（墙钟总时长封顶），均可用环境变量配置。

> 有个**直跑兜底**：当没有文件系统 provider（如某些 dev 场景）时，才退回"直接起子进程"跑，此时与 `fs:shell` 无关。生产/打包态一定走 `fs:shell`。

---

## 6. 源码速查

| 位置 | 职责 |
|---|---|
| `[引擎] ctx_weft/protocols/capability.py` | `SkillCapability` / `SkillDefinition` / `SkillCapabilityProvider` 协议 |
| `[引擎] ctx_weft/core/orchestrator/skill_executor_capability.py` | 三个通用工具 + 路由索引 + 派发 |
| `[引擎] ctx_weft/providers/capability_skill_local/` | 本地 provider（扫目录、解析 SKILL.md、执行） |
| `src/netlivecowork/providers/capability/skills/provider.py` | 云端引用 provider（借用—归还）——**本包唯一的 provider** |
| `…/skills/adapters/` | 每家市场的接口方言（cowork / mythos）+ 有哪几家的注册表 + `scopes.py` 页签/作用域数据模型 |
| `…/skills/services/` | 用例层：`market.py` 市场聚合 · `local.py` 本地 skill 增删查 |
| `…/skills/references/` | 引用式加载的持久化：`store.py` 引用库（v3 身份 + 原子事务）· `defaults.py` 默认引用播种 · `presets.py` profile 预置协调器 |
| `…/skills/runtime/` | 执行期机制：`materialize.py` 临时物化 · `zip_utils.py` 解包校验 · `reporting.py` 上报元数据 |
| `…/skills/legacy/` | 旧数据兼容（旧 pull 记录 → 引用），退休条件见其文档 |
| `…/skills/errors.py` · `current_user.py` | 全包共用：错误类型与 HTTP 映射 · 进程级当前登录用户 |
| `src/netlivecowork/api/skills.py` | REST 路由（导入/列表/删除/发布/市场/current-user）+ 触发路由索引重建 |
| `frontend-desktop/src/components/SkillsPage.tsx` · `api/skills.ts` | 技能管理 + 市场 UI |

> `[引擎] ctx_weft` 以 vendored wheel 交付，`uv sync` 后位于 `.venv/.../site-packages/ctx_weft/`（只读，绝不修改）。

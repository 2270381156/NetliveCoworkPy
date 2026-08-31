# 云端 Skill「引用式加载」设计

> 状态：**设计中（待评审）**。用于把云端市场 skill 从"安装到本地长存"改为"只引用、用时临时下载、用完即删"，以保护云端数据不在本地长期留存。

---

## 1. 背景与目标

**现状**：从市场 pull 一个 skill → 下载 zip → 解压到 `skills_dir/<folder>`（**永久存**）→ 记进 `skill_pull_config.json` → 本地扫描目录、按需调用。

**目标**：为保护云端数据，市场 skill 改为：
- "安装" = 只在本地留一条**引用**（轻量元数据，不含内容）；
- 实际**调用数据 / 执行脚本**时，才从云端下载 zip → 解压到临时目录 → 读/执行 → **用完立即删除**全部文件。

**已确认的需求边界（决策）**：
1. 需求是**「不长存」**，不是「不落盘」。执行/读取瞬间文件会临时落到磁盘，执行完即删，这可接受（脚本要跑、reference 要读，不落盘不现实）。
2. 临时目录放**系统临时区**、前缀**不含 "skill"**、`sessionId` 可用、**保持简单**；并发各自独立目录、互不影响（§4）。
3. 删除粒度**激进**：一次「脚本执行完」或「reference 数据读取完成」就删该次的临时文件。
4. 引用库**不新增数据库表**，沿用现有**文件式存储**（JSON，落在 data_dir）。
5. **本地自建 skill 不改**（仍走 `LocalSkillCapabilityProvider`、永久存）；页面上需**区分本地 skill 与云端 skill**；市场"安装"按钮改为"**引用**"。
6. 现有已安装的市场 skill **迁移**为引用式并删除其本地文件（§10）。
7. 离线不可用是预期行为：**写日志 + 向 LLM 返回说明**，不崩流程（§6）。
8. **mythos 引用按用户隔离**：skill 可见性因人而异，引用记 `owner`，列表按当前登录用户过滤，materialize 用**当前用户**身份（方案 A，§8）。**cowork 本轮视为公开、不做用户区分**。

---

## 2. 为什么现有架构天然适合：Skill 的三层

`LocalSkillCapabilityProvider` 已把一个 skill 拆成三层暴露：

| 层 | 内容 | 来源 | 新模型归属 |
|---|---|---|---|
| **Level 1 (list)** | name / description / triggers / version | SKILL.md frontmatter | **引用库持久化**（广告元数据，非受保护内容） |
| **Level 2 (load_definition)** | 指令正文 instructions | SKILL.md 正文 | **临时化**（属受保护内容） |
| **Level 3 (list_files / load_resource / exec_script)** | references/ + scripts/ | skill 目录文件 | **临时化**（受保护内容 + 脚本） |

LLM 靠 Level 1 知道"有这个 skill、干啥用"→ 决定使用 → Level 2 读指令 → Level 3 读文档/跑脚本。

**映射**：引用 = 只持久化 Level 1；内容（Level 2/3）用时临时下载、用完删。核心改动是"换存储 + 加 materialize-on-demand"，**不动三层协议和执行器**。

---

## 3. 总体架构

```
安装/引用（一次性）:
  pull → download_zip 一次 → 解压到临时目录 → 解析 SKILL.md frontmatter(Level1)
       → 写入「引用库」(source, remote_id, name, desc, triggers, version) → 删临时文件

运行时(每次 Level2/3 操作):
  materialize: 按 source 下载 zip → 解压到 skill_cloud/<sessionId>/<skill>/<uuid>/
             → 执行该次操作(读指令 / 读 reference / 跑脚本)
             → 操作结束立即删 <uuid> 目录
  Level1(list): 直接从引用库出，不下载
```

**新增/改动组件**：
1. **引用库 `SkillReferenceStore`**（文件式，替代/扩展 `SkillPullStore`）：持久化每条引用的元数据 + source + remote_id，**不存文件**。
2. **安装流程改造**：`MarketService.pull` 不再解压到 `skills_dir`，改为"下载一次 → 抽 frontmatter → 存引用 → 删临时"。
3. **新 Provider `ReferencedSkillCapabilityProvider`**：Level 1 从引用库出；Level 2/3 先 materialize（下载解压到临时目录）再委托原有读取/执行逻辑，操作完即删。
4. **下载分发**：复用现有 cowork / mythos 的 `download_zip`（见 §7）。
5. **清理生命周期**：每次操作后删；会话结束扫会话目录；启动时扫孤儿目录（防崩溃残留）。

**本地 skill 与云端引用 skill 并存**：两个 provider 同时给 agent 供给 Level 1 列表 —— `LocalSkillCapabilityProvider`（本地永久） + `ReferencedSkillCapabilityProvider`（云端引用）。

---

## 4. 临时目录布局与并发（决策：简单、前缀不含 "skill"）

**约束**：不放工程目录；根前缀**不含 "skill" 字样**；`sessionId` 可用；**保持简单**（越简单越不易出错）。

**路径**：`<系统临时区>/imc-rt/<sessionId>/<random>/`
```
<tempfile.gettempdir()>/imc-rt/<sessionId>/<random>/
    SKILL.md
    references/...
    scripts/...
```
- 根：系统临时区（`tempfile.gettempdir()`，不在工程里，OS 也会自行回收）。
- 前缀 `imc-rt`（**不含 skill**）。
- `<sessionId>`：分组，便于会话结束时**按目录整片清扫**（无需内存映射，简单）。
- `<random>`：`tempfile.mkdtemp` 生成，隔离**同会话内并发**（`NLC_TASK_MAX_CONCURRENT` 多工具并行）的多次 materialize，一方删除不影响另一方。

**清理**（简单、按路径）：
- **每操作**：删该次 `<random>`。
- **会话结束**：`rmtree <tmp>/imc-rt/<sessionId>/`。
- **启动**：`rmtree <tmp>/imc-rt/`（清崩溃残留）。

---

## 5. 引用库数据结构（决策 4：文件，不建表）

现有 `SkillPullStore` 就是 JSON 文件（`<data_dir>/skill_pull_config.json`，仅存 `{source:remote_id → 本地文件夹}`）。引用库沿用文件式，**升级其结构**（或新建 `skill_references.json`），每条引用存元数据、不存文件夹：

```jsonc
{
  "version": 2,
  "references": {
    "cowork:123": {
      "source": "cowork",
      "remote_id": "123",
      "name": "pdf-extractor",
      "description": "从 PDF 抽取结构化数据",
      "triggers": ["pdf", "抽取"],
      "skill_version": "1.2.0",
      "referenced_at": "2026-07-08T10:00:00Z"
    },
    "mythos:abc": {
      "source": "mythos", "remote_id": "abc", "name": "...",
      "owner": "a001"      // 仅 mythos：引用者用户名，用于「列表按当前用户过滤」（见 §8）
    }
  }
}
```

- key 仍是 `<source>:<remote_id>`（沿用现有命名空间，防两市场 id 撞车）。
- `owner`：**仅 mythos 条目**存 —— skill 可见性因人而异，用它把列表**按当前登录用户过滤**（见 §8）。
  - 注意：`owner` 只用于**过滤列表**；materialize 下载用的 username 是**当前登录用户**（方案 A），不是 `owner`（防越权，见 §8）。
  - cowork 本轮视为公开，条目**不存 owner**、对所有用户可见。
- **迁移**：见 §10。
- **兼顾现有测试**：`SkillPullStore` 已有测试 `tests/test_skills_pull_store.py`（断言 `record_pulled` / `get_pulled_map` / `remove_pulled_by_folder` 的 `{source:remote_id→folder}` 语义）。升级为引用库时：要么保留这些方法语义、要么演进为新结构并同步更新该测试。

---

## 6. 运行时流程（三层）

**Level 1 — list**：`ReferencedSkillCapabilityProvider.list()` 把引用库转成 `SkillCapability(name, description, triggers, version)`。零下载、零落盘。**mythos 条目按「当前登录用户」过滤**（只列 `owner == 当前用户` 的；cowork 条目不过滤，见 §8）。

**Level 2 — load_definition（读指令）**：
```
materialize(session_id, skill) → temp = <tmp>/imc-rt/<sessionId>/<random>/   # 见 §4
load_skill_md(temp) 取正文 → 返回 instructions
finally: rmtree(temp)          # 决策 3：读完即删
```

**Level 3 — load_resource / list_files（读文档）**：
```
materialize → temp
读 temp 下目标文件 / 列文件 → 返回内容
finally: rmtree(temp)          # 读完即删
```

**Level 3 — exec_script（跑脚本）**：
```
materialize → temp（解压整包，脚本可能引用同目录其它文件）
在 temp 下执行脚本（复用现有 bash_runner / workspace venv / 超时 / 隐藏窗口）
脚本进程退出后 → rmtree(temp)  # 决策 3：执行完即删
```

**复用**：materialize 后的读取/执行**完全复用**现有 `load_skill_md` 与脚本执行链路（可内部构造一个指向 temp 的临时 `LocalSkillCapabilityProvider`，或抽出公共读取/执行函数），避免重复实现。

**代价（决策 3 明确接受）**：一次 skill 使用跨多个 Level 2/3 操作 → 每个操作各下载解压一次。对大 zip、高频使用的 skill 有明显重复下载与延迟。这是"激进删除 + 不长存"的取舍。

**下载失败（离线等）处理（决策：离线不可用）**：materialize 时下载/解压失败 → **写日志**（WARNING，含 source/remote_id/原因）+ 向 LLM **返回一段清晰说明**（如"该云端技能当前无法加载：云端不可达；请稍后再试或改用其它方式"），让 agent 知情并据此回复用户，而非抛异常崩流程。确保失败时已建的临时目录被清掉、不留半包。

---

## 7. cowork vs mythos 下载差异

复用现有两套 `download_zip`（`MarketService.pull` 已按 source 分发）：

| source | 接口 | 额外要求 |
|---|---|---|
| cowork | `CoworkSkillService.download_zip(remote_id)` | 无 |
| mythos | `MythosSkillService.download_zip(skill_id, username)` | **需 username**（`x-gde-username`），见 §8 |

materialize 时按引用的 `source` 选对应 service。cowork 直接下；mythos 用**当前登录用户**的 username（方案 A，§8），非引用里的 owner。

---

## 8. 运行时当前用户 + 多用户隔离（mythos）

### 8.1 问题
`ProviderContext` 只带 `session_id / agent_id / skill_name / extra`，**不带 username**。而 mythos 有两处按用户区分：
1. **可见性因人而异**：不同用户能看到的 skill 不同 → 引用列表必须**按当前用户过滤**。
2. **下载需 username**：`MythosSkillService.download_zip(skill_id, username)` 要 `x-gde-username`。

安装/引用时能拿到 username（前端请求带的，`getSession().username`）；但**运行时执行 skill 是 agent 在跑、没有前端请求**，两处都拿不到当前用户。

### 8.2 关键场景（为什么必须按用户隔离）
A 登录 → 引用了「只有 A 能看到」的 mythos skill → 切换 B 登录：
- **列表**：若引用库是全局一份，B 会看到 A 的引用（B 无权），错。
- **越权**：若 materialize 用「引用里存的 A 的 username」下载，B 就借 A 的身份拿到 A 的私有 skill → **数据泄露**。

### 8.3 决策：方案 A —— 登录后把「当前用户名」注入后端，运行时读它
- **electron/渲染层**：登录（或切换账号）后，把当前 `getSession().username` 推给后端一次（如 `POST /api/v1/current-user`）。
- **后端**：进程级持有「当前用户名」（线程安全）。mythos 相关**列表过滤**与**下载**都读它。
- **引用带 `owner`**（§5）：mythos 每条引用记录引用者用户名。
- **列表按当前用户过滤**：`ReferencedSkillCapabilityProvider.list()` 只返回 `owner == 当前登录用户` 的 mythos 引用（cowork 引用不过滤，见 8.5）。
- **materialize 用「当前登录用户」下载**（不是 `owner`）：B 触发的下载一律用 B 的 username → mythos 按 B 的权限校验 → **B 拿不到 A 的私有 skill**，从根上防越权。

### 8.4 各场景行为
- **A 引用、A 使用**：列表可见、当前用户=owner=A → 下载正常。
- **切到 B**：A 的引用对 B **不可见**（不是失效，是过滤隐藏；A 回来仍在）；B 只看到 B 自己的。
- **owner 自己后来无权了**（权限被回收）：materialize 用当前用户下载 → mythos 拒 → 走「离线/不可用」降级（日志 + 告知 LLM），不崩。
- **后端还没拿到当前用户名的窗口**（app 刚启动、尚未推送）：mythos 列表/下载按「用户名为空」优雅降级（跳过 mythos / 报清晰错），登录后立即恢复。

### 8.5 cowork 本轮不做用户区分
cowork 当前 catalog/download **是公开的**（不带用户身份），`download_zip(remote_id)` 也不需要 username。所以：
- cowork 引用**不存 owner、不按用户过滤、对所有用户可见**；
- 若以后 cowork 也要按用户可见（它上传已带 JWT），需 cowork 服务端支持、且 download 也转发用户 token —— **留待后续**，本轮不处理。

### 8.6 改动量（方案 A）
- 后端：进程级「当前用户名」持有者 + setter 端点（`POST /current-user`）；mythos 列表/下载读它。~30-50 行。
- 渲染层：AuthGate 解析出 user 后调一次该端点。~5-10 行。无 electron 主进程改动。
- 顺带可简化现有 catalog 的「每请求传 username」（改读全局）—— 可选，后续优化。

---

## 9. 前端改动（决策 5：区分本地 / 云端）

- **本地 skill 列表接口**需为每条带上来源标记：`origin: "local" | "cloud"`，云端再带 `source: "cowork" | "mythos"`。
- 页面在每条 skill 上加**徽章**：`本地` / `云端(cowork)` / `云端(mythos)`。
- "安装"按钮语义**改为"引用"**（决策 4 确认）；卸载 = 删除引用。
- 云端引用 skill **不占本地内容空间**，列表数据来自引用库；本地 skill 仍来自 `skills_dir` 扫描。
- （可选）云端 skill 卡片提示"使用时从云端加载"，让用户知道它离线不可用。

---

## 10. 迁移（现有已 pull 的 skill）

**决策：迁移**（已确认可迁移）。现有 `skill_pull_config.json` 里记录的、已解压在 `skills_dir` 的市场 skill：
- **迁移策略**：加载时把这些条目转成"引用"（source/remote_id 已有；name/desc/triggers 从其现存 `skills_dir/<folder>/SKILL.md` 读一次补齐），随后**删除 `skills_dir` 下这些市场 skill 的文件**（它们改为引用式）。
- **注意只删市场来源的**，用户自建的本地 skill（不在 pull store 里）**不动**。
- 迁移需幂等、可回滚（先备份/软删，确认无误再清）。
- 迁移一次性触发（首次加载升级版引用库时），之后走引用式。

---

## 11. 清理与健壮性

- **每操作删**（主）：Level 2/3 操作 `finally` 里 rmtree 该 `<uuid>`。
- **会话结束扫**：会话终态时删 `<tmp>/imc-rt/<sessionId>/`。
- **启动扫孤儿**：进程启动时清空整个 `<tmp>/imc-rt/`（残留必是崩溃遗留，无长存价值）。
- **失败处理**：下载失败 / 解压失败 → 报清晰错误（skill 暂不可用），并确保已建的临时目录被清掉，不留半包。
- **磁盘安全**：materialize 前校验 zip 合法（复用现有 `zipfile.is_zipfile` 检查）、解压路径防穿越（复用现有 `extract_zip` 的防护）。

---

## 12. 取舍与影响

- **离线不可用**：引用式云端 skill 每次用都要联网；现在已安装的能离线用 → 变化点，需接受/告知用户。
- **延迟**：每次操作下载解压有延迟（决策 3 激进删除放大了重复下载）。
- **数据保护语义**：是"**本地不长期留存副本**"，不是"永不落盘"；执行瞬间明文在磁盘（§1 已确认可接受）。
- **本地 skill 零影响**：机制、性能、离线全不变。

---

## 13. 落地顺序建议
1. 后端：进程级「当前用户名」持有者 + `POST /current-user` 端点（方案 A，§8）；渲染层登录后推送。
2. 后端：`SkillReferenceStore`（升级/替换 pull store，含 mythos `owner`）+ 安装流程改造（下载一次抽元数据）。
3. 后端：`ReferencedSkillCapabilityProvider`（Level1 出引用、mythos 按当前用户过滤；Level2/3 materialize+删；mythos 下载用当前用户）+ 复用下载分发。
4. 后端：清理生命周期（每操作 / 会话结束 / 启动扫孤儿）+ 迁移逻辑。
5. 前端：列表带 origin/source + 徽章 + "引用/卸载"语义。
6. 联调：cowork + mythos 各验一遍；并发同 skill 验隔离；**多用户验隔离（A 引用切 B 看不到、B 用自己身份下载）**；崩溃残留验清扫。

---

## 14. 决策汇总（本轮已全部拍板）

- 临时目录：`<系统临时区>/imc-rt/<sessionId>/<random>/`，前缀不含 "skill"，简单、按路径清扫（§4）。
- 引用库：文件式（升级 `skill_pull_config.json`），不建表；mythos 条目带 `owner`（§5）。
- 运行时当前用户：**方案 A —— 登录后注入后端**，用于 mythos「列表按用户过滤」+「下载用当前用户」（§8）。
- **多用户隔离（mythos）**：引用按 `owner` 过滤列表；materialize 用当前登录用户身份（防越权）；cowork 本轮视为公开、不做用户区分（§8）。
- 现有已安装市场 skill：**迁移**为引用并删本地文件（§10）。
- 离线不可用：**写日志 + 向 LLM 返回说明**，不崩（§6）。
- 前端按钮改为"**引用**"，页面区分本地/云端（§9）。
- 本地自建 skill：**不动**。

> 设计已闭环，可进入开发。落地顺序见 §13。

---

## 15. 关联文件（现状锚点）
- `src/netlivecowork/providers/capability/skills/market_service.py` — 聚合 + `pull` + source 分发。
- `src/netlivecowork/providers/capability/skills/pull_service.py` — cowork `download_zip`。
- `src/netlivecowork/providers/capability/skills/mythos_service.py` — mythos `download_zip(username)`。
- `src/netlivecowork/providers/capability/skills/store.py` — 现 `SkillPullStore`（将升级为引用库；其测试见 `tests/test_skills_pull_store.py`）。
- `ctx-weft/src/ctx_weft/protocols/capability.py` — `SkillCapabilityProvider` 三层协议：`list` / `load_definition` / `list_files` / `load_resource` / `exec_script`（新引用 provider 实现同一套）。
- `src/netlivecowork/providers/capability/skills/zip_utils.py` — `extract_zip` / `sanitize_folder`。
- `ctx-weft/src/ctx_weft/providers/capability_skill_local/provider.py` — 三层 provider（新引用 provider 参照/复用）。
- `ctx-weft/src/ctx_weft/protocols/context.py` — `ProviderContext`（username 注入点讨论见 §8）。

# 会话上报增强:附带 skills / agents / references / configs

- 日期:2026-07-16
- 状态:设计已确认,待写实现计划
- 相关既有设计:
  - `docs/observability-docs/specs/2026-06-11-phase-c-session-report-design.md`(session-report 原始设计)
  - `docs/superpowers/plans/2026-06-25-phase-c-session-report.md`
  - `docs/superpowers/specs/2026-06-25-client-observability-db-export-design.md`(SQLite 导出契约)

## 1. 背景与目标

今天用户点击"上报此会话"时,Electron 主进程把三样东西打进一个 zip 上传:

1. `session-{id}.sqlite.gz` — 后端 `GET /api/v1/sessions/{id}/export` 返回的 gzip(sqlite)(`electron/lib/session-report.js:12`)
2. `environment.json` — 客户端环境块(`electron/main.js:1319-1325`)
3. 运行日志尾巴(每文件 256KB,`electron/lib/log-bundler.js:collectTail`)

组装在 `electron/lib/session-report.js` 的 `buildSessionReportEntries`(纯函数),由 `report-session` IPC handler(`electron/main.js:1307-1342`)喂数据。

**目标**:上报时额外附带诊断/复现所需的本地数据文件——skill references、本地 skills 文件夹、本地 agents 文件夹,以及 llm/mcp/.env 等配置——让接收端能更完整地还原会话上下文。

## 2. 数据位置(均在 AppData 下,Electron 主进程可直接读)

在打包安装态,所有用户可变数据都解析到 Electron 的 AppData 目录(`electron/main.js:411-421`):

- 本地 skills 文件夹:`getUserSkillsDir()` = `<AppData>/skills`(`electron/main.js:490`,对应 `IPMC_SKILLS_DIR`)
- 本地 agents 文件夹:`getUserAgentsDir()` = `<AppData>/agents`(`electron/main.js:491`,对应 `IPMC_AGENTS_DIR`)
- data 目录:`<AppData>/data`(`IPMC_DATA_DIR`),内含:
  - `skill_references.json`(云端引用技能的元数据清单,`SkillReferenceStore`)
  - `skill_pull_config.json`(旧的已拉取技能记录,`SkillPullStore`)
  - llm / mcp 等配置文件
- `.env`:`<AppData>/.env`(`electron/main.js:426`)

后端 `src/ipmastercowork/paths.py` 是这些路径的 Python 侧单一真相(`skills_dir()`/`agents_dir()`/`data_dir()`/`resources_dir()`),但本设计不改后端。

## 3. 架构决策:Electron 侧组装(方案 A)

**采用方案 A**:在 Electron 侧读取 AppData 下的静态文件,追加为 zip entry。

理由:

- Electron 主进程本来就为设置环境变量读过这些路径(`envPathVals` / `getUserSkillsDir` / `getUserAgentsDir`),直接访问最自然。
- 后端零改动;与"最终 zip 由 Electron 拼"的现有架构一致。
- live SQLite 需要后端导出,是因为它是活动数据库、需一致性快照;而 skills/agents/配置是磁盘上的静态文件,Electron 直接读即可,无需再走 HTTP。

**否决方案 B(后端新路由打包)**:多一条链路,且后端要重复实现 Electron 已能做的文件遍历/打包,收益不抵成本。

## 4. zip 布局

在现有 3 项之外新增(zip 内用目录前缀分区):

```
session-{id}.sqlite.gz          (现有)
environment.json                (现有)
<run-log tails...>              (现有)
skills/<相对路径...>             (新增:递归 <AppData>/skills 全部文件,保留相对路径)
agents/<相对路径...>             (新增:递归 <AppData>/agents 全部文件,保留相对路径)
config/skill_references.json    (新增,存在才带)
config/skill_pull_config.json   (新增,存在才带)
config/.env                     (新增,存在才带)
config/<llm/mcp 配置...>         (新增,存在才带)
report-manifest.json            (新增:见 §6)
```

**config/ 用显式 allowlist,不盲扫 data 目录**:data 目录里还躺着 SQLite 库(如 `ipmc-dev.db`)、WAL、以及其它运行态文件,盲扫会把它们卷进来(与会话 SQLite 重复、体积失控)。因此 config 只取明确列举的配置文件:`skill_references.json`、`skill_pull_config.json`、`.env`(在 AppData 根,非 data 下),以及 llm/mcp 配置文件(具体文件名在实现计划阶段按 `startup.py` / config 加载逻辑核实后固定为 allowlist)。allowlist 之外的一律不带。

## 5. 体积安全阀

服务端对上传包有 **20MB 上限**(见 `electron/lib/log-bundler.js:30` 注释;现有 `collectFull` 用 16MB raw 预算确保 zip 后稳在其下)。

对 `skills/` 与 `agents/` 目录遍历:

- **单文件 > 2MB**:跳过,记入 manifest 的 `skipped`。
- **合计 raw 预算 16MB**(skills + agents 共享一个预算,与现有 `collectFull` 约定对齐):累计达到预算后,剩余文件不再纳入,全部记入 `skipped`(原因 `budget-exceeded`)。
- 遍历顺序稳定(相对路径排序),使"哪些被跳过"可预测、可测试。

`config/` 下的 JSON / .env 等小配置文件**不受此约束**(体积可忽略,且是诊断关键)。

**不静默截断**:被跳过的每个文件都出现在 `report-manifest.json` 里,接收端能一眼看出上报包不完整及原因。

## 6. report-manifest.json 结构

```json
{
  "generated_for_session": "<sessionId>",
  "sources": {
    "skills": { "status": "present|absent", "dir": "<AppData>/skills", "included": 12, "bytes": 34567 },
    "agents": { "status": "present|absent", "dir": "<AppData>/agents", "included": 3, "bytes": 8901 },
    "config": { "included": ["skill_references.json", ".env", ...] }
  },
  "skipped": [
    { "path": "skills/big/asset.bin", "bytes": 5242880, "reason": "file-too-large" },
    { "path": "agents/x/y.md", "bytes": 1234, "reason": "budget-exceeded" }
  ],
  "errors": [
    { "path": "skills/locked.md", "reason": "<读文件异常信息>" }
  ]
}
```

## 7. 密钥处理:原样带上(不脱敏)

llm / mcp / `.env` 含 API key、`DATABASE_URL` 及 LLM 身份密钥。用户在被两次提醒泄漏风险后**明确选择原样带上、不脱敏**,理由是上报目标是其自身可控的内网 telemetry 环境。

因此本设计**不做脱敏**。配置文件字节原样纳入 zip。(若未来上报目标外扩,应新增脱敏开关;当前 YAGNI。)

## 8. 错误处理原则

上报是尽力而为的诊断行为,任何单点失败都不得阻断整体上报:

- 目录不存在(如用户从没建过 skills):该源标 `absent`,不报错、不阻断。
- 读单个文件失败:记入 manifest 的 `errors`,继续遍历。
- 整体流程与今天一致:仅用户显式点击 + `shouldReportTelemetry(updateConfig)` 门控(`electron/main.js:1309`),这是唯一上传会话内容的路径。

## 9. 实现落点

- **新增** `electron/lib/report-collect.js`(或并入 `log-bundler.js`):纯函数 `collectDirTree({ dir, prefix, perFileBytes, budget, fsImpl })` → `{ entries, skipped, bytesUsed }` 及 `absent` 标记;递归遍历目录、保留相对路径、施加 §5 安全阀。做成纯函数便于单测。
- **改** `electron/lib/session-report.js`:`buildSessionReportEntries` 新增入参(如 `extraEntries`、`manifest`),把新 entry 与 `report-manifest.json` 追加到返回数组。保持纯函数。
- **改** `electron/main.js` 的 `report-session` handler(1307-1342):在收集 sqlite/env/logs 之后,调用 `collectDirTree` 遍历 `getUserSkillsDir()` / `getUserAgentsDir()`,读取 `config/` 下各文件,组装 manifest,传入 `buildSessionReportEntries`。

## 10. 测试

扩展 `electron/test/session-report.test.js`(用注入的 `fsImpl` / 内存目录):

- 新 entry 名与目录前缀正确(`skills/…`、`agents/…`、`config/…`、`report-manifest.json`)。
- 单文件 > 2MB 被跳过且出现在 manifest `skipped`(原因 `file-too-large`)。
- 合计超 16MB 预算后剩余文件进 `skipped`(原因 `budget-exceeded`)。
- 缺失目录 → manifest 标 `absent`,不抛错,现有 3 项仍正常上报。
- 配置文件原样纳入(字节不变、不脱敏)。
- 读文件异常 → 记入 `errors` 且不中断。

`electron/lib/log-bundler.js` 现有测试不受影响(若新增 helper 独立成文件)。

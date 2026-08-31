# 设计:升级时规整用户 `.env`（env reconcile on upgrade）

日期：2026-06-25　范围：Electron host（`electron/main.js` + 新 `electron/lib/`）

## 背景与问题

启动用的 `.env` 在 `%APPDATA%\IPMaster-Cowork\.env`，由 `ensureUserEnvFile()` **create-once**（仅在不存在时写）。后果：

- 新版改了出厂默认值（典型：`IPMC_LLM_BASE_URL` 从 `…:10020` 改成 `…:10020/v1`），老用户的 `.env` 永不刷新，拿不到新值。
- 旧版残留的、或非 `IPMC_` 命名空间的杂键无人清理。
- 路径键的**运行时**已由 `startBackend` 的 spawn env 钉死到 AppData（fix #1，本设计**不动它**），但 `.env` 文件本身仍可能是旧的/不准的。

## 目标

升级时（版本变化）对用户 `.env` 做一次**幂等规整**，向"当前 canonical 形态"收敛，且**绝不误删用户自定义值**。

## 非目标

- 不改 spawn env 的路径钉死（fix #1 保留）。运行时路径仍以 spawn 注入为准。
- 不做全量 merge（不拖入模板的注释/全部键——这是先前被否决的方案）。
- 不改 core 的 `IPMC_LLM_*` 自举读取逻辑。

## 触发时机

- 独立 marker 文件：`%APPDATA%\IPMaster-Cowork\.env-reconciled-version`。
- 在 `app.whenReady()` 中、`startBackend()` **之前**调用 `reconcileUserEnv()`。
- 运行条件：`.env` 存在 **且** marker ≠ `app.getVersion()`（或 marker 缺失）。
  - `.env` 不存在 → 跳过（全新安装交给 `ensureUserEnvFile` 创建），并写 marker。
- 处理完写 marker = 当前版本。→ 同版本再启动是 no-op。

## 键策略注册表（canonical schema）

每个 canonical 键声明一个 policy：

| policy | 行为 | 键 | canonical 值来源 |
|--------|------|----|------------------|
| **force** | 总是设为 canonical 值，覆盖用户 | `DATABASE_URL`、`IPMC_LLM_ACCOUNT/STYLE/API_KEY/BASE_URL/MODEL`（厂商控制的出厂 LLM 身份/凭证，升级必须跟随构建；.env 手改不保留，定制走 UI） | 模板 `.env.example` 当前激活值（`DATABASE_URL`=`sqlite`） |
| **managed** | 用户值 ∈ `oldDefaults` → 改成 canonical 值；= 用户自定义 → 保留；缺失 → 补 canonical 值 | `IPMC_LLM_CONTEXT_LIMIT/MAX_OUTPUT_TOKENS/TIMEOUT_SEC`、`IPMC_HTTP_SSL_VERIFY`、`IPMC_SKILL_PULL_SERVER_URL`、`IPMC_TASK_MAX_RETRIES`、`IPMC_TASK_MAX_CONCURRENT`、`IPMC_WATCH_INTERVAL`、`IPMC_DEFAULT_TOKEN_BUDGET`、`IPMC_PIP_INDEX_URL/TRUSTED_HOST/TIMEOUT` | 模板 `.env.example` 当前激活值 |
| **path** | 总是设为计算出的 AppData 绝对路径（forward-slash）；缺失则补 | `IPMC_DATA_DIR`=`<AppData>/data`、`IPMC_RESOURCES_DIR`=`<AppData>/resources`、`IPMC_SKILLS_DIR`=`<AppData>/skills`、`IPMC_AGENTS_DIR`=`<AppData>/agents`、`IPMC_LOG_DIR`=`<AppData>/logs`、`IPMC_LOG_FILENAME`=`backend.log`（定值） | main.js 计算 |

**`oldDefaults` 注册表**（managed 键的历史旧默认值，新值始终取模板当前值）：
- 当前为空 `{}`：现有 managed 键均无历史默认变更 → 只会"缺失补齐"，不会改动已有值；以后某 managed 默认变了，把旧值加进来即可触发迁移。

> **修订（升级覆盖 bug）**：最初把 `IPMC_LLM_*`（含 API_KEY/BASE_URL/MODEL/ACCOUNT/STYLE）全列为 managed，靠 `oldDefaults` 注册表来"认旧默认才覆盖"。但该注册表只登记了 `IPMC_LLM_BASE_URL` 一项，导致出厂 API key 轮换、模型升级等改动在老用户 `.env` 上**永不生效**（旧值未登记 → 被当成用户自定义保留）。修复：把厂商控制的 5 个 LLM 身份/凭证键改为 **force**（升级总是跟随模板），`oldDefaults` 随之清空。policy 列表与 `buildEnvCanonical` 已移入 `lib/env-reconcile.js` 便于单测（见 `env-reconcile.test.js` 的 upgrade 回归用例）。

## 操作（逐键 / 逐行）

1. 解析现有 `.env`（保留注释、空行、未知行的原始顺序）。
2. 对每个 canonical 键按 policy 计算目标值并应用：命中已有赋值行 → 改值；缺失 → 末尾补 `KEY=value`。
3. 删除"**赋值行且键名不以 `IPMC_` 开头**"的行；白名单 `{DATABASE_URL}` 除外（保留 + 已被 force 更新）。
4. 注释行（`#` 开头）与空行**保持不动**。

## DATABASE_URL 决策

`DATABASE_URL` 由 host `config.py:162` 读取（core 不读）；不带 `IPMC_` 前缀是有意沿用 12-factor 通用约定。**保留为删除规则的白名单例外**，且**强制更新为 `sqlite`**（桌面版 DB 恒为 AppData/data 下本地 SQLite，用户即便改过也拉回）。

## 模块划分

### 纯函数 `electron/lib/env-reconcile.js`（可单测，仿 `lib/seed-migration.js`）

```
reconcileEnv(existingText, { canonical, keepNonIpmc }) -> { text, changed }
```
- `canonical`: `[{ key, policy:'force'|'managed'|'path', value, oldDefaults? }]`
- `keepNonIpmc`: 删除规则白名单，默认 `['DATABASE_URL']`
- 不碰 fs / electron；模板值与路径值由调用方算好传入。

### `electron/main.js` 接线

- 新函数 `reconcileUserEnv()`：读 `.env` + 随包模板 `.env.example` → 组装 `canonical`（模板激活值 / 计算的 path 值 / `oldDefaults` 注册表）→ 调 `reconcileEnv` → 变了就写回 + 写 marker。
- 在 `whenReady` 里、`startBackend` 前调用，受 marker 门控。
- **配套修补**：`ensureUserEnvFile` 创建分支补上 `IPMC_RESOURCES_DIR` 的路径替换（当前只填 DATA/SKILLS/AGENTS，漏了 RESOURCES），让全新安装也一致。

## 测试（`electron/test/env-reconcile.test.js`）

- managed：= 旧默认 → 更新；= 用户自定义 → 保留；缺失 → 补齐。
- force：总是覆盖（`DATABASE_URL=postgresql://…` → `sqlite`）。
- path：重写成给定 AppData 路径；缺失 → 补。
- 删除非 `IPMC_` 赋值键；`DATABASE_URL` 白名单保留。
- 注释 / 空行 / 未知注释不动。
- 幂等：对结果再跑一次 `changed=false`、文本不变。

## 风险与备注

- 0.4.6→0.4.7 这一跳：旧 **install 目录**里的配置已被 NSIS 抹掉、无法挽救；本机制规整的是 **`.env` 文件本身**，不负责找回已丢的 llm_configs。
- force `DATABASE_URL=sqlite` 会覆盖用户自设 DB —— 桌面版刻意如此。
- 路径键虽被 spawn 钉死、运行时不读 `.env` 值，仍校正以保文件准确（用户可能直接看/编辑 `.env`）。
- 删除非 `IPMC_` 键是版本门控、非每次启动 —— 降低误删用户临时加的自定义键的概率，但仍是有意的清理行为。

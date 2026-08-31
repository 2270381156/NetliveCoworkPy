# 桌面端更新系统 — 设计文档

- 日期：2026-05-28
- 状态：待评审
- 适用：NetLIVE-CoWork 桌面端（Electron + 内嵌 PyInstaller 后端）
- 范围：客户端自助更新 + 客户端遥测上报 + 服务端更新管理服务（统计 + 发布管理）

## 0. 概览与交付物拆分

应用即将迁移到内网、面向多用户开放，当前为 beta、需高频迭代。由于是**桌面端分发**（每用户本地一份 Electron 应用 + 本地后端实例，互不可达），首要诉求是**把新版本自动推达分散的用户**，并能**观测更新效果**与**管理发布**。

本设计是**一份完整 spec**，但**实现拆为两个独立交付物**（见 §16）：

| 交付物 | 内容 | 形态 |
|---|---|---|
| **① 客户端**（Part A） | electron-updater 自助更新 + 分发 + 遥测上报 | Electron/前端代码，现有 app 仓 |
| **② 管理服务**（Part B） | 遥测 ingest + 存储 + 发布管理 + 统计看板 + 产物托管 | 服务端应用（API + DB + 后台 UI），单独仓 / `server/` 组件 |

两者仅通过两个契约耦合：**遥测事件 schema**（§C1）与 **feed/产物布局**（§C2）。①可先在单机独立验证，不依赖②。

**不在本次范围**：OAuth（agent 认证，独立后做）、mac/Linux、代码签名（推荐可选）、`stagingPercentage` 百分比放量（已明确不做）。

---

# Part A — 客户端

## A1. 架构总览

- 更新逻辑完全在 Electron 主进程（`electron-updater`）。Python 后端基本不动，仅两处协同：**安装前优雅停后端**、**升级后版本感知补种**。
- 客户端额外**主动上报更新生命周期遥测**到②的 ingest 端点。
- feed 与产物由②托管（生产）；单机验证时用 localhost 静态服务器。

## A2. 组件拆分

| 组件 | 位置 | 职责 |
|---|---|---|
| Updater 模块 | 新增 `electron/updater.js` | 解析 feed URL + channel、接 electron-updater 事件、下载策略、触发安装 |
| 遥测上报模块 | 新增 `electron/telemetry.js` | 上报更新生命周期事件，失败重试 + 离线队列 |
| Updater UI | `frontend-desktop` 设置页 | 当前版本、「检查更新」按钮、状态、「重启以更新」 |
| IPC 桥 | `electron/preload.js` | 触发检查、查状态、订阅进度、触发安装（已有 `app-version`） |
| 后端停止协调 | `electron/main.js`（强化 `stopBackend`） | 安装前确保 `netlive-cowork.exe` 退出、端口释放，超时强杀 |
| 版本感知补种 | `electron/main.js`（增强 `seedDefaultData`/`ensureUserEnvFile`） | 版本变化时补缺失默认配置 + `.env` 新增键，绝不覆盖 |
| 发布配置 | `electron/package.json` build | `publish: generic` + 版本化产物 + blockmap |

## A3. 配置解析（feed URL + channel + 遥测端点）

运行时按优先级解析，写在 `electron/updater.js` / `telemetry.js`：

1. 环境变量 `NETLIVE_COWORK_UPDATE_FEED_URL` / `NETLIVE_COWORK_UPDATE_CHANNEL` / `NETLIVE_COWORK_TELEMETRY_URL`；
2. AppData 配置文件 `%APPDATA%\NetLIVE-CoWork\update-config.json`：`{ "feedUrl": "...", "channel": "beta", "telemetryUrl": "..." }`；
3. 打包时 electron-builder 写入的 `app-update.yml` 默认值；
4. feed URL 为空 → 跳过 `checkForUpdates()`，不发请求；telemetry URL 为空 → 不上报。

channel：`beta` → `autoUpdater.channel='beta'`（读 `beta.yml`）；缺省/`stable` → 默认（读 `latest.yml`）。

约束：
- `autoUpdater` 仅 `app.isPackaged` 生效；dev 用 `dev-app-update.yml` + `forceDevUpdateConfig` 调事件接线，但安装步骤仍需已装版。
- **必须注册 `error` 事件**：不可达时静默记日志、app 照常；否则 Node EventEmitter 在 `error` 无监听会抛未捕获异常。

## A4. 更新流程（时序）

1. 启动加载 UI；上报 `app_launch`（当前版本）；
2. feed 已配置 → `checkForUpdates()`；
3. 有新版 → 上报 `update_available` → 后台 `autoDownload`，显示进度；
4. `update-downloaded` → 上报 `update_download_completed` → 提示「重启更新」；
5. 用户确认 → **优雅停后端（§A5）+ 端口释放确认**；
6. `quitAndInstall(false, true)`；
7. 重启新版 → 版本感知补种（§A6）→ 启动时上报新版本 `app_launch`（服务端据此判定升级成功）。

## A5. 后端停止时序（Windows 文件锁，关键风险）

`quitAndInstall` 前必须保证 spawn 的 `netlive-cowork.exe` 已退出，否则 NSIS 覆盖因占用失败。`stopBackend()` 升级：

1. 发 `SIGTERM`；
2. 轮询 `exitCode` / 超时（如 5s）；
3. 超时未退 → `taskkill /PID <pid> /T /F` 杀进程树；
4. 处理「端口被占则复用已有后端」路径下的**孤儿后端**：端口仍占用则定位清理；
5. 确认端口释放后再 `quitAndInstall`。

## A6. 升级数据 / 配置迁移（版本感知补种）

- 用户数据在 `%APPDATA%\NetLIVE-CoWork`，NSIS 只换安装目录 → **天然保留**（验证时眼见为实）。
- 现状 `seedDefaultData`/`ensureUserEnvFile` 是「不存在才建」，升级时新增默认配置/`.env` 键拿不到。改为版本感知：
  - AppData 记 `installed_version`；
  - 启动时比对 `app.getVersion()`：版本变化时补**缺失**默认配置文件、合并 `.env` **缺失键**；
  - 已有内容一律不动；更新 `installed_version`。
- 补种 diff 逻辑抽纯函数，便于单测。

## A7. 灰度发布（仅 B 通道）

- 两条通道：stable → `latest.yml`，beta → `beta.yml`。客户端按 §A3 channel 决定读哪条。
- **beta 入组（方案 A）**：管理员手动给指定机器写 `update-config.json` 的 `channel:"beta"`（或 env）。默认 = stable。人群由「谁能改该机器配置」界定，无需登录。
- **不做** `stagingPercentage` 百分比放量。
- caveat：channel 是**放量机制非访问控制**。无鉴权下知道 beta 路径即可配入 beta。内网受控前提下可接受；若须「禁止」非 beta 用户拿 beta 包，需网络层限制或单独鉴权，属另一件事。

## A8. 客户端遥测上报

- 模块 `electron/telemetry.js`：按 §C1 schema POST 事件到 `telemetryUrl`。
- 可靠性：发送失败写入本地离线队列（AppData 小文件），下次启动/定时重试；不阻塞更新主流程。
- 隐私：携带**匿名 `installId`**（客户端生成的稳定 GUID，存 AppData，**非用户身份、无 PII**）。
- telemetryUrl 未配置则完全不上报（与「feed 未配置则不检查」一致）。

## A9. 更新 UX

启动自动检查；后台自动下载（`autoDownload=true`）；下载完非侵入提示「重启更新」；设置页有手动「检查更新」按钮 + 状态。安装由用户确认触发，不强制。

---

# Part B — 更新管理服务

## B1. 架构总览

独立服务端应用，三块职责：**遥测 ingest + 存储**、**发布管理**（产物 + 清单 + 通道提升）、**统计看板**；并**托管产物与 feed**。部署在内网（单容器即可）。

## B2. 技术栈（推荐，待确认）

- API：**FastAPI**（与现有后端一致，复用模式与团队熟悉度）；
- 存储：**SQLite** 起步（零运维单文件，beta 量级足够；预期增长可换 Postgres）；
- 后台 UI：**React**（与桌面前端栈一致）小型管理页；
- 产物：服务器**文件系统目录** + DB 存元数据/遥测；
- 部署：**Docker 容器**，内网自托管。

## B3. 组件拆分

| 组件 | 职责 |
|---|---|
| 遥测 ingest API | 接收 §C1 事件，校验后落库 |
| 产物/feed 托管 | 静态提供 `latest.yml`/`beta.yml`/`Setup x.y.z.exe`/`.blockmap` + 人用 "latest" 下载入口 |
| 发布管理 API + UI | 上传产物、生成/更新清单、列出版本、**一键 beta→stable 提升**（复制产物+清单） |
| 统计看板 | 下载/安装量、各版本在线分布、**安装成功率**、最近失败列表 |
| 鉴权 | 保护发布管理 + 看板（见 B5） |

## B4. 数据模型（概要）

- `telemetry_events`：`install_id`、`event_type`、`app_version`、`channel`、`os`、`arch`、`error`、`ts`、`received_at`。
- `releases`：`version`、`channel`、`artifact_path`、`sha512`、`size`、`published_at`、`promoted_from`。
- 统计为查询派生：版本分布按 `install_id` 最近 `app_launch`；安装成功率按 `update_download_completed` → 新版本 `app_launch` 配对。

## B5. 鉴权姿态（关键，待确认）

| 端点 | 鉴权 |
|---|---|
| 产物 / feed 下载 | **开放**（靠内网边界 + sha512 + 建议 HTTPS）；与 §A 一致，不耦合 OAuth |
| 遥测 ingest | **内网开放**，可选一个**共享静态 token** 防滥用（客户端无用户身份，POST 前未登录） |
| 发布管理 + 看板 | **必须鉴权** —— 上传产物/提升通道/看统计是特权操作，绝不能裸奔 |

后台登录推荐：beta 起步用**简单运维登录**（账号口令哈希 + 会话/JWT，置于内网）；**待确认**是否后续接入已有 IdP（OIDC SSO）。注意这与「agent 的 OAuth」是两套东西（此处是给发布者的后台登录）。

## B6. 发布流程

1. 每次发版 bump `electron/package.json` `version`；后端 `app/config/settings.py` 的 `app_version`（`/health` 用）对齐同一来源；
2. `electron-builder ... --publish`（或手动上传）把产物经发布管理录入②；
3. 先发 beta 通道 → canary 机器（配 beta）验证一天 → 后台**一键提升 beta→stable**；
4. 托管保留历史版本化文件（差分依赖）+ 维护 "latest" 下载入口；
5. **portable target 不能自动更新**：更新仅针对 NSIS 安装版，portable 作免安装试用、不期望更新。

---

# 共享契约

## C1. 遥测事件 schema

POST JSON 到 `{telemetryUrl}/events`，公共字段 + `event_type`：

公共：`install_id`(匿名 GUID)、`app_version`、`channel`、`os`、`arch`、`ts`。

事件类型：
- `app_launch`（启动时当前版本 → 在线版本分布）
- `update_available`（看到版本 X）
- `update_download_started` / `update_download_completed` / `update_download_failed`(带 error)
- `update_check_failed`（feed 不可达等）

升级成功 = `update_download_completed` 后，同 `install_id` 出现更高版本的 `app_launch`。

## C2. feed / 产物布局

```
{host}/latest.yml          # stable 清单
{host}/beta.yml            # beta 清单
{host}/NetLIVE-CoWork Setup x.y.z.exe
{host}/...exe.blockmap
{host}/download/latest     # 人用首装下载入口（重定向到当前 stable exe）
```

客户端 `feedUrl` 指向 `{host}`；channel 决定读 `latest.yml` 或 `beta.yml`。

---

## 13. 验证与测试

**① 客户端单机验证（同时即开发循环）**：
1. `serve`/`python -m http.server` 起 localhost 文件源，`NETLIVE_COWORK_UPDATE_FEED_URL` 指向它；
2. build `0.1.0` → NSIS **正式安装**（`app.isPackaged` 才生效）；
3. bump `0.1.1` → build → 产物丢进文件源；
4. 启动 `0.1.0` → 检测 → 下载 → 重启为 `0.1.1`；
5. 重点验证：后端 exe 无文件锁失败、`%APPDATA%` 数据保留、版本感知补种生效、blockmap 差分、channel 读 `beta.yml`、遥测事件按序发出（可先指 localhost ingest）。

**② 管理服务本地验证**：本地起服务 → 客户端遥测指向它 → 看板出现事件；上传产物 + 一键 beta→stable 提升后，客户端能拉到对应清单。

**可单测纯逻辑**：feed/channel 解析、版本感知补种 diff、遥测离线队列与重试、安装成功率配对查询。

## 14. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Windows 后端 exe 文件锁 | §A5 强制停后端 + 超时强杀 + 端口确认 |
| 更新/遥测服务器未就绪 | §A3 可配置 + 未配跳过 + 必接 `error` handler + 遥测离线队列 |
| 未签名 SmartScreen | 签名列推荐项，beta 不阻塞；仅首装受影响 |
| 全量包体积大 | blockmap 差分 |
| 升级后缺新默认配置 | §A6 版本感知补种 |
| 管理后台特权裸奔 | §B5 后台强制鉴权 |
| 遥测含 PII | §A8 仅匿名 installId、无用户身份 |

## 15. 不在本次范围

OAuth（agent 认证，独立后做）、mac/Linux、代码签名（推荐可选）、`stagingPercentage` 百分比放量、灰度按身份「禁止访问」（仅做放量）、后台接入 IdP SSO（先简单登录，后续可选）。

## 16. 实现拆分

- **Plan 1 — 客户端（Part A）**：可独立先做、单机验证。依赖②仅为 feed URL 与遥测端点（验证期可用 localhost 顶替）。
- **Plan 2 — 管理服务（Part B）**：独立仓/组件，按 §C1/§C2 契约对接。
- 顺序：建议先①(可立即验证、交付价值)，②并行或随后。两份各自走 spec→plan→实现循环。

## 17. 未决 / 待确认项

- 管理服务技术栈（FastAPI + SQLite + React）—— §B2 推荐，待确认；
- 后台登录方式（简单运维登录 vs 接入 IdP SSO）—— §B5；
- 遥测 ingest 是否加共享 token —— §B5；
- 更新 UX 默认「后台自动下载 + 提示」（vs 下载前征询）；
- 版本感知补种放第一版（§A6）；
- portable 保留但不更新（§B6）；
- 后端 `app_version` 与 `package.json` `version` 的同一来源落地方式（构建注入 vs 手动同步）。

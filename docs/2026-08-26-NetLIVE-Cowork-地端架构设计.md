# NetLIVE Cowork 地端 —— 架构设计

> 本文按**当前实现**写：描述代码现在的样子，不记录设计过程。
> 最后一次按实现校对：2026-08-30（分支 `netlive-cowork`）。
>
> 相关：需求见 `2026-08-26-NetLIVE-Cowork-地端需求.md`，验收对照见
> `2026-08-28-Cowork-验收对照表.md`，打点解耦见 `2026-08-26-运营打点解耦设计.md`。

---

## 0. 这是什么

一个 Windows 桌面应用。用户打开它，看到几个**智能体**（IPMaster Cowork、NFV Cowork……），
选一个开始对话。每个智能体能用哪些 MCP、哪些大模型、哪些技能市场，**由云端授权决定**，
不由用户配置。

技术组成：Electron 主进程 + React 前端 + 随包的 Python 后端（PyInstaller 冻结），
后端跑 `ctx_weft` 内核（只读 wheel，`vendor/` 下有可读副本）。

一个「智能体」在代码里叫 **cowork**，载体是一个签名 zip 套件。

---

## 1. 名词

| 词 | 是什么 |
|---|---|
| **cowork** | 一个智能体。有 id（`ipmaster`）、显示名、能力清单 |
| **套件（package）** | cowork 的载体：签名 zip，含 `cowork.json` + 四个人设 facet + `TOOLS.md` |
| **facet** | 人设文档：`SOUL.md` / `ROLE.md` / `METADATA.md` / `COMPACT.md` |
| **substrate** | 云端管理服务。回答"我被授权了哪几个"、"给我某一个的包" |
| **暂存目录（staging）** | 主进程放 zip 的地方。两个进程之间唯一的交接面 |
| **对账（reconcile）** | 比对"该有哪几个"与"已装哪几个"，装缺的、删多的 |
| **母版（`default`）** | 不是 cowork。历史会话与内部任务靠它，任何权限都收不回它 |

---

## 2. 总图

### 2.1 进程与数据流

```
┌───────────────────────────── 云端 ─────────────────────────────┐
│  substrate   https://ipmastercowork.gts.huawei.com/substrate   │
│    GET /api/me/agents              → [{agentId, version}]      │
│    GET /api/me/agents/<id>/package → zip + X-Package-Sha256    │
└───────────────────────────────┬────────────────────────────────┘
                                │ HTTPS + Bearer（W3 登录态）
┌───────────────────────────────▼────────────────────────────────┐
│ Electron 主进程                                                 │
│   lib/substrate.js    只管说话：列清单、下载包                  │
│   lib/cowork-sync.js  只管落盘：写 zip、写 entitled.json         │
│   启动时同步一次，之后每天一次（substrate 无法主动通知）         │
│   lib/auth.js         W3 登录，令牌来源                          │
└───────────────────────────────┬────────────────────────────────┘
                                │ 暂存目录（文件系统，两进程唯一交接面）
                                │  %APPDATA%\NetLIVECowork\data\cowork-packages\
                                ▼
┌────────────────────────────────────────────────────────────────┐
│ Python 后端 netlivecowork                （详见 2.2）           │
└───────────────────────────────┬────────────────────────────────┘
                                │ HTTP + SSE
┌───────────────────────────────▼────────────────────────────────┐
│ React 前端 frontend-desktop                                     │
│   agents/registry.ts  阵容唯一来源（/coworks → Agent[]）        │
│   agents/lineup.ts    阵容状态：pending / ready / none / …      │
└─────────────────────────────────────────────────────────────────┘
```

主进程与后端的分工是刻意的：**主进程只负责「取」，后端只负责「装」**。取包要登录态和网络，
装包要验签和文件系统；混在一起的话，一次网络失败会表现成"套件被删了"。

### 2.2 后端分层

```
                       HTTP / SSE
                            │
 ┌──────────────────────────▼──────────────────────────────────────┐
 │ api/            FastAPI 路由 + Pydantic schema                   │
 │   sessions / hitl / llms / mcp / skills / workspace / rewind     │
 │   coworks       /coworks、/coworks/{id}/logo、/coworks/recheck   │
 │ api/models/     SessionEntry：进程内会话状态 + 事件→前端帧翻译    │
 └──────────────────────────┬──────────────────────────────────────┘
                            │
 ┌──────────────────────────▼──────────────────────────────────────┐
 │ bootstrap/host_runtime.py     **装配层：唯一同时认识各方的地方** │
 │   _setup_cowork()   ① reconcile  ② 建 scope+policy  ③ 装三处回查 │
 │   把 providers 包上 guards，再注入内核                           │
 └───┬───────────────┬──────────────────┬───────────────┬──────────┘
     │ 读判据         │ 包一层            │ 落盘           │ 归属
 ┌───▼───────────┐ ┌─▼───────────────┐ ┌▼────────────┐ ┌▼─────────────┐
 │ cowork/       │ │ providers/      │ │ persistence/│ │ reporting/   │
 │  套件·授权·归属│ │  LLM / Template │ │  事件落盘    │ │ observability│
 │               │ │  MCP / Skill    │ │  投影 / 快照 │ │  打点·指标    │
 │ **不碰内核**   │ │  ↑ guards 包在  │ │  SSE 帧日志  │ │              │
 │               │ │    这一层外面   │ │             │ │              │
 └───────────────┘ └─┬───────────────┘ └─────────────┘ └──────────────┘
                     │ 注入
 ┌───────────────────▼─────────────────────────────────────────────┐
 │ ctx_weft 内核（只读 wheel）                                      │
 │   CtxWeftRuntime / Loop Engine / EventBus / capability 协议      │
 │   纯引擎：无 HTTP、无 DB、不认识 cowork                           │
 └─────────────────────────────────────────────────────────────────┘

 旁支：auth/（会话令牌）  low_integrity/（全自动模式的边界）
       rewind/（回退快照）  office_broker/  migration/  web/
```

### 2.3 cowork 层怎么接进去

**它不直接连内核**，只通过三条边被别人用：

| 谁用它 | 用来干什么 | 接口 |
|---|---|---|
| `bootstrap/host_runtime` | 装配时对账、建 scope/policy、把 guards 包在 provider 外面 | `reconcile()` / `runtime.setup()` |
| `providers/` 外面的 `guards/` | 运行期问"这条会话能不能用这个能力" | `policy.allows_mcp()` / `scope.cowork_of()` |
| `api/` | 回答 `/coworks`、按 cowork 过滤 `/llms`、给市场页签排序 | `installed.list_all()` / `policy.*` |

方向是**单向**的：`cowork/` 不 import `providers/`、不 import `persistence/`、更不 import
`ctx_weft`。反过来，`providers/` 和 `reporting/` 也不 import `cowork/` —— 它们只接受被注入的
一个回调（`install_resolver` / `install_cowork_markets`）。

这样做的代价与收益都很具体：**代价**是装配层要多写几行显式接线；**收益**是"哪个模块认识
cowork"这个问题永远只有一个答案。反过来做（让每个 provider 自己去问 cowork）的话，
cowork 这个概念会散进四五个包，之后任何一次改动都要在每个包里各确认一遍。

---

## 3. 套件

### 3.1 包的样子

```
<id>-cowork-<version>.zip
  └── <id>/
        cowork.json     清单
        SOUL.md         ┐
        ROLE.md         │ 四个人设 facet
        METADATA.md     │
        COMPACT.md      ┘
        TOOLS.md        工具说明
        logo.svg        可选
      cowork.sig        签名（zip 注释区）
```

**没有签名的包一律不装**（`signature.verify`）。开发密钥只在非冻结构建里认，判据是
`sys.frozen` 而不是环境变量 —— 环境变量能改，构建类型不能。

### 3.2 清单

```jsonc
{
  "schema": 1,
  "id": "ipmaster",              // 判定一切以它为准，不看文件名
  "version": "1.2.0",
  "order": 10,                   // 界面排序
  "branding": {
    "displayName": "IPMaster Cowork",
    "subtitle": "IP 网络",
    "accent": "#3b82f6",
    "logo": "logo.svg"           // 可选；不写则按 logo.svg|png|webp 找
  },
  "mcp":  { "use": [...], "localOnly": [...], "define": { ... } },
  "llm":  { "allow": [...], "define": [...], "default": { ... } },
  "skills": { "marketUrl": "...", "mythosUrl": "..." }
}
```

落到 `manifest.Cowork`。**解析与结构分开**（`manifest_parse` / `manifest`）：解析是纯函数，
不碰文件系统。

`branding.logo` 只存**文件名**，图片是包里的一个文件 —— `/coworks` 是高频接口，把几十 KB
的 base64 塞进清单每次列阵容都要传一遍。文件名会被拼进路径，所以解析时就削成基名，
端点那层再挡一次路径穿越。

---

## 4. 对账

### 4.1 为什么是对账，不是事件

云端**没有推送通道**。"某个 cowork 被收回"在地端的表现是：这次拿到的授权清单里没有这个 id。
差集就是结论。

```
主进程                        暂存目录                      后端
  │                              │                            │
  ├─ GET /api/me/agents ────────►│                            │
  │   [{ipmaster,6},{nfv,3}]     │                            │
  ├─ 逐个比对已装版本             │                            │
  │   版本不同才下载              │                            │
  ├─ GET .../package ───────────►│  ipmaster-cowork-6.zip     │
  ├─ 清掉不在清单里的 zip ───────►│                            │
  ├─ 写 entitled.json ──────────►│  {"agents":["ipmaster",…]} │
  │                              │                            │
  │                              │◄─── reconcile(staging, coworks)
  │                              │       读 entitled.json
  │                              │       扫 zip、验签
  │                              │       plan()  : 装谁、删谁
  │                              │       apply() : 落盘
```

### 4.2 三条判据

**① `None` 与空集合是两件事。**

```python
entitled = staging.read_entitled(staging_dir)   # 读不到 → None
```

`None` 是"这次没拿到清单" —— **一个都不删**。空集合是"确实一个都没有" —— 全删。
搞混的代价是把网络故障当成权限收回，删掉用户的套件连同他改过的提示词，且不可逆；
反过来（该删没删）只是晚一次对账才生效。两个方向的错不对称，所以往安全的一侧偏。

**② 版本只做相等比较，不能写成"变大才装"。** 云端版本是递增整数，管理员回滚时它会**变小**。
写成大于号的现象是"我明明回滚了他还在用新版"，而且不报错。

**③ 不知道该有哪几个时，照装不误。** 与①是同一条原则的两面，因为两个动作可逆性不同：
装可撤销（下次对账不在授权里就删了），删不可逆。这同时让开发态好用 —— 往假云端目录丢几个
zip 就能试，不必先伪造凭据文件。

### 4.3 母版永远保留

`default` 不是 cowork，历史会话和内部任务都靠它。删了的表现是一批老会话集体跑不动，
而原因完全指不到这里。

### 4.4 对账失败不挡启动

连不上云端、暂存目录空的、包全坏了 —— 都只意味着"这次没装上"。应用照常打开，历史会话
照常查看。真要对话时自然会失败，不需要再造一道门去拦。

---

## 5. 能力隔离

一条会话能用什么，由它所属的 cowork 决定。三类能力三条路。

### 5.1 会话 → cowork

`scope.CoworkScope` 只干这一件事：

```
bind(session_id, template_id)     建会话时登记
cowork_of(session_id) → Cowork    运行期回查
set_resolver(fn)                  内存里没有时的回查（重启后恢复的会话）
```

`set_resolver` 必须装。装配期漏了它的表现是：**重启后恢复的会话看得见全部能力** ——
内存里没有绑定记录，回落到"归属未知 → 不过滤"。这个洞出现过一次。

### 5.2 MCP 与本地 skill：包装器

内核那些 provider 扫目录、有什么给什么，不认识归属。做法是**把它包一层**
（`cowork/guards/`）：不改内核（只读），也不让 provider 自己去问 cowork（那会让每个
provider 都认识 cowork）。

两条硬约束：

**必须是内核 ABC 的真子类。** 内核建索引用 `isinstance` 而非鸭子类型。不是真子类的表现是
这类能力整个从索引里消失 —— "列表里有、就是调不动"。

**必须覆盖每一个按名字进入的入口。** 只过滤 `list`/`retrieve` 的话，模型确实"看不见"，
但名字一旦出现过（历史消息、另一个 cowork 的会话记录、SKILL.md 里的交叉引用）照样能读能跑。
本地 skill 的包装器覆盖 6 个入口：

```
retrieve / list                                          列表
load_definition / list_files / load_resource /
exec_script / invoke                                     按名字直取
```

有一条测试专门钉这件事：把协议的公开方法集与包装器的做差集，非空即失败。它的价值在
**升级内核的那一刻**才显现，而那正是没人会想起检查的时刻。

隔离这层出错时，最坏结果应当是"没做隔离"，而不是"这类能力全用不了"：归属库读不动、
scope 还没装好，一律放行。

### 5.3 LLM：按来源管，不按加密与否

| 来源 | 谁给的 | 落盘 | 受 `llm.allow` 约束 |
|---|---|---|---|
| `ORIGIN_FACTORY` | 随包出厂（`default_llm_accounts.json`） | 是 | 是 |
| `ORIGIN_SUITE` | 套件下发（清单 `llm.define`） | **否** | 是 |
| `ORIGIN_USER` | 用户自己配的 | 是 | **否** |

**用户在自己机器上配的账号，任何云端清单都不能没收它。** 判据是来源，不是"这个 key 有没有
加密" —— 后者只是统一交付恰好都加密，不是它的定义。

套件下发的账号 `persist=False`：它属于 cowork 不属于用户，套件被收回、重启后就该消失。
加密的 key（`enc:v1:`）在清单这层不解密，`__repr__` 里也不出现。

对账之后要一并重建这批账号（`rebuild_cowork_llm_accounts`）：先 `drop_accounts_of_origin(SUITE)`
再按新清单注册。漏了这步的表现是"套件更新了但模型还是旧的那批"。

### 5.4 两处空集合语义**故意相反**

```
mcp.use   = []   什么都不给      （白名单：没列就是没有）
llm.allow = []   不加限制        （没写就是不限制）
```

看着不一致，但各自是对的：MCP 问的是"这个 cowork 用哪几个"，LLM 问的是"不许用哪些之外的"。
统一成一种的代价是其中一个必然反直觉。

### 5.5 技能市场：把 cowork 变成数据

市场层自己不认识 cowork。套件里的市场地址（`skills.marketUrl` / `mythosUrl`）属于权限，
不属于部署配置，所以只在 `_setup_cowork` 一处注入：

```python
market_registry.install_cowork_markets(_cowork_markets)
```

页签顺序 = `(order, id)`，与主界面智能体下拉一致。

### 5.6 profile 预置 skill（`skills.presets`）

套件清单可声明默认 skill 引用（需求附录 A「skill·预置」）。系统在三个入口自动差量协调，
用户无需手动引用：

- **启动**（`_register_skills`，共享来源如 cowork；此时还没登录）；
- **W3 登录**（`POST /skills/current-user`，按用户来源如 mythos——principal 已知才协调）；
- **`/coworks/recheck` 与启动共用** `apply_cowork_state` 的派生状态清单（读当前
  `current_user`），三个入口同一个 `ProfileSkillPresetReconciler`。

协调语义：profile 携带**完整 L1 元数据**，启动期不下载 ZIP（实际使用时才临时下载）；
作用域由套件市场配置推导（`scopes.py` 的 `build_scopes` + `effective_scope_id`，遵守 H3
不跨市场回落）；用户删除写 opt-out 不复活，重新手工引用清 opt-out；profile 减预置/收回
只撤自己的绑定（有效归属 = 手工 ∪ 预置，引用无人认领才删）。引用身份是
`(market_scope, source, remote_id, principal)` 四元组，对外为不透明 `reference_id`；
引用库、随包播种账本、预置账本同住一份 `skill_references.json`、同一次原子提交。

Electron 不加任何新状态：预置引用就显示现有"已引用"，目录卡片按后端 `reference_id`
精确配对（同一 source/id 在通用与专属市场不再串台）。

---

## 6. 会话与事件

后端把内核事件翻译成前端帧（`api/models/session.py`），持久化进 `session_sse_events`。
前端重连 / 切回会话时读的是**这份帧日志**，不是从事件重放。

```
内核 EventBus ──► session_consumer ──► translate_event ──► sse_events（内存 + 落库）
                                                             │
                                          SSE  GET /sessions/{id}/stream
                                                             ▼
                                                           前端
```

`/sessions/{id}/messages` 是 **POST**（发消息 / 应答 HITL），不是读历史的接口。

---

## 7. 前端

阵容只有一个来源：`agents/registry.ts` 从 `/coworks` 拉，转成 `Agent[]`。其余组件
（切换器、新建会话、技能中心）一律问它。

`lineup.ts` 把"没有 cowork"分成几种状态：`pending`（还没拉到）、`unreachable`（拉不到）、
`none`（确实一个都没开通）、`ready`。都显示成同一句话的话，权限没配好的人会以为产品就长这样。

`AgentMark`：有 logo 显示 logo；没有时看 `fallback` 参数 —— 列表和下拉用 `none`（不渲染），
新建会话页用 `letter`（accent 底色 + 首字母），因为那页正中就这一个图形。图加载失败走同一条
回落路径。

---

## 8. 品牌、端口与打包

### 8.1 品牌标识唯一来源

`electron/branding.json`：

```
appId          com.netlive-cowork.desktop
productName    NetLIVE Cowork
appDataDir     NetLIVECowork      → %APPDATA%\<值>，业务数据
npmName        netlive-cowork     → Electron userData，Chromium 缓存/存储
backendName    netlive-cowork     → PyInstaller 产物目录名
backendPort    17926              → 本地后端端口
legacyAppDataDir  IPMaster-Cowork → 数据迁移的来源目录
```

运行期 `main.js` 与前端（vite 的 `@branding` 别名）直接读它；构建期
`packaging/build_electron.ps1` 把它注入 `electron/package.json` 的 `build` 段 ——
electron-builder 打包时会剥掉 build 段，运行期读不到，所以必须双写。

`appDataDir` 与 `npmName` 各自决定一个 AppData 目录，衍生品牌两个都要改。
**Windows 路径大小写不敏感**：两者忽略大小写后必须真的不同，否则"两个目录"会塌成一个。

### 8.2 端口不能有默认值

```js
const PORT = parseInt(process.env.NLC_BACKEND_PORT || String(branding.backendPort || ''), 10);
if (!Number.isInteger(PORT) || PORT <= 0) throw new Error('branding.json 缺少 backendPort');
```

**故意不给回落值。** 曾经写死回落到 `15926` —— 那是上一代 IPMaster-Cowork 的端口。
后端把前端 dist 挂在 `/`，窗口从后端加载；两个品牌共用一个端口时，后启动的那个会把先启动
的当成"自己的后端"复用，于是前端、后端、数据整条串到对方那边，**而且一声不吭**。

复用之前还要比对身份：

```
GET /health → {"status":"ok","runtime":true,"app_id":"com.netlive-cowork.desktop"}
```

`app_id` 由主进程通过 `NLC_APP_ID` 传给后端。**拿不到或对不上一律当成"不是我的"** ——
宁可起不来让人看见，也不能把别人的应用当成自己打开。

### 8.3 打包流水线

```
前端构建 → PyInstaller 后端 → 内置 Python/Node runtime → 绘图引擎
        → browser-mcp → electron-builder 出 NSIS
```

**根 `resources/` 从不进包**，随包数据只取 `packaging/default_data/`。开发用的 mock 套件、
本地 skill、开发密钥因此不会泄进安装包。exe 里**不含任何 skill**。

配置分两层：`app-config.json` 是工程级出厂配置（云端地址、渠道、更新源），安装/升级时按
`APP_CONFIG_FORCE_KEYS` 强制对齐随包模板；`.env` 是用户级。

---

## 9. 目录布局

```
%APPDATA%\NetLIVECowork\
  coworks\                    已装套件（解开的）
    default\                  母版，永不删
    ipmaster\                 cowork.json + 5 个 md
  data\
    cowork-packages\          暂存目录
      entitled.json
      <id>-cowork-<v>.zip
    <db>                      会话、事件、SSE 帧
    local_skill_owners.json   本地 skill 的归属
    skill_references.json
```

开发期用 `NLC_COWORK_PACKAGES_DIR` 指向一个本地目录当**假云端**，与真下发共用同一段安装
代码，区别只是 zip 从哪来。**不配这个变量就一个 cowork 都没有** —— 任何"没配就给全量"的
兜底都会让权限失去意义。

---

## 10. 迁移记录

| 时间 | 改动 | 兼容处理 |
|---|---|---|
| 2026-08-27 | `cowork/` 三处改名：`service.py`→`reconcile.py`、`store.py`→`installed.py`，及相应函数名（`list_installed`→`list_all` 等） | 纯内部，无外部引用 |
| 2026-08-29 | 环境变量前缀 `IPMC_` → `NLC_`（IPMC 是 IPMaster Cowork 的缩写，产品已改名） | 老 `.env` 在数据迁移时按前缀重写 |
| 2026-08-29 | 应用身份全面改名：Python 包 `ipmastercowork` → `netlivecowork`；appId / productName / appDataDir / backendName | `migrateLegacyAppData()`：新目录不存在且老目录存在时整目录拷贝，并重写 `.env` 里的前缀与目录名 |
| 2026-08-30 | 合入 upstream/master：W3 内嵌免密登录、登录闪回修复、task 胶囊收起时机、electron.exe 安装/更新兼容 | 上游仍用 `IPMC_`/`ipmastercowork`，合并时一律保留本分支命名；`W3_CLIENT_ID`、`ipmastercowork.gts.huawei.com` 是厂商标识与真实域名，**不改** |
| 2026-08-30 | 后端端口 15926 → 17926，写进 branding；`/health` 增加 `app_id` 并在复用前比对 | 15926 是上一代端口，必须避开；老版本的探测只看 HTTP 200，改不了了 |

数据迁移的判据是"新目录是否存在"，只做一次。**老目录不删** —— 迁移出错时用户还能自己找回来。

---

## 11. 已知缺口

按当前代码，以下是真实存在、尚未处理的：

1. **新建会话的第一轮回复可能到不了界面。** `create_session` 里 `runtime.start_session()`
   返回时任务已经在跑，而 `session_consumer` 要在其后若干个 await（写库、拍工作区快照）
   之后才 `create_task`；`event_bus.stream()` 又要等 `async for` 跑起来才真正登记订阅。
   这段窗口里发出的事件没有任何订阅者，总线不回放，**永久丢失**。工作区快照要拷目录，
   几秒很正常，足以覆盖一整轮。表现：事件表里回复完整存在、token 也算了，但帧日志里没有，
   重启也补不回来。`resume` 那条路上有同样的顺序问题。

2. **`cowork/fetch.py` 是死代码。** 桌面端取包由 Electron 主进程完成，这份 Python 实现
   目前只被自己的测试引用。

3. **归属未知 → 不过滤。** 历史会话、母版会话、内部任务都靠这条兜底，但它同时让 §5.1 那个
   resolver 漏装的洞**静默**了很久。收紧的前提是先把"未知"的几种来源拆开。

4. **substrate 不下发 logo。** 契约里没有这个字段，套件自带 logo 的能力目前只在本地打包的
   套件上生效。

5. **exe 未做代码签名。** 安装时 Windows 会弹 SmartScreen。

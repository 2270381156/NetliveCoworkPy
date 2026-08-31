# ctx-weft 拆仓：core 私有仓 + host 原地改造 + vendored `.pyc`

日期：2026-07-08
分支：master（拆分动作本身跨仓，非单分支特性）
状态：设计定稿，待实现

## 1. 目标与非目标

### 1.1 目标

把 core（`ctx_weft`）从 host（`ipmastercowork` 桌面应用层）**物理隔离到独立的私有 git 仓**，使得：

- **host 仓的开发者拿不到 core 源码**、也改不了 core（他们只拿到可运行的 `.pyc`）。
- host 开发者仍能**本地跑/调试两层**（electron/前端 + `src/ipmastercowork` Python 后端）。
- **打包依旧方便**：官方安装包在 host 仓一处构建，PyInstaller 把 vendored 的 core `.pyc` 一并收进。

### 1.2 定调：防君子不防小人

保护强度定位为 **T1（仅 `.pyc`）**：装了能跑、打开不是源码，但**可被反编译还原**。用户已明确接受这一强度；不追求 Nuitka/Cython 级别的"编译不可读"。由此推出的所有"够用即可"取舍（见 §9）都在此定调下成立。

### 1.3 非目标

- **不**开源 host 到公众。host 仓保持**私有**，"隔离 + 开发者看不到 core 源码"即达标（用户拍板：仓可私有）。
- **不**建私有 PyPI / index，**不**发 token，**不**编译二进制。core 以 vendored `.pyc` wheel 直接提交进 host 仓。
- **不**在本次改 Python 包名（见 §10.1，单独一步以后再做）。

## 2. 决策记录（brainstorming 结论）

| # | 议题 | 结论 |
|---|---|---|
| D1 | 拆分动机 | IP 保护；core 是核心资产，host 开发者不应看到其源码 |
| D2 | 隐藏深度 | 只藏源码；"依赖一个叫 ctx-weft 的私有包"这个事实可见 |
| D3 | host 公开与否 | **私有即可**，不对公众开源（隔离 + 看不到 core 就够） |
| D4 | 谁当 host 仓 | **当前仓原地当 host**（用户坚持保留当前仓身份） |
| D5 | 谁当 core 仓 | **新建私有 core 仓**，core 源码迁入 |
| D6 | core 交付形态 | **vendored `.pyc` wheel 直接提交进 host 仓**（无 index / token / 编译） |
| D7 | 保护强度 | **T1**：仅 `.pyc`，防君子不防小人 |
| D8 | host 历史 | **抹掉**：orphan 单快照 commit + force-push；接受 GitHub 旧 SHA 残留 |
| D9 | core 历史 | **保留**：filter-repo 把 core 相关历史抽入新仓 |
| D10 | 在飞分支 | 抹历史前**先全部合入 master 再删分支** |
| D11 | 包改名 | 暂不改，保持 `ctx_weft`；改名单列一步 |
| D12 | host 开发层面 | 前端 + Python 后端**两层都改** → core 必须能在其机器上 import |

### 2.1 被否决的替代方案（存档，避免回炉）

- **私有 index + 下载 token**：能做到 host 开发者不进源码仓，但明文 wheel 解压即源码；且要维护 index 基建。相比 vendored `.pyc` 无净收益，否决。
- **git-URL 依赖 core 私有仓**：会给到源码仓读权限 = 等于给私仓权限，违背 D1，否决。
- **`.pyc` 或编译包直接进"公开"仓**：公开仓 + `.pyc` = 向全世界公开可反编译源码，自毁目标；要在公开仓成立必须上 T2 编译。因 D3 定为私有，此顾虑消解。
- **force-push 抹历史当"删干净"**：GitHub 不即时 GC，旧 commit 仍可经 SHA 访问。因 D7 定调"防君子不防小人"，接受此残留（见 §9.1）。

## 3. 终态架构

```
┌─────────────────────────────┐        vendored .pyc wheel        ┌──────────────────────────────┐
│  Core 私有仓 (新建)          │  ── build .pyc-only wheel ──▶     │  Host 仓 (= 当前仓, 原地)     │
│  IpmasterCoworkAgentCore     │     丢进 host 的 vendor/          │  XingLiyin/IpMasterCoworkPy   │
│  - src/ctx_weft (源码)       │                                   │  - src/ipmastercowork         │
│  - tests, pyproject          │                                   │  - electron/ frontend*/       │
│  - .pyc wheel build 脚本     │                                   │  - packaging/ _run.py         │
│  - 保留 core 历史            │                                   │  - vendor/ctx_weft-*.whl ◀────┘
│  - 仅 core 团队              │                                   │  - 历史抹掉、快照起步         │
└─────────────────────────────┘                                   │  - host 开发者               │
                                                                   └──────────────────────────────┘
```

- **无** index、**无** token、**无**编译。
- core 更新流：core 仓改码 → 构建新 `.pyc` wheel → 丢进 host 仓 `vendor/` → host 开发者 `git pull` + `uv sync`。

## 4. Core 私有仓

### 4.1 由来与内容

- **新建**私有仓 `IpmasterCoworkAgentCore`（名字待定，可后续 GitHub 改名）。
- 内容 = 当前仓 `ctx-weft/` 子目录**提升到仓根**：
  - `src/ctx_weft/**`
  - `tests/**`（core 自己的测试，现 `ctx-weft/tests/`）
  - `pyproject.toml`（name = `ctx-weft`，保持不变）
  - `README.md` / `ARCHITECTURE.md`（core 专属文档）
  - `uv.lock`、`.gitattributes`
- **随 core 走**、不进 host 的 core 相关脚本：`tools/sync_core.sh`、`tools/backfill_core.sh` 等上游同步/回灌工具。

### 4.2 历史（D9：filter-repo 保留）

用 `git filter-repo` 从当前仓抽取 core 历史进新仓，需覆盖 core 在各历史阶段的**所有路径别名**：

- `ctx-weft/**`（现路径）
- `src/ctx_weft/**` 与顶层 `ctx_weft/**`（更名 ctx_weft 后、提子目录前的中间态）
- `loomex_core/**`（最早期，`ae242b9 rename loomex_core -> ctx_weft` 之前）

> ⚠️ 实现时必须先跑一遍历史路径普查（`git log --all --name-only` 聚合出 core 曾用过的全部前缀），把它们全部喂给 filter-repo 的 `--path`，否则会漏掉早期 commit 的 core 源码。

### 4.3 `.pyc`-only wheel 构建

core 仓新增一个 build 步骤，产出**仅 `.pyc`、无 `.py`** 的 wheel：

- **布局**：sourceless import——每个 `foo.py` 在包内换成同位置的 `foo.pyc`（**不是** `__pycache__/foo.cpython-311.pyc`，而是 `foo.pyc` 直接摆在原 `.py` 处），并删除 `.py`。CPython 在无 `.py` 时会直接 import 同名 `.pyc`。
- **实现**：post-build 脚本——`hatchling` 正常构建 wheel → 解包 → `compileall` 生成字节码 → 把 `__pycache__/*.cpython-311.pyc` 搬成包内 `*.pyc`、删所有 `.py` 和 `__pycache__/` → 重打包 wheel。
- **产物命名**：`ctx_weft-<ver>-py3-none-any.whl`（纯 Python，platform=any）。
- **验证**：新建干净 venv，仅装此 wheel，`python -c "import ctx_weft; ..."` 跑通；确认 wheel 内 `find` 无任何 `.py`。

## 5. Host 仓（当前仓原地改造）

### 5.1 目录结构（终态）

```
XingLiyin/IpMasterCoworkPy   （原地，历史抹掉后单快照起步）
├── pyproject.toml           ★改：core 依赖指向 vendored wheel
├── uv.lock
├── _run.py                  桌面后端入口（PyInstaller 打这个）
├── .python-version          3.11，与 core .pyc 对齐
├── .env.example  .gitattributes  .gitignore
├── README.md  ARCHITECTURE.md  LICENSE.txt  项目介绍_产品经理版.md
├── vendor/
│   └── ctx_weft-0.1.0-py3-none-any.whl      ★新：仅 .pyc 的 core
├── src/ipmastercowork/      Python 后端（api/ auth/ observability/ persistence/ providers/ cli.py config.py paths.py）
├── electron/                Electron 壳
├── frontend-desktop/        桌面前端（build 时 dist/ 内嵌）
├── frontend/                ← 若在用则留，否则裁（见 §10.2）
├── frontend-desktop-v2/     ← 同上，WIP 变体
├── packaging/
│   ├── ipmaster-cowork.spec        ★微调（§5.3）
│   ├── build_electron.ps1
│   └── default_data/
├── resources/               运行时资源模板
├── tests/                   host 测试（test_host_* / test_hitl_* / test_run_spa_* …）
├── docs/                    host 相关文档（core 专属随 core 走）
├── Dockerfile  docker-compose.yml
└── .github/                 host CI
```

不进仓（gitignored，照旧）：`build/ data/ workspace/ node_modules/ .venv/ __pycache__/ dist/`。

### 5.2 pyproject 改动（唯一必改的依赖接线）

```toml
# 今天
[tool.uv.sources]
ctx-weft = { path = "ctx-weft", editable = true }

# 改成
[tool.uv.sources]
ctx-weft = { path = "vendor/ctx_weft-0.1.0-py3-none-any.whl" }
```

- `dependencies = ["ctx-weft[builtin,skills]", …]` **不动**（未改名前提下，名字仍是 `ctx-weft`）。
- wheel 是 path 源、非 editable → host 开发者装到的是不可编辑的 `.pyc` 包，符合"改不了 core"。
- `[builtin,skills]` 这些 extra 的第三方依赖（httpx/psutil/pyyaml）照常从 PyPI 装；只有 core 本体来自 vendored wheel。

### 5.3 packaging 微调

- `packaging/ipmaster-cowork.spec`：PyInstaller 分析 `_run.py` 时会顺着 import 收集**已安装的** `ctx_weft`（现在来自 vendored `.pyc` wheel），机制不变；确认 `.pyc`-only 包被 `Analysis` 正确收集（必要时在 `hiddenimports` 补 `ctx_weft` 子模块，或用 `collect_submodules`）。
- 终端用户本就拿到 `.pyc`，与 vendored `.pyc` 一致，无回归。

### 5.4 历史抹除（D8）

- 前置：§7.1 先把所有在飞分支合入 master 并删分支。
- 动作：`git checkout --orphan` 从当前 master 树造单一 root commit → 设为 master → force-push origin。
- 接受：旧含 core 的 commit 可能经 SHA 在 GitHub 残留（§9.1）；ZoeRen fork 及既有 clone 仍有 core（§9.2）。

## 6. 工作流

- **Core 开发**：在 core 仓改码、跑 core 测试（`uv run pytest`）→ 需要下发时构建 `.pyc` wheel。
- **Host 开发**：`git clone` host 仓即带 core `.pyc` → `uv sync` → 两层本地跑/调；core 是黑盒（可 `import`、不能 step-in 源码）。要 core 新改动 → 换 `vendor/` 里的 wheel + `uv sync`。
- **core→host 下发**：core 仓构建新 `.pyc` wheel → 丢进 host 仓 `vendor/` 覆盖 + bump 文件名版本 + 更新 pyproject 的 path + commit。可后续用 core 仓 CI 自动对 host 仓开 PR（nice-to-have，非本次范围）。
- **官方打包**：在 host 仓 `packaging/build_electron.ps1` → `uv sync`（装 vendored core）→ PyInstaller → electron。由有 host 仓权限者（你/团队）执行。

## 7. 迁移步骤（有序）

### 7.1 前置：分支收敛（D10）

**已于 2026-07-08 验证：所有分支的工作均已在 master 中，无需再合，直接删即可。**

核查结果（`git rev-list --count master..<branch>` 全为 0）：

- 本地 4 条 `feat/interaction-preserving-capsule`、`fix/raw-args-doom-loop`、`refactor/hitl-id-unify`、`sync/upstream-agent-memory-compaction` → 0 未合入。
- 远端 `origin/master`、`origin/feat/interaction-preserving-capsule`、`origin/refactor/hitl-id-unify` → 0 未合入；本地 master 与 origin/master 完全一致（0/0）。
- ZoeRen fork `forked-ren/master`、`forked-ren/feat/ask-user-md-render` → 0 未合入（其 fork 侧在飞工作也已落 master）。

> 原先"胶囊特性应合回 `sync/*`、直合 master 有风险"的顾虑（`[[capsule-feature-merge-target]]`）**已作废**：master 已包含全部成果，`sync/*` 亦无 master 缺失的提交。

步骤：删除本地与远端这些分支（含 `sync/*`）→ 确认 master 即唯一分支 → 进 §7.2。

### 7.2 抽取 core 到新仓（D9）

3. 历史路径普查（§4.2）→ `git filter-repo` 从当前仓副本抽 core 历史 → 推入新建私有 core 仓。
4. core 仓内把 `ctx-weft/**` 提升到仓根、补 build 脚本（§4.3）、跑通 core 测试。

### 7.3 构建首个 `.pyc` wheel

5. 在 core 仓构建 `.pyc`-only wheel 并按 §4.3 验证（无 `.py`、干净 venv 可 import）。

### 7.4 改造 host 仓

6. 当前仓（master）：删 `ctx-weft/` 目录、删随 core 走的 `tools/*core*`、`docs/` 分家；放入 `vendor/ctx_weft-*.whl`；改 pyproject（§5.2）；微调 spec（§5.3）。
7. `uv sync` + `uv run pytest`（host 测试）+ 本地跑 `_run.py`/electron 冒烟：确认两层可跑、core 从 vendored wheel 正常 import。
8. 打包冒烟：`build_electron.ps1` 出一个安装包，确认 PyInstaller 收进了 core `.pyc`、装后能启动。

### 7.5 抹历史

9. §5.4：orphan 快照 + force-push。

### 7.6 权限

10. core 私有仓：仅 core 团队。host 仓：host 开发者（ZoeRen 等）——注意 ZoeRen fork 既成事实（§9.2）。

## 8. 验证标准

- [ ] host 仓全新 clone 后 `git log` 无任何 core 源码、无 `ctx-weft/**` 历史文件。
- [ ] host 仓 `vendor/*.whl` 解包后**无 `.py`**、仅 `.pyc`。
- [ ] host `uv sync` 成功；`uv run pytest` host 测试通过；`_run.py` + electron 本地起得来。
- [ ] `build_electron.ps1` 产出安装包，安装后可启动，行为与拆分前一致。
- [ ] core 仓 `uv run pytest` 全绿；`.pyc` wheel 在干净 venv 可 `import ctx_weft`。
- [ ] host 开发者用 3.11 之外的 Python 装 wheel 会失败（预期，§9.3）。

## 9. 已接受的取舍与风险

### 9.1 GitHub 旧 SHA 残留
force-push 抹历史后，含 core 的旧 commit 仍可能经 `/commit/<sha>` 在 GitHub 残留较久。**已接受**（D7 防君子不防小人）。若日后要真删，需删库重建或联系 GitHub 支持。

### 9.2 既有 fork/clone 已有 core
ZoeRen 的 fork 与任何既有 clone 已含全套 core 源码与历史，本方案不能回收。保护的是**今后 + 其他人**。若 ZoeRen 今后为 host-only 且必须隔离，属另一件事（收回访问，但本地副本收不回）。

### 9.3 `.pyc` 绑 Python 小版本
`.pyc` 字节码随 CPython 版本（magic number）变，与平台无关（core 为纯 Python）。两仓与打包**都锁 3.11**（`.python-version` 已是）；host 开发者用 3.12 等会装不上——预期行为，文档需写明。

### 9.4 T1 可反编译
vendored `.pyc` 可被 `decompyle3` 等还原近似源码。已接受。真要挡死需升 T2（Nuitka/Cython），非本次范围。

## 10. 延后 / 待定

### 10.1 Python 包改名（D11，独立后续步骤）
`ctx_weft` → 新名（如 `ipmc_agent_core`）。对 IP 目标零帮助，却要改遍两仓所有 import、PyInstaller `hiddenimports`、测试，并触动 `[[naming-scheme-ctxweft-ipmc]]` 与上游同步工具假设。**建议单列一步、在拆分完成并稳定后再做**，且优先在 core 仓内原地改名验证后再传导到 host。

### 10.2 前端目录取舍
`frontend/`、`frontend-desktop/`、`frontend-desktop-v2/` 三者去留待确认。桌面 build 用 `frontend-desktop/dist`；另两个按实际使用裁剪。

### 10.3 core→host 下发自动化
core 仓 CI 自动构建 `.pyc` wheel 并对 host 仓开 PR 更新 `vendor/`。nice-to-have，非本次范围。

# 分支手术:memory v2 干净基线 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `feat/kb-and-memory-protocol-v2` 上的 memory protocol v2 改动摘到从 master 新开的干净分支上,旧分支(kb MCP 直写 v1)封存作零件库。

**Architecture:** 纯 git 手术 + vendor wheel 重建,零新代码。四步:旧分支 WIP 封存改名 → 新分支 cherry-pick → 重建 wheel → 全量验证。对应 spec `docs/superpowers/specs/2026-08-03-cowork-restructure-git-native-design.md` §2。

**Tech Stack:** git、uv(build/lock/sync)、pytest。

## Global Constraints

- 主仓:`C:\Users\Xing\Documents\codes\IpMasterCoworkPy`;core 仓:`C:\Users\Xing\Documents\codes\Loome-02\ctx-weft`(已在 `feat/memory-protocol-v2` 分支,勿切分支)。
- 旧分支 `feat/kb-and-memory-protocol-v2` 改名为 `archive/kb-mcp-write-v1`;**无远端 tracking,纯本地操作,不碰任何 remote**。
- 新分支名:`feat/memory-protocol-v2`(host 侧),基点 master(`f3e09c7` 之后的当前 master HEAD)。
- 关键提交:`25d5f50` = memory v2 迁移;`1ddab72` = 改造方案 spec 文档。
- 依赖名 `ctx-weft`,vendored 路径 `vendor/ctx_weft-0.1.0-py3-none-any.whl`(版本号不变,靠 `uv lock --upgrade-package` 刷 hash)。
- 测试一律 `uv run pytest`(pyproject 已配 `pythonpath=["."]`)。
- core 仓工作区有一个脏文件 `tests/unit/test_composer_resources_placement.py`(M)——**不碰它**;wheel 只打包 src,不受影响。
- 全程不 push;完成后由用户决定是否推远端。

---

### Task 1: 旧分支 WIP 封存 + 改名

**Files:**
- Modify(commit 既有工作区改动,不改内容):`src/ipmastercowork/providers/knowledge/capability.py`、`src/ipmastercowork/providers/knowledge/capability_sync.py`、`tests/unit/test_kb_capability_provider.py`、`tests/unit/test_kb_capability_sync.py`、`tests/unit/test_kb_foundation.py`、`vendor/ctx_weft-0.1.0-py3-none-any.whl`

**Interfaces:**
- Consumes: 工作区现有未提交改动(capability 技能+MCP 工具统一版 + 配套 wheel)。
- Produces: 封存分支 `archive/kb-mcp-write-v1`;工作区只剩 `项目介绍_产品经理版.md` 的移动(D 根目录文件 + ?? `docs/项目介绍_产品经理版.md`),留给 Task 2 在新分支重做。

- [ ] **Step 1: 确认起点状态**

Run: `git status --short; git branch --show-current`
Expected: 当前分支 `feat/kb-and-memory-protocol-v2`;改动恰为:M 上列 6 个文件 + `D 项目介绍_产品经理版.md` + `?? docs/项目介绍_产品经理版.md`。若有其他改动,停下来报告用户。

- [ ] **Step 2: WIP commit(只加 6 个文件,不加文档移动)**

```powershell
git add src/ipmastercowork/providers/knowledge/capability.py src/ipmastercowork/providers/knowledge/capability_sync.py tests/unit/test_kb_capability_provider.py tests/unit/test_kb_capability_sync.py tests/unit/test_kb_foundation.py vendor/ctx_weft-0.1.0-py3-none-any.whl
git commit -m @'
wip(kb): capability 统一版(技能+MCP 工具入 cap source)+ 配套 wheel —— 封存留档

新设计(git 原生单轨)下 CapabilitySync 重落的参考版本,见
docs/superpowers/specs/2026-08-03-cowork-restructure-git-native-design.md。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

- [ ] **Step 3: 验证工作区只剩文档移动**

Run: `git status --short`
Expected: 仅 `D 项目介绍_产品经理版.md` 与 `?? docs/项目介绍_产品经理版.md` 两行。

- [ ] **Step 4: 分支改名封存**

Run: `git branch -m feat/kb-and-memory-protocol-v2 archive/kb-mcp-write-v1`
验证: `git branch --show-current` 输出 `archive/kb-mcp-write-v1`。

---

### Task 2: 新分支 + cherry-pick memory v2 与 spec 文档

**Files:**
- Modify: `src/ipmastercowork/providers/memory/postgres.py`(cherry-pick 落入)
- Modify: `tests/unit/test_postgres_compact_segment_scope.py`、`tests/unit/test_postgres_compact_trailing_anchor.py`、`tests/unit/test_postgres_compact_user_aware.py`、`tests/unit/test_postgres_memory_supersede.py`、`tests/unit/test_postgres_recall_by_agent.py`(cherry-pick 落入)
- Create: `docs/superpowers/specs/2026-08-03-cowork-restructure-git-native-design.md`(cherry-pick `1ddab72`)
- Create: `docs/项目介绍_产品经理版.md` + Delete 根目录同名文件(重做移动)

**Interfaces:**
- Consumes: `archive/kb-mcp-write-v1` 上的提交 `25d5f50`、`1ddab72`。
- Produces: 分支 `feat/memory-protocol-v2`,HEAD 含 memory v2 代码(此刻测试预期红——依赖 Task 3 的新 wheel,两个提交合起来才绿,这是有意的)。

- [ ] **Step 1: 从 master 开新分支**

Run: `git switch -c feat/memory-protocol-v2 master`
Expected: 成功切换;文档移动的两行工作区改动随行(`git status --short` 仍是那两行)。

- [ ] **Step 2: cherry-pick memory v2**

Run: `git cherry-pick 25d5f50`
Expected: **冲突,这是预期**——`src/ipmastercowork/providers/knowledge/memory.py` 与 `tests/unit/test_kb_memory_provider.py` 两个文件是 modify/delete 冲突(master 上不存在)。其余文件干净落入。

- [ ] **Step 3: 丢弃两个 kb 文件的 hunk,完成 cherry-pick**

```powershell
git rm src/ipmastercowork/providers/knowledge/memory.py tests/unit/test_kb_memory_provider.py
git -c core.editor=true cherry-pick --continue
```

验证: `git show --stat HEAD` 只含 `postgres.py` + 5 个 `test_postgres_*`,**不含任何 knowledge/kb 文件**。

- [ ] **Step 4: cherry-pick spec 文档,拷入本计划**

```powershell
git cherry-pick 1ddab72
git checkout archive/kb-mcp-write-v1 -- docs/superpowers/plans/2026-08-03-branch-surgery-memory-v2-baseline.md
git add docs/superpowers/plans/2026-08-03-branch-surgery-memory-v2-baseline.md
git commit -m @'
docs: 分支手术实施计划(自封存分支拷入)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

Expected: spec 干净落入(纯新增文件);计划文档按路径取封存分支最新版,不依赖提交哈希。

- [ ] **Step 5: 重做文档移动并提交**

```powershell
git add 项目介绍_产品经理版.md docs/项目介绍_产品经理版.md
git commit -m @'
docs: 项目介绍(产品经理版)移至 docs/

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

验证: `git status --short` 输出为空(工作区全清)。

---

### Task 3: 重建 vendor wheel(core feat/memory-protocol-v2)

**Files:**
- Modify: `vendor/ctx_weft-0.1.0-py3-none-any.whl`(用 core 分支产物覆盖)
- Modify: `uv.lock`(刷 hash)

**Interfaces:**
- Consumes: core 仓 `C:\Users\Xing\Documents\codes\Loome-02\ctx-weft` 的 `feat/memory-protocol-v2` 分支 HEAD。
- Produces: 主仓 venv 装上含 memory protocol v2 的 ctx_weft(`MemoryAddress`/8 方法协议面可 import),Task 4 的测试依赖此。

- [ ] **Step 1: 核实 core 分支内容(spec 风险点 1)**

```powershell
git -C C:\Users\Xing\Documents\codes\Loome-02\ctx-weft branch --show-current
git -C C:\Users\Xing\Documents\codes\Loome-02\ctx-weft log --oneline -15
git -C C:\Users\Xing\Documents\codes\Loome-02\ctx-weft log --oneline master..HEAD -- src/ctx_weft/protocols/capability.py src/ctx_weft/providers/capability_mcp 2>$null
```

Expected: 当前分支 `feat/memory-protocol-v2`(若 core 主分支不叫 master,换成实际名重跑第三条)。第三条列出该分支上混入的 capability 协议提交——**有也不处理,照单全收(spec 已拍板)**,把结果记进 Task 4 的 wheel commit message 即可。

- [ ] **Step 2: 构建 wheel**

```powershell
$env:VIRTUAL_ENV = $null
Remove-Item C:\Users\Xing\Documents\codes\Loome-02\ctx-weft\dist\*.whl -Force -ErrorAction SilentlyContinue
uv build --wheel C:\Users\Xing\Documents\codes\Loome-02\ctx-weft
```

Expected: 产出 `C:\Users\Xing\Documents\codes\Loome-02\ctx-weft\dist\ctx_weft-0.1.0-py3-none-any.whl`(清 `VIRTUAL_ENV` 是绕 Windows venv trampoline 坑,见记忆)。

- [ ] **Step 3: re-vendor + 刷 lock + 重装**

```powershell
Copy-Item C:\Users\Xing\Documents\codes\Loome-02\ctx-weft\dist\ctx_weft-0.1.0-py3-none-any.whl vendor\ctx_weft-0.1.0-py3-none-any.whl -Force
uv lock --upgrade-package ctx-weft
uv sync --reinstall-package ctx-weft
```

Expected: 三条全部成功;`uv sync` 会把 dev venv 从 editable core 切回 wheel 安装(editable 是 `25d5f50` 时期的临时形态,本步骤即恢复正轨)。

- [ ] **Step 4: 冒烟验证协议面可 import**

Run: `uv run python -c "from ctx_weft.protocols import MemoryAddress, MemoryScope; print('ok')"`
Expected: 输出 `ok`。

---

### Task 4: 全量验证 + 收尾提交

**Files:**
- Commit: `vendor/ctx_weft-0.1.0-py3-none-any.whl` + `uv.lock`

**Interfaces:**
- Consumes: Task 2 的代码 + Task 3 的 wheel。
- Produces: 干净基线 = master + memory v2,全量测试绿。

- [ ] **Step 1: 全量测试**

Run: `uv run pytest`
Expected: 全绿。若 pg 测试族失败,按 systematic-debugging 排查(先看是否 wheel 未刷新:`uv pip show ctx-weft` 确认非 editable),**不得跳过或 xfail 掩盖**。

- [ ] **Step 2: 提交 wheel 与 lock**

```powershell
git add vendor/ctx_weft-0.1.0-py3-none-any.whl uv.lock
git commit -m @'
chore: re-vendor ctx_weft wheel(core feat/memory-protocol-v2)

与上一提交(memory v2 迁移)配对——两者合起来才构成可测绿的状态。
[此处按 Task 3 Step 1 的核实结果补一行:core 分支是否混入 capability 协议改动]

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

- [ ] **Step 3: 终态验收**

```powershell
git log --oneline master..HEAD
git diff --stat master..HEAD
git status --short
```

Expected:
- log 恰 5 个提交:memory v2 迁移(cherry-pick)、spec 文档、本计划拷入、文档移动、wheel;
- diff --stat 只含:`postgres.py`、5 个 `test_postgres_*`、spec 文档、本计划文档、`docs/项目介绍_产品经理版.md`(+根目录删除)、wheel、`uv.lock`——**零 knowledge/、零 startup/config/sessions 改动**;
- 工作区干净。

- [ ] **Step 4: 向用户报告**

报告终态验收三项输出与测试结果,提请用户决定:是否推远端、是否着手 M1 计划(`mirror/` 记录平面,见 spec §3.2)。

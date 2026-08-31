# cowork 侧改造方案:git 原生单轨集成 × memory protocol v2 保留

状态:设计定稿(2026-08-03)。
上游权威设计:`docs/gbrain集成.md`(git 原生单轨 · gitolite)。本文档只回答
一个问题:**cowork(host)侧如何从当前 `feat/kb-and-memory-protocol-v2` 分支
的状态,以结构最干净、解耦、合理的方式,改造到新设计的目标形态**——保留
memory protocol v2 改动,其余改动废弃(封存作零件库)。

---

## 1. 现状盘点与分类结论

当前分支 `feat/kb-and-memory-protocol-v2` 相对 master 共 28 个提交:

- **memory protocol v2 = 1 个提交**(`25d5f50`):`providers/memory/postgres.py`
  协议面迁移 + 5 个 `test_postgres_*` 测试 + 对 kb 线 `knowledge/memory.py`
  委派面的顺手同步(废弃 kb 后该部分自然丢弃)。
- **其余 27 个提交全部是 kb/gbrain v1(MCP 直写模式)**,按新设计逐一分类:

| 现有组件 | 新设计下的命运 | 依据 |
|---|---|---|
| `mirror.py` MCP 推送模式(`put_page` 直写 DB) | **结构性废弃** | 公理 3:不存在内容直推 DB 的通道 |
| `knowledge/memory.py` 经 MCP 的写钩子 | **结构性废弃** | 同上;沉淀改由 Distiller 落仓 |
| `source_map.py` 的 `ws-<id>` / `ws-<id>-bb` 双 source 命名 | **结构性废弃** | 新命名 `ws-<user>-<wsid>` 单 source + schema type 区分 |
| client 的 `source_id` 写扩展依赖(gbrain v125 决议 6) | **结构性废弃** | 新设计明确「该分支不 ship,gbrain 保持原生」 |
| `client.py` 连接管理/读写分级超时/MCP 预连接 | **幸存,按文件抄** | 读侧 + cap 写面照旧需要 |
| `capability.py` + `capability_sync.py`(含未提交的技能+MCP 工具统一版) | **幸存,按文件抄** | §5.4 capabilities 通道原样保留 |
| `tools.py` kb_search / kb_get | **幸存,按文件抄** | §6.5 会话内主动检索 |
| mirror 扫描/抽取纯函数层(`file_slug`/`scan_workspace`/markitdown 分派/忽略规则) | **幸存,按文件抄** | 产物从 put_page 变为写本地仓文件,扫描抽取逻辑不变 |
| startup/config/sessions 接线 | **废弃重写** | 接线随新结构按里程碑重做,`IPMC_KB_*` 键按新语义重定义、不继承旧键 |

「幸存」的复用方式一律**按文件抄进新结构**,不 cherry-pick 提交:实现成熟
可直接搬,但接线、命名、docstring 里的架构叙述全部按新设计重写——抄文件比
摘提交干净,且旧分支封存后历史仍可考。

## 2. 第一部分:分支手术(得到干净基线)

1. **旧分支收尾封存**:
   - 工作区未提交的 capability 统一改动(技能 + MCP 工具入 cap source,
     **含配套的 vendor wheel 更新**)作为 WIP commit 提交到旧分支——它与
     新设计 §5.4 完全对齐,是将来重落 CapabilitySync 的最佳参考版本。
   - 旧分支重命名 `archive/kb-mcp-write-v1` 封存,不删除。
   - `docs/项目介绍_产品经理版.md` 的移动与两条线无关,在新分支上单独重做。
2. **从 master 开新分支**(`feat/memory-protocol-v2`),cherry-pick `25d5f50`:
   - `postgres.py` + 5 个 `test_postgres_*` 干净落地(该文件在分支上只被这
     一个提交改过,无交叉污染);
   - `knowledge/memory.py`、`test_kb_memory_provider.py` 两处 hunk 因文件在
     master 不存在而冲突,解法 = 丢弃(`git rm` 冲突侧)。
   - 本 spec 文档随手术拷入新分支(新分支自 master 起,不含本文件)。
3. **重建 vendor wheel**:从 core 仓(本机 Loome-02/ctx-weft)
   `feat/memory-protocol-v2` 分支 `uv build --wheel` → re-vendor →
   `uv lock --upgrade-package` + `uv sync --reinstall-package`(版本号不变须
   刷 hash,见既有流程)。
   - **已拍板**:若 core 侧该分支混入了 capability 统一协议改动
     (`Capability`/`MCPCapabilityProvider` 面),**照单全收**——host 基线不
     import 它们,多余协议是惰性代码,不值得在 core 侧做摘取手术。
4. **验证**:`uv run pytest` 全量绿 → 基线达成:master + memory v2,零 kb 痕迹。

## 3. 第二部分:目标结构

核心结构决策:系统切成**两个平面 + 一个独立轴**,依赖方向单向。

```
src/ipmastercowork/
  providers/memory/postgres.py   ← memory v2(独立轴:会话记忆,与集成完全无关)
  mirror/                        ← 记录平面(纯确定性、纯本地、零 gbrain 依赖)
    naming.py                    ←   <user>/<wsid>/source-id 派生的唯一权威(集成设计 §2 命名预算)
    repo.py                      ←   本地镜像仓生命周期:init/布局/gbrain.yml/commit
    remote.py                    ←   GitRemoteManager:密钥、remote add、push、info 自检
    workspace.py                 ←   WorkspaceMirror v2:扫描/抽取 → files/(纯函数层自旧分支)
    distiller.py                 ←   BlackboardDistiller:SessionFinished → sessions/<id>.md
    keeper.py                    ←   keeper 派发契约:单飞/材料装配/git 事实验收/游标
    loop.py                      ←   MaintenanceLoop:双时钟 + 事件节流
  providers/knowledge/           ← 检索平面(MCP 读 + cap 写,全程 fail-open)
    client.py                    ←   自旧分支,删除 source_id 写扩展依赖
    capability.py / capability_sync.py ← 通道 2,以旧分支未提交统一版为参考重落
    tools.py                     ←   kb_search / kb_get
    state.py                     ←   通道 1:本地仓直读 _state.md,回落远端 get_page
```

**已拍板**:`mirror/` 是 `providers/` 之外的新顶层包——它不是 ctx-weft
provider,是 host 后台服务,与 `api/`、`observability/` 同级同性质。

### 3.1 依赖规则(解耦的实质)

- `mirror/` 只依赖 git + 文件系统 + host 事件总线,**一行都不 import gbrain
  客户端**。服务器不存在时它照常完整工作——这是公理 4(全链 fail-open)的
  **结构性保证**,而不是靠 try/except。
- `providers/knowledge/` 可以 import:
  - `mirror/naming`(source id 从仓命名派生——仓是系统记录、检索面是派生
    索引,代码依赖方向与公理 1 同构);
  - `mirror/repo` 的只读路径(通道 1 本地 fast path)。
- **反向 import 禁止**(`mirror/` → `providers/knowledge/` 永不出现)。
- keeper 是唯一跨面的组件,但 `mirror/keeper.py` 只做调度与验收(git 事实,
  不信 agent 自述),经 `run_single_task` 派发,自身不碰 LLM、不碰 gbrain。

### 3.2 落地节奏(对齐集成设计 §9 里程碑)

| 里程碑 | cowork 侧交付 | 备注 |
|---|---|---|
| M1 终端上行 | `mirror/` 的 naming + repo + remote + workspace | 可只用本地裸仓测试,不需要服务器 |
| M2 沉淀 | distiller + SessionFinished 订阅 | |
| M3 现状闭环 | keeper + loop + 检索平面重落 + startup 接线 | 通道 1 本地 fast path 在此接通 |

config 的 `IPMC_KB_*` 键随各里程碑按新语义重定义。

## 4. 风险与待核实点

1. **core 仓 `feat/memory-protocol-v2` 的实际内容**:手术第 3 步前须确认该
   分支状态(是否混入 capability 协议、是否与当前 dev venv 的 editable 安装
   一致)。处置原则已定(照单全收),但内容要看过。
2. **cherry-pick 后的测试面**:`test_kb_memory_provider.py` 不带入,pg 测试
   族须独立全绿;若 `25d5f50` 的 pg 测试引用了 kb 侧夹具,现场修复。
3. **命名预算**(集成设计开放议题 2):`naming.py` 落地时统一核算
   `<user>`≤6 / `<wsid>` 预算与冲突策略,是 M1 的第一件事。

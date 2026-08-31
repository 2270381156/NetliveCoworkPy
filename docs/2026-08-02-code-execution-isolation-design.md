# Agent 工具执行的准入与隔离

**日期**：2026-08-02
**状态**：设计草案，待 spike 验证后定稿
**范围**：PC 端（Windows）本地工具执行的准入判定与隔离边界，覆盖 shell 命令与代码执行两类。算力侧（Linux）隔离见另文。

---

## 1. 问题定义

### 1.1 现状

当前的工具防护是**策略型**的：`bash_policy.classify()` 对命令文本分类为 `ALLOW / CONFIRM / DENY`，`SelectiveBashAuthorizer` 据此放行、走 HITL 或拒绝。

这套机制对**shell 命令**是有效的，因为 shell 命令的危险动词表面是有限且可枚举的（`rm` / `del` / `curl` / `sudo` …）。

### 1.2 突破口：代码执行

一旦允许执行 Python（或任何解释器），策略型防护失效。

**当前的具体状态**（`src/netlivecowork/auth/bash_policy.py`）：

```
命令: python analyze.py
├─ split_segments   → ["python analyze.py"]
├─ command_word     → "python"    ← 不在 _NETWORK,不在 _DANGEROUS
├─ _path_tokens     → ["python", "analyze.py"]  ← 都不是绝对路径、无 ..
└─ 结果             → Decision(Verdict.ALLOW)   ← 零摩擦执行,不弹确认
```

而该脚本可以执行 `shutil.rmtree("C:\\")`。

同类的隐蔽入口：

| 入口 | 实质 |
|---|---|
| `pip install <pkg>` | `setup.py` / build hook 任意代码执行 |
| `npm install` | `postinstall` 钩子任意代码执行 |
| `node script.js` | 同 Python |
| `powershell -File x.ps1` | 同上 |

以上在 `_DANGEROUS` 中均不存在。

### 1.3 为什么这不是"再加几条规则"的问题

存在根本的不对称：

| | 动词表面 | 规则能否覆盖 |
|---|---|---|
| **命令文本** | 有限、可枚举 | 能覆盖大部分 |
| **代码** | 图灵完备，语义等价写法无限 | **永远漏** |

且**不需要刻意混淆**即可绕过：LLM 会自然写出 `shutil.rmtree(build_dir)`，其中 `build_dir` 在运行时计算——静态分析无法判定它指向何处。再加一层间接（`getattr(__import__('os'), 'remove')(p)`）即可击穿任何 AST 扫描。

现有 `bash_policy.py` 的 docstring 将该限制描述为"内层命令词隐藏在字符串参数里"。**这个描述低估了问题**：Python 不需要 shell out，`os.remove` / `shutil.rmtree` / `open(p,'w')` 是直接系统调用，**没有"命令词"可供检测**。

这不是同一类风险的延伸，是另一类风险。

### 1.4 为什么 HITL 不能兜底

HITL 有效的前提是**被确认的对象人类能一眼看懂**：

- shell 命令满足该前提 → 用户能判断 `rm -rf /data` 是否合理
- 程序不满足 → 用户不可能在批准前读完 200 行生成的 Python

结论：**代码执行场景下的 HITL 提供的是虚假安全感**——比没有 HITL 更危险，因为用户以为自己在把关。

### 1.5 现有 docstring 中一个需要重新评估的假设

`bash_policy.py` 接受解释器包装盲区的理由之一是：

> (b) 本环境处于内网隔离，内层网络命令即使绕过分类也实际失败

这是**用部署环境兜底策略缺口**。该假设在当前部署下成立，但一旦不成立（客户有外网出口、用户在家办公、内网存在代理），缺口即暴露。建议在文档中将其标记为**部署假设**而非**设计保证**。

---

## 2. 概念分层：准入与隔离

本节是全文的框架。后续所有设计决策都可以回到这张图上定位。

### 2.1 两层结构

```
模型：想做什么
  │  工具调用（声明意图）
  ▼
┌──────────────────────────────────────────┐
│ 准入层（harness / auth）                   │  看的是「名字」
│ 谁能调 · 参数合不合规 · 要不要人确认        │  运行【前】判定
│ 有上下文,但只能相信声明                     │
│ → 现有 bash_policy / SelectiveBashAuthorizer│
└────────────┬─────────────────────────────┘
             │ 放行
             ▼
┌──────────────────────────────────────────┐
│ 边界层（OS / sandbox）                     │  管的是「行为」
│ 实际能碰到什么 · 消耗多少 · 能否逃逸        │  运行【中】强制
│ 无上下文,但不依赖声明                       │
│ → 本文要新增的 Restricted Token / Job / IL  │
└──────────────────────────────────────────┘
```

### 2.2 两层的信息是互补的

| | 准入层 | 边界层 |
|---|---|---|
| 判定依据 | 工具名、参数、命令文本 | 实际的系统调用 |
| 判定时机 | 运行前 | 运行中，每次访问 |
| 知道上下文？ | ✅ 知道 agent / 会话 / 工作区 / 模式 | ❌ 不知道 |
| 有强制力？ | ❌ 只能相信声明 | ✅ 由内核强制 |
| 覆盖范围 | 只看到被提交的那一行命令 | **整棵进程树**（子进程继承） |
| 用户体验 | 可提前告知、可批准 | 只能事后报错 |

**准入层有上下文没强制力，边界层有强制力没上下文。** 所以策略在准入层表达、在边界层强制——是一件事的两半，不是两件独立的事。

Claude Code 文档对该区别的表述可直接引用：

> 权限规则在命令**运行前**基于命令字符串判断；操作系统在**运行中**强制沙箱边界，**所以它成立与否与模型选择运行什么无关，也与"一个被允许的命令实际做的事超出它名字暗示的范围"无关。**

### 2.3 准入层的第二个固有缺陷：TOCTOU

§1.3 论证了准入层对代码执行无能为力。这里补充**独立于代码执行**的另一条缺陷：**检查时刻与使用时刻的时间差**（Time-of-Check-to-Time-of-Use）。

`classify()` 在 T 时刻检查 `python analyze.py`——确认 `analyze.py` 在工作区内、命令词无害。但在 T 到实际执行之间：

- `analyze.py` 的**内容**可被替换（agent 上一步刚写的文件，下一步再改）
- 路径可被换成**符号链接**指向工作区外
- 目录可被替换成 junction

**准入层检查的是快照，执行的是之后的状态。** 而边界层天然免疫这一类问题——OS 在**每次实际访问时**做检查。

> 参考：Claude Code 对其 settings 保护的 deny 规则做了符号链接解析——"当一个符号链接在启动后出现在受保护的 settings 文件路径上，沙箱会把它的目标加入下一次命令的 deny 列表"。这是针对 TOCTOU 打的补丁，但也说明该问题在纯准入层方案中需要逐个场景打补丁，而边界层是系统性解决。

**结论**：即使不考虑代码执行，TOCTOU 也构成边界层不可省的独立论据。

### 2.4 命名与归属

**建议称本议题为"Agent 工具执行的准入与隔离"，而非"harness 层的权限管理"。**

后者精确命中了准入层，且"这件事属于 harness 职责而非独立安全模块"的定位是对的（openJiuwen 把权限引擎放在 `harness/security/`，我们放在 `auth/`，都是这个定位）。但用它命名整体有一个实际后果：

**命名影响归属，归属决定这件事会不会被做。** 若议题名为"harness 层权限管理"，团队会自然地派给写 harness 的人，而 Restricted Token / venv ACL / Job Object 这些会因"不属于 harness"而无人认领——它们既不像业务功能也不像安全团队的活，最容易在排期中蒸发。

代码结构上也应体现该区分：

| 层 | 现有 / 建议目录 |
|---|---|
| 准入 | `src/netlivecowork/auth/`（现有，命名恰当） |
| 边界 | `src/netlivecowork/sandbox/`（建议新增） |

---

## 3. 威胁模型

明确边界，避免过度工程与虚假承诺。

**适用范围**：本模型覆盖 agent 发起的**全部工具执行**——shell 命令与代码执行两类，不限于后者。

### 3.1 本方案要防的：事故

| 场景 | 例子 |
|---|---|
| 误删 | `shutil.rmtree` 或 `del /s /q` 打到工作区之外 |
| 误改 | 覆盖系统配置、shell 启动脚本、产品自身文件 |
| 资源耗尽 | fork bomb、内存吃满、无限循环 |
| 意外副作用 | 脚本调用关机/重启 API |
| 跨项目污染 | 项目 A 的脚本影响项目 B 的执行环境 |
| **TOCTOU** | 检查通过后路径/内容被替换（§2.3） |

**验收标准**：工作区外的写操作失败（无论来自 Python、cmd.exe、PowerShell 还是它们的任意层子进程），而正常的分析脚本与常用命令无感知地正常工作。

### 3.2 本方案**不**防的

| 不防 | 原因 |
|---|---|
| **数据外泄**（读 + 发网络） | `WRITE_RESTRICTED` 只限写，读不受限。见 §9.1 |
| 有意的提权攻击 | 用户态方案无法防内核漏洞 |
| 已有共享资源的滥用 | 命名管道、COM、其他进程的 IPC 端点 |

### 3.3 该划分的依据

防事故与防攻击的门槛相差一个数量级。前者只需保证危险操作**失败**；后者需要抵抗主动绕过。

我们的对手是"agent 手滑"，不是"agent 被操纵去攻击宿主"。按防事故设计，成本可控、验收可测。

**但这个边界必须在产品中明说**（见 §8.3），不能让用户从"有沙箱"推断出"什么都不用担心"。

---

## 4. 运行环境评估

### 4.1 嵌入式 Python：有利条件

解释器随产品分发（`NLC_FS_BASH_VENV_PYTHON` 指向随包 runtime），ACL 集合可完整枚举：

```
只读:   <install>\python\      嵌入式解释器 + stdlib
        <install>\venv\        统一 venv（含 site-packages）
读写:   <workspace>\           当前工作区,且仅当前这一个
        <temp>\<session>\      会话临时目录
其余:   拒绝写
```

对比业界同类产品：它们必须面对用户机器上任意的 Python/Node/系统环境配置。**我们不用。这是产品形态带来的红利，是本方案可行性的关键前提。**

> 注意：该红利只覆盖**代码执行**路径。bash 命令的行为无法同等枚举，处理方式见 §6.8。

### 4.2 统一 venv：需要一并处理的连带风险

近期已从"每工作区一个 venv"改为"所有工作区共用一个 venv"。该改动本身合理（省磁盘、省安装时间、避免重复安装 numpy/pandas/scipy 等大包），**不建议回退**。但它有安全侧的连带影响。

**影响面放大**：

| | per-workspace venv | unified venv |
|---|---|---|
| 一次污染的影响 | 止于单个工作区，删除重建即可 | **所有工作区 + 未来所有会话** |
| 用户可定位性 | 高 | **极低**——表现为"某项目脚本行为异常"，无人会怀疑共享 venv |

**四条注入路径**，均不需要提权，只需对 venv 目录的写权限（而 agent 当前必然拥有）：

| 路径 | 触发时机 |
|---|---|
| 放置 `sitecustomize.py` | 每次 Python 启动自动 import |
| site-packages 中的 `.pth` 文件（`import ` 开头的行会被执行） | 每次启动，**最隐蔽** |
| 修改已安装包的 `__init__.py` | 下次 import |
| 覆盖/安装同名包 | 下次 import |

**多客户合规提醒**：不同项目可能属于不同客户。unified venv 意味着 A 项目安装的包、留下的配置文件、`__pycache__` 对 B 项目可见；部分库会在自身目录缓存凭证或数据。若客户有数据隔离要求，此项可能无法通过审计。**建议至少在产品文档中显式记录"依赖环境跨项目共享"这一事实**，避免其成为隐含假设。

---

## 5. 业界调研

### 5.1 五家横评

| Agent | macOS | Linux | **Windows 原生** | 兜底 |
|---|---|---|---|---|
| **QwenPaw** | Seatbelt | Bubblewrap + Landlock | ✅ **AppContainer + Restricted Token** | — |
| **Claude Code** | Seatbelt | bubblewrap + socat + seccomp | ❌ 明确不支持 | 让你在 WSL2 里跑 |
| **OpenClaw** | Docker | Docker | ❌ 文档无 | Docker / 设备节点 / 云沙箱 |
| **Hermes Agent** | Docker 等 | Docker 等 | ❌ **只有建议，无实现** | 7 种 backend，local 无隔离 |
| **OpenCode** | 无 | 无 | ❌ **明确拒绝** | "自己去 Docker/VM 里跑" |

### 5.2 光谱

```
无隔离 ←────────────────────────────────────────────→ 原生隔离

OpenCode      Hermes         OpenClaw      Claude Code     QwenPaw
明确拒绝      local无隔离     Docker为主    mac/Linux/WSL2  三平台原生
              +6种容器        +云沙箱       原生Win不支持    含Windows
              Win只给建议                                   AppContainer
                                                           +RestrictedToken
   ↑                                                            ↑
 我们现在的位置（默认策略更严 + 有 HITL，但仍属纯准入层）      目标
```

### 5.3 关键结论

**(1) 原生 Windows 隔离只有 QwenPaw 做了**，其余四家全部选择"容器 / WSL / 不做"。

**(2) 准入层业界形态高度趋同**（allow/ask/deny + 模式匹配 + 路径边界），我们在这个维度不落后——**默认值甚至比 OpenCode 更严**（OpenCode 大部分权限默认 `allow`，我们对危险命令默认 CONFIRM、网络默认 DENY）。

**(3) 真正的分野在有无边界层，而且业界共识是"有边界后准入可以放松"**：

- Hermes 的容器/云 backend **直接跳过危险命令检查**，local backend 才做
- Claude Code 的沙箱 auto-allow 模式：**命令在沙箱里跑就自动批准，不再逐条问**——边界替代了确认

**(4) OpenCode 的反面立场值得正视**。其官方安全声明：

> OpenCode does **not** sandbox the agent. The permission system exists as a **UX feature**… **it is not designed to provide security isolation.**

该立场对开发者工具成立（用户懂风险、会装 Docker），**对我们不成立**：

| | OpenCode | 我们 |
|---|---|---|
| 用户 | 开发者 | 网络工程师，未必有安全意识 |
| 数据 | 自己的代码 | 现网拓扑/配置/流量，客户资产 |
| 部署 | 单人本地 | 大规模企业交付 |
| "自己套 Docker" | 可行 | 运营商桌面禁虚拟化是常态 |

### 5.4 WSL Containers 评估（2026-06-29 公测，目标 2026 秋 GA）

| 优势 | 风险 |
|---|---|
| 系统内置，无需 Docker Desktop（免商业授权 + 免几百 MB 安装） | 公测中，微软自己建议 GA 前不上生产，API 可能 breaking change |
| 有 Windows-facing API（C/C++/C#），可程序化集成 | **要求 Win11 + pre-release WSL 通道** |
| virtiofs 提速、启动比 Docker Desktop 快约 40%（微软自测） | **依赖 WSL/Hyper-V 可用**，企业桌面常禁 |
| 企业策略管控（限制镜像仓库） | Defender 集成仍在私有预览 |

**隔离模型**（公测期文档仍在变，建议自行验证）：跨应用/会话是 hypervisor 边界；**同一会话内的多个容器共享该会话的 Linux 内核**，属 namespace 隔离。实际隔离强度约等于 Docker，优势在集成方式而非隔离强度。

**结论**：方向正确，**但不能作为唯一方案，也不能作为默认**。存量用户中的 Win10、企业禁虚拟化、GA 时间——三条任一都足以让它不能作为可用性底座。**做成可插拔后端的最强档，不做前提条件。**

---

## 6. 技术方案：OS 级降权

### 6.1 前置：Windows 访问检查模型

进程持有 **Access Token**：

| 字段 | 内容 |
|---|---|
| User SID | 身份 |
| Group SIDs | 所属组（每个 SID 带属性标志） |
| Privileges | 特权列表，**部分特权可绕过 DACL** |
| Integrity Level | Untrusted / Low / Medium / High / System |
| Restricting SIDs | 仅 restricted token 有 |

每个可保护对象有 Security Descriptor：Owner + DACL（allow/deny ACE 列表）+ Mandatory Label。

**检查顺序**：

```
1. 强制完整性检查   对象 IL > token IL 且策略 NO_WRITE_UP → 写操作直接拒绝
2. 特权检查         部分特权直接绕过后续检查
3. DACL 遍历        deny ACE 优先,累积 allow 权限
4. 【restricted token】用 restricting SID 再走一遍 DACL,两遍都过才放行
```

第 4 步是 restricted token 的核心机制。

### 6.2 Restricted Token

`CreateRestrictedToken` 提供三种互相独立、可任意组合的削弱手段。

#### (a) `SidsToDisable` — 组 SID 降为"仅用于拒绝"

被 disable 的 SID 标记 `SE_GROUP_USE_FOR_DENY_ONLY`：**只能匹配 deny ACE，不能匹配 allow ACE**。

典型用法：disable `BUILTIN\Administrators`。用户即使是管理员，子进程也拿不到管理员的 allow 权限；针对 Administrators 的 deny ACE 仍然生效。**只减不增。**

#### (b) `PrivilegesToDelete` — 删除特权

特权是绕过 DACL 的合法后门。关键项：

| 特权 | 危害 |
|---|---|
| `SeBackupPrivilege` / `SeRestorePrivilege` | **绕过 DACL 读/写任意文件** |
| `SeTakeOwnershipPrivilege` | 夺取任意对象所有权 → 任意改 DACL |
| `SeDebugPrivilege` | 打开任意进程读写内存 |
| `SeImpersonatePrivilege` | 多种提权手法的基础 |
| `SeLoadDriverPrivilege` | 加载内核驱动 |
| `SeTcbPrivilege` | 作为操作系统的一部分 |

**实操：直接用 `DISABLE_MAX_PRIVILEGE` 标志**，删除除 `SeChangeNotifyPrivilege` 外的全部特权。

> ⚠️ `SeChangeNotifyPrivilege`（绕过遍历检查）**必须保留**。缺失时访问 `C:\a\b\c` 会对路径每一级做访问检查，大量程序会异常失败。`DISABLE_MAX_PRIVILEGE` 已自动保留该项。

#### (c) `SidsToRestrict` — 限制 SID（最强）

一旦存在 restricting SIDs，访问检查变为两遍，**必须都通过**：

```
第一遍: 用正常 user SID + group SIDs 查 DACL
第二遍: 仅用 restricting SIDs 查 DACL
```

这是真正的白名单机制：造一个专用 SID 放入 restricting 列表，仅在工作区 ACL 上为该 SID 添加 allow ACE，则进程只能触碰显式授权的位置。

#### `WRITE_RESTRICTED` 标志 — 与本场景高度契合

加上该标志后，**第二遍检查只对写操作生效**，读操作走正常检查。

| 操作 | 需求 | `WRITE_RESTRICTED` 下的效果 |
|---|---|---|
| 读嵌入式解释器 + stdlib | 必须 | 正常检查，可读 |
| 读 venv / site-packages | 必须 | 正常检查，可读 |
| 读工作区 | 必须 | 可读 |
| **写 venv** | 要禁 | 第二遍无 ACE → **拒绝** |
| **写工作区外任意位置** | 要禁 | 第二遍无 ACE → **拒绝** |
| 写工作区 / 临时目录 | 需要 | ACL 上有专用 SID 的 ACE → 通过 |

> 不使用 `WRITE_RESTRICTED` 的话，需要为 stdlib、site-packages、每个 DLL 逐一添加读 ACE，工作量与出错概率都大得多。

### 6.3 Integrity Level

Vista 引入的强制访问控制，**在 DACL 之前生效**，一次 API 调用即可设置：

```
SetTokenInformation(token, TokenIntegrityLevel, &low_il, size)
```

默认策略 `NO_WRITE_UP`：Low IL 进程无法写 Medium IL 对象。系统上绝大多数对象默认 Medium，因此设为 Low 后：

- 写不了大部分文件系统位置与 HKCU
- 不能向高 IL 进程发窗口消息（UIPI，防 shatter attack）
- 只能写标记为 Low 的位置

配套：工作区目录需标记为 Low，否则子进程写不进去。

```
icacls <workspace> /setintegritylevel (OI)(CI)Low
```

> ⚠️ `%TEMP%` 默认 Medium，Low 进程无法写入。需为专用临时目录标 Low，或使用 Windows 约定的 `%TEMP%\Low`。**这是最易踩的坑，且在 bash 场景比代码执行场景更高频（见 §6.8）。**

不建议使用 Untrusted：大量系统 DLL 加载会失败，Python 可能无法启动。**Low 是甜点。**

### 6.4 Job Object

Job 管理**资源与行为**，**完全不管访问控制**。与 token 正交，两者都需要。

```
CreateJobObject → SetInformationJobObject(配置) → AssignProcessToJobObject
```

`JOBOBJECT_EXTENDED_LIMIT_INFORMATION` 关键项：

| 标志 | 作用 |
|---|---|
| `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` + `ActiveProcessLimit` | 最大进程数 → **防 fork bomb** |
| `JOB_OBJECT_LIMIT_PROCESS_MEMORY` / `JOB_MEMORY` | 单进程 / 整 job 内存上限 |
| `JOB_OBJECT_LIMIT_JOB_TIME` / `PROCESS_TIME` | CPU 时间上限 |
| **`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`** | **句柄关闭即杀光全部进程 → 不留孤儿** |
| `JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION` | 崩溃即死，不弹 WER 对话框 |

`KILL_ON_JOB_CLOSE` 对本场景尤为重要：会话结束或 host 崩溃时，跑飞的子进程被自动清理。

#### 关于 breakaway

| 标志 | 语义 |
|---|---|
| `JOB_OBJECT_LIMIT_BREAKAWAY_OK` | **允许**子进程用 `CREATE_BREAKAWAY_FROM_JOB` 脱离 |
| `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` | 子进程**自动**不加入 job |

**默认（两个都不设）即为禁止脱离**——子进程强制继承 job 归属，且用 `CREATE_BREAKAWAY_FROM_JOB` 创建进程会失败。

**正确做法是不设置这两个标志**，而非"设置一个禁止标志"。

（嵌套 job 自 Windows 8 / Server 2012 起支持，现代 Windows 上不存在"进程已属于其他 job 导致 assign 失败"的问题。）

#### UI 限制

`SetInformationJobObject(job, JobObjectBasicUIRestrictions, ...)`：

| 标志 | 防什么 |
|---|---|
| **`JOB_OBJECT_UILIMIT_EXITWINDOWS`** | **脚本调用关机/重启 API** |
| `JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS` | 修改系统参数 |
| `JOB_OBJECT_UILIMIT_DISPLAYSETTINGS` | 修改显示设置 |
| `JOB_OBJECT_UILIMIT_HANDLES` | 使用 job 外部的 USER handle |
| `JOB_OBJECT_UILIMIT_READCLIPBOARD` / `WRITECLIPBOARD` | 读写剪贴板 |

`EXITWINDOWS` 值得单独设置——"重启使配置生效"类脚本可冲掉用户正在进行的工作。

### 6.5 四种机制的分工

| 机制 | 管什么 | 挡住的事故 |
|---|---|---|
| **Restricted Token** | 能访问**哪些对象** | `rmtree("C:\\")`、读其他项目数据、改 venv |
| **Integrity Level** | 能写**哪个级别**的对象（DACL 前的粗粒度门） | 同上，成本极低，作为纵深 |
| **Job Object** | 消耗**多少资源** + 能否逃逸 | fork bomb、内存耗尽、跑飞、关机、孤儿进程 |
| **ACL** | 具体**授权哪些路径** | 定义"工作区可写"这条边界本身 |

### 6.6 组合配方

```
① 复制当前进程 token
   OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE|TOKEN_QUERY|...)

② CreateRestrictedToken
   Flags:          DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED
   SidsToDisable:  [BUILTIN\Administrators]
   SidsToRestrict: [专用 SID]          ← 决定可写范围

③ SetTokenInformation(TokenIntegrityLevel) → Low

④ ACL 准备（安装 / 首次运行时执行一次）
   工作区:        为专用 SID 添加 (OI)(CI) 写权限 + setintegritylevel Low
   会话临时目录:   同上
   venv/产品目录:  不添加 ACE → 第二遍检查失败 → 不可写
                  读不受影响（WRITE_RESTRICTED）

⑤ CreateJobObject + §6.4 全套限制

⑥ 启动进程（顺序关键）
   CreateProcessAsUser(restricted_token, ..., CREATE_SUSPENDED)
   AssignProcessToJobObject(job, hProcess)
   ResumeThread(hThread)
```

> ⚠️ **第 ⑥ 步的 `CREATE_SUSPENDED` → assign → resume 顺序是必须的。** 若先让进程运行再 assign，它可能在被纳入 job 前 fork 出子进程，该子进程不在 job 内。这是经典竞态。
>
> Windows 10+ 可用 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在 `CreateProcess` 时直接指定 job，从根本上消除窗口期。若仅支持 Win10+，优先使用此方式。

### 6.7 环境变量必须白名单构造

子进程环境应显式构造，不得直接继承：

```
必须清除:  PYTHONPATH        改模块搜索路径
          PYTHONSTARTUP      交互模式自动执行脚本
          PYTHONHOME
          PYTHONEXECUTABLE

必须设置:  PYTHONPYCACHEPREFIX=<可写临时目录>   只读 venv 的前置条件
          MPLCONFIGDIR 及各库自有 cache 变量
          TEMP / TMP → 指向已标 Low 的会话临时目录
```

### 6.8 作用域：bash 命令与代码执行使用同一套机制

#### 6.8.1 为什么是同一套

降权是加在**进程**上的，不是加在"Python"上的。任何从降权 token 启动的进程都受同一约束：

```
python analyze.py           → 降权子进程 → 受限
cmd.exe /c del C:\...       → 降权子进程 → 受限
powershell -Command "..."   → 降权子进程 → 受限
```

且**子进程继承 token 与 job 归属**（§6.4，默认禁止 breakaway），因此：

```
cmd.exe /c "build.bat"
   └─ build.bat 调 python
        └─ python 用 subprocess 起 git
             └─ git 起 ssh
                  全部在同一个降权 token + 同一个 job 内
```

**准入层只能看到被提交的那一行命令文本，边界层覆盖整棵进程树。** 这正是 §1.5 所述解释器包装盲区的根本解法——不是去看穿它，而是让内层跑不出边界。

**结论**：bash 与代码执行共用同一套 token 派生、同一个 job、同一份 ACL，**不增加实现工作量**。

#### 6.8.2 但 bash 有三个实质差异

| # | 差异 | 说明 |
|---|---|---|
| 1 | **兼容性风险高一个数量级** | 代码执行的依赖可枚举（venv 是我们分发的）；bash 命令的行为枚举不了：`git config --global` 要写 `~/.gitconfig`、包管理器要写各种缓存、用户自带工具位置不可预知 |
| 2 | **"工作区外写"存在合法用例** | "把报告导出到桌面"、"配置 git 用户"都是正当需求；而分析脚本几乎没有此类需求 |
| 3 | **失败可诊断性差** | Python 被拒 → 明确的 `PermissionError`，agent 可见并调整；bash 被拒 → 可能是某工具第 N 层子进程失败，错误信息不知所云 |

#### 6.8.3 解法：白名单 + 排除清单 + 逃生舱

对应 §6.8.2 的三条差异，采用 Claude Code 已验证的三件套：

| 机制 | 解决 | 说明 |
|---|---|---|
| **写白名单**（`allowWrite`） | 差异 1 | 显式列出工作区外的可写路径，OS 级强制，对子进程同样生效 |
| **排除清单**（`excludedCommands`） | 差异 1 | 已知不兼容的命令整个不进沙箱（Claude Code 自己把 `docker *` 列了进去） |
| **逃生舱** | 差异 2、3 | 命令因边界限制失败时，**提升为 CONFIRM 并展示"该命令需要写工作区外的 X"**，用户批准后在宿主进程重跑 |
| **严格开关** | To B 交付 | 可配置关闭逃生舱，命令要么在沙箱内成功，要么失败 |

**逃生舱对我们几乎是白送的**——已有完整 HITL 流，链路为：

```
命令在沙箱内执行 → 因权限失败 → 提升为 CONFIRM（展示被拒的具体路径）
                → 用户批准 → 在宿主进程重跑
```

比 Claude Code 的同类机制更清楚一点：我们能在确认框里告诉用户**具体是哪个路径被拒**，而不只是"这个命令要脱离沙箱"。

#### 6.8.4 两层配合在 bash 场景比代码执行场景更有价值

代码执行场景下准入层基本无能为力（§1.3），边界层是唯一防线。

**bash 场景不同——路径大多明文出现在命令里，准入层有真实价值。** 现有的 `_looks_outside_workspace()` 正好承担该角色：

| 层 | 职责 | 价值 |
|---|---|---|
| **准入层**（现有 `classify`） | 命令文本出现工作区外路径 → CONFIRM | **提前告知 + 给批准机会**，体验好 |
| **边界层**（新增降权） | 写操作实际发生时拒绝 | **兜住准入层漏掉的**：运行时算出的路径、藏在脚本里的、子进程里的、TOCTOU |

**因此：加入边界层后，准入层的路径检查不但不应删除，价值反而提升**——有了兜底，准入层可以更侧重"用户体验"（提前问）而非"安全保证"。

#### 6.8.5 Windows 特有的两个坑

**(1) PowerShell 在 Low IL / restricted token 下的行为需实测。**

`FsTool.BASH_EXEC` 的注释指出实际 shell 是 `cmd.exe` / `/bin/sh`，从不是 bash。在 Windows 上：

- `cmd.exe` 降权运行问题不大
- **PowerShell 更复杂**——加载 profile、读模块路径、模块自动加载、execution policy。这些在 Low IL 下是否正常**本文未验证**，需实测

若兼容性差，退路：列入 `excludedCommands`（回落到准入层 + HITL），或强制以 `-NoProfile -NonInteractive` 启动。

**(2) `%TEMP%` 的坑在 bash 场景严重得多。**

大量命令行工具向 `%TEMP%` 写入，而 `%TEMP%` 默认 Medium IL（§6.3）。**给会话临时目录标 Low 并重定向 `TEMP` / `TMP` 在 bash 场景从"建议"变为"必须"**，命中率远高于代码执行场景。

---

## 7. 统一 venv 的处理

### 7.1 设计张力

- **venv 对代码执行子进程可写** → §4.2 的四条注入路径全部开放，降权基本失效
- **venv 只读** → agent 无法 `pip install`，功能受损

必须正面解决。

### 7.2 方案：venv 只读 + 包安装提升为独立 capability

```
代码执行子进程（降权）:  venv 只读、产品目录只读、仅工作区可写
包安装:                独立 capability（如 pkg:install）
                       走宿主进程（不降权）
                       强制 HITL，展示包名 + 来源 + 版本
```

agent 仍可安装依赖，但安装成为**显式、可审计、不可由任意代码触发**的动作。

**一石二鸟**：`pip install` / `npm install` 本身即任意代码执行入口（`setup.py`、`postinstall`）。将其单列，同时堵上该入口。

**不采用分层 venv**（base 只读 + 每工作区 overlay）：刚从 per-workspace 改为 unified，分层等于部分回退；且 Python 的 venv 分层不如容器镜像层干净，`.pth` 叠加语义坑较多。

### 7.3 只读 venv 的实操坑

部分包会在 import 或首次使用时向自身目录写入（编译缓存、`__pycache__`、下载模型/数据）。只读后会报错，且错误信息通常难以理解。

需配套设置的环境变量见 §6.7（不完整，须按实际依赖补充）。

> **重要**：改为只读之前，先用完整依赖清单跑一遍冒烟测试，找出所有需要写入的位置并重定向。否则会遭遇一批难以理解的报错，容易误判为"只读方案行不通"而放弃。

---

## 8. 架构调整

### 8.1 代码执行拆为独立 capability

**现状**：代码执行寄生于 `fs:shell`（`FsTool` 中仅有 `shell` / `read_file` / `write_file` / `glob`，`bash_exec` 为 `shell` 的兼容别名），复用为 shell 命令设计的 `SelectiveBashAuthorizer`。

**目标**：

| capability | authorizer | 语义 |
|---|---|---|
| `fs:shell` | `SelectiveBashAuthorizer` | 准入策略 + HITL + 边界层 + 逃生舱（§6.8.3） |
| `fs:exec_code`（新） | `SandboxedCodeAuthorizer` | **强制走边界层，无逃生舱** |
| `pkg:install`（新） | `PackageInstallAuthorizer` | 宿主进程执行 + 强制 HITL |

注意三者的**逃生舱策略不同**：bash 有合法的越界需求（§6.8.2 差异 2），代码执行没有——分析脚本不应该需要写工作区外。**这个差异正是拆分 capability 的价值所在：它让"哪些能降级、哪些不能"成为架构约束而非约定。**

目前"代码执行必须隔离、shell 可用策略 + 逃生舱"这条规则只存在于讨论中，代码里无法表达——因为它们是同一个 capability id、共用同一个 authorizer。

该拆分亦与 openJiuwen 的 `BaseCodeProtocol` / `BaseShellProtocol` 分离一致——**若后续要把代码执行送算力侧，接口形状是现成对齐的**。

### 8.2 沙箱后端可插拔 + 自动降级

```
探测顺序:
1. Restricted Token + Job Object     ← 本方案，无外部依赖
2. wslc（WSL Containers）            ← GA 后接入，最强档
3. Docker / Podman                   ← 用户已安装时（不主动要求安装）
4. 无边界层 + 准入层                  ← 兜底，明确告知隔离等级
```

第 4 档不是"没做沙箱"，而是"**降级并告知**"。现有准入层在该档位是唯一防线。

### 8.3 降级语义与用户告知

Claude Code 的托管配置提供 `sandbox.failIfUnavailable`：依赖缺失时**硬失败拒绝启动**，而非警告后无沙箱运行。

对应到本产品：

- 默认：降级 + **显眼地告知当前隔离等级**
- 提供开关：To B 交付时可配置为"边界层不可用即拒绝启动"

**这一条同时是从 OpenCode 学到的**：把限制说在明处。不能让用户从"有确认框"推断出"我是安全的"，也不能让用户从"有沙箱"推断出 §3.2 那些也被防住了。

---

## 9. 未覆盖的风险与后续方向

### 9.1 网络：必须单独做

Restricted Token 与 Job Object **均不管网络**。而本方案的读操作不受限，因此**"读取现网数据 + 外发"这条路径完全不被覆盖**。

**建议解法（按成本排序）**：

1. **默认禁网 + 独立授权 capability** —— 子进程默认无网络访问，联网须走单独授权路径。成本最低
2. **AppContainer** —— 其 capability 模型（`internetClient` / `internetClientServer` / `privateNetworkClientServer`）**由 OS 强制**，不授予即无法联网。这是相对 Restricted Token 的实质优势
3. **WFP（Windows Filtering Platform）** —— 最强也最重

> 注意：Windows 上没有 Linux network namespace 的等价物，**纯代理方案（设 `HTTP_PROXY` 等环境变量）可被进程直接绕过**，不构成强制边界。

bash 场景下网络类命令更常见（`curl` / `git clone` / `pip`）。当前准入层对网络命令直接 DENY（基于内网部署假设，见 §1.5）；若该假设放宽，本项的优先级需相应提升。

### 9.2 AppContainer 作为加固目标

**观察**：QwenPaw 的实现顺序是 **AppContainer 先（PR #5525），Restricted Token 后（PR #5931）**，且后者被标注为 "an additional sandbox option"。

**推测**（待验证）：AppContainer 是更正统更强的方案，但对程序兼容性要求高；实现后发现部分场景不通，遂补一个兼容性更好的 restricted token 作为退路。

若该推测成立，对我们的含义：

- **Restricted Token 作为起点正确**——兼容性更好、落地更快
- **AppContainer 值得作为后续加固目标**——它一并解决 §9.1 的网络问题
- 我们的环境（嵌入式 Python、可控依赖清单）比 QwenPaw（任意用户环境）干净得多，**AppContainer 的兼容性风险对我们可能显著更低**

结论：不是二选一，而是 **Restricted Token 起步 → AppContainer 加固**。

### 9.3 供应链：工作区内容影响 agent 配置

OpenCode 有一个值得借鉴的设计：**用 SHA-256 内容哈希管控仓库内的 `.mcp.json`**——恶意仓库不能靠自带配置文件自动拉起 MCP server；OpenCode 在启动时拦截未信任配置，标记为未批准，**在 MCP server 启动之前阻断**。

**对我们直接相关**：存在 `RemoteSkillSourceManager`（git skill 源）与 MCP 支持，而项目空间中包含"现网脚本"等外部来源内容。

**待排查项**（独立于代码执行的供应链攻击面）：

- [ ] 工作区中放置文件能否改变 agent 加载的 skill？
- [ ] git skill 源更新时，新增 skill 是自动生效还是需确认？
- [ ] MCP 配置从何处读取，工作区能否影响？

若任一为"能"，应加入内容哈希 + 首次批准机制。**成本低，堵的是另一类洞。**

---

## 10. 落地计划

### 10.1 止血（立即，成本≈0）

| # | 动作 | 验收 |
|---|---|---|
| 1 | `python` / `python3` / `node` / `pip` / `npm` / `uv` / `powershell -File` 加入 `_DANGEROUS` → CONFIRM | `python x.py` 触发确认 |
| 2 | **HITL 确认时展示待执行的代码内容**，而非仅命令行 | `python -c "..."` 展示内联代码；`python foo.py` 展示文件内容或 diff |

> 第 2 条是关键。仅加 CONFIRM 而不改展示，用户看到 `python analyze.py` 仍会点同意——**仪式感更强，实际防护未变**。

### 10.2 根治：分三阶段收紧

不要一次性把所有工具执行塞进边界层。原则是**先摘低垂果实**：代码执行风险最高但兼容性风险最低（环境可控），bash 风险中等但兼容性风险最高。

#### 阶段 A：代码执行进入边界层

**第一天必做的 spike（决定方案生死）**：

> 验证：从当前进程派生的 restricted token 能否用于启动进程。
>
> `CreateProcessAsUser` 通常需要 `SeAssignPrimaryTokenPrivilege`（一般仅服务账户具备），但**自派生 restricted token 属于特例**，主流沙箱实现（Chromium sandbox）走的正是此路径。
>
> **本文尚未验证此点。** 若实测需要特权，退路为 `CreateProcessWithTokenW`（需 `SeImpersonatePrivilege`）或调整 token 派生方式。
>
> **约 20 行代码。不通则整个方案不成立，勿在设计上继续投入后才发现受阻。**

spike 通过后：

| # | 动作 | 验收 |
|---|---|---|
| A1 | 依赖清单冒烟测试，找出所有需写 venv 的位置并重定向 | 全部依赖在只读 venv 下可正常 import 与运行 |
| A2 | 拆出 `fs:exec_code` / `pkg:install` 独立 capability + authorizer | 代码执行不再复用 bash authorizer |
| A3 | 加 Low IL | 依赖冒烟测试仍通过 |
| A4 | 加 `WRITE_RESTRICTED` + 专用 SID + 工作区 ACL | **`shutil.rmtree("C:\\")` 失败；正常分析脚本无感知通过** |
| A5 | 加 Job Object | fork bomb 被挡；`KILL_ON_JOB_CLOSE` 清理干净 |
| A6 | 降级探测 + 隔离等级告知 + 严格开关 | 各档位行为符合预期 |

#### 阶段 B：埋点收集 bash 实际分布（2~4 周，与阶段 A 并行启动）

**这是阶段 C 的前置，需要提前几周开始，不能等到要做 C 时才想起。**

采集内容：

- 执行了哪些命令（命令词分布）
- 写入了哪些工作区外路径（频次排序）
- 哪些命令的子进程层级较深

**我们有真实用户，这份数据别人拿不到。** 用它决定阶段 C 的白名单，比参考任何外部配置都准。

#### 阶段 C：bash 进入边界层

| # | 动作 | 验收 |
|---|---|---|
| C1 | 用阶段 B 数据配置 `allowWrite` 白名单 | 高频合法越界路径不再触发失败 |
| C2 | 用阶段 B 数据配置 `excludedCommands` | 已知不兼容命令回落到准入层 |
| C3 | 逃生舱（复用现有 HITL） | 被拒命令提升为 CONFIRM 并展示被拒路径；批准后宿主重跑 |
| C4 | PowerShell 兼容性实测（§6.8.5） | 明确 PowerShell 是进沙箱还是列入 excluded |
| C5 | `TEMP`/`TMP` 重定向 + Low IL 标记 | 常用工具链在沙箱内正常工作 |

### 10.3 加固（后续）

- 网络：默认禁网 + 独立授权 capability（§9.1）
- AppContainer 后端（§9.2）
- wslc 后端（GA 后，§5.4）
- 供应链排查（§9.3）

### 10.4 优先级说明

Project 显式化、算力侧作业等是**功能价值**——延后只是延后收益。

本方案是**风险敞口**——每延后一天都在累积事故概率，且事故不可逆（用户数据丢失）并叠加声誉损失。用户规模越大，事故期望值增长越快（一次事故的声誉代价与用户数相关，呈超线性）。

**因此：§10.1 止血立即执行，阶段 A 两周内排入，阶段 B 埋点同期启动。** 止血削掉最陡的一段风险后，本方案与功能演进可并行推进。

---

## 附录 A：调试建议

权限被拒时 Python 抛出的是笼统的 `PermissionError`，shell 工具的报错往往更含糊，均无法区分是 IL 拒绝、第一遍 DACL 拒绝还是第二遍拒绝。

**开发期使用 Process Monitor 抓 `ACCESS DENIED` 事件**，可直接定位是哪个对象、哪一层拒绝，效率比推测高一个数量级。阶段 C 排查 bash 兼容性问题时尤其依赖此工具。

## 附录 B：实现参考

**Python 侧**：`pywin32` 提供全套封装（`win32security.CreateRestrictedToken`、`win32job.*`、`win32process.CreateProcessAsUser`），亦可 `ctypes` 直接调用 advapi32 / kernel32。项目已依赖 `psutil`，新增 `pywin32` 负担可接受。

**唯一可读的生产参考实现**：QwenPaw（agentscope-ai）

- AppContainer 沙箱：PR #5525
- Restricted token 沙箱：PR #5931

> 抓取到的 release 页日期疑似有误（显示 2024 年，与 PR 编号及当前时间不符），**版本时间请自行到仓库确认**。PR 编号本身明确，可直接阅读实现，尤其关注其对附录中 spike 问题的处理方式。

## 附录 C：来源

- [agentscope-ai/QwenPaw](https://github.com/agentscope-ai/QwenPaw) · [Releases](https://github.com/agentscope-ai/QwenPaw/releases)
- [Configure the sandboxed Bash tool — Claude Code Docs](https://code.claude.com/docs/en/sandboxing)
- [Security — anomalyco/opencode](https://github.com/anomalyco/opencode/security) · [Permissions — OpenCode Docs](https://opencode.ai/docs/permissions/) · [Issue #12674](https://github.com/anomalyco/opencode/issues/12674)
- [Sandboxing & Isolation — openclaw/openclaw (DeepWiki)](https://deepwiki.com/openclaw/openclaw/7.3-sandboxing-and-isolation) · [Sandboxing — OpenClaw Docs](https://docs.openclaw.ai/gateway/sandboxing)
- [Security — Hermes Agent Docs](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- [WSL container is now available for public preview — Windows Command Line Blog](https://devblogs.microsoft.com/commandline/wsl-container-is-now-available-for-public-preview/) · [The New WSL Container — pisinger](https://pisinger.github.io/posts/wsl-container-decoded/)

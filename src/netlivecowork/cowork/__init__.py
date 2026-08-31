"""cowork —— 套件、授权、能力归属。

这一块**新增**，与现有后端的关系见 docs/2026-08-26-NetLIVE-Cowork-地端架构设计.md：
读路径从外面包一层（集中、可测、可去掉），写路径老老实实改对应的包。

两簇，分界是「包 → 磁盘」与「磁盘 → 运行」：

  交付链
    fetch.py          向云端管理服务要清单与包（错误分类、重试、4xx 不重试）
    staging.py        暂存目录：**待装**的包与那份授权凭据
    signature.py      验签。验不过一律不装，且不删已装的旧版本
    entitlement.py    对账的**领域逻辑**：该有哪几个 × 已装哪几个 → 装什么/删什么
                      ← 纯函数，不碰网络、不碰文件
    install.py        解包、装、删（防路径穿越、先全读再落盘）
    installed.py      **已装**清单：列出、读版本（与 staging 对称）
    reconcile.py      总装 —— **全模块唯一真的改变本地状态的地方**

  运行期
    scope.py          会话 → cowork 的登记表。只回答归属，不承载能力语义
    policy.py         归属 → 能不能用（MCP / LLM / 市场 / 可用性）
    runtime.py        进程级单例与装配
    guards/           包装内核 provider，按归属过滤（MCP、本地 skill）

  共享词汇
    manifest.py       清单的**结构**：Cowork / MCPServerDef / LLMAccountDef
    manifest_parse.py 清单的**解析**：容忍缺字段，不拒绝启动
                      ← 与结构分开：改字段的人看前者，处理下发兼容的人看后者

⚠ 依赖方向单向：本包可以依赖内核协议与现有后端；**反过来不行**。
`providers/` `persistence/` 不得 import 本包（见架构设计 §7 的 import 规则测试）。
"""

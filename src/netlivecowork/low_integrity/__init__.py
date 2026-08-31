"""low_integrity —— strict-auto 会话的 OS 写入边界（Windows 低完整性级别）。

注意：这**不是** Docker 那种容器隔离——只把子进程降到低完整性级别，**仅限制"写工作区外"**，
读、联网、跑什么程序都不限。本质是个 OS 层写入边界，不是 Docker 那种全隔离容器。

只在 **strict-auto 会话 + Windows** 生效；其余一律走内核默认执行（不碰内核，见 low_shell）。
机制见《全自动模式安全设计》§5：把 agent 的 shell/代码子进程降到 Low 完整性级别，
只让它写 {工作区 + 共享环境 + 一个 Low 临时目录}，其余只读；读不受限。

模块划分：
  env       —— 可写集 + 两组环境变量重定向（TEMP + 家目录/AppData → Low 目录）。跨平台纯逻辑。
  windows   —— Low 令牌 / icacls 标 Low / CreateProcessAsUser + 管道→StreamReader 适配器。仅 Windows。
  low_runner—— 自带的 run-with-liveness（用 Low 启动器起进程）。仅 Windows。
  low_shell —— provider 子类用的 shell 处理器：非低完整性会话委托内核、低完整性会话走 Low 路径。
"""

from netlivecowork.low_integrity.env import LowIntegrityLayout, redirect_env

__all__ = ["LowIntegrityLayout", "redirect_env"]

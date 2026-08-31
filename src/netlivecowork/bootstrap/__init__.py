"""进程装配根：把 host 的一切装到一起，供 cli / 冻结态入口调用。

分两层，界线是**要不要事件循环**：
  host_runtime.build_host_runtime()  同步装配，所有 capability provider 只在这里注册；
  lifecycle.start_* / stop()         需要跑在事件循环里的（DB、模板同步、目录监视、
                                     MCP 预连接、崩溃恢复）及其收摊。

api 层不参与装配：它只接过装好的 HostRuntime，注入 deps、挂路由、挂外面给的 lifespan。
"""

from netlivecowork.bootstrap.host_runtime import HostRuntime, build_host_runtime, db_url_from

__all__ = ["HostRuntime", "build_host_runtime", "db_url_from"]

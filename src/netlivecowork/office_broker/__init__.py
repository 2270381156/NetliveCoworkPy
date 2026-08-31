"""Office broker：让自动模式（低完整性）会话也能用 Office COM，同时守住"只能写工作区"。

为什么需要它：DCOM 用【调用方的完整性级别】启动进程外 COM 服务器，Low 会话里 Dispatch 出来的
EXCEL.EXE 自己也是 Low，连临时文件都写不了（实测 Workbooks.Add() 即失败，报错还伪装成
"内存或磁盘空间不足"）。给 Low 补可写目录这条路已验证走不通：把 %TEMP% 标 Low 之后 Excel 仍然
失败，再往下就得开放 HKCU 的 Office 键和 %APPDATA%\Microsoft\Excel，而那里的 XLSTART 是"用户
下次开 Excel 就自动执行"的目录，等于给 agent 留后门。

所以把 COM 挪到边界外的一个受控 Medium 进程里，agent 只能通过一条能审计的窄通道驱动它：

  policy      —— 闸门：ProgID 白名单 + 危险成员封禁 + 参数级路径校验（纯逻辑，跨平台可测）
  protocol    —— 线协议：4 字节长度前缀 + JSON
  pipe        —— 命名管道（安全描述符带 Low 完整性标签，否则 Low 客户端写不进去）
  server      —— Medium 侧 broker 主循环，持有 COM 对象表
  client_stub —— 投递给 agent 的 `ipmc_office.py`（用法同 win32com.client）
  manager     —— host 侧生命周期：按会话起停、注入连接环境
"""

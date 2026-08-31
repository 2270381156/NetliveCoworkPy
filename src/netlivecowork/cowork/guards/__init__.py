"""包装器 —— 把现有 provider 包一层，按 cowork 归属过滤。

**为什么用包装而不是让 provider 自己问**（架构设计 §3.3）：
认识 cowork 的地方从"每个能力各一处"收成"每种协议一个包装器"。
代价是要盯住两件事，而这两件都能被测试机械挡住：

    包装器必须是内核抽象基类的**真子类**   —— 否则该类能力整个从索引里消失
    包装器必须覆盖协议的**全部公开方法**   —— 内核长出新方法就会静默漏一个洞

第二条尤其要紧：内核以只读 wheel 交付且在持续更新，而漏掉的那一刻不报错。
⇒ tests 里有一条拿包装器方法集比对协议基类的检查，少一个就红。
"""
from .local_skill import CoworkScopedLocalSkillProvider
from .mcp import CoworkScopedMCPProvider

__all__ = ["CoworkScopedLocalSkillProvider", "CoworkScopedMCPProvider"]

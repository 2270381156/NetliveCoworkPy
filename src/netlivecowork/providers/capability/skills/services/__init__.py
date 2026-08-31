"""用例层 —— API 直接调的那两个 service。

它们跟 ``provider.py`` 的分工是：**service 服务于人，provider 服务于模型。**
用户在技能页点"添加/删除/上传"走 service；agent 在会话里用一个 skill 走 provider。
两边共用引用库（``references/``）与执行期机制（``runtime/``），但入口不同、时机不同，
所以没有合成一个。
"""

from .local import LocalSkillService
from .market import SkillMarketService

__all__ = ["LocalSkillService", "SkillMarketService"]

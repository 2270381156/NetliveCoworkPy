"""技能市场的接口适配层 —— 一家市场一个 adapter。

分法照搬 ``providers/llm/``：那边 ``llm_provider`` 管领域逻辑、按 ``style`` 选 adapter，
``adapters.py`` 里每家 API 方言一个类，只管"这一家怎么说话"（端点推断、SSL、建客户端）。
provider 从头到尾不知道 OpenAI 和 Anthropic 有什么区别。

这里要立的是同一条规矩：**上层不该知道有几家市场、哪家要鉴权、哪家要翻页。**

对外只导出契约本身。具体某一家（cowork / mythos）由后续步骤搬进来，届时在这里登记。
"""

from .base import MarketContext, MarketItem, SkillMarketAdapter

__all__ = ["MarketContext", "MarketItem", "SkillMarketAdapter"]

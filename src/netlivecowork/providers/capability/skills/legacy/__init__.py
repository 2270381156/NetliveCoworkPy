"""过渡物：迁完就能整目录删掉的东西。

这里放的**不是产品功能**，是把老数据搬到新形态的一次性代码。单开一个目录是为了让
"哪些能删"一眼看得出来——原先它们和长期功能同住在包根，想清理时得先逐个判断哪个还在用。

    pull_store.py   旧的"已装市场 skill"记录（skill_pull_config.json）。只被下面那个读。
    migration.py    把上面那些转成引用，并删本地文件。

**退役条件**：确认所有在用的安装都已启动过一次带本迁移的版本（届时它们的
``skill_pull_config.json`` 已清空或不存在）。满足后删掉整个目录，并去掉 ``api/startup.py``
里那次调用。**在此之前不能删**——删了会让还没升级的用户丢 skill。

不直接删而只是标注，是因为"能不能删"取决于外部事实（有多少人还没升级），代码里判断不了；
但"删的条件是什么"可以写下来，免得下一个人要么不敢动、要么删早了。
"""

from .migration import migrate_pulled_to_references
from .pull_store import SkillPullStore

__all__ = ["SkillPullStore", "migrate_pulled_to_references"]

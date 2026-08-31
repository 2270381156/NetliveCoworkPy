"""云端 skill 的「引用」—— 只记住引用了什么，不存内容。

内容在运行时按需下载到临时目录、用完即删（见 ``runtime/materialize.py``）。这里只有两件事：
``store`` 是那份 JSON 的读写，``defaults`` 是随包默认引用的一次性播种与坏数据清理。
"""

from .store import SkillReference, SkillReferenceStore

__all__ = ["SkillReference", "SkillReferenceStore"]

"""云端 skill 的「引用」—— 只记住引用了什么，不存内容。

内容在运行时按需下载到临时目录、用完即删（见 ``runtime/materialize.py``）。这里有
三件事：``store`` 是那份 JSON 的读写，``defaults`` 是随包默认引用的播种与坏数据清理，
``presets`` 是 profile 预置引用的差量协调器。
"""

from .presets import ProfileSkillPresetReconciler, ReconcileResult
from .store import SkillReference, SkillReferenceStore

__all__ = [
    "ProfileSkillPresetReconciler",
    "ReconcileResult",
    "SkillReference",
    "SkillReferenceStore",
]

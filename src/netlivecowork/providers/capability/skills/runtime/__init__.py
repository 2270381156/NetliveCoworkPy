"""执行期机制 —— 一个云端 skill 从「一串字节」变成「能跑的目录」，用完再抹掉。

``zip_utils`` 校验并解包，``materialize`` 管临时目录的生命周期与会话清扫，
``reporting`` 记录这次用的 skill 自带的上报元数据。三者都不认识市场，也不认识引用库：
它们只处理"手上这个 zip / 这个目录"。
"""

from .materialize import materialized, sweep_session, temp_root
from .zip_utils import extract_zip, validate_skill_zip

__all__ = [
    "materialized", "sweep_session", "temp_root",
    "extract_zip", "validate_skill_zip",
]

"""套件的来源校验 —— **这份东西确实是我们发的**。

## 为什么必须有

套件里带着提示词与 MCP 连接定义。没有签名，**能往托管处放文件的人，就能让所有装了该
套件的机器去连任意地址、按任意提示词行动**（需求 §D 开头）。

## 签名保证什么、不保证什么

    保证    这份 zip 是持有私钥的人发的，且发出后一个字节没被改过
    不保证  它落到用户磁盘之后没人读得到 —— 套件会解包到用户数据目录，
            本机任何进程都能打开。⇒ 套件仍不得携带明文凭据（需求 NFR-4）

## 与内容哈希的分工

下发契约里有个 `X-Package-Sha256` 响应头。**那一层防的是传输损坏与截断，
不是防篡改** —— 哈希与包走同一条通道，能改包的人也能改哈希（需求 C8）。

## ⚠ 当前状态：骨架 + 开发密钥

真包怎么带签名**尚未与运维确认**（需求 OQ-5）：塞进 zip 内 / 加一个响应头 /
单独端点取，三条路都可能。本模块把验签这一步**先摆进安装链路**，
并按"签名随包一起给"的形状实现；等契约定了，只改 `extract_signature()` 一处。

**没有做成"先放行、以后再补"**：留一个"没签名就放行"的口子等于没签名——
攻击者只需把签名去掉（需求 D5）。所以开关是**是否启用整套验签**，
一旦启用就一律要求，不存在半开状态。
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import zipfile
from dataclasses import dataclass
from io import BytesIO

logger = logging.getLogger(__name__)

#: 签名在包里的位置（当前形状；契约定了可能改这一处）。
SIGNATURE_ENTRY = "cowork.sig"

#: 开发密钥。**只用于开发期自签**，发布构建里靠真密钥（见 trusted_keys）。
#: 它是公开的、写在源码里的——所以**绝不能**让它出现在发布构建的可信名单里。
DEV_KEY_ID = "dev"
_DEV_SECRET = b"netlive-cowork-dev-signing-key-not-for-release"


class SignatureError(Exception):
    """验签没过。**与"下载失败"分开报**（需求 D6）。

    验签失败可能是发布流程出错，也可能是包被替换了。
    静默跳过的现象是"改了没生效"，与一次攻击**完全无法区分**。
    """


@dataclass(frozen=True)
class Signature:
    key_id: str
    value: str


def trusted_keys() -> dict[str, bytes]:
    """内置的可信密钥：key_id → 密钥。

    ⚠ **公钥必须随应用交付，绝不能从下发通道取**（需求 D2）——
    从同一条通道取公钥等于没验：能改包的人也能改公钥。

    **支持多把，任一把验过即通过**（需求 D4）：否则轮换密钥要求所有客户端同时升级，
    实际做不到；而密钥一旦不能轮换，泄露时就只剩重出包一条路。
    """
    keys: dict[str, bytes] = {}
    if _dev_signing_enabled():
        keys[DEV_KEY_ID] = _DEV_SECRET
    # TODO(OQ-5)：真密钥在契约定了之后加进来。加在这里，不要加在别处——
    # "有哪几把可信密钥"必须只有一个来源。
    return keys


def _dev_signing_enabled() -> bool:
    """开发密钥只在**非发布构建**里可信。

    ⚠ 这是最容易漏的一条（需求 D8）：为本地方便加一个"跳过验签"的开关，
    然后它留在了发布版里。所以判据取自**构建类型**，不是运行期配置——
    运行期配置能被改，构建类型不能。
    """
    from netlivecowork import paths
    return not paths.is_frozen()


def signing_enabled() -> bool:
    """这个构建要不要验签。

    没有任何可信密钥时返回 False（等于本期还没接上真密钥的状态）。
    ⚠ 一旦有了密钥就**一律要求**，不存在"没签名就放行"（需求 D5）。
    """
    return bool(trusted_keys())


def sign(data: bytes, *, key_id: str = DEV_KEY_ID) -> str:
    """给一段字节算签名。**开发与测试用**；发布签名在构建流水线里做。"""
    secret = trusted_keys().get(key_id) or _DEV_SECRET
    return hmac.new(secret, data, hashlib.sha256).hexdigest()


def extract_signature(data: bytes) -> Signature | None:
    """从包里取出签名。取不到返回 None。

    当前形状：zip 内一个 ``cowork.sig``，内容为 ``<key_id>:<签名>``。
    契约定了之后只改这一个函数（需求 OQ-5）。
    """
    try:
        with zipfile.ZipFile(BytesIO(data)) as zf:
            if SIGNATURE_ENTRY not in zf.namelist():
                return None
            raw = zf.read(SIGNATURE_ENTRY).decode("utf-8", errors="replace").strip()
    except (zipfile.BadZipFile, OSError, KeyError):
        return None
    key_id, _, value = raw.partition(":")
    if not key_id or not value:
        return None
    return Signature(key_id=key_id.strip(), value=value.strip())


def signed_bytes(data: bytes) -> bytes:
    """被签名覆盖的那部分字节。

    **签名必须覆盖整个包，不能只签清单**（需求 D3）：只签清单的话提示词可以被随意
    替换而验签照过 —— 而提示词就是这个 agent 的全部行为。

    实现上把签名条目本身排除在外（它不可能签自己），其余**逐条按名字排序后连起来**算。
    不直接对整个 zip 字节流算：同样的内容重新打一次包，字节流会因压缩参数、
    时间戳而不同，那样签名就没法在打包与安装之间传递了。
    """
    out = bytearray()
    with zipfile.ZipFile(BytesIO(data)) as zf:
        for name in sorted(n for n in zf.namelist() if n != SIGNATURE_ENTRY):
            out += name.encode("utf-8") + b"\0"
            if not name.endswith("/"):
                out += zf.read(name)
            out += b"\0"
    return bytes(out)


def verify(data: bytes) -> None:
    """验签。**不通过就抛，绝不放行**（需求 D1/D5）。

    这个构建没有任何可信密钥时直接返回 —— 那是"本期还没接上真密钥"的状态，
    不是"这个包可以不验"。两者的区别在于：前者是全局的、可见的；
    后者会变成一个按包放行的口子。
    """
    if not signing_enabled():
        return

    sig = extract_signature(data)
    if sig is None:
        raise SignatureError(
            f"套件没有签名（应含 {SIGNATURE_ENTRY}）。"
            "不接受未签名的包——留这个口子等于没签名"
        )

    keys = trusted_keys()
    secret = keys.get(sig.key_id)
    if secret is None:
        raise SignatureError(
            f"签名用的密钥 {sig.key_id!r} 不在可信名单里（可信：{sorted(keys)}）"
        )

    expected = hmac.new(secret, signed_bytes(data), hashlib.sha256).hexdigest()
    # 定长比较：避免按字节提前返回泄露信息。
    if not hmac.compare_digest(expected, sig.value):
        raise SignatureError("签名对不上——这份包在发布之后被改过，或者发布流程出了错")


def attach_signature(data: bytes, *, key_id: str = DEV_KEY_ID) -> bytes:
    """给一个包补上签名，返回新的 zip 字节。**开发与测试用。**"""
    value = hmac.new(trusted_keys().get(key_id) or _DEV_SECRET,
                     signed_bytes(data), hashlib.sha256).hexdigest()
    buf = BytesIO()
    with zipfile.ZipFile(BytesIO(data)) as src, zipfile.ZipFile(buf, "w") as dst:
        for item in src.infolist():
            if item.filename == SIGNATURE_ENTRY:
                continue
            dst.writestr(item, src.read(item.filename))
        dst.writestr(SIGNATURE_ENTRY, f"{key_id}:{value}")
    return buf.getvalue()


def _env_flag(name: str) -> bool:  # pragma: no cover - 仅供排查用
    return (os.getenv(name) or "").strip().lower() in {"1", "true", "yes"}

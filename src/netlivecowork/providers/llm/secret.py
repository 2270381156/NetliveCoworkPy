"""LLM api_key 混淆加密（obfuscation-grade）。

目的：让 api_key 不以明文躺在磁盘文件里（.env / llm_configs/*.json），
挡住"打开文件直接看见"这种随手查看。

⚠️ 这是混淆，不是真正的加密：解密密钥内置在本源码里，随应用分发，
有决心的人反编译/抓内存仍可取得。真正保密需把 key 放服务端走代理。

设计：
- 用内置 secret 经 sha256 派生密钥流，与明文 XOR，再 base64 → 密文。
- 密文带魔法前缀 ``enc:v1:``；``decrypt_key`` 对**无前缀的值原样透传**，
  因此明文 key 仍可直接使用（dev 方便），且对历史明文存储向后兼容。

生成密文（给打包/配置用）：
    python -m netlivecowork.providers.llm.secret encrypt "sk-ant-..."
    -> enc:v1:....   把它填进默认账号种子 default_llm_accounts.json 的 api_key，
       或用户账号库 llm_configs 即可（运行时自动解密）。
"""

from __future__ import annotations

import base64
import hashlib

_MAGIC = "enc:v1:"

# 内置混淆密钥。改它会让已加密的旧值失效（需重新加密）。
# CHANGE THIS：发布前可改成自己的字符串，但全链路要一致。
_OBFUSCATION_SECRET = b"ipmc-llm-key-obfuscation-v1"


def _keystream(n: int) -> bytes:
    """sha256(secret || counter) 分块拼出长度 n 的密钥流。"""
    out = bytearray()
    counter = 0
    while len(out) < n:
        out += hashlib.sha256(_OBFUSCATION_SECRET + counter.to_bytes(8, "big")).digest()
        counter += 1
    return bytes(out[:n])


def is_encrypted(value: str) -> bool:
    return value.startswith(_MAGIC)


def encrypt_key(plain: str) -> str:
    """明文 → 密文（enc:v1:...）。空串原样返回。"""
    if not plain:
        return plain
    data = plain.encode("utf-8")
    ks = _keystream(len(data))
    xored = bytes(a ^ b for a, b in zip(data, ks))
    return _MAGIC + base64.urlsafe_b64encode(xored).decode("ascii")


def decrypt_key(value: str) -> str:
    """密文 → 明文；无 enc:v1: 前缀的值（明文/空串）原样透传。"""
    if not value or not value.startswith(_MAGIC):
        return value
    try:
        xored = base64.urlsafe_b64decode(value[len(_MAGIC):])
        ks = _keystream(len(xored))
        return bytes(a ^ b for a, b in zip(xored, ks)).decode("utf-8")
    except Exception:
        # 解密失败（密钥变了/数据损坏）→ 返回空，避免把垃圾当 key 用
        return ""


if __name__ == "__main__":
    import sys

    if len(sys.argv) >= 3 and sys.argv[1] == "encrypt":
        print(encrypt_key(sys.argv[2]))
    elif len(sys.argv) >= 3 and sys.argv[1] == "decrypt":
        print(decrypt_key(sys.argv[2]))
    else:
        print("usage: python -m netlivecowork.providers.llm.secret encrypt|decrypt <value>")
        sys.exit(1)

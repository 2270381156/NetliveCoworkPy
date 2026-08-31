"""假的 substrate（云端管理服务）—— 只为本地打桩自测。

真实 substrate 在内网，开发机连不通。这个 mock 顶替它的**两个**接口，形状照
demo/experimental 的 `electron/lib/substrate.js`（运维那份《智能体套件下发 —— 最小对接契约》）：

    GET /api/me/agents                 → [{ "agentId": "...", "version": 3 }]  按 id 升序
    GET /api/me/agents/<id>/package    → zip 原文（application/octet-stream）
                                         X-Package-Version / X-Package-Sha256 /
                                         Content-Disposition

契约原文见 netcowork 仓 `doc/DESKTOP_AGENT_PACKAGE_API.md`（feat/substrate 分支）。
**照契约，不照 demo** —— 两者差在：version 是递增整数且三处同值、
Content-Type 是 octet-stream、不存在的 id 回 **400 不是 404**。

两个接口都**要求 Authorization: Bearer <token>**，没带就 401 —— 不校验令牌内容
（那是真 substrate 的事），但"没带令牌会 401"这件事必须真，否则主进程那边
"未登录时不对账"那条分支永远走不到。

## 它发的是**真签名的包**

用 `dev/pack_cowork.py` 同一段签名逻辑现打。发未签名的包的话，后端验签那关会拒
（需求 D5），于是这套 mock 只能验到"下载失败"，验不到"装上了"。

## 用法

    # 套件源目录：每个子目录一个 cowork（含 cowork.json 与四个 facet）
    MOCK_SUBSTRATE_SUITES=C:/.../nlc-dev/src \\
    MOCK_SUBSTRATE_PORT=9097 \\
    python dev/mock/mock_substrate_server.py

    # 想模拟"收回 mbb"：把它从 MOCK_SUBSTRATE_AGENTS 里去掉
    MOCK_SUBSTRATE_AGENTS=ipmaster,coremaster python dev/mock/mock_substrate_server.py

    # 想模拟"某个包坏了"（验 C9：一次失败不算收回）
    MOCK_SUBSTRATE_BROKEN=coremaster python dev/mock/mock_substrate_server.py

然后让主进程指向它：

    NLC_SUBSTRATE_BASE_URL=http://127.0.0.1:9097
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pack_cowork import build_bytes  # noqa: E402  （见下方 fallback）

_AGENTS_PATH = "/api/me/agents"
_PACKAGE_RE = re.compile(r"^/api/me/agents/([^/]+)/package$")


def _suites_dir() -> Path:
    raw = os.environ.get("MOCK_SUBSTRATE_SUITES", "")
    if not raw:
        raise SystemExit("请用 MOCK_SUBSTRATE_SUITES 指向套件源目录（每个子目录一个 cowork）")
    d = Path(raw)
    if not d.is_dir():
        raise SystemExit(f"套件源目录不存在：{d}")
    return d


def _entitled() -> list[str] | None:
    """授权名单。不设则 = 源目录里有几个就给几个。"""
    raw = os.environ.get("MOCK_SUBSTRATE_AGENTS", "").strip()
    return [x.strip() for x in raw.split(",") if x.strip()] if raw else None


def _broken() -> set[str]:
    """故意发不出去的那几个（验"一次失败不算被收回"，需求 C9）。"""
    raw = os.environ.get("MOCK_SUBSTRATE_BROKEN", "").strip()
    return {x.strip() for x in raw.split(",") if x.strip()}


def _manifest_of(cid: str) -> dict | None:
    p = _suites_dir() / cid / "cowork.json"
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except OSError:
        return None


def _agents() -> list[dict]:
    """`[{agentId, version}]`，**按 agentId 升序**（契约 §3）。

    ⚠ **version 三处同值**：清单里的、响应头 `X-Package-Version`、以及包内
    `cowork.json` 的 `version`。它是 substrate 自动递增的**整数**，不是 semver
    —— "由机器给出的 1.0.0 是假语义"（契约 §5）。

    所以这里直接取包内 manifest 的 `version`，不做任何换算：换算出来的值与包内的对不上，
    而客户端判"要不要重装"比的就是这两者，对不上的表现是**每次对账都重下一遍**。

    清单里**只有这两个字段**：displayName / order 在包里，清单再给一份就是第二个来源，
    而"哪个准"是个不该存在的问题。
    """
    allow = _entitled()
    out = []
    for d in sorted(_suites_dir().iterdir()):
        if not d.is_dir():
            continue
        m = _manifest_of(d.name)
        if not m:
            continue
        if allow is not None and d.name not in allow:
            continue
        out.append({"agentId": d.name, "version": _version_of(m)})
    return sorted(out, key=lambda a: a["agentId"])


def _version_of(manifest: dict) -> int:
    """包内 `version` → 整数。

    真 substrate 发的就是整数。这里容忍开发套件里写成 `1.5.0` 的历史形态：
    取第一段。**取不出就 0** —— 0 与任何已装版本都不相等，于是每次都重装，
    比"静默不装"好查。
    """
    raw = str(manifest.get("version", "")).strip()
    head = raw.split(".")[0]
    return int(head) if head.isdigit() else 0


class Handler(BaseHTTPRequestHandler):
    server_version = "MockSubstrate/1"

    def _send(self, code: int, body: bytes, headers: dict[str, str] | None = None) -> None:
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   {"Content-Type": "application/json; charset=utf-8"})

    def _authed(self) -> bool:
        """**没带令牌就 401。** 不校验内容 —— 但这条分支必须真，否则主进程那边
        "未登录时不对账"永远走不到（需求 B4）。"""
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer ") and auth[7:].strip():
            return True
        self._json(401, {"message": "缺少用户令牌"})
        return False

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path

        if path == _AGENTS_PATH:
            if not self._authed():
                return
            self._json(200, _agents())
            return

        m = _PACKAGE_RE.match(path)
        if m:
            if not self._authed():
                return
            cid = unquote(m.group(1))
            if cid in _broken():
                self._json(502, {"message": f"{cid} 的包发不出去（mock 故意的）"})
                return
            src = _suites_dir() / cid
            if not (src / "cowork.json").is_file():
                # ⚠ **400 不是 404**（契约 §6："我们没有用 404"）。
                # 按状态码分支的客户端要照这个来。
                self._json(400, {"message": f"没有这个智能体：{cid}"})
                return
            try:
                data = build_bytes(src)
            except Exception as e:  # noqa: BLE001
                self._json(500, {"message": f"打包失败：{e}"})
                return
            ver = next((a["version"] for a in _agents() if a["agentId"] == cid), 0)
            self._send(200, data, {
                # 契约 §4：application/octet-stream
                "Content-Type": "application/octet-stream",
                "Content-Disposition": f'attachment; filename="{cid}-agent-v{ver}.zip"',
                "X-Package-Version": str(ver),
                "X-Package-Sha256": hashlib.sha256(data).hexdigest(),
            })
            return

        self._json(404, {"message": f"没有这个接口：{path}"})

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("  mock-substrate: " + (fmt % args) + "\n")


def main() -> None:
    port = int(os.environ.get("MOCK_SUBSTRATE_PORT", "9097"))
    print(f"  假 substrate 起在 http://127.0.0.1:{port}")
    print(f"  套件源：{_suites_dir()}")
    print(f"  授权名单：{_entitled() or '（源目录里有几个给几个）'}")
    if _broken():
        print(f"  故意发不出去的：{sorted(_broken())}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()

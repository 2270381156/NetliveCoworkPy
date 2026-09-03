"""临时的 mythos 市场 mock 服务（仅供本地集成测试，零依赖）。

真实的 IPmasterMythos 服务不在本环境，这里用一个最小服务顶替它的两个接口，
永远返回固定的默认数据。**纯标准库实现**，无需 fastapi/uvicorn，任意 python 可跑：

  POST /adc-studio-agent/cse/rest/v1/protected/agent-skill/query
       → {total, data: [...]}（按 start/limit 分页切片，保证客户端翻页能终止）
  GET  /adc-studio-agent/cse/rest/v1/protected/agent-skill/download/{skill_id}
       → 一个合规的 skill zip 文件流（含 SKILL.md），任意 id 都给一个默认 skill

用法：
  python dev/mock/mock_mythos_server.py                 # 默认监听 127.0.0.1:9099
  MOCK_MYTHOS_PORT=9099 python dev/mock/mock_mythos_server.py
  MOCK_MYTHOS_LABEL=ip python ...        # 给 skill 名字加前缀，多实例时分得清是哪一家

然后让后端指向它（config 默认是真实地址，需用 env 覆盖）：
  export NLC_SKILL_MYTHOS_BASE_URL=http://127.0.0.1:9099

接口契约见 docs/skill市场新数据源接口.md。
"""

from __future__ import annotations

import io
import json
import os
import re
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

_QUERY_PATH = "/adc-studio-agent/cse/rest/v1/protected/agent-skill/query"
_DOWNLOAD_PREFIX = "/adc-studio-agent/cse/rest/v1/protected/agent-skill/download/"

# 固定的默认 skill 目录。字段对齐文档响应：mythos_service 只读 skill_id /
# skill_name / description.default / updater / updated_time，其余仅为贴近真实结构。
_DEFAULT_SKILLS = [
    {
        "skill_id": 1129,
        "skill_name": "use-count-report",
        "display_name": {"default": "调用量上报", "zh_CN": "", "en_US": ""},
        "description": {"default": "上报技能调用量的示例 skill（mock）", "zh_CN": "", "en_US": ""},
        "tag_names": ["IPmaster_Baseline"],
        "updater": "c30025961",
        "updated_time": "2026-06-25T11:09:36.000+00:00",
    },
    {
        "skill_id": 1130,
        "skill_name": "weather-lookup",
        "display_name": {"default": "天气查询", "zh_CN": "", "en_US": ""},
        "description": {"default": "查询城市天气的示例 skill（mock）", "zh_CN": "", "en_US": ""},
        "tag_names": ["test"],   # 无 baseline tag → 会被过滤掉（演示过滤）
        "updater": "c30025961",
        "updated_time": "2026-06-24T09:00:00.000+00:00",
    },
    {
        "skill_id": 1131,
        "skill_name": "pdf-summarize",
        "display_name": {"default": "PDF 摘要", "zh_CN": "", "en_US": ""},
        "description": {"default": "对 PDF 生成摘要的示例 skill（mock）", "zh_CN": "", "en_US": ""},
        "tag_names": ["demo", "IPmaster_Baseline"],   # 多个 tag，含 baseline → 保留
        "updater": "a001",
        "updated_time": "2026-06-23T18:30:00.000+00:00",
    },
    {
        # 故意制造一个"空内容"的 skill：列表里有它，但下载返回空 body，用来复现
        # 真实 mythos 部分 id 无文件、无法下载 zip 的情况，验证前端报错提示。
        "skill_id": 1132,
        "skill_name": "broken-empty-skill",
        "display_name": {"default": "空内容技能（演示报错）", "zh_CN": "", "en_US": ""},
        "description": {"default": "下载会返回空内容，用于验证安装失败提示（mock）", "zh_CN": "", "en_US": ""},
        "tag_names": ["IPmaster_Baseline"],   # 保留，用于演示下载空内容报错
        "updater": "a001",
        "updated_time": "2026-06-22T08:00:00.000+00:00",
    },
    {
        "skill_id": 1200,
        "skill_name": "topology-audit",
        "display_name": {"default": "拓扑巡检", "zh_CN": "", "en_US": ""},
        "description": {"default": "拓扑巡检 的示例 skill（mock）", "zh_CN": "", "en_US": ""},
        "tag_names": ["IPmaster_Baseline"],
        "updater": "c30025961",
        "updated_time": "2026-06-10T10:00:00.000+00:00",
        "downloadCount": 512,
    },
    {
        "skill_id": 1201,
        "skill_name": "bgp-troubleshoot",
        "display_name": {"default": "BGP 排障", "zh_CN": "", "en_US": ""},
        "description": {"default": "BGP 排障 的示例 skill（mock）", "zh_CN": "", "en_US": ""},
        "tag_names": ["IPmaster_Baseline"],
        "updater": "c30025961",
        "updated_time": "2026-06-11T10:00:00.000+00:00",
        "downloadCount": 348,
    },
    {
        "skill_id": 1202,
        "skill_name": "config-diff",
        "display_name": {"default": "配置比对", "zh_CN": "", "en_US": ""},
        "description": {"default": "配置比对 的示例 skill（mock）", "zh_CN": "", "en_US": ""},
        "tag_names": ["IPmaster_Baseline"],
        "updater": "a001",
        "updated_time": "2026-06-12T10:00:00.000+00:00",
        "downloadCount": 1207,
    },
    {
        "skill_id": 1203,
        "skill_name": "log-digest",
        "display_name": {"default": "日志摘要", "zh_CN": "", "en_US": ""},
        "description": {"default": "日志摘要 的示例 skill（mock）", "zh_CN": "", "en_US": ""},
        "tag_names": ["IPmaster_Baseline"],
        "updater": "a001",
        "updated_time": "2026-06-13T10:00:00.000+00:00",
    },
    {
        "skill_id": 1204,
        "skill_name": "vlan-planner",
        "display_name": {"default": "VLAN 规划", "zh_CN": "", "en_US": ""},
        "description": {"default": "VLAN 规划 的示例 skill（mock）", "zh_CN": "", "en_US": ""},
        "tag_names": ["IPmaster_Baseline"],
        "updater": "w00812",
        "updated_time": "2026-06-14T10:00:00.000+00:00",
        "downloadCount": 96,
    },
    {
        "skill_id": 1205,
        "skill_name": "srv6-migrate",
        "display_name": {"default": "SRv6 迁移", "zh_CN": "", "en_US": ""},
        "description": {"default": "SRv6 迁移 的示例 skill（mock）", "zh_CN": "", "en_US": ""},
        "tag_names": ["IPmaster_Baseline"],
        "updater": "w00812",
        "updated_time": "2026-06-15T10:00:00.000+00:00",
        "downloadCount": 0,
    },
    {
        "skill_id": 1206,
        "skill_name": "cli-cheatsheet",
        "display_name": {"default": "命令速查", "zh_CN": "", "en_US": ""},
        "description": {"default": "命令速查 的示例 skill（mock）", "zh_CN": "", "en_US": ""},
        "tag_names": ["IPmaster_Baseline"],
        "updater": "w00812",
        "updated_time": "2026-06-16T10:00:00.000+00:00",
    },
    {
        "skill_id": 1207,
        "skill_name": "mpls-lsp-check",
        "display_name": {"default": "LSP 校验", "zh_CN": "", "en_US": ""},
        "description": {"default": "LSP 校验 的示例 skill（mock）", "zh_CN": "", "en_US": ""},
        "tag_names": ["IPmaster_Baseline"],
        "updater": "lty0417",
        "updated_time": "2026-06-17T10:00:00.000+00:00",
        "downloadCount": 73,
    },
    {
        "skill_id": 1208,
        "skill_name": "subnet-calc",
        "display_name": {"default": "子网计算", "zh_CN": "", "en_US": ""},
        "description": {"default": "子网计算 的示例 skill（mock）", "zh_CN": "", "en_US": ""},
        "tag_names": ["IPmaster_Baseline"],
        "updater": "lty0417",
        "updated_time": "2026-06-18T10:00:00.000+00:00",
        "downloadCount": 2048,
    },
    {
        "skill_id": 1209,
        "skill_name": "device-inventory",
        "display_name": {"default": "设备清点", "zh_CN": "", "en_US": ""},
        "description": {"default": "设备清点 的示例 skill（mock）", "zh_CN": "", "en_US": ""},
        "tag_names": ["IPmaster_Baseline"],
        "updater": "lty0417",
        "updated_time": "2026-06-19T10:00:00.000+00:00",
    },
    {
        "skill_id": 1210,
        "skill_name": "acl-linter",
        "display_name": {"default": "ACL 检查", "zh_CN": "", "en_US": ""},
        "description": {"default": "ACL 检查 的示例 skill（mock）", "zh_CN": "", "en_US": ""},
        "tag_names": ["IPmaster_Baseline"],
        "updater": "c30025961",
        "updated_time": "2026-06-20T10:00:00.000+00:00",
        "downloadCount": 15,
    },
    {
        "skill_id": 1211,
        "skill_name": "qos-template",
        "display_name": {"default": "QoS 模板", "zh_CN": "", "en_US": ""},
        "description": {"default": "QoS 模板 的示例 skill（mock）", "zh_CN": "", "en_US": ""},
        "tag_names": ["IPmaster_Baseline"],
        "updater": "a001",
        "updated_time": "2026-06-21T10:00:00.000+00:00",
        "downloadCount": 634,
    },
]

# 下载会返回空 body 的 skill id（模拟"id 实际对应文件为空"）。
_EMPTY_SKILL_IDS = {1132}

# 同时跑多个实例时（每个 cowork 一家市场），光看 skill 名字分不出目录来自哪一家 ——
# 而"到底有没有按套件里的地址去问"正是要验的那件事。给个标签，名字上就能看出来。
_LABEL = os.environ.get("MOCK_MYTHOS_LABEL", "").strip()
if _LABEL:
    for _s in _DEFAULT_SKILLS:
        _s["skill_name"] = f"{_LABEL}-{_s['skill_name']}"
        # display_name 也要加 —— 界面上显示的是它，只改 skill_name 的话
        # 标签根本看不见，“分得清是哪一家”这个目的就没达到。
        _d = _s.get("display_name")
        if isinstance(_d, dict) and _d.get("default"):
            _d["default"] = f"[{_LABEL}] {_d['default']}"

# 演示"市场没有下载量/上传时间字段时，前端不显示对应排序"。
# 各 cowork 自带的市场未必回这两个字段，这里用环境变量模拟整列缺失。
if os.environ.get("MOCK_MYTHOS_NO_DOWNLOADS"):
    for _s in _DEFAULT_SKILLS:
        _s.pop("downloadCount", None)
if os.environ.get("MOCK_MYTHOS_NO_TIME"):
    for _s in _DEFAULT_SKILLS:
        _s.pop("updated_time", None)

_BY_ID = {s["skill_id"]: s for s in _DEFAULT_SKILLS}


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower().strip()).strip("-")
    return s or "mock-skill"


def _make_skill_zip(skill_name: str, description: str) -> bytes:
    """生成一个合规的单根 skill zip（含 SKILL.md frontmatter）。"""
    folder = _slug(skill_name)
    md = (
        "---\n"
        f"name: {skill_name}\n"
        f"description: {description}\n"
        "---\n\n"
        f"# {skill_name}\n\n这是来自 mock mythos 市场的示例 skill。\n"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"{folder}/SKILL.md", md)
    return buf.getvalue()


class _Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: bytes, content_type: str, extra_headers: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, payload: dict) -> None:
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path != _QUERY_PATH:
            self._send_json(404, {"error": "not found", "path": path})
            return
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw or b"{}")
        except Exception:
            body = {}
        # 按 start/limit 切片，确保客户端按 total 翻页时能正常终止。
        start = int(body.get("start", 0) or 0)
        limit = int(body.get("limit", 10) or 10)
        page = _DEFAULT_SKILLS[start:start + limit]
        self._send_json(200, {"total": len(_DEFAULT_SKILLS), "data": page})

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if not path.startswith(_DOWNLOAD_PREFIX):
            self._send_json(404, {"error": "not found", "path": path})
            return
        raw_id = path[len(_DOWNLOAD_PREFIX):].strip("/")
        try:
            skill_id = int(raw_id)
        except ValueError:
            skill_id = None
        # 模拟"空内容"skill：返回 200 但 body 为空，触发后端 MYTHOS_SKILL_EMPTY。
        if skill_id in _EMPTY_SKILL_IDS:
            self._send(200, b"", "application/zip")
            return
        # 已知 id 用其名字/描述；未知 id 也给一个默认 skill（永远返回默认值）。
        skill = _BY_ID.get(skill_id) if skill_id is not None else None
        if skill is not None:
            name, desc = skill["skill_name"], skill["description"]["default"]
        else:
            name, desc = f"mock-skill-{raw_id or 'x'}", "mock mythos 市场的默认 skill"
        data = _make_skill_zip(name, desc)
        self._send(200, data, "application/zip", {"Content-Disposition": f'attachment; filename="{_slug(name)}.zip"'})

    def log_message(self, fmt: str, *args) -> None:  # 简洁日志
        print(f"[mock-mythos] {self.command} {self.path} -> {args[1] if len(args) > 1 else ''}")


def main() -> None:
    host = os.environ.get("MOCK_MYTHOS_HOST", "127.0.0.1")
    port = int(os.environ.get("MOCK_MYTHOS_PORT", "9099"))
    server = ThreadingHTTPServer((host, port), _Handler)
    print(f"[mock-mythos] listening on http://{host}:{port}")
    print(f"[mock-mythos] point backend at it:  export NLC_SKILL_MYTHOS_BASE_URL=http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[mock-mythos] bye")
        server.shutdown()


if __name__ == "__main__":
    main()

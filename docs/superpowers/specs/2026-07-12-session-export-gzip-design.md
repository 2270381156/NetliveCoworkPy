# 会话导出/导入 gzip 压缩 — Design

**Date:** 2026-07-12
**Status:** Approved
**Context:** `session_export.py::export_session_db` 把单会话的行拷进一个全新 SQLite 文件、返回其**原始字节**。该字节里 `events.payload_json`、`snapshots.state_blob_json`（每个快照 = 整份累积状态、重复存）、`session_sse_events.event_json`（events 的翻译副本）等**未压缩 JSON 文本**造成大量跨行/跨表冗余——文件体积大，但 RAR/DEFLATE 压缩后极小（冗余被折叠）。本设计在导出侧对整包做 gzip，导入侧透明解压，直接拿到 RAR 级压缩比，**零数据丢失、零回放/viewer 语义变更**。

## 1. 范围与非目标

**范围**：`export_session_db` 产物由原始 sqlite 字节改为 **gzip(sqlite 字节)**；`import_session_db` 变为 **gzip 感知**（按 magic 嗅探，压缩则解压，否则按原始 sqlite 处理）。

**非目标（明确排除）**：
- **不删/裁派生冗余表**（`snapshots` / `session_sse_events`）。它们虽是 events 的派生/加速数据，但 `import_session_db` 是**逐行原样回灌**、前端回放读的是**已存的** `session_sse_events`——无任何从 events 重建的逻辑。删表需在导入/回放侧新建重建逻辑，属独立更大工程，本期不做。
- 不做 VACUUM / page-size 调优：只去结构性余量（~10–30%），gzip 之后余量本就被压掉，叠加无意义。

## 2. 契约变更

### 2.1 导出（`session_export.py`）
- `_build_export_bytes(collected) -> bytes`：调用原 `_write_sqlite_bytes` 得原始 sqlite 字节，再 `gzip.compress(raw, compresslevel=9)` 返回。压缩与写文件同在 `asyncio.to_thread` 内，不阻塞事件循环。
- `_write_sqlite_bytes` 语义不变（仍返回原始 sqlite 字节，保持函数名诚实、可单测）。
- level 9：单会话数据有界，一次性管理动作，体积优先。

### 2.2 导入（`session_import.py`）
- `_read_dump(data)` 开头嗅探 gzip magic：`data[:2] == b"\x1f\x8b"` → `data = gzip.decompress(data)`，否则原样。
- **向后兼容**：既有的未压缩 dump 仍可导入（嗅探不命中 → 走原路径）。
- 解压后逻辑（写临时 sqlite、逐表读、id 重映射、回灌）完全不变。

### 2.3 路由
- `GET /{session_id}/export`：media_type 保持 `application/octet-stream`；产物现为 gzip 字节。（可选：加 `Content-Disposition: attachment; filename="session-<id>.sqlite.gz"` 便于 Web 下载识别；不影响 electron 按字节取用。）
- `POST /import`：无签名变更；`import_session_db` 内部透明解压。**这是解压消费方**（Web 前端回放调试链路 export → /import 自闭环）。

## 3. 消费方影响

| 消费方 | 变化 |
|--------|------|
| `POST /import`（本期同步改） | 内部嗅探解压，签名不变，兼容旧 raw dump |
| electron 上报路径（`session-report.zip`） | 已 DEFLATE-zip；现在 zip 的是 gzip 字节（已压缩 → zip ~等价，上传体积无回归、仍小）。entry 名 `session-<id>.sqlite` 实为 gzip，**若仍走「admin 取出置换进 viewer」链路，需在 electron 侧改名 `.sqlite.gz` 并由 admin 先 gunzip**。本期以 `/import` 为准，electron 改名列为后续 follow-up。 |

## 4. 测试

- **导出**：`export_session_db` 产物前两字节 == `1f 8b`；`gzip.decompress` 后是合法 sqlite，且仅含目标会话行（改造现有 `test_export_contains_only_target_session`：先 gunzip 再 `sqlite3.connect`）。
- **导入向后兼容**：喂**未压缩**的原始 sqlite 字节（绕过 export 直接造）→ 仍能导入。
- **导入 gzip**：喂 `export_session_db` 的 gzip 产物 → 正常重映射回灌（现有 import 测试的 `_make_dump` 天然覆盖，因 export 现在产 gzip）。
- **坏输入**：`b"not a sqlite file"`（非 gzip、非 sqlite）→ `InvalidSessionDumpError`。
- **roundtrip**：export → import 一致性（现有测试覆盖）。

## 5. 隐私与安全

无变化：仍是同一份会话数据，仅传输/落盘表示由原始 sqlite 变为 gzip。压缩不等于加密，语义敏感性不变（会话 SQLite 含完整对话内容，仅经用户主动上报出客户端——沿用原 spec §10）。

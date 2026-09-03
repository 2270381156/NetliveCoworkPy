# Token 用量上报接口（地端 → 云端）

地端桌面应用把每次大模型调用的 token 用量上报到云端，供统计与呈现（按用户 / agent /
模型分账）。本文说清**接口**、**每个字段的含义与口径**、以及 **`itemId` 幂等去重契约**。

> 地端实现：`electron/main.js`（`postTokenUsageEvent` / `buildTokenUsagePayload`）+
> `electron/lib/token-usage.js` + `electron/lib/token-usage-controller.js` +
> 后端 `observability/token_usage_subscriber.py`。

---

## 0. 传输架构（mirror）

当前上报是 **mirror**：

> 桌面端打 **netcowork（主，响应权威）**，**nginx 复制一份给 substrate（影子）**。

- 桌面端只发一次、目标是 `netcoworkBaseUrl`；substrate 不由地端直连，而是从镜像拿到同一份。
- 桌面端拿到的响应仍全部来自 netcowork。
- substrate 侧的接收 / 去重 / 建表由 substrate 实现；本文说清地端**发什么**与**字段契约**。

---

## 1. 接口

| 项 | 值 |
|---|---|
| 方法 | `POST` |
| 路径 | `{netcoworkBaseUrl}/api/token-usage/report` |
| 鉴权 | `Authorization: Bearer <JWT>` —— 用户令牌，**只有地端 Electron 主进程持有**（Python 后端不经手） |
| Content-Type | `application/json` |
| 批量 | **否**，一次请求一条记录 |

`netcoworkBaseUrl` 由地端 `app-config.json` 配置（当前生产为 `https://ipmastercowork.gts.huawei.com`）。JWT 由 substrate 用同一把 `JWT_SECRET` 铸的字节兼容令牌，netcowork / substrate 验签均无感。

**未登录不上报**：拿不到用户 JWT 时地端不发（记录暂存本地，登录后再发；登录边界之前产生的存量**故意不补发**）。

---

## 2. 请求体字段

```json
{
  "itemId": "b7d3c1e2-9f04-4a55-8c21-0e6a1f2b3c4d",
  "sessionId": "desktop:ses_01ABC...:3",
  "cowork": "coremaster",
  "inputTokens": 1280,
  "outputTokens": 340,
  "llmAccount": "NIS-glm",
  "llmModel": "glm-4"
}
```

| 字段 | 类型 | 必填 | 含义与口径 |
|---|---|---|---|
| `itemId` | string | 是 | **幂等去重键**：该条上报**全局唯一、跨重发稳定**的标识（UUID）。云端以 `(用户, itemId)` 去重，消除重试导致的重复计数。语义契约见 §4。 |
| `sessionId` | string | 是 | **上报所属的那一轮对话**，格式固定 `desktop:{原始会话id}:{turn_seq}`。`turn_seq` 是会话内一来一回的序号（从 1 递增）。**它不是唯一键**——同一 turn 的 actor 调用与 ObserveStep 后台 observe 会各发一条、**共享同一 sessionId**，是两条合法记录（用 `itemId` 区分，见 §4）。 |
| `cowork` | string | 否（可空串） | **这次用量属于哪个 agent**（cowork id，如 `coremaster` / `mbb` / `nfv`）。按 agent 分账用它。**空串 = 归属未知**（会话归属未解析），聚合时作"未归类"，不代表"属于所有人"。 |
| `inputTokens` | integer ≥ 0 | 是 | **实际未缓存输入 token**（供应商 `usage.input_tokens` 口径，自 2026-07-16 起）——**不含**缓存命中部分。 |
| `outputTokens` | integer ≥ 0 | 是 | 输出 token。 |
| `llmAccount` | string | 否 | LLM 账号名（如 `NIS-glm` / `HIS`）。可空串。 |
| `llmModel` | string | 否 | 具体模型名（如 `glm-4`）。可空串。 |

> 用户维度不在 body 里，由 **JWT** 携带 —— 云端从令牌解析用户身份。

---

## 3. 关键语义

1. **每条是一次调用的独立值，不是累计。** 一个 turn 可有多条（actor / observe），各自就是那一次的量，**不要做"减上一次累计"之类处理**。要总量云端按维度求和。

2. **`sessionId` 不是唯一键，`itemId` 才是。** 去重认 `itemId`（§4）：`sessionId` 标识"哪一轮"，`itemId` 标识"这一轮里的哪一条上报"。

3. **`cowork` 可能是空串。** 归属未解析时为空；聚合按 agent 时归"未归类"，**不要丢弃整条**（token 数仍计入用户总量）。

4. **上报节奏**：地端实时触发（有新用量就发）+ 定时兜底 + 失败重试。云端只需保证接口**幂等**、快速返回 2xx；非 2xx 会被地端当失败、进重试队列（最多攒 500 条）。

---

## 4. `itemId` 幂等去重契约（务必严格，否则去重白做）

现在的上报**不幂等**且云端单方修不了：服务端**已写入成功**、响应在返回途中丢失 → 地端判失败 → 重发同一条 → 若无稳定标识，服务端**又累加一次**。`itemId` 就是那个稳定标识。

云端拿 `itemId` 当去重键，它必须同时满足：

1. **跨重发稳定**：一个逻辑上报事件**生成一次** `itemId`，此后**首发和所有重试都用同一个**。**绝不能**每次重发重新生成。

2. **全局唯一**：每一条**不同**的上报配**不同**的 `itemId`。UUID 天然满足。

> `itemId` 与 `sessionId`：一个 turn 里 actor 与 observe 两条，**`sessionId` 相同、`itemId` 不同**。

### ⚠ 最容易踩的坑：首发也必须带同一个 `itemId`

若首发不带、只重试才带，会漏掉最坏情况：首发在云端**写成功但响应丢失** → 首发那条无 `itemId`、云端已落库 → 重试带 `itemId` 过来时云端**认不出是同一条** → 依旧重复计数。**首发不带 = 没修。**

**地端实现**（已落地）：`itemId` 在事件**入队 / 首次准备发送时**就定下来（`prepareRetryBatch`：`claimed ? value.itemId : newItemId()`），`wrapRetryEvent` 在重试时**原样保留**；`buildTokenUsagePayload(event, itemId)` 把 `entry.itemId` 透进 payload —— 首发与重试走同一条"带 itemId"的构造路径。

---

## 5. 云端会怎么用（完整闭环）

- **去重**：按 `(用户, itemId)` —— 见过的 `itemId` 直接跳过、不再累加；没见过才落库。去重表与计量行解耦，去重窗口**天级**（覆盖离线攒着、隔很久才重发）。
- **不改累加语义**：同一 turn 里 `sessionId` 相同但 `itemId` 不同的多条，照常**各自累加**（actor + observe 分别计入）；去重只挡"同一条被重发"。
- **按 agent 呈现**：云端 DTO 增加 `cowork` 字段、表增列、统计接口按 `cowork` 加聚合维度（地端已在发 `cowork`，未声明时被 `@JsonIgnoreProperties(ignoreUnknown=true)` 安全忽略）。
- **用户身份取自 JWT 的 `username` claim（= 工号 / W3 uid），不是 `sub`。** `sub` 是 substrate 自铸的 **surrogate_id（UUID）**，不是工号——接收侧按 username(工号) 归属/呈现，切勿把 `sub` 当稳定工号用。
- **换工号连续性**：substrate 内部把工号解析到永久的 `surrogate_id`，`user_token_usage` 在 re-key（阶段1）后挂到 `surrogate_id`，使换工号后同一人的用量连续（见 netcowork `doc/IDENTITY_SURROGATE_ANCHOR.md`）。

**可聚合维度**：用户（JWT）× agent（`cowork`）× 模型（`llmModel`）× 账号（`llmAccount`）× 时间；指标 = `inputTokens` / `outputTokens` 求和、调用次数计数。

---

## 6. 上线顺序（mirror 下互不阻塞）

netcowork 忽略未知字段（`itemId` / `cowork`），substrate 按需启用，两边任意先后都不会坏：

- **`itemId`**：netcowork `ignoreUnknown` 忽略、落库数字一字不变，**地端可先行上线**；substrate 认 `itemId` 去重后，从地端发的**第一条**起受保护。建议地端准备好后**先知会 substrate**，确认去重已上线再放量。
- **`cowork`**：同理，substrate 加字段+列后即可按 agent 呈现，不阻塞地端。

---

## 7. 地端自测（三条，覆盖 §4 契约）

1. **跨重发稳定**：强制同一条上报连发两次（模拟"写成功但响应丢失"），两次 payload 的 `itemId` **相同**。
2. **全局唯一**：不同 LLM 调用产生的两条上报，`itemId` **不同**。
3. **同 turn 多条**：一个 turn 的 actor 与 observe 两条，`sessionId` **相同**、`itemId` **不同**。

---

## 8. 不改的东西（边界）

- 路径 / 方法 / 鉴权不变（`POST {netcoworkBaseUrl}/api/token-usage/report` + 用户 JWT）。
- **一次请求一条**不变（不是 turn 级聚合或批量）。
- 其余字段语义与口径全不变。

---

## 9. 完整示例

```
POST https://ipmastercowork.gts.huawei.com/api/token-usage/report
Authorization: Bearer eyJhbGciOi...
Content-Type: application/json

{
  "itemId": "b7d3c1e2-9f04-4a55-8c21-0e6a1f2b3c4d",
  "sessionId": "desktop:ses_01M14070E66W5JGN1YTA1DM8WH:3",
  "cowork": "coremaster",
  "inputTokens": 1280,
  "outputTokens": 340,
  "llmAccount": "NIS-glm",
  "llmModel": "glm-4"
}
```

成功返回 2xx（无 body 要求）；非 2xx 地端照旧重试**同一条**（`itemId` 不变）。

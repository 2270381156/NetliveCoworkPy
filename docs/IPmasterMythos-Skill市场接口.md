```markdown
# 地端CoWork调用IPmasterMythos技能 接口文档

## 一、接口概览

| 接口名称 | 请求方法 | 请求路径 |
|---------|---------|---------|
| 查询skill | POST | `/adc-studio-agent/cse/rest/v1/protected/agent-skill/query` |
| 下载skill | GET | `/adc-studio-agent/cse/rest/v1/protected/agent-skill/download/{skill_id}` |

---

## 二、认证信息

只要header，不需要auth

---

## 三、公共请求头

| Header Key | Header Value | 备注 |
|------------|--------------|--------------|
| Content-Type | application/json |  |
| x-cse-context | `{"x-gde-tenant-id":"2000","x-gde-username":"a001"}` | 租户id固定2000，用户为当前用户名 |

当前用户名就是前端认证后获取的用户名，如果用户名校验非法，query接口将报错，需要保证skill市场依然可以运转（只显示另一个数据源的skill）
---

## 四、接口详情

### 4.1 查询skill

**接口名称**: 【Agent】【cse接口】查询skill

**请求方法**: POST

**请求路径**: `https://ipmastermythos.huawei.com/adc-studio-agent/cse/rest/v1/protected/agent-skill/query`

#### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| start | integer | 否 | 起始位置，默认0 |
| limit | integer | 否 | 每页数量，默认10 |
| order | string | 否 | 排序方式，asc/desc，默认desc |
| sort_by | string | 否 | 排序字段，默认updated_time |
| active | boolean | 否 | 是否只查询激活状态，默认true |

#### 请求示例

```json
{
    "start": 0,
    "limit": 1,
    "order": "desc",
    "sort_by": "updated_time",
    "active": true
}
```

#### 响应示例（过滤 skill_id=1129）

```json
{
	"total": 170,
	"data": [
		{
			"skill_id": 1129,
			"project_name": "agent_JvIHY",
			"module_name": "agent_JvIHY",
			"skill_name": "use-count-report",
			"display_name": {
				"default": "调用量上报",
				"zh_CN": "",
				"en_US": ""
			},
			"description": {
				"default": "1",
				"zh_CN": "",
				"en_US": ""
			},
			"scope": {
				"default": "",
				"zh_CN": "",
				"en_US": ""
			},
			"type": "agent_skill",
			"icon": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAB4AAAAeBAMAAADJHrORAAAAAXNSR0IB2cksfwAAAA9QTFRFAAAA////////////////j0LeaAAAAAV0Uk5TAID/v0CEK3eAAAAAfUlEQVR4nLXP0RWAIAgFUDw5gNQEPifIGqBO7T9TiFT6X3x53xFBol/KYe0JhJ5NUIm0GTO6YMRdUZ0fp7b9fXHoyeGo9HPtj1QC9hnWX4Ioc2xnFpwvdznWG7tar0Ij268EaTtsPwETC+8PSRBkykNyI6aG+oWWEiyBPqkLVsAWScdVOy4AAAAASUVORK5CYII=",
			"auto_summarize": false,
			"tag_names": [],
			"updater": "c30025961",
			"updated_time": "2026-06-25T11:09:36.000+00:00",
			"customizable": false,
			"customized": false,
			"runtime_customize": false,
			"agent_skill_type": "common",
			"come_from": "custom"
		}	
	]
}

```

这里只需要关注skill_id（后面要用这个id下载skill）、display_name（展示名，结构同 description，取 default）、description、updater（创建人）、updated_time（更新时间）

更新：需要额外保留tag_names，根据里面的tag过滤skill，保留策略：tag_names中包含 "IPmaster_Baseline"，注意是只要包含，可能也有其他tag，不影响
---

### 4.2 下载skill

**接口名称**: 【Agent】【cse接口】下载skill

**请求方法**: GET

**请求路径**: `https://ipmastermythos.huawei.com/adc-studio-agent/cse/rest/v1/protected/agent-skill/download/{skill_id}`

#### 路径参数

| 参数名 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| skill_id | integer | 是 | Skill ID，此处示例为1129 |

#### 响应示例

文件流 zip文件
````
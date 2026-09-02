# Profile 预置 Skill 设计

## 背景

NetliveCoworkPy 已支持从远端下载并安装 cowork profile，也支持 cowork 与 Mythos 两类 Skill 市场。当前 profile 只能声明市场地址，用户仍需在 Electron 技能市场中手动引用 Skill。

需求文档已预留“skill·预置”能力，但运行期模型、引用身份、播种账本和 profile 更新回收尚未实现。本设计让 profile 声明默认 Skill 引用：系统自动协调到本地引用库，Electron 继续显示现有“已引用”状态，Skill 内容仍在实际使用时临时下载并在使用后删除。

## 目标

- Profile 可声明完整的预置 Skill L1 元数据。
- 系统启动、profile 更新和用户登录后自动协调预置引用，无需人工操作。
- 保持现有引用式加载：本地持久化元数据，使用时下载 ZIP，不把市场 Skill 永久解压到 `skills_dir`。
- 尊重用户删除；已删除的预置项不在普通启动时复活。
- Profile 减少预置或被收回时，只撤销该 profile 管理的归属。
- 支持 cowork 与 Mythos 市场、profile 专属市场作用域以及 Mythos 的 W3 用户隔离。
- Electron 不增加新状态或交互，预置项沿用“已引用”。

## 非目标

- 不在启动阶段下载完整 Skill ZIP。
- 不把云端 Skill 转换为本地永久 Skill。
- 不新增 Electron 的“已预置”徽章、进度或按钮。
- 不改变用户手工导入本地 Skill 的生命周期。

## Profile 清单

`cowork.json` 的 `skills` 节点增加 `presets`：

```json
{
  "skills": {
    "pullServerUrl": "https://example/cowork/api",
    "mythosBaseUrl": "https://example/mythos",
    "presets": [
      {
        "source": "mythos",
        "remoteId": "1129",
        "name": "调用量上报",
        "description": "上报 Skill 调用量",
        "version": "1.0",
        "triggers": []
      }
    ]
  }
}
```

Profile 作者不重复声明 `marketScope`。系统根据包含该预置项的 profile、该 profile 的市场配置以及通用市场回落规则解析有效市场作用域，避免声明值与 profile ID 漂移。

制作或发布 profile 时严格校验：

- `source` 必须是已注册的市场类型。
- `remoteId`、`name`、`description` 必须为非空字符串。
- `triggers` 必须是字符串数组，`version` 可选。
- 同一 profile 内不得声明重复的预置身份。
- 该来源必须能在 profile 的有效市场作用域内解析。
- 对预置数量和元数据长度设置上限。

本仓负责定义上述契约、执行运行期数量/长度上限并提供测试。Profile 的制作/发布服务不在本仓中；发布侧必须在接入此字段时复用同一契约做严格拒绝，这是发布依赖，不伪装成本仓已覆盖的实现任务。

运行期解析保持现有容错原则：超过上限或单个非法预置项被跳过并记录日志，不阻止已经安装的 profile 或应用启动。

## 引用身份

现有引用用 `source + remote_id` 定位，但同一来源在通用市场和不同 profile 专属市场中可指向不同服务器。新身份为：

```text
market_scope + source + remote_id + principal
```

- `market_scope`：通用市场或解析后的 profile 市场作用域。
- `source`：例如 `cowork`、`mythos`。
- `remote_id`：市场内的 Skill 标识。
- `principal`：共享来源使用 `*`；按用户隔离的来源使用 W3 用户名。

对外的引用 ID 是不透明字符串。前端和 API 不再通过拆分 `source:remote_id` 推断来源，所有查找和删除通过引用库完成。

### 市场页“已引用”的精确语义

`is_pulled` 从“当前用户是否有一条同 `source + remote_id` 且归属可见的引用”改为“当前市场作用域、来源、remote ID 和用户主体组成的**精确引用身份**是否存在”。因此：

- 在 IPMaster 专属市场引用的条目，不再让通用市场或其他 profile 的同 ID 条目显示“已引用”。
- 通配归属只扩大该引用的可见范围，不改变它来自哪个市场，也不会让另一个市场的同 ID 条目显示“已引用”。
- v2 引用缺少市场来源证据，迁移时按 `market_scope=general` 处理；它只会在通用市场显示“已引用”。如果用户需要专属市场版本，应在该 profile 页签重新引用。

这是用户可见但必要的纠错，替换当前依赖 `source:id` 的跨作用域命中语义，并与 H3 的“不跨市场回落”保持一致。

## 持久化模型

引用库升级后仍只使用一个 `skill_references.json` 文件。引用、随包默认播种账本和 profile 预置账本都位于同一个 JSON 根对象，确保一次 `Path.replace` 原子提交：

```json
{
  "version": 3,
  "references": {},
  "seeded_defaults": [],
  "preset_ledger": {
    "active_bindings": {},
    "opt_outs": []
  }
}
```

逻辑模型为：

```text
SkillReference
├─ identity: market_scope/source/remote_id/principal
├─ L1 metadata: name/description/version/triggers
├─ manual_labels: 用户主动设置的归属
└─ preset_bindings: 自动预置它的 profile 绑定

PresetLedger
├─ 已处理的 profile、用户和预置身份
└─ 用户主动退出的 opt-out
```

有效归属是 `manual_labels` 与 `preset_bindings` 的并集。Profile 协调器只修改自己拥有的 preset binding，不直接覆盖用户归属。

Mythos 等按用户可见的来源按 W3 用户名分别记录引用、绑定与 opt-out；cowork 等共享来源使用主体 `*`。

### 兼容迁移

- 现有 v2 `source:remote_id` 引用迁移为 `market_scope=general`。
- 现有 `owner` 转成按用户来源的 `principal`，其他来源使用 `*`。
- 现有 `labels` 转成 `manual_labels`，升级不改变既有可见范围。
- 现有 `seeded_defaults` 不能改用新的引用 hash 直接查询。迁移将旧 `source:remote_id` 记账项转换为 v3 的稳定 bundled-default seed ID；`defaults.py` 同步改为按该 seed ID 防复活，并用 `market_scope=general` 构造新版引用。
- 随包全局默认播种机制继续保留，但与 profile 预置协调器相互独立；用户删过的随包默认引用在 v2→v3 升级后仍不得复活。
- 新旧引用 ID 的兼容解析保留一个迁移窗口。
- 引用库和账本在同一份原子写入中提交；迁移失败保留旧文件并用旧数据启动。

## 协调器

新增 `ProfileSkillPresetReconciler`，输入为已安装 profile、当前用户和现有引用状态，输出一次完整的新引用状态。协调过程先在内存中计算，再原子提交。

```text
已安装 profiles
       │
       ▼
解析 skills.presets
       │
       ▼
ProfileSkillPresetReconciler
   ├─ 新预置项 ──────► 新增或合并引用
   ├─ 用户已删除 ────► 保持 opt-out，不复活
   ├─ 预置被移除 ────► 撤销该 profile 绑定
   ├─ profile 收回 ──► 撤销其全部绑定
   └─ 仍有其他归属 ──► 保留引用
       │
       ▼
原子提交并刷新 Skill 路由索引
```

### 生命周期规则

- 新增预置：不存在对应 opt-out 时，创建或合并引用及 profile 绑定。
- 元数据更新：同一预置仍存在时，用新版 profile 的非空 L1 元数据刷新。
- 减少预置：撤销该 profile 的绑定；无手工归属和其他 profile 绑定时删除引用。
- Profile 收回：按同样规则撤销该 profile 的全部绑定。
- 用户删除：删除引用，并为相关 profile/用户/预置身份写入 opt-out。
- 用户修改归属：写入 `manual_labels`；如果用户从有效归属中移除了某个 active preset binding 对应的 profile，同时为该 binding 写入 opt-out，避免下一次协调把它加回。
- 用户重新从市场点击“引用”：清除匹配的 opt-out，恢复为用户主动引用。
- 多 profile 共用：preset binding 取并集，一个 profile 更新不影响其他 profile。
- 用户把引用改为通用或其他 profile：保存为 manual labels，后续 profile 回收时保留。
- Profile 以后重新加入曾撤下的预置：没有用户 opt-out 时重新加入；有 opt-out 时保持删除。

## 启动、登录与更新接线

```text
Electron 下载并暂存 profile
              │
              ▼
后端安装/更新 profile
              │
              ▼
ProfileSkillPresetReconciler
   ├─ cowork 来源：启动时立即协调
   └─ mythos 来源：获得 W3 用户名后按账号协调
              │
              ▼
SkillReferenceStore
              │
              ▼
刷新 Skill 路由索引
              │
              ▼
Electron 显示现有“已引用”状态
```

接入点：

- `_setup_cowork()` 先完成 profile 对账和市场注册。
- `_register_skills()` 在 provider 注册前完成共享来源的首次协调。
- `POST /skills/current-user` 设置 W3 用户名后协调该用户的按用户来源。
- `/coworks/recheck` 与启动使用同一 profile 派生状态刷新入口，并调用同一个协调器；recheck 从 `current_user.get_current_username()` 读取当前 W3 用户，同时协调共享来源和该用户的 Mythos 预置。
- 只有协调原子提交成功后才使 Skill 执行路由索引失效。
- `ReferencedSkillCapabilityProvider` 下载内容时必须把引用保存的 `market_scope` 传给市场服务。
- 作用域解析复用 `adapters/scopes.py` 已有的 `GENERAL_SCOPE`、`MarketScope` 和 `build_scopes()`；不得在 registry 中定义第二套 `GENERAL_SCOPE`。Profile 预置使用一个明确的 `resolve_profile_preset_scope()` 包装器调用该数据模型；地址相同的 profile 被合并时，解析为 `build_scopes()` 保留的有效作用域 ID，而不是一律退回 `general`。

## Electron 行为

不增加新交互：

- 预置引用出现在现有 Skill 列表中。
- 用户登录并进入对应市场页签后，目录卡片返回现有 `is_pulled=true`，显示“已引用”。
- 用户删除后恢复现有“引用”操作。
- “已引用”只表示本地已有引用元数据，不表示 ZIP 永久下载。

## 异常处理

- 启动协调不访问网络。
- 单个非法预置项跳过并记录 profile、source 和 remote ID。
- 引用库或账本写入失败时保持旧状态，应用继续启动，下次协调重试。
- Profile 减少预置但提交失败时暂时保留旧引用，避免半完成回收。
- Mythos 未登录时不协调该用户的数据；已有其他用户数据仍保存在库中并由 principal 过滤。
- 实际使用 Skill 时的下载失败沿用现有重试与错误呈现，不影响启动。

## 测试策略

- Manifest：新字段解析、缺字段容错、重复项、非法来源和市场作用域校验。
- 引用库：v2 到新版迁移、复合身份、W3 用户隔离、旧 ID 兼容、`seeded_defaults` 防复活迁移和原子失败回滚。
- 协调器：新增、减少、profile 收回、多 profile 共用、用户删除、手工重新引用和元数据更新。
- 启动接线：首次启动、`current-user`、`coworks/recheck` 调用同一协调器。
- 下载路由：通用市场与 profile 专属市场使用相同 remote ID 时仍路由到正确服务器。
- API/UI：预置引用继续返回现有“已引用”状态，不增加新状态。
- 端到端：profile v1 预置 A/B，升级 v2 只保留 A，验证 B 在不同手工归属、profile 绑定和用户 opt-out 状态下正确保留或删除。

## 已接受的设计决策

- 使用 profile 预置协调器，不拿全局默认播种文件承载 profile 数据，也不在启动时调用市场下载；现有全局默认播种机制继续保留并迁移其防复活账本。
- Profile 携带完整 L1 元数据，Skill ZIP 在实际使用时临时下载。
- 用户删除优先，普通启动不得复活。
- Profile 减少预置和收回时执行差量回收。
- 支持 cowork 与 Mythos，每项显式声明 `source`。
- 市场作用域和用户主体进入引用身份。
- Mythos 按 W3 用户隔离，cowork 共享。
- Electron 沿用“已引用”，不新增交互。

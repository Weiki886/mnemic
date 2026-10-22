# CLI 斜杠命令（#32，拆分 1/4–4/4）

前两轮交付本地命令入口及 `/memory`、`/forget`。
原计划三轮，现为保持检索与配置管理的审查边界，调整为四轮：3/4 接入 `/recall`，4/4 接入 `/status`、`/config`。
均复用服务端单源配置及项目范围 API；当前无新数据库字段或迁移。

## 使用

在 `mnemic chat --project UUID` 或 `mnemic resume ID --project UUID` 中输入：

| 命令                           | 行为                                                        |
| ------------------------------ | ----------------------------------------------------------- |
| `/help`                        | 显示已实现命令、用法和计费提示，不新增 HTTP 或模型请求      |
| `/new`                         | 提交当前会话后新建，不继承历史                              |
| `/resume UUID`                 | 按项目恢复为新续聊会话，引用完整历史，原会话只读            |
| `/exit`                        | 等待当前请求后提交并退出；Ctrl+C 行为不变                   |
| `/memory`                      | 查看当前项目 active 记忆，支持搜索、类型、状态和分页筛选    |
| `/forget UUID`                 | 软删除当前项目的 active 记忆，可在 Web 恢复，不调用模型     |
| `/recall 查询内容`             | 手动混合检索，显示入选内容、分数和轨迹，embedding 可能计费  |
| `/status`                      | 当前项目/会话、精确记忆计数及生效模型槽位，不探测模型       |
| `/config`                      | 查看全局服务端 Provider 配置及生效槽位，不返回密钥          |
| `/config set UUID FIELD VALUE` | 修改已有 Provider 元数据或 chat/extraction 槽位，作用于全局 |

打开对话仍按原有流程创建或恢复服务端会话；上表“本地”不意味着整个 CLI 离线运行。
提交或归档可能触发尚未处理消息的后台提取并计费；后续普通消息会调用聊天模型。

输入 `/he` 再按 Tab，会补成 `/help `；命令前的空白会保留，`  /he` 也可补全。回车才执行。输入 `/` 再按 Tab，
只展示匹配的已实现命令，不选中、不执行。补全后光标在结尾，可继续输入参数。
仅补全整段输入中的命令名；不补全 UUID、文件、历史内容或模型名称。普通文本和参数中的 Tab 不改变内容。
候选提示在编辑或提交后清空；请求处理中或退出时不接受补全和新提交。
行输入在同一份同步状态上处理按键：支持左右光标、Home/End、退格与粘贴，
连续输入、Tab、参数和回车无需等待中间一帧渲染；退格按 Unicode 码点处理，不拆开 emoji 的 UTF-16 代理对。

命令区分大小写，可带首尾空白。`/resume` 和 `/forget` 接受一个 UUID 并统一为小写，
`/help`、`/new`、`/exit` 不接受参数。未知命令或非法参数只显示本地错误，输入保留供直接修改；
不作为消息发送、不会触发模型请求。成功解析并开始执行命令后才清空输入。
以 `/` 开头的绝对路径也会按命令检查；如要讨论路径，请写“路径是 /tmp/example”等普通句子。

## 记忆列表与软删除

```text
/memory
/memory --type decision --limit 10 --offset 0 database
/memory --status deleted
/forget 你的记忆UUID
```

`/memory [--type TYPE] [--status STATUS] [--limit N] [--offset N] [搜索词...]`：

- 默认 `status=active`、`limit=20`、`offset=0`；limit 为 1–1000，offset 为非负安全整数。
- TYPE 为 `fact` / `preference` / `decision` / `progress`，省略则不过滤；STATUS 为 `active` / `deleted` / `retracted` / `all`。
- 类型取**当前版本来源 Observation.type**，不是任何历史版本的类型。无来源或不可验证来源返回 `null`，显示“类型未记录”，不匹配类型过滤。
  人工修正使用现有 fact Observation，因而可能改变列表里的当前类型；这不是持久的 Belief 分类字段。
- 搜索与 Web 一样，只匹配 subject/attribute 的字面子串，不搜 value，`%`、`_`、`\` 不当作用户通配符。
  筛选在 SQL 中完成后再分页。返回当前值（终端预览最多 240 字符）、ID、状态、类型；详情沿用 `mnemic memory ID --project UUID`。
- 以空白分词，不是 shell：无需为多词查询加引号，引号会被当作查询文本；重复/未知选项、非法数值在本地拒绝。
  搜索词以 `-` 开头时，在搜索词前加 `--`，例如 `/memory -- -db`。
  参数不参与 Tab 补全。翻页请保留相同筛选条件，再调整 offset；不自动请求下一页，不承诺并发写入下的分页快照。

`/forget UUID` 使用与 Web 相同的 `POST /projects/:projectId/beliefs/:id/delete`：只允许 active → deleted，
不会创建聊天消息、Observation 或新版本，也不会提取或调用模型。跨项目/不存在为 404，状态不允许为 409。
收到匹配 ID 且 status=deleted 才提示成功。网络失败或响应不兼容时不自动重试；
服务器可能已经删除，请先用 `/memory --status deleted` 或 Web 核对。
软删除退出默认检索，但不是硬删除或历史引用清除（#11）；恢复仍在 Web 操作。
操作期间禁止重复提交；Ctrl+C 先等待在途记忆请求结束，再提交当前会话退出。

CLI 与服务端需同步升级以支持新的 type 响应/筛选契约；旧服务端缺字段时 CLI 明确报响应不兼容，不假装过滤成功。
原有 Web 默认页大小 200 不变，CLI 显式请求默认 20。没有配置、模型探测或隐式重试。

## 手动召回与轨迹（3/4）

```text
/recall PostgreSQL storage
```

命令后的整段文本为查询，首尾空白去除，长度 1–1000；没有 shell 引号或选项解析，`--help` 也是查询文字。
`/rec` + Tab 补全为 `/recall `；`/re` 同时匹配 resume/recall，只提示候选，不自动执行。

- 通过 shared client 显式 `POST /projects/:projectId/recall`，要求 Bearer、JSON 请求体 `{ "query": "..." }`。
  不提供有副作用的 GET；拒绝所有浏览器 Origin（包括允许的 Web 源）。非法参数、未鉴权和不存在项目不调用模型。
- **可能调用 embedding 并计费**；不调用聊天/提取模型、不生成聊天消息或 Observation/版本，不切换会话。
  embedding 有 30 秒预算且本次不自动重试；缺少配置、失败或超时时沿用关键词降级，不把“有结果”当作模型联通验证。
- 最多显示 5 条入选当前 active 记忆，以及 trace ID、向量/关键词/融合分、入选状态与原因。
  trace 预览最多 200 条，标明显示数/总数与截断状态；库里保留完整评分轨迹。拒答时也显示该次 trace 和落选原因（如存在候选）。
- 检索池在计算分数前限定为当前项目 active 信念及其所属当前版本，不使用其他项目/历史版本归一化关键词分数。
  本入口强制关闭读时强化，即使服务端设置 `MNEMIC_READ_REINFORCE=1` 也不改变 salience。
- 每次检索会存查询原文与评分轨迹，trace 只存版本 ID/得分/原因，不复制记忆正文。
  查询不放入 URL；但它会进入数据库，请不要用此命令查询原始密钥或凭据。
- HTTP 失败或客户端超时时，服务端可能已经计费/写入轨迹；CLI 不自动重发。Ctrl+C 等待在途命令后提交会话退出，
  不承诺立即取消计费调用。提交若有尚未处理消息，仍可能触发原有后台提取。

向量未命中时显示“未命中”，不伪装成 0 分；API 不返回 Provider Key、端点或原始 SDK 异常。
仅提供手动召回诊断，不生成回答。现阶段仍使用 pgvector 扫描与 simple 关键词分词，不承诺大库 ANN 性能或中文分词效果。

## 状态与配置管理（4/4）

```text
/status
/config
/config set ProviderUUID name My Provider
/config set ProviderUUID chat new-chat-model
/config set ProviderUUID extraction new-extraction-model
/config set ProviderUUID base_url https://api.example.com/v1
/config set ProviderUUID protocol openai-compatible
```

- `/status` 不接受参数，从服务端读取当前项目与当前会话；必须同时匹配二者，否则 404。
  `total` 包括 active/deleted/retracted/superseded/expired，各状态计数由数据库精确聚合，非当前列表页的估算。
  状态和配置查询是调用时快照，不承诺多次查询之间的事务一致性。
- `/config` 是**全局配置，不是项目配置**：展示已有 Provider ID、名称、协议、安全端点、已配置的槽位与当前生效槽位。
  同一用途取最早创建且配置了该槽位的 Provider，创建时间相同则按 ID 升序；真实模型解析与消解记录使用相同规则。
  修改非生效 Provider 不会使它自动获得优先级，须用 `/config` 核对。
- 查询只选择非密钥字段，不解密、不构造模型 SDK、不调用或探测模型。未配置槽位显示“未配置”，不伪装为已连通。
  新 HTTP 视图不返回明文、密文或掩码 Key；旧端点里的 URL 凭据、查询和片段不会出现在新视图中。
  名称、路径与模型 ID 是用户配置文本，仍请不要把凭据放在这些字段里。
- `FIELD` 仅支持 `name`、`base_url`、`protocol`、`chat`、`extraction`。`VALUE` 为后续以空白分隔的文字（空白合并，不处理 shell 引号）。
  名称上限 64，模型 ID 上限 200；协议为 openai-compatible/anthropic；端点须为不含用户信息、查询和片段的 HTTP(S) URL。
  上述长度/去空白约束只适用于新修改；已有名称和模型 ID 原样读取，与 SDK 实际使用值一致，不因历史合法长值而拒绝整页。
  本命令只修改已有 Provider，不创建/删除 Provider，不接收 API Key，不改 `.env`。密钥录入沿用现有服务端安全配置流程，不应粘贴到聊天输入。
- embedding 模型切换及维度变化需要 REEMBED/部署流程，本轻量编辑器不提供；若某 Provider 已承载 embedding，
  其端点/协议变更也返回 409，防止原有索引与新模型混用；仍可修改名称及 chat/extraction 槽位。
- 配置修改复用 `PATCH /providers/:id`，要求 Bearer 与 JSON；空修改、未知字段或非法值为 400，不存在为 404，名称重复或 REEMBED 限制为 409。
  槽位更新按 JSON 字段合并且行锁串行化，保留其他槽位与原加密 Key。不记录配置正文或原始异常。
- 只有收到匹配 ID/修改字段的响应才确认成功；失败/超时时先用 `/config` 核对，不自动重试。
  修改不会探测模型或产生 Evidence/版本；后续模型解析使用新配置，已经解析的调用不切换。Ctrl+C 仍等待进行中的配置请求，再提交会话退出。

HTTP：`GET /v1/config`；`GET /projects/:projectId/status?conversation_id=UUID`；`PATCH /providers/:id`。
均需要现有全局 Bearer，响应 no-store。当前鉴权是个人服务单 Token，不宣称多用户租户授权。

## 范围边界

至此 #32 的六类命令均可在对话中使用并补全；本轮 PR 经 owner 审查合并后再关闭 Issue。
用户自定义命令、任意工具执行、密钥创建/轮换 UI 和 REEMBED 管理不属于此轻量入口。

没有通用 shell 解析器、用户自定义命令、工具执行、网络加载命令、自动重试或新依赖。
后续命令继续通过同一注册表接入，不把“有命令名字”当作已交付功能。

## 验证

纯函数测试核对注册表、帮助和补全一致性；Ink 输入测试覆盖 Tab、候选、补全后的参数编辑、
未知命令拒绝及既有会话操作。记忆 API 以真实 PostgreSQL 验证来源类型、项目隔离、
软删除/恢复和默认检索一致性；模型使用离线替身，不调用真实模型。

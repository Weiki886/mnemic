# OpenAPI 部分契约（#24）

当前生成的是**部分契约**：`GET/HEAD /health`、`GET/PUT /v1/config/flags`、下方列出的六个项目记忆操作、五个会话生命周期/只读操作、五个 Provider/配置/状态操作，以及统一 problem+json 错误结构。其余 API 尚未登记，`/docs` 和完整中间件接入指南留后续 PR，本轮不关闭 #24。契约版本 0.1.0 表示本轮产物，不代表已发布仓库 Release 或完整 API 覆盖。

## 生成与检查

在仓库根目录完成正常工作区安装后执行：

```sh
pnpm install --frozen-lockfile
pnpm --filter @mnemic/server run openapi:generate
pnpm --filter @mnemic/server run openapi:check
```

源码入口是 `apps/server/scripts/openapi.ts`；`docs/openapi.json` 为已提交生成产物，不应手改。脚本只允许默认生成或 `--check`，不接受外部输出路径。检查先逐字比对确定性生成结果，过期时拒绝而不覆盖，再用 Redocly recommended 规则 lint。CI 会运行同一检查，不会在 CI 内悄悄更新文档。

字段结构来自既有/共享 Zod：健康响应、特性开关快照/完整更新/HTTP 成功结果，以及统一错误模型。路由说明、状态码、请求/响应示例、安全要求是显式登记的协议元数据；不靠扫描 TS 推测接口或手写另一份字段 YAML。真实 HTTP 契约测试读取**提交的 JSON 产物**，用独立 Ajv 校验实际响应，不以当前实现临时生成预期结果。

生成器不读取 `.env`、数据库或真实模型配置，不监听服务端口、不调用模型，也不在处理错误时获取任何 URI。OpenAPI 中的 `http://127.0.0.1:3000` 只是本地地址示例，实际部署 URL、HTTPS 和端口由操作者配置。

构建工具均为 server 开发依赖，生产容器不导入脚本。转换器固定为支持当前 Zod 3 的 7.3.4（[上游说明](https://github.com/asteasolutions/zod-to-openapi#installation)）；Redocly 1.34.15 保留既有 Node >=22.9 下限，不为工具升级抬高运行环境要求。格式化复用仓库根目录声明的 Prettier 开发工具。

当前产物登记了仓库 [LICENSE](../LICENSE) 声明的 Apache License 2.0。Redocly 检查为零错误、2 条提示：两个公开 liveness 操作没有业务 4xx。保持提示，不编造不存在的健康检查鉴权/限流响应，也不禁用相应规则。后续扩大覆盖仍需重新执行同一检查；缺少 `$ref` 和闲置组件均会使门禁失败。

## 已覆盖的协议

- `/health` 是公开存活检查，GET 返回 `{ "status": "ok" }`，HEAD 无正文；不保证数据库或 Provider 可用，查询参数被忽略。接口维持既有精确鉴权/限流豁免。
- 特性开关管理要求全局 Bearer Token；不接受查询参数，不调用模型，所有响应 no-store。GET 是持久值，不是当前操作的有效覆盖值。
- PUT 只接受 JSON 和完整快照，必须带当前 `expected_revision`；冲突为 409，无变化不增 revision、不记变更审计。语法 schema 中的字段是布尔量，不代表尚未支持的开关可以启用；这些 true 值仍按管理端规则返回 400。详见 [特性开关说明](feature-flags.md)。
- 429 为请求预算拒绝，含整数秒 `Retry-After` 与请求 ID；这不等于模型日配额或费用上限。

产物中的 PUT 示例针对隔离的新库 revision=0，将 memory_gate 关为 false。真实接入应先 GET，再明确选择本次完整替换值，不能盲目重放示例的 revision。示例请求及健康响应由真实 TCP + 测试 PG 自动断言，使用离线工厂保证没有付费调用。Token 仍由操作者设置并经请求头提供，文档不内置或生成真实凭据。

## 错误 URI 与兼容性

`problem()` 现在按稳定错误码发出 `https://mnemic.dev/errors/<小写连字符错误码>`，例如 `NOT_FOUND` 对应 `https://mnemic.dev/errors/not-found`。URI 是标识符，**不承诺该域名/路径存在可访问页面**，客户端无需请求它。HTTP status、code、title、requestId 和字段级 errors 的含义保持原有约定。

共享 `ProblemDetailsSchema` 与生成的 oneOf 同时约束 code/URI 配对，未知代码、未知 URI 和额外字段不会被当作本版本契约。新响应不再写 `about:blank`；为读取旧服务端保留它的解析分支，旧 ApiError 客户端 fixture 仍通过。将 type 写死为 about:blank 的外部消费方需要升级；推荐继续按稳定 code 判断业务分支。新增错误码时必须登记 URI、更新契约并通过漂移检查。

保留已有决定：使用 requestId 标识请求，不另外生成 instance；校验详情通过结构化 errors 提供，根级错误 path 可以为空字符串。错误契约不放宽异常脱敏，真实上游/SQL/密钥和堆栈不会因文档化而进入 5xx 响应。

回滚 #109 基座会停止契约生成门禁并恢复旧 type 输出；仅回滚本轮记忆契约扩展则保留 #109 的门禁、健康/flags 契约和错误 URI，只移除记忆登记、相关测试及输入 schema 抽取。两次交付均无迁移、业务数据修改、鉴权豁免扩张或真实服务部署。其余接口、在线页和完整三槽位接入文档仍需后续完成后才能关闭 #24。

## 记忆中心契约扩展（#24 后续拆分）

产物现在另覆盖以下六个现有操作，均继承全局 Bearer 鉴权，项目 ID 是数据查询作用域，**不代表按用户划分的所有权鉴权**：

| 操作 | 路径                                             |
| ---- | ------------------------------------------------ |
| GET  | `/projects/{projectId}/beliefs`                  |
| GET  | `/projects/{projectId}/beliefs/{id}`             |
| GET  | `/projects/{projectId}/beliefs/{id}/resolutions` |
| POST | `/projects/{projectId}/beliefs/{id}/correct`     |
| POST | `/projects/{projectId}/beliefs/{id}/delete`      |
| POST | `/projects/{projectId}/beliefs/{id}/restore`     |

路径参数必须是 UUID，详情或修改跨项目访问与不存在均为 404。列表缺失项目返回空数组。列表默认 status=active、limit=200、offset=0，上限 1000；共享 CLI 默认 20 不变。q 只按字面量查 subject/attribute，不查 value，百分号/下划线不扩张匹配。列表按 subject/attribute 排序，offset 分页不是并发变化期间的稳定快照。详情版本和消解历史仍为全量返回，无新增分页。

输入校验来自生产路由实际使用的 `apps/server/src/contracts/memory.ts`（复用 shared 的列表规则），输出 Zod 描述也在此文件（列表直接复用 shared）。输出 schema 不作为 Fastify response serializer，避免为了文档而删除、强转业务响应；真实 TCP + 独立 Ajv 测试对提交产物验证所有六个操作。原有兼容语义不变：未知查询/修正 body 字段被忽略，修正 value 要求非空字符串但不 trim；详情和状态操作忽略查询。删除/恢复无必填 body，仅对应 active→deleted、deleted→active，重复操作为 409，同事务审计后返回。

修正示例 body 为 `{ "value": "SQLite" }`。测试创建独立项目、信念及版本，以实际 ID 替换模板，执行产物中的 body 后检查新值、版本链、provenance、消解记录、删除/恢复审计；不是向读者现有项目写示例数据。手工使用时必须先明确选中自己的项目和记忆，不能将模板占位符原样发送。已删除的记忆修正返回 409，必须先显式恢复；retracted 记忆允许修正复活。修正走同步 ingest/Resolver，无提取或 embedding 模型调用；本接口不新增秘密检测，不应向修正值提交凭据。

JSONB 值允许 object/array/string/number/boolean/null，字段必须存在。分数保持 number|null，消解历史保留既有 camelCase。relation 只含四态或 null，ignore/retract 位于 policies；历史 flagsSnapshot 为 null，不补造当前配置。policies/modelSnapshot 是既有 JSON 数据，契约不发明内部固定结构。

转换器 v7 对 unconstrained JSON 输出无 type 的 nullable，对 nullable enum 也不补 null 枚举项。构建工具按 [OpenAPI 3.0 Schema Object](https://spec.openapis.org/oas/v3.0.3.html#schema-object) 归一化：无约束 JSON 为 `{}`（原本就允许 null），有 type 的 nullable enum 显式包含 null，required 不变；只遍历 schema 位置，不解释 example。枚举采用新数组，避免生成过程改变共享 Zod 的原始枚举。测试覆盖任意 JSON/显式 null/缺失值，以及生成后查询仍拒绝 type=null。Redocly 继续为 0 errors / 2 个健康检查提示。

目前仍是部分契约。消息发送（含流式/取消/附件准入）、召回、PENDING、用量/审计/审批、其余项目/诊断等接口，以及 `/docs` 在线页和完整接入指南均未因本轮自动覆盖。原先 3 次交付的规划在接口盘点后继续按可审查大小拆分；#24 保持打开，不能仅凭本轮契约通过关闭。

## 会话生命周期与只读契约扩展

本轮追加五个现有操作，创建沿用 `200`，续聊为 `201`，不统一篡改既有状态码：

| 操作 | 路径                                              |
| ---- | ------------------------------------------------- |
| GET  | `/projects/{projectId}/conversations`             |
| GET  | `/projects/{projectId}/conversations/{id}`        |
| POST | `/v1/conversations`                               |
| POST | `/v1/conversations/{id}/commit`                   |
| POST | `/projects/{projectId}/conversations/{id}/resume` |

字段复用 shared 的会话/列表/提交/消息/续聊 Zod schema；输入定义集中在 `apps/server/src/contracts/conversation.ts`，由路由、生成守卫和生成器共同消费。输出中的引用值保留任意 JSON（含 null）并要求字段存在，详情和续聊都包含完整消息视图；输出契约不参与生产响应改写。`speaker=tool`、文件 Evidence 元数据和 interrupted/failed 生成状态保持原有含义，文件元数据并非正文副本。

列表默认 limit=200（1–1000）、offset=0（非负整数），按 started_at/id 升序；未知查询字段忽略，缺失项目返回空数组，offset 不是并发写入期间的一致快照。计数包括已验证的继承历史；坏历史保留列表行，返回 `message_count=null` 和 `history_error="unavailable"`，不伪造零消息。二者的联动是 shared Zod 的运行时 refinement，生成结构本身不完整表达它。详情与续聊重新验证消息/文件父引用；损坏引用为 409，不归档源/当前会话、不复制部分可用历史。详情是全量消息，无新增分页；历史引用记忆包括同项目的历史/删除状态内容，跨项目或失效引用 ID 不解析，不能将详情当成仅检索 active 记忆的结果。

创建 body 的 `project_id` 必须替换为已有项目 UUID，title 可省略；存在时长度 1–200，不 trim。未知 body 字段忽略，精确保留标题 `manual-corrections` 由运行时 refinement 拒绝（OpenAPI 中的字符串长度不代表任何标题都能创建）。普通同名会话仍允许。产物内示例使用占位 UUID，自动化测试替换为新建隔离项目，再真正发送示例 body。

提交接口是既有全局 ID 路由：从会话推导项目，无 projectId 参数，依赖同一全局 Bearer 操作者授权，不宣称按用户/项目成员身份鉴权。UUID 已由生成守卫校验。无必填 body，忽略查询；重复提交、生成繁忙、停机中或坏历史为 409。`extraction_triggered` 只表示登记了工作，不代表提取/索引已完成；正式入口在归档事务中写持久 outbox，未配置队列的库调用保留旧异步路径。存在未提取物理 Evidence 时，这些后续任务可能调用付费模型并占用配额，不能因为本轮契约测试零调用就推断生产提交永不调用模型。

续聊必须发送 JSON 对象（示例 `{}`，不能省略 body）；未知字段严格拒绝，可选 `current_conversation_id` 也须在 URL 项目内。源和当前会话在任何归档前校验，均不得为专用修正会话。每次成功创建新会话，归档仍开放的源/当前会话，并引用已验证历史；旧消息不复制，继承 Evidence 不重新提取。`201` 回执丢失后不可盲目自动重试，否则可能创建另一个续聊会话。文件路径/父消息引用约束也有运行时校验，不能仅靠生成的字段类型推断其安全性。

真实 TCP 契约测试直接读取提交 JSON，用独立 Ajv 验证这些操作的响应。测试为开启持久提取的真实路由接上全局鉴权，但故意不启动 worker，直接断言任务为 queued、extracted_at 仍 null 且无 Observation；既有已提取历史证明不重复投递。它还验证新会话物理消息数为零、历史 ID 不变、文件/工具/打断元数据、项目隔离、坏历史、分页、400/401/404/409/413/415。测试用抛错工厂保证无模型调用；不冒充 worker 完整恢复或付费模型验收。

仅回滚本次会话扩展会移除上述五个登记和输入定义抽取，保留 #109/#110 的错误 URI、健康/flags/记忆契约及生成门禁。消息发送、SSE、取消、召回等未覆盖 API 和在线 `/docs`/完整指南仍待后续，#24 保持打开。

## Provider、配置快照与项目状态契约扩展

本轮追加五个操作，字段和输入规则分别复用既有共享 management schema 与抽取后的 `apps/server/src/contracts/providers.ts`：

| 操作  | 路径                           | 成功响应                   |
| ----- | ------------------------------ | -------------------------- |
| GET   | `/providers`                   | 200，旧 camelCase 掩码列表 |
| POST  | `/providers`                   | 201，旧 camelCase 掩码行   |
| PATCH | `/providers/{id}`              | 200，snake_case 安全配置行 |
| GET   | `/v1/config`                   | 200，安全全局配置/槽位快照 |
| GET   | `/projects/{projectId}/status` | 200，项目计数和全局槽位    |

这五个操作都要求全局 Bearer，不能据此推断项目成员身份鉴权。旧 GET/POST `/providers` 还要求 DB 与主密钥，否则路由未注册、返回 404；PATCH/config/status 只要求 DB。所有操作都不构造 SDK、不探测端点、不调用模型，创建成功也不等于密钥或 embedding 维度已验证。JSON 输入中的 `api_key` 在产物标记为 writeOnly，示例只有明显的离线假值和 `example.invalid` 域名。不要向离线示例填真实密钥；实际配置应由操作者经受保护的连接提交，不能将凭据放进 URL。

旧 POST 保留原有宽松对象、非 trim 字符串和通用 URL 校验；models 的未知字段会被剥离，至少一个 chat/extraction/embedding 槽位必须非空（运行时 refinement）。创建配置、密钥加密和只含协议/槽位标识的审计同事务。GET 解密只为构造掩码；响应的 `apiKeyMasked` 不是可重用凭据，永不返回 API key 原文或密文列。列表仍无分页，按 created_at 排序并忽略查询字段。

**旧接口的 `baseUrl` 与 `models` 是原样存储元数据**：URL 不做安全清理，models 在损坏历史数据下也可能不是槽位对象，因此读取契约将 models 如实表示为必填任意 JSON；不能声称旧接口已经过滤全部 URL 凭据或验证全部配置。新 `/v1/config` 与 PATCH 的 `base_url` 安全视图则去掉用户名/密码/查询/片段，非 HTTP(S) 或无法解析的 URL 为 null；不带 key，连掩码也不带。模型名和 Provider 名属于操作者配置元数据，并非面向匿名/按项目成员的公开目录。

PATCH 继续严格拒绝未知字段、`api_key`、embedding 修改和空更新；只允许元数据及 chat/extraction 槽位。输入字符串 trim；HTTP(S) URL 不允许凭据、query、fragment，末尾斜杠归一化。至少修改一个字段/槽位、安全 URL 等 refinement 与转换仍由运行时执行，OpenAPI 的结构性字段不完整表达这些限制。承载 embedding 的 Provider 改变端点或协议为 409，不能通过该接口绕过 REEMBED。无变化不写审计；实际修改与不含名称/端点/模型/凭据正文的审计同事务。冲突为 409，其他写入异常返回固定 500，不自动重试；不能只凭响应丢失就认定没有提交。

配置快照不解密任何密钥，不构造 SDK。按 created_at/id 选择最早配置了槽位的 Provider，非法元数据行从 providers 排除并报告 ID；若最早候选非法，槽位显示 `model=null, invalid=true`，不会默默改选后面的行。没配置的槽位为 null。最多读取 1000 个 Provider，超限为 500，不冒充完整结果。base_url=null 或结构合法都不代表端点可连接，这不是 readiness/probe。该 GET 拒绝任何查询字段。

项目状态要求 `conversation_id` 查询参数，严格拒绝未知字段；URL 项目与会话不匹配时先返回 404。counts 只统计本项目六种状态，total 必须等于分项和（运行时 refinement），slots 则仍是全局快照。配置/状态处理器和 PATCH 成功响应设置 no-store；不额外承诺所有在处理器之前产生的传输错误都有相同缓存头。

真实 TCP + PG 契约测试发送产物中的创建与 PATCH 示例，检查加密落库、掩码与安全视图差异、最早槽位选择、无变化不记审计、审计失败回滚、embedding 保护、字段级 400、401 先于 JSON 解析、404/409/413/415/固定500。损坏密文时 safe config/status 仍可读、旧掩码列表返回 500，证明了不解密边界。测试全用假密钥，SDK 工厂直接抛错以保证零调用；仅操作独立测试库，并保存/恢复原测试 Provider 行（由 PG 编码完整时间精度），不读取用户 `.env` 或真实 Provider 配置。

回滚本次扩展会移除这五个登记及对应输入定义抽取，保留 #109–#111 的契约、错误 URI 和 CI 门禁。消息发送/SSE/取消、召回、PENDING、用量/审计/审批、其余项目与诊断接口、在线 `/docs` 和完整接入指南仍未覆盖，#24 保持打开。

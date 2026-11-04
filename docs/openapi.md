# OpenAPI 部分契约（#24）

当前生成的是**部分契约**：`GET/HEAD /health`、`GET/PUT /v1/config/flags`、下方列出的六个项目记忆操作、五个会话生命周期/只读操作、五个 Provider/配置/状态操作、三个召回/诊断操作、三个 PENDING 操作、两个用量查询/导出操作、两个审批审计操作、平台审计查询、JSON/SSE 消息发送与取消，以及统一 problem+json 错误结构。已提供只读 `/docs` 与原始契约下载；完整中间件接入指南留后续 PR，最终覆盖仍需按路由盘点核对，本轮不关闭 #24。契约版本 0.1.0 表示本轮产物，不代表已发布仓库 Release 或完整 API 覆盖。

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

目前仍是部分契约。消息发送（含流式/取消/附件准入）、PENDING、用量/审计/审批、其余项目等接口，以及 `/docs` 在线页和完整接入指南均未因本轮自动覆盖。原先 3 次交付的规划在接口盘点后继续按可审查大小拆分；#24 保持打开，不能仅凭本轮契约通过关闭。

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

仅回滚本次会话扩展会移除上述五个登记和输入定义抽取，保留 #109/#110 的错误 URI、健康/flags/记忆契约及生成门禁。消息发送、SSE、取消等未覆盖 API 和在线 `/docs`/完整指南仍待后续，#24 保持打开。

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

项目状态要求 `conversation_id` 查询参数，严格拒绝未知字段；URL 项目与会话不匹配时先返回 404。counts 只统计本项目五种状态，total 必须等于分项和（运行时 refinement），slots 则仍是全局快照。配置/状态处理器和 PATCH 成功响应设置 no-store；不额外承诺所有在处理器之前产生的传输错误都有相同缓存头。

真实 TCP + PG 契约测试发送产物中的创建与 PATCH 示例，检查加密落库、掩码与安全视图差异、最早槽位选择、无变化不记审计、审计失败回滚、embedding 保护、字段级 400、401 先于 JSON 解析、404/409/413/415/固定500。损坏密文时 safe config/status 仍可读、旧掩码列表返回 500，证明了不解密边界。测试全用假密钥，SDK 工厂直接抛错以保证零调用；仅操作独立测试库，并保存/恢复原测试 Provider 行（由 PG 编码完整时间精度），不读取用户 `.env` 或真实 Provider 配置。

回滚本次扩展会移除这五个登记及对应输入定义抽取，保留 #109–#111 的契约、错误 URI 和 CI 门禁。消息发送/SSE/取消、PENDING、用量/审计/审批、其余项目接口、在线 `/docs` 和完整接入指南仍未覆盖，#24 保持打开。

## 手动召回与诊断契约扩展

本轮追加三个操作。它们仍使用全局 Bearer 操作者授权，不是用户/项目成员鉴权；GET 诊断、显式探测和手动召回有不同的调用副作用，不能混为一谈。

| 操作 | 路径                           | 调用边界                                               |
| ---- | ------------------------------ | ------------------------------------------------------ |
| GET  | `/v1/doctor`                   | 读取数据库/配置，解密和构造 SDK 解析槽位，但不调用模型 |
| POST | `/v1/doctor/probe`             | 显式调用三槽位，可能计费                               |
| POST | `/projects/{projectId}/recall` | 可能调用查询 embedding，写检索轨迹                     |

输入复用 `apps/server/src/contracts/diagnostics.ts` 的现有 UUID/严格空对象规则，召回请求/结果和诊断报告来自 shared Zod。诊断输出分别约束 probe=false/true；没有为契约新增生产 response serializer。生成结果只表达结构和字段上限，不完整表达召回 selected/reason/count/abstained/flags 等运行时联动校验。

GET 诊断始终注册，任何查询参数（包括 probe=true）均为 400。它会读数据库、检查向量列/部署维度、解密配置并构造 SDK 解析三个槽位，所以不能声称“不解密/不构造 SDK”；但不会发起模型调用或新增用量。模型项标 skipped，不冒充已探测可用。缺失 DB/主密钥、连接/配置/维度错误仍返回 HTTP200，报告 ok=false；HTTP200 或 ok=true 都不是模型连通性和生产 readiness 的保证。

probe 必须显式 POST JSON 空对象 `{}`，body 不能省略，未知字段拒绝，URL 查询字段忽略。与召回一样，任何 Origin（包括配置为可信的 Web 源和字面量 null）均在 JSON 解析前被拒绝；这不是只靠 CORS 隐藏结果。JSON charset 可接受，其他媒体类型为 415。健康配置下两个文本槽位和 embedding 并行调用，每次 SDK 调用 maxRetries=0，携带 15 秒 abort signal，并校验向量维度/有限值；这些不是覆盖全部数据库等待的端到端硬超时，也不证明停止计费。

探测失败、模型日配额拒绝等被转为逐项 HTTP200/ok=false 报告，不承诺上游错误或配额耗尽一定体现为 HTTP429；HTTP429 描述的是外层请求令牌桶。响应不返回生成文本、密钥字段或原始异常。probe 不创建 Evidence/Belief/检索轨迹，但实际 SDK 调用会尝试写用量记录，并可能占用正式入口的日调用预算和产生供应商费用。回执不明时不要自动重发。

手动召回只提供 POST，且要求 DB+主密钥；缺少依赖时路由未注册。body 只接受 trim 后 1–1000 字符的 query，不开放 topK、阈值、reinforce 或 flags；URL 查询字段忽略，也不能借此控制强化。向量路开启时 query 可能被发送给 embedding Provider 并计费；embedding 失败（含本地日配额拒绝）降级为关键词路，不保证直接返回 HTTP429。只选本项目 active 的当前版本，最多五个选中结果，并持久化 query_text 和只含 ID/分数的检索轨迹；不要将凭据放进查询中。结果包含选中记忆的正文值，trace 最多公开 200 个候选，candidate_count/truncated 描述完整候选数。

手动路径显式 reinforce=false 优先于持久或环境配置，有效快照会记入轨迹；读取不提升 salience，也不改 confidence/evidence_count/provenance。30 秒 signal 只约束相关 embedding 工作，不覆盖所有 SQL。其他错误使用固定 500 文案，轨迹可能已经写入，不能自动重试。成功响应 no-store；认证和传输错误遵守各自既有规则。

真实 TCP + PG 契约测试读取提交的 JSON，用独立 Ajv 校验示例及错误响应。SQL 预置确定性的向量，模型调用只经过 Mock V2 离线替身：检查 GET 零调用、probe 两次文本一次 embedding、用量 purpose=probe、无记忆/检索轨迹副作用、召回项目过滤/前五项/轨迹反查/关闭强化、无答案拒答、embedding 失败降级和未支持开关提前失败。全程无真实 Provider 请求或付费调用。测试会保存并恢复测试库 Provider 和 flags，全量执行显式置空模型 key；这不是供应商账单或模型质量评测。

仅回滚本扩展会移除这三个登记和输入定义抽取，保留 #109–#112 的契约和门禁。消息发送/SSE/取消、PENDING、用量/审计/审批、其余项目接口和 `/docs`/完整指南仍待后续；#24 保持打开。

413 的契约测试另有传输边界：Node fetch 在上传超大 body 时，可能因服务端提前关闭上传而先得到 EPIPE，无法读取已发送的拒绝响应。四组 OpenAPI HTTP 测试共用仅发送 Expect/超限 Content-Length 头部的 TCP 夹具，等待最终 413 后关闭请求，不上传、重试或重放 body；真实响应仍交给同一产物/Ajv 校验。另有完整超大 JSON 的 app.inject 测试验证相同默认 body limit，保留实际大请求体覆盖。这个改动只稳定测试，不承诺任意正在上传的客户端都必然收到完整 problem+json。

## PENDING 候选契约扩展

追加 `GET /pending` 和 `POST /pending/{id}/confirm|reject`。输入复用 `apps/server/src/contracts/pending.ts` 的既有列表规则，输出按存储行定义 Zod；生产响应不增加 serializer。三个操作都要求全局 Bearer 操作者 Token 和数据库，不要求主密钥，不构造或调用模型；无 DB 时路由不存在、返回 404。它们没有用户/项目成员级鉴权。

列表必填 `project_id`（UUID），仅用于 SQL 过滤；不存在的项目返回空数组。status 可取 pending/confirmed/expired/rejected/promoted，省略时处理器默认 pending；未知查询字段被忽略，包括 limit/offset。当前无分页，按 createdAt 升序，同时间的行不保证稳定顺序。TTL 过期不会自动从列表隐藏或触发过期操作。返回 camelCase 完整候选行，candidate/gateScores 是必填的原样 JSONB，历史 null、标量和数组均合法，不承诺匹配当前提取 schema。响应可能含记忆正文，不适合公开缓存；本路由尚未添加 no-store，客户端应主动避免持久缓存。

操作 URL 的 id 当前仅为字符串，没有路由 UUID 校验；非法格式会到数据库，再由旧处理器捕获为 404，不能把它写成字段级 400。POST 不要求 body；提供的合法 JSON 会被忽略，原有 text/plain parser 也接受文本，但仍执行 Fastify 的解析、媒体和大小限制（坏 JSON 为 400，未支持媒体为 415，超限为 413）。查询字段同样忽略，不能通过 query/body 的 project_id 控制项目作用域。沿用普通 CORS，不像 probe/recall 拒绝所有 Origin。

confirm/reject 按全局候选 ID 无条件更新，既不检查原状态，也不拒绝过期 TTL；重复操作会重新设置 decidedAt，确认后仍可拒绝，反之亦然，没有 CAS/409 前置条件。返回行的 status 分别限定 confirmed/rejected。**确认不代表写入正式记忆**：它不创建 Observation/Belief、不重过 Gate/Resolver、不入队提取、不调用模型，因此不保证候选会成为可检索记忆。只在 debug 开启时输出元数据事件，不新增持久决定审计。

旧处理器把仓储失败也转成 404，不能据此区分“不存在”和“写入失败”，更不能在回执不明时自动重试或声称一定没有提交。列表未捕获的 DB 错误仍为固定 500。鉴权在 JSON/数据库之前执行；HTTP 请求预算的 429 带 Retry-After。这些既有作用域、全量列表、原样 JSONB 与宽 catch 边界在本次契约化中如实记录，不静默修改业务。

产物中的 UUID 参数示例是离线占位值。自动化使用独立测试 PG 预置对应资源后替换 UUID，真实 TCP 执行 GET/confirm/reject；独立 Ajv 验证提交产物、任意 JSONB、五态列表、时间、缺项目空表、状态覆盖/重复操作、无正式记忆副作用及 400/401/404/413/415/429/500。异常路径使用抛错 Proxy 验证固定错误、认证顺序及无原始异常泄露；没有读取用户 Provider 或调用付费服务。

仅回滚本扩展会移除三个登记和列表 schema 抽取，保留 #109–#113 的契约/门禁。消息发送/SSE/取消、用量/审计/审批、其余项目接口和在线 `/docs`/完整接入指南仍未覆盖，#24 保持打开。

## 用量查询与导出契约扩展

新增 `GET /projects/{projectId}/usage` 和 `GET /projects/{projectId}/usage/export`。输入/JSON 输出直接复用 shared/usage 的 Zod，项目参数只抽取原有 strict UUID 小写规则；无生产行为、计价算法或序列化器变更。两个接口只读既有用量，不解析 Provider 配置、不构造 SDK、不调用模型；导出另有持久审计副作用。要求数据库和全局操作者 Token，不要求主密钥；无数据库时路由不存在。项目/会话过滤不等于用户成员授权。

查询严格拒绝未知字段和重复标量参数；projectId、conversation_id、after UUID 归一化为小写。可选 from/to 是带时区的 ISO 时间，过滤精度最多毫秒、换算后 UTC 年份在 0001–9999，窗口须大于零且不超过 366 天；这些 refinement/联动限制不全部体现在 OpenAPI 结构中。默认 to 为服务端当前时间、from 为 to 前 30 天。范围为 `[from,to)`，day 按 UTC 分组。conversation_id 按实际归属会话筛选，不重复计算续聊继承的历史；无项目的 probe 记录不计入项目结果。

汇总默认 group_by=day，还支持 model/purpose/conversation；group_limit 默认 200、最大 1000。groups_truncated 仅表示分组详情截断，totals 在单条 SQL 快照内仍完整。token 和 duration_ms 均为精确十进制字符串，可能超过 JavaScript 安全整数；不要转成 number。未报告 token 是 null/缺失计数，不应估为零；provider 的 total_tokens 独立于输入输出之和。估价按本实例当前价格配置及历史生效时间算出，返回 currency/pricing_revision；known_amount 有 12 位小数，未知价格时为 null，已知小计为零也不代表免费。它不是供应商账单或停止计费证明。单纯查询报告不写导出审计。

导出由 `format=json|csv` 查询字段选择，默认 json，不按 Accept 协商；limit 默认 200、最大 1000。after 是同项目/会话/窗口内已有用量行的 UUID，否则 404。按 `(started_at,id)` 升序分页，游标时间从 PG 回查，保留微秒精度；JSON 行 started_at 可以含六位小数，不能套用过滤输入的毫秒上限。JSON 返回 records 和 next_after，最后一页 next_after=null。

CSV 是 `text/csv; charset=utf-8` 附件，文件名 usage.csv，不能交给 JSON parser。所有字段加双引号、内部引号加倍、记录用 CRLF；可能被表格识别为公式的单元格加前导单引号，null 输出空单元格，不冒充零。provider_name/model_id 是既有记录元数据，不承诺任意秘密检测或脱敏。CSV 无 JSON 包络，列依次为：project_id、currency、pricing_revision、id、conversation_id、provider_name、model_id、slot、purpose、status、started_at、duration_ms、prompt_tokens、completion_tokens、total_tokens、reasoning_tokens、cached_input_tokens、estimated_cost。

两种导出都用 X-Usage-From/To 返回实际窗口，仍有后页时返回 X-Next-After，最后一页省略该头。默认时间范围分页时，后续请求必须复用第一次返回的 from/to，不能每页重新使用 now。每个请求是独立事务，跨页不是冻结的数据快照；并发新增记录的整份一致性不在本接口保证内。浏览器只有在可信 CORS 源下才能利用暴露的分页头。

导出先在同一事务准备完整有界正文并写 `usage.export / prepared` 审计，再提交后发送；空页同样记录。审计只含作用域、格式、行数、窗口和游标，不复制导出内容或 Provider/模型名称。审计失败为固定 500，不发送 CSV/JSON 导出正文，不留下本次 prepared 记录。prepared 仅证明服务端准备完成，不证明客户端已收到或保存；回执不明时不能据此断言没有审计，也不应自动重试。处理器响应 no-store，处理器之前的认证/传输错误遵守原有规则。

真实 TCP + 测试 PG 读取提交产物并使用独立 Ajv：执行带资源 UUID 替换的参数示例，覆盖四种分组、截断但完整总量、时区归一化、半开窗口、未知计价、超安全整数、null token、微秒/同时间游标分页、独立手写 CSV 预期、JSON/CSV 格式与头部、每页 prepared 审计及失败回滚。测试不使用生产 CSV formatter 生成预期、不读取真实 Provider；工厂 tripwire 验证零模型调用，测试清理自有用量/审计/作用域资源。

本轮仍 Refs #24。只回滚本扩展会撤销两个登记、参数抽取和相应测试/文档，保留 #109–#114；消息发送/SSE/取消、审计/审批、其余项目接口和在线 `/docs`/完整指南留后续。

## 项目审批审计契约扩展

追加 `POST/GET /projects/{projectId}/approvals`，字段结构复用 shared/approval-audit；项目 Params 仅抽取既有 strict UUID 小写规则，不改变生产校验、权限或审计写入行为。两个接口要求数据库和全局 Bearer 操作者，不要求主密钥；无数据库时路由不存在。URL 项目必须存在，写入时 event.project_id 必须与 URL 项目匹配，否则先返回 404，不插入记录。这不是用户/项目成员鉴权；沿用普通 CORS，不像 probe/recall 拒绝所有 Origin。

这些记录是**客户端报告的审批决定**，不是服务端远程授权、工具执行凭证或操作成功证明。接口不会修改授权、执行工具、解析 Provider 或调用模型。root_hash/target_hash/command_hash 是客户端提交的 SHA256 形状字符串，服务端无法验证本地文件、命令和执行事实。body 中 request_id 是客户端审批请求的关联 UUID，独立于 HTTP x-request-id。

POST 接受严格事件对象，拒绝明文 command/path/target、伪造 client_reported/version 等额外字段；未知 URL 查询字段则被忽略。未知媒体为 415，text/plain 虽可由 Fastify 解析，仍因不是事件对象返回 400；JSON charset 可用，超限为 413。UUID 都转为小写；allow/deny、reason、mode、operation、scope、target_basis 与 command_hash 的组合由运行时 refinement 约束，OpenAPI 枚举不代表任意组合均可接受。例如 shell 必须带 command_hash，其他 operation 不得带；拒绝无效请求可用 operation/target_hash=null；破坏性操作不能报告会话/永久复用。测试包含这些联动失败场景。

首次 event_id 写入返回 201。服务端固定存 actor=cli、meta.version=1/client_reported=true，action 为 approval.<operation或invalid>，target 为 sha256:<target_hash> 或 null，decision 为 allow/deny；不存原始命令/路径正文。相同 ID 的规范化事件再次提交返回 200 和原 recorded_at，不新增行；字段顺序、UUID 大小写变化不影响幂等。相同 ID 的其他内容，或碰撞不兼容/平台/其他项目事件，返回固定 409，不覆盖原内容，也不泄漏已有载荷。

响应丢失可能发生在插入提交之后。若操作者明确重试审计回执，应保留完全相同的 event_id 和 payload，不要重新生成 ID，更不能重做底层工具操作。这不提供跨服务业务副作用 exactly-once。处理器响应 no-store；认证和处理器前传输错误遵守既有规则。

GET 严格拒绝未知查询字段。limit 默认 50、范围 1–200；offset 默认 0、上限 MAX_SAFE_INTEGER；数字字符串只接受十进制数字（可含前导零），空串、小数/指数/负号或不安全整数被拒。生成的 anyOf 表达数字/字符串形状，完整数值 refinement 仍由运行时执行。返回 items/limit/offset，没有 total 或 next_after；按数据库 `(ts,id)` 升序，不是跨页冻结快照。recorded_at 是服务端记录时间，以 JS 毫秒精度序列化，不是客户端决定时间。

读取仅选择 actor=cli、action 匹配 approval.% 且 meta 项目/client_reported/version 匹配的行，排除脱敏和其他平台事件。选中的历史行仍须通过事件 schema 和 actor/action/target/decision/ID 一致性检查；不兼容时整页固定 500，不静默省略，也不回显原始元数据。该接口与平台全局 audit-log 的历史兼容策略不同，不应混用。

真实 TCP + 独立测试 PG 的契约测试读取提交产物，用独立 Ajv 校验。执行事件/参数示例（替换成测试资源 UUID），验证逐字段落库、相同回执/8 路并发重试、碰撞不覆盖、项目隔离、毫秒显示与 `(ts,id)` 分页、无记录空页、严格参数和事件联动、敏感额外字段不落库/日志、401 先于解析/DB、413/415/429 和固定 500。测试只清理自有审计和项目，工厂 tripwire 保证零模型调用，没有读取真实 Provider 或付费服务。

本轮仍 Refs #24。回滚只撤销两个登记、Params 抽取和对应测试/文档，保留 #109–#115；平台审计查询、消息发送/SSE/取消、其余项目接口及在线 `/docs`/完整接入指南留后续。

## 平台审计查询契约扩展

新增 `GET /v1/audit-log`。原有 strict Query 原样抽取，事件字段复用现有 Platform/Redaction/CLI Approval 的 Zod 定义；输出用这些字段派生联合类型，并复用既有投影做一致性校验，不复制另一套元数据字段表。生产只消费输入 schema，未新增响应 serializer、写入或权限逻辑。两个审批接口与此处平台历史查询仍是不同的操作。

这是全局操作者查询，要求数据库和 Bearer，不要求主密钥；无数据库时路由不存在。actor/action/target 是允许的枚举或 UUID/hash 形式；未知查询字段和重复标量被拒。project_id 只匹配原始 meta.project_id 字符串，不检查项目是否存在，也不包含没有该字段的全局 Provider/flags 事件；它不是用户/项目成员权限边界。

日期规则与用量窗口一致：默认 to 为当前时间、from 为前 30 天，范围 `[from,to)`、跨度大于零且不超过 366 天；过滤时间最多毫秒、UTC 年份 0001–9999。limit 默认 50、范围 1–200；数字字符串可含前导零，不接受空串/负号/小数/指数。跨字段与日期 refinement 由运行时执行，OpenAPI 结构不完整表达。

按 `(ts,id)` 升序分页，after 必须指向同一筛选/窗口内的历史行，否则 404。游标从 PG 回查原始时间，保留微秒；响应 ts 也含微秒，不应套用输入过滤的毫秒上限。后续页复用已返回的 from/to，next_after=null 表示结束。每页单独查询，不保证跨页冻结快照。

已知平台事件、gate 脱敏摘要和客户端审批报告只公开既有安全投影。未知/损坏/不兼容/包络不一致的历史行仍保留 id/ts，但 actor/action/target/decision/meta 全为 null，metadata_omitted=true。SQL 在投影前限制 actor/action/decision 为 64 字节、target 为 128 字节，meta::text 超过 65536 UTF8 字节时同样省略；不是截断后返回半截内容。被省略的行仍占分页位置，也能作为游标。与项目 approvals 查询不同，这里不会因一条不兼容元数据就整页失败。

客户端必须尊重 metadata_omitted，不能将不兼容历史猜成成功动作；客户端报告不是工具执行证明，prepared 也不表示客户端已收到导出。该 GET 不写新审计、不改权限、不解析 Provider 或调用模型。路由 hook 在根鉴权/限流之后设置 no-store，较早拒绝沿用各自规则；普通 CORS 适用。它不是备份，也不证明现实中每个操作都已被记录。

生成过程中发现 OAS3 转换器会将普通 z.null() 变成无类型 nullable，归一化后无法保证 null-only；省略分支改用 z.literal(null)，生成 enum:[null]，让结构校验也拒绝任意内容。未改变全局 normalizer 或既有路径/组件。独立 Ajv 使用 JSON Schema 的数值 exclusiveMinimum/Maximum，而 OAS3 使用布尔标志配合 minimum/maximum；测试端只对 schema 位置的副本做等价转换，不修改提交产物或示例，单测验证端点仍严格排除边界。

真实 TCP + 测试 PG 使用提交产物和独立 Ajv，覆盖六种平台事件、脱敏和 CLI 报告、未知/损坏/大元数据/长 actor、所有省略字段为 null、微秒与同时间分页、opaque 游标、原始字段过滤、项目不存在但可过滤、日期/参数错误、鉴权先于 DB、429/固定500和无数据库404。测试校验省略分支无法携带秘密、count>0 不会被测试适配放宽；只清理自有审计 ID，无真实 Provider 或付费请求。

本轮 Refs #24。回滚撤销这个 GET 的登记、Query 抽取、既有 Redaction schema 导出及相应测试/文档，保留 #109–#116；消息发送/SSE/取消、其余项目接口和在线 `/docs`/完整指南留后续，#24 不关闭。

## JSON 消息发送契约扩展

新增 `POST /projects/{projectId}/conversations/{id}/messages`。输入 body 直接复用 shared/file-context 的 strict schema；路径 schema 只抽取原有 strip 对象、UUID 小写归一规则。输出从 shared/chat 及既有必填引用值字段派生，明确要求 `history_included`；不安装生产 response serializer，不修改消息、检索、提取或鉴权行为。该路径要求数据库和主密钥，缺一时路由不存在。全局 Bearer 操作者授权仍不等于项目成员身份；URL 项目与会话必须同时匹配，外国项目/缺失会话均为 404，作用域检查先于繁忙状态和 Evidence 准入。URL 查询字段忽略，普通 CORS 适用，非一概拒绝 Origin。

body 必须是 JSON 对象，`text` 为 1–8000 字符、不 trim；仅允许 `text` 和可选 `attachments`。附件为客户端声明的相对路径、文本和截断标记，不读取服务端文件。单内容最多 16 KiB UTF8、总量 64 KiB、至多 8 个文件及 8 个目录、总计最多 16 项；重复路径、敏感路径名、越界路径、非法 Unicode 和二进制控制字符会被运行时 refinement 拒绝。目录根路径 `.` 只可配 kind=directory。生成结构不完整表达字节数、路径及数量组合限制，结构通过不能代替服务器校验。

用户 text **原样存储和发送给 chat 模型**，不承诺本路径对它脱敏，勿提交凭据。文件正文/路径先走秘密模式扫描，再保存独立 tool Evidence、指向同物理会话的 user 消息，并写 gate 脱敏摘要审计；模型只见文件的脱敏文本。PROJECT_FILE 来源由可信写回路径重算，HTTP/模型不能以自报来源提升权威。固定黑名单/模式不是全部秘密检测，数据边界也不是 Prompt Injection 防护承诺。`truncated` 是客户端报告，服务器不会替客户端补全文件。

会话行锁内验证开放状态、继承历史与文件父引用，再原子登记用户/文件 Evidence 和持久提取 outbox。正式入口默认持久队列，库调用未配置队列时仍走旧进程内写回；`200` 不表示后续提取、Gate、索引已完成。检索可能调用计费 embedding，chat 可能调用计费模型，SDK 重试和后续提取还会新增调用。检索异常（含 embedding 日配额拒绝）降级为无记忆回答；`abstained=true` 描述检索结果，不保证 answer 为空或回答一定拒绝。

成功返回完整 `answer`、助手 `message_id`、`abstained`、`history_included` 与选中引用。引用 value 必填但可为任意 JSON（含 null）；助手消息仅持久保存版本 ID，响应包含本次选中引用正文。`history_included` 表示模型接收了历史。JSON 路径没有 SSE 的 generation_id、取消回执、显式生成超时或 no-store 保证，不能把断开 HTTP 等同于模型已停止计费。既有协调器允许 JSON 轮次相互重叠，不提供跨实例串行化。

准入后的模型/配置/保存错误可能返回 500，同时保留用户/文件 Evidence 和已入队任务，没有助手回答；并发归档也可能在模型成功后使保存返回 409。HTTP 令牌桶 429 (`RATE_LIMITED`) 在 body/DB/模型前拒绝；chat 日配额 429 (`MODEL_QUOTA_EXCEEDED`) 或不可用 503 (`MODEL_QUOTA_UNAVAILABLE`) 则可在 Evidence 已入库后发生，带 Retry-After/no-store。此外，既有错误处理器会保留不可重试 SDK 异常的 HTTP status；上游 400/401/403/422/429 等也可能在准入后出现。因此 `UNAUTHORIZED`/401 本身不证明是本地鉴权拒绝，其他已登记 4xx 也不一定来自本地校验。未单列的上游状态使用 default problem 响应；上游 4xx 的 detail 沿用异常 message，只有 5xx 固定隐藏详情，不承诺全部 Provider 4xx 文本安全。Provider 429/503 不保证 Retry-After，本地请求预算和本地模型配额路径才设置该头。契约如实记录旧边界，本轮不改写错误处理策略。

这不是安全重放凭证：相同 body 再发送会产生新消息和新 Evidence，没有幂等键，回执不明时不要自动重发。text/plain 被解析后因不是对象返回 400；坏 JSON 400、未知媒体 415、超限 413 沿用原规则。

自动化用提交 JSON + 独立 Ajv、真实 TCP 和独立 PG 执行文档 body 示例。只配置明显离线的测试 Provider 和 Mock V2；真实路由启用 durableExtraction，但故意不启动 worker，直接查表验证 Evidence、父引用、脱敏摘要、用量和 queued outbox，不能将排队冒充提取完成。另覆盖引用 null/结构值、历史、重复发送、检索降级、严格输入与运行时附件限制、项目隔离、坏历史、归档竞争、失败残留、两类配额、六种不可重试 SDK HTTP 错误、认证/请求预算先于 DB、413/415 和无依赖 404。全量运行显式置空付费评测 key，不接触真实 Provider。

本轮 Refs #24。SSE 发送、取消及在线 `/docs`/完整接入指南仍未交付，不能关闭 Issue。仅回滚本轮会撤销 JSON send 登记、Params 抽取和相关测试/文档，保留 #109–#117 契约及生成门禁；无迁移、依赖或真实部署变化。

## SSE 消息发送与取消契约扩展

新增 `POST /projects/{projectId}/conversations/{id}/messages/stream` 和 `POST /projects/{projectId}/conversations/{id}/generations/{generationId}/cancel`。输入规则只抽取原有 UUID 小写归一、strip 路径对象与 strict 空取消 body；消息 body 继续复用 shared/file-context。取消输出复用 shared 的三态回执，事件沿用 shared 的四个 strict 变体并要求引用 value 显式存在（任意 JSON，含 null）。没有新增生产 serializer、流式算法、预算、鉴权、迁移或依赖。

成功 SSE 的媒体为 `text/event-stream; charset=utf-8`，不是 JSON 数组、JSON 流或 `ChatStreamEvent` 对象响应。OpenAPI 3.0 没有标准的逐帧 SSE data schema 位置，因此文本 schema 上使用本项目扩展 `x-sse-event-schema`：它是从同一 Zod 生成并归一化的**内联事件 schema**，供测试和了解该扩展的客户端校验解析后的 data；不声称第三方 SDK 会自动支持。Redocly 不追踪扩展里的组件引用，最初注册的独立事件组件会被判 unused，因此改为内联，不禁用 lint、不伪造对象响应。

wire 帧为 `event: <type>\ndata: <一行 JSON>\n\n`，事件名必须等于 JSON 的 type。顺序为一次 start、零至多次 delta，最后 finish 或 error（仅在传输仍可写时）。start 中 version=1、conversation_id 等于 URL 会话，generation_id 全程一致；它也是本次助手消息 ID，finish.message_id 与它相同。将 delta.text 按序连接得到可见回答；模型文本中的换行会被 JSON 转义，不能注入 event 行。reasoning 不输出为 delta。没有 SSE id/retry、断点重放或 Last-Event-ID 续传；文档示例 wire 中的 UUID 只是离线示例，不是实际可取消对象。

项目与会话在登记活动生成前匹配，跨项目/不存在都为 404，不能探测 foreign busy 状态。同进程每会话只允许一个 SSE，活动 SSE 最多 32 个，并与旧消息/归档/续聊协调；不是跨实例锁。会话关闭、坏继承历史或坏文件父引用在 Evidence 准入前为 409。成功准入会原子写 user/文件 Evidence 与持久 outbox；文件、截断标志、来源权威和 user text 的边界沿用上一节 JSON send。HTTP200/start 只说明进入流，不证明模型成功或提取/索引完成。

start 在模型准备前发送。因此模型配置、SDK 错误、chat 日配额等准入后的错误，都在 HTTP200 内以 error 事件终止，不再改成 JSON401/429/503。`GENERATION_FAILED` 可以对应已保存、generation_status=failed 的可见前缀；`PERSISTENCE_FAILED` 表示不能确认助手保存成功。finish 的 status 只有 complete/interrupted，且在助手保存成功后发送。complete 表示当前实现接受 SDK 的正常终止，不限定 finishReason=stop，length/tool-calls 也可能正常结束；不要把它当成语义完整性的保证。检索失败仍可能降级为无记忆回答，abstained 描述检索而不是回答文本质量。

显式取消、HTTP 断开、服务停机或生成截止会尝试保存 interrupted 前缀，包括空回答。未收到终止帧的 EOF/本地 abort 是**未确认**，不能推断保存结果或停止计费；需另读会话或取得项目范围内回执。chat stream 使用 maxRetries=0，但 query embedding/后台提取有各自重试策略，仍可能产生费用。默认 300 秒截止从准入完成、创建流时开始，覆盖准备和模型收流，不覆盖前面的 SQL 准入；背压等待 30 秒会取消，另有截止加 30 秒的传输关闭保护，不是所有数据库等待的硬超时。delta 长度最多 16384 个 UTF16 code unit，单事件最多 128 KiB、可见文本及 text+reasoning 预算各 2 MiB，wire 预算 8 MiB 并预留终止事件空间；这些约束不全由 OpenAPI 字段表达。成功 SSE 有 no-store 和 X-Accel-Buffering:no，建立前的错误沿用原规则。

cancel 的 body 可以省略或为 JSON null（都归一化为 {}），提供对象时必须严格为空；查询字段忽略。text/plain 会被解析后拒绝 400，坏 JSON 400、未知媒体 415、超限 413 不变。URL 三个 UUID 都归一化为小写。若本进程有匹配的活动生成，先发取消信号并等待保存决定，再按项目/会话/assistant 消息匹配读取持久状态，不等下游终止帧消费。200 回执可能是 complete/interrupted/failed，generation_id=message_id；它是既有保存决定，不证明这次请求改变了状态，也不含回答或引用正文。完成后重复查询不新增消息、不调用模型。

未知/跨项目/非 assistant/旧的 generation_status=null 消息都是 404。活动生成保存失败时最初 cancel 可为固定 500；活动项释放后，同一 ID 后续可能只查到 404。取消也受全局鉴权和 IP/Token 请求预算约束，429 不会取消上游；回执失败不能当作已取消。当前回执无 no-store 或端到端 SQL 截止保证。多实例请求可能落到没有活动注册表的进程，不承诺分布式取消或进程崩溃后活动恢复。不要因回执不明自动重发原始聊天请求。

真实 TCP + 独立测试 PG 读取提交的 JSON，用独立 Ajv 校验每个事件/回执/错误，并用一个只支持服务器当前两行 LF 帧的测试解析器检查 wire；不使用共享生产 encoder/consumer 生成预期。离线 Mock V2 控制 delta/finish/SDK 失败，测试按事件驱动取消，不靠固定 sleep。覆盖文档 body/wire 示例、保存先于 finish、引用 null、文件脱敏与父引用/outbox、三态重复回执、busy/容量/项目隔离、正常 length/tool-calls 结束、配额与 SDK 错误在 SSE 内终止、失败保存、准备期取消、截止与断流、限流拒绝取消、输入/媒体/大小、认证先于 DB 和缺依赖路由。故意不启动 worker，queued 不冒充已提取；付费 key 显式清空。

本轮仍 Refs #24，在线 `/docs` 和完整三槽位/记忆 API 接入指南及最终覆盖盘点未完成，Issue 保持打开。回滚只移除这两项登记、输入 schema 抽取、对应测试和说明，保留此前全部契约与生成门禁；无真实部署变化。

## 在线只读参考页

服务现在提供 `GET/HEAD /docs` 与 `GET/HEAD /docs/openapi.json`。前者按操作分组展示参数、请求体、响应、示例和 Schema 索引；后者返回提交的契约原始字节。页面使用本地 HTML/CSS 与原生展开控件，不依赖 CDN、外部字体、浏览器脚本或文档服务，不接收 Token，也没有 Try it out、表单或自动 API 请求。

仅这两个**精确路径**的 GET/HEAD 公开，query 不影响内容。它们只是仓库已公开的静态契约，不展示实例 Provider、密钥、数据或实时可用接口；数据库/主密钥缺失时，契约里的部分业务接口仍可能未注册。工厂仍要求有效服务端 Token；其他路径、方法、编码变体与业务 API 继续按原规则鉴权。文档仍受 IP 桶限制，超限为 429/Retry-After；匿名文档不消耗认证 Token 桶。反向代理后共用 IP 的既有部署边界没有改变。

响应设置 no-store、nosniff、no-referrer；页面 CSP 禁止脚本、外部资源、表单和嵌入。所有契约文字与 JSON 在 HTML 中转义，URL/query/Host/Authorization 不参与页面生成。文档不是交互式客户端，勿将凭据放进 URL，也不要向页面粘贴真实 key。SSE 的逐帧扩展仍需客户端自行理解，不因有在线页面就获得自动 SDK 支持。

本地访问 `http://127.0.0.1:3000/docs`。现有 Caddy 部署同时支持 `https://<域名>/docs`、`https://<域名>/docs/openapi.json` 以及原 `/api/docs`、`/api/docs/openapi.json`；页面相对下载链接兼容两种前缀。仅精确 docs 路径反向代理到 server，未扩张其他业务路径。服务容器显式包含 `/app/docs/openapi.json`；源码与构建后的工作区按固定相对位置读取同一产物，不接受 HTTP 参数选择文件。

每进程启动时读取并缓存一份不可变契约和页面。运行 `openapi:generate` 后，需要重启服务才能更新在线内容；开发 watch 不保证感知工作区外的 JSON。缺失、损坏或不兼容的产物会以固定 `Documentation artifact unavailable` 拒绝启动，不降级为旧/空页面、不回显文件系统异常。HEAD 返回同一资源头部与空正文。

真实 TCP 测试在无数据库/模型访问的 tripwire 下验证公开只读访问、原始字节与提交契约一致、独立 Ajv 校验、HEAD/安全头、路径/方法负例、IP 与 Token 预算分离及业务鉴权不变。部署冒烟新增直接与 `/api` 前缀的页面/JSON/HEAD 断言，用隔离的 HTTPS 栈确认容器产物与代理路径。浏览器验证使用构建后的独立本地服务、假 Token、无 DB/Provider；不调用模型。

本轮仍 `Refs #24`。在线参考页已交付，完整中间件接入指南（三槽位、记忆 API、MCP 预告）、最终路由覆盖盘点和按指南走通仍留后续，不能关闭 Issue。回滚撤销文档路由/精确公开例外、容器静态文件与代理登记及本次测试；保留此前业务契约与门禁，无业务迁移或实例数据修改。

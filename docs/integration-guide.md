# 中间件接入指南

面向把 Mnemic 接入现有应用的开发者。本文对应仓库当前 HTTP API；[在线参考](openapi.md#在线只读参考页) 和提交的 [OpenAPI](openapi.json) 提供字段、示例与错误结构。无需先接入 CLI / Web，也不需要多语言 SDK。MCP Server 尚未实现，见文末预告。

## 1. 启动一个可用实例

按 [README Quickstart](../README.md#quickstart) 安装 Node / pnpm、PostgreSQL 17 + pgvector，准备数据库并执行迁移。全新库不能跳过迁移；`/health` 成功只表示 HTTP 进程存活，不表示数据库、模型或记忆已就绪。

服务端私密配置至少包括 `DATABASE_URL`、`MNEMIC_AUTH_TOKEN` 和 `MNEMIC_MASTER_KEY`。Token 为 32–256 位 Bearer 字符；主密钥为 64 位 hex（32 字节），用于服务端加密 Provider Key，需妥善备份，不能当成 Token 或轮换后指望自动解密旧数据。根据 `.env.example` 填写受保护的环境文件，勿提交真实配置。

```sh
pnpm install --frozen-lockfile
pnpm --filter @mnemic/server db:migrate
pnpm dev:server
```

迁移命令读取当前 shell 的 `DATABASE_URL`，不会因为复制了 `.env` 就自动加载它；启动的 dev 脚本会加载根 `.env`。执行迁移前确认 shell 已配置**同一个目标库**，不要在生产或测试库之间误操作。生产启动、HTTPS、备份和升级按 [部署指南](deployment.md)，不通过禁用鉴权解决连接问题。

在另一个可信 shell 设置 URL，并通过受保护的环境注入与服务端一致的 `MNEMIC_AUTH_TOKEN`，不要把真实值写进脚本、截图或仓库。原生默认只监听环回；Caddy 部署的业务 base URL 是 `https://你的域名/api`，本地示例则为：

```sh
mnemic_url=http://127.0.0.1:3000
curl --fail-with-body "$mnemic_url/health"
curl --fail-with-body "$mnemic_url/docs/openapi.json"
curl --fail-with-body -H "Authorization: Bearer $MNEMIC_AUTH_TOKEN" "$mnemic_url/v1/config"
```

只有公开健康检查、精确 GET/HEAD 文档路径与必要预检是例外，业务接口需要 Bearer。`/docs` 没有 Token 输入或 Try it out，不访问实例配置，也不能验证模型。单个 Token 是全局操作者权限，不是用户 / 项目成员权限；浏览器 CORS 配置不能替代它。

## 2. 配置 chat / extraction / embedding 三槽位

配置存在服务端加密库，客户端不自行保存模型 Key。支持 `openai-compatible` 与 `anthropic`；Anthropic 协议不能提供 embedding。chat 和 extraction 可用同一 Provider，也可分别配置。默认按创建时间 / ID 选择最早配置该槽位的 Provider，不是“最新配置覆盖旧配置”；最早候选损坏也不会静默改选后面的记录。

先 GET `/v1/config` 检查已有槽位，不要盲目重复创建。以下是**格式示例而非可连接的模型推荐**：先替换 URL、模型名和假 Key，再保存为仓库外、权限 600 的私密 JSON 文件。公开文档和测试只有离线假值。POST 成功仅表示配置加密落库，不表示 Provider 可用。

`provider-text.json`：

<!-- example:provider-text -->

```json
{
  "name": "integration-text",
  "protocol": "openai-compatible",
  "base_url": "https://text.example.invalid/v1",
  "api_key": "offline-example-key-replace-before-real-use",
  "models": {
    "chat": "your-chat-model",
    "extraction": "your-extraction-model"
  }
}
```

`provider-embedding.json`：

<!-- example:provider-embedding -->

```json
{
  "name": "integration-embedding",
  "protocol": "openai-compatible",
  "base_url": "https://embedding.example.invalid/v1",
  "api_key": "offline-example-key-replace-before-real-use",
  "models": {
    "embedding": "your-embedding-model"
  }
}
```

本版向量列为 1024 维，选择实际输出 1024 维向量的模型。设置 `MNEMIC_EMBEDDING_DIMENSIONS` 只校验部署预期与数据库列，不会调整模型输出或重建索引；适配器没有替任意模型自动协商维度。已有数据更换 embedding 必须规划 REEMBED / 迁移，不能原地 ALTER 或经 metadata PATCH 绕过保护。

下列路径由你替换为实际私密文件；不要把 Key 填到命令行 JSON、query 或共享日志里：

```sh
curl --fail-with-body --request POST "$mnemic_url/providers" \
  -H "Authorization: Bearer $MNEMIC_AUTH_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @/secure/provider-text.json
curl --fail-with-body --request POST "$mnemic_url/providers" \
  -H "Authorization: Bearer $MNEMIC_AUTH_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @/secure/provider-embedding.json
curl --fail-with-body -H "Authorization: Bearer $MNEMIC_AUTH_TOKEN" "$mnemic_url/v1/config"
curl --fail-with-body -H "Authorization: Bearer $MNEMIC_AUTH_TOKEN" "$mnemic_url/v1/doctor"
```

创建返回 201；名称重复为 409，不覆盖已有 Key。旧 GET/POST `/providers` 返回 Key 掩码，安全 `/v1/config` 不带 Key 或掩码；旧接口的 URL 元数据不做完整脱敏，配置 URL 中不要夹带凭据。PATCH `/providers/{id}` 仅支持受约束的元数据和 chat/extraction 槽位，不提供 Key 轮换或 embedding 修改，详见 [契约说明](openapi.md)。

GET doctor 不调用模型，模型项为 SKIP 不能当成连通成功。只有操作者明确接受费用时才 POST `/v1/doctor/probe`，JSON body 为 `{}`；它会真实调用槽位并可能计费，无需为本文的离线验证运行它。probe 与手动 recall 都拒绝任何 Origin，因此浏览器 Web 页面不能直接发这两个请求；请在受信服务端 / CLI 接入。其他业务接口按普通 CORS 与 Bearer 规则运行。

## 3. 准备项目，创建会话

**当前没有项目创建 HTTP API。** 使用已有项目 UUID，或由数据库管理员在专用演示库准备新项目。生成一个 UUIDv7：

```sh
pnpm --filter @mnemic/server exec node --input-type=module \
  -e 'import { uuidv7 } from "uuidv7"; console.log(uuidv7())'
```

把输出填入 `mnemic_project_id`；管理员 shell 的 DATABASE_URL 必须指向该实例，下面是会写数据库的显式初始化步骤。普通 API 客户端不获得数据库凭据：

```sh
mnemic_project_id='<新生成或已有的项目UUID>'
# 仅创建新项目时执行；已有项目跳过，不要重复插入。
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v project_id="$mnemic_project_id" <<'SQL'
INSERT INTO projects (id, name) VALUES (:'project_id'::uuid, 'integration-demo');
SQL
```

创建请求保存为 `create-conversation.json`，替换其中 project_id：

<!-- example:create-conversation -->

```json
{
  "project_id": "01900000-0000-7000-8000-000000000024",
  "title": "Integration guide"
}
```

```sh
curl --fail-with-body --request POST "$mnemic_url/v1/conversations" \
  -H "Authorization: Bearer $MNEMIC_AUTH_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @create-conversation.json
mnemic_conversation_id='<上述响应的id>'
```

成功状态是 **200**，不是 201。保留返回的会话 ID；`manual-corrections` 是保留标题，不能用于普通会话。带项目的路由同时匹配 projectId 与资源 ID，跨项目与不存在通常为 404；旧全局 ID 路由仍依赖全局 Token，不宣称项目成员鉴权。

## 4. 写入 Evidence，等待记忆产生

将下例保存为 `send-message.json`。这个接口是聊天入口，不是直接 upsert Belief；不要虚构 `/ingest` 或 `POST /beliefs`：

<!-- example:send-message -->

```json
{
  "text": "integration-demo database is PostgreSQL. Remember this project decision."
}
```

```sh
curl --fail-with-body --request POST \
  "$mnemic_url/projects/$mnemic_project_id/conversations/$mnemic_conversation_id/messages" \
  -H "Authorization: Bearer $MNEMIC_AUTH_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @send-message.json
```

返回完整 answer、助手 message_id、abstained、history_included 和 memories 引用。JSON 路径先保存用户 Evidence，再检索和调用 chat；模型失败也可能留下消息。**相同请求不幂等，不要因超时、断线或 500 自动重发。** 用户 text 原样入库 / 发给模型，不承诺准入脱敏，请勿发送凭据；附件的已知模式脱敏不等于完整秘密或 PII 检测。

正式服务把提取任务与 Evidence 一起落库，后台依次提取 → Gate → 去重 / Resolver → 异步索引；回答成功或 commit 的 `extraction_triggered` 都不表示记忆已可检索。候选也可能 SKIP / PENDING，因此不能仅以“模型回答了”断言写入成功。检查列表与来源；若暂未产生记忆，先核对任务 / 死信、槽位和 [队列边界](task-queue.md)，不要盲目重发原话。

```sh
curl --fail-with-body -H "Authorization: Bearer $MNEMIC_AUTH_TOKEN" \
  "$mnemic_url/projects/$mnemic_project_id/beliefs?status=active&limit=20&offset=0"
mnemic_belief_id='<选定记忆的id>'
curl --fail-with-body -H "Authorization: Bearer $MNEMIC_AUTH_TOKEN" \
  "$mnemic_url/projects/$mnemic_project_id/beliefs/$mnemic_belief_id"
```

列表默认 active，q 按字面查询 subject/attribute；列表支持分页，详情返回当前值、双时态版本链和每版来源会话 / 消息。保留引用 ID，不复制原始 Evidence 建立自己的第二份真相。生产模型的候选与回答并不确定，本文不承诺任何一条任意自然语言都必定通过 Gate。

## 5. 召回、修正、删除与恢复

`recall-memory.json`：

<!-- example:recall-memory -->

```json
{
  "query": "database"
}
```

```sh
curl --fail-with-body --request POST "$mnemic_url/projects/$mnemic_project_id/recall" \
  -H "Authorization: Bearer $MNEMIC_AUTH_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @recall-memory.json
```

手动 recall 可能发送查询给 embedding 并计费；只选本项目 active 的当前版本，最多五条 candidates，并持久化 query_text；候选轨迹只含引用 / 得分、不复制记忆正文。查询文本也会被存储，请勿在查询里放凭据或敏感内容。abstained=true 是没有达到证据阈值，不代表错误或允许编造；手动路关闭读时强化，不提高 confidence / salience。检索失败可能降级关键词，不保证向量调用失败一定是 HTTP 错误。

`correct-memory.json`：

<!-- example:correct-memory -->

```json
{
  "value": "SQLite"
}
```

```sh
curl --fail-with-body --request POST \
  "$mnemic_url/projects/$mnemic_project_id/beliefs/$mnemic_belief_id/correct" \
  -H "Authorization: Bearer $MNEMIC_AUTH_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @correct-memory.json
curl --fail-with-body -H "Authorization: Bearer $MNEMIC_AUTH_TOKEN" \
  "$mnemic_url/projects/$mnemic_project_id/beliefs/$mnemic_belief_id/resolutions"
curl --fail-with-body --request POST -H "Authorization: Bearer $MNEMIC_AUTH_TOKEN" \
  "$mnemic_url/projects/$mnemic_project_id/beliefs/$mnemic_belief_id/delete"
curl --fail-with-body --request POST -H "Authorization: Bearer $MNEMIC_AUTH_TOKEN" \
  "$mnemic_url/projects/$mnemic_project_id/beliefs/$mnemic_belief_id/restore"
```

修正走同步 Observation / Resolver 路径并保留版本和消解历史，不调用提取模型；不要提交秘密值，它不是通用脱敏入口。对已删除记忆修正返回 409，必须先显式恢复。delete 只做 active→deleted，移出默认检索；restore 只做 deleted→active，重复或其他状态为 409。软删除不清除证据 / 审计 / 历史，也不是“抹除所有副本”；硬删除传播是另一项能力。

结束会话时提交：

```sh
curl --fail-with-body --request POST -H "Authorization: Bearer $MNEMIC_AUTH_TOKEN" \
  "$mnemic_url/v1/conversations/$mnemic_conversation_id/commit"
```

会话已提交、正在生成或历史损坏可能为 409；`extraction_triggered=false` 也可能因为 Evidence 已处理。不要把任意 409 都当成提交成功；需读取会话的 ended_at 确认。续聊使用项目范围 resume 创建新会话、引用历史，而不是重新打开旧会话或重提取继承消息，见 [会话恢复](session-resume.md)。

## 6. 流式客户端与错误处理

需要边生成边展示时，POST 同一路径的 `/messages/stream`，仍发送上述 JSON body。HTTP200 是 SSE，不是 JSON 回复；读取 `event` 与 data.type、核对会话 / generation ID，连接 delta.text，只在 finish 或取消回执后确认保存。start 不表示模型或提取成功，error 事件发生在 HTTP200 内。generation_id 也是本次助手 ID；取消路径为 `/projects/{projectId}/conversations/{id}/generations/{generationId}/cancel`，body 可省略或为 `{}`。

可复用 `packages/shared` 的 `createApiClient`、`openMessageStream` / `cancelMessageStream` 与 `consumeChatStream`；仓库包是 workspace 私有包，**没有承诺可从 npm 安装**。其他语言按 [流式协议](chat-streaming.md) 自行解析，本项目的 `x-sse-event-schema` 不是通用 SDK 自动流式支持。EOF、客户端 abort、取消接口 429 或回执不明都不是保存 / 停止计费证明；不要自动重发原始消息。

统一错误为 `application/problem+json`，按 code 和结构化 errors 处理，requestId 用于关联日志。type 是稳定错误标识，不需要请求该 URI。注意 JSON chat 中上游不可重试 4xx 可能沿用 HTTP status / message，401 不一定是本地 Token 拒绝；不要据此推断没有写入或付费。429 区分请求桶与模型日配额，Retry-After 也不意味着非幂等操作可安全重放。5xx 不应回显内部异常，具体旧边界见 [契约说明](openapi.md)。

## 7. 契约覆盖与离线验收

提交产物覆盖当前完整配置下的显式 HTTP 操作。测试通过 Fastify 的 onRoute 捕获实际注册，与契约双向核对；只单独处理框架自动 HEAD 和 CORS 通配 OPTIONS，不把它们冒充新业务能力。未配置 DB / 主密钥的实例是子集，静态 `/docs` 不证明所有业务路由可用。生成结构也不完整表达跨字段 refinement、权限或跨页一致性，仍需读操作说明。

可在隔离测试环境运行本文的离线验收：

```sh
DEEPSEEK_API_KEY= DASHSCOPE_API_KEY= pnpm --filter @mnemic/server exec vitest run \
  test/openapi-route-inventory.test.ts test/integration-guide-http.integration.test.ts
pnpm --filter @mnemic/server run openapi:check
```

HTTP 用例读取本文标记的 JSON，实际创建加密配置、发送请求并以独立 Ajv 校验提交契约；真实测试 PG 执行 Evidence、EXTRACT / REEMBED、来源链、召回、版本修正及状态变更。模型仅用离线 Mock，不评估真实模型质量或账单，不运行计费 probe。测试在可控点主动驱动实际持久 handler，生产则由同进程 worker 调度；不会把 queued 冒充 done。测试保存 / 恢复全局配置，只清理自己的项目资源。

## 8. MCP Server 预告

MCP 适配层属于 [Issue #27](https://github.com/Weiki886/mnemic/issues/27)，目前没有可启动的 MCP Server、transport 地址或工具清单，也没有安装命令。未来会复用记忆 service 与确认 / 审计语义，不应通过重新实现一套记忆存储或伪装当前 REST 为 MCP 来接入。本指南交付的是现有 HTTP 中间件，不代表 MCP、VS Code 插件或 AGENTS.md 产品自动生成能力已完成。

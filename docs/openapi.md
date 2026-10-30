# OpenAPI 契约基座（#24 拆分 1/3）

当前生成的是**部分契约**：`GET/HEAD /health`、`GET/PUT /v1/config/flags`，以及统一 problem+json 错误结构。其他已实现 API 尚未登记，`/docs` 和完整中间件接入指南留后续 PR，本轮不关闭 #24。契约版本 0.1.0 表示本轮产物，不代表已发布仓库 Release 或完整 API 覆盖。

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

回滚本 PR 会停止契约生成门禁并恢复旧 type 输出；无迁移、业务数据修改、鉴权豁免扩张或真实服务部署。其余接口、在线页和完整三槽位接入文档仍需后续完成后才能关闭 #24。

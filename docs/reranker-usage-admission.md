# Reranker 调用准入与用量

这是 #9 / #22 的内部接线准备，依赖 [Score API 适配器](qwen-reranker-adapter.md)。
正式 chat / recall 尚未调用它，`reranker=true` 仍被管理 API 和运行时拒绝；不关闭 #9/#22。

## 唯一受计量入口

后续检索接线使用 `createMeteredQwenReranker(db, config, { admitModelCall, usageLogger? })`，
再调用 `rerank(input, { projectId, conversationId }, signal?)`。API 配置仍须由受信调用方显式提供；
没有环境变量读取、Provider 数据库读取、自动探测或默认端点。

- `admitModelCall` 必须显式传入，生产组装应复用现有 `createModelQuota` 返回的服务级准入函数。
  回调是受信依赖，不是新的远端权限凭证；传入 no-op 不代表已启用持久配额。
- 文本、版本 ID 和严格 UUID 作用域在首次等待前复制。未知作用域字段、缺少 conversationId
  或非法 ID 拒绝；项目级调用须明确传 `conversationId: null`。
- 非空批次先检查项目存在性及会话归属，再预留配额，最后调用 Score API。
  缺失/跨项目/作用域 DB 故障统一固定 `INVALID_RERANK_SCOPE`，不调用模型或预留配额。
  此处校验的是用量归属，不是项目成员鉴权，也不查询输入文档版本；后续检索仍须从已校验
  当前版本/项目作用域的候选取得 ID 和正文，不能信任客户端提供的候选内容。
- 空文档直接返回空结果，不查询 DB、不预留配额、不调用模型、不落用量；这不是一次成功推理。
- 已取消或在准入等待中取消的调用，不发送模型请求、不造 usage 行。准入已扣除的预算不退款。
  配额的 typed `ModelQuotaError` 保持原有 429/503 语义；其他准入异常统一为
  `RERANK_ADMISSION_FAILED`，不回显 SQL、取消 reason 或原始异常。

## 一次请求，一条记录

一批最多 200 个候选，只对应一次 Score API POST / 一次配额预留 / 一条用量记录。
适配器不重试。传输失败、无效响应、超时记 `error`；调用期间取消记 `aborted`；完整通过
响应校验记 `success`，不代表排序质量或客户端已使用记忆。

`model_usage` 记录：

- `slot = reranker`、`purpose = rerank`；这是**用量类别**，不是第四个 Provider 配置槽位。
  `ModelSlots` / `resolveModel` 仍只接受 chat / extraction / embedding。
- `provider_name = qwen-score-api` 是固定逻辑传输标签，不能区分真实供应商、账户或端点。
  `model_id = Qwen/Qwen3-Reranker-0.6B` 是本适配器固定的协议模型回声。
- project / physical conversation、开始时间、单调耗时；耗时从配额后发起适配器开始，到调用
  完成或失败，排除前置作用域校验、配额等待和后置遥测写入。
- prompt/completion/total 只接受上游报告的安全非负整数。零保留，未知为 NULL；total 不按
  输入输出加总。reasoning/cached-input 没有协议来源，始终 NULL。
  响应未完整通过校验时不采信其中局部 usage，全部为 NULL。

不新增正文/端点/凭据/原始响应/原始异常列。写入沿用白名单仓储；只有固定 pino 告警
`model usage persistence failed`。数据库或 logger 故障不重放调用，不替换成功结果或原始固定错误。
记录失败、进程退出可能缺行，仍不承诺财务级可靠性或补账。

适配器的 timeout 覆盖 Score API 传输与解析，不覆盖 DB 作用域检查、配额预留或遥测持久化。
和已有普通模型用量一样，完成路径等待遥测写入；取消首先由适配器转发上游，再等待遥测。
数据库卡住仍可能延后包装器返回。超时、取消及记录均不能证明供应商停止推理或停止计费。

## 查询、估价及兼容性

现有项目/会话/时间报告和 CSV/JSON 导出能读出 reranker 类别。金额仍由显式价格配置计算：
可为固定逻辑 provider/model/slot 设置费率，必须由操作者确认适用于所选端点。未配置价格，
或所需输入/输出 token 未报告，则未估价；即使缺失输出在精排里常见，也不擅自补零当免费。
按请求/文档计价的服务不适用当前按 token 估价公式；不内置或抓取供应商价格。

OpenAPI 的 UsageExportPage 中 `slot` 枚举增加 `reranker`，没有新增公开操作或改变其他字段。
旧版严格枚举客户端在导出包含新类别时会拒绝响应，应先升级使用该契约的客户端；报告分组键
本来是字符串，不需要新筛选参数。本轮 CLI/Web 复用更新的共享解析契约，不改变 UI 或命令。

## 迁移、回滚与验收边界

0018 仅替换 `model_usage_slot_check`，不新增列、不回填、不修改历史行。
单个 DO 语句在同一事务内替换约束，可重放；ALTER TABLE 会取表锁并扫描已有记录，
大表应在维护窗口迁移，生产接线前必须先迁移。Drizzle snapshot 只改变这条 CHECK。

回退本轮代码会停止使用此入口；应保留拓宽后的 CHECK 和历史记录，不删除 reranker 行，
不强行恢复三类别 CHECK。旧版导出服务也会拒绝含新类别的行，因此产生此类记录后，
应保留支持新类别的共享契约/用量读取版本；不能把整个旧版 API 回滚说成无条件兼容。

测试使用真实 PG17 和独立本地 HTTP/离线 fetch。配额测试用独立连接的临时计数表，
不清空或重置现有公共日配额。覆盖作用域拒绝、配额失败/不退款、取消、未知 token、批次计数、
依赖/输入 mutation、SQL/日志失败、迁移旧 CHECK 升级/重放和真实鉴权 HTTP 导出契约。
没有读取真实 Provider 或环境文件、没有付费请求、真实 Qwen 推理、默认开启、生产检索接线或指标验收。

本 PR 堆叠在仍待审查的 #132 分支上。合并顺序为先 #132，再将本 PR 移到 main 并复验；
本轮开发不代表任一 PR 获得合并授权。

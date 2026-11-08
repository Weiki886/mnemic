# 当前版本有效时间过滤（#9 部分交付）

现有 `retrieval_time` 开关已接通，可通过鉴权的 `/v1/config/flags` CAS 更新启用，默认仍为 false。
它是当前版本上的过滤条件，不制造独立“时间票”，不做自然语言时间理解、历史版本回退或 #10 的定时失效任务。
实体检索已独立接通（见 [实体召回](runtime-entity-recall.md)）；Reranker/衰减/读时消解继续被管理 API 与运行时拒绝，#9/#22 不关闭。

## 语义与冻结点

开启时所有分数来源共用以下条件：

```sql
bv.recorded_to IS NULL
AND bv.valid_from <= :validAt
AND (bv.valid_to IS NULL OR :validAt < bv.valid_to)
```

保留已有 project/current_version_id↔belief_id/active 条件。时间窗口左闭右开；即使过去存在适用版本，
若当前版本尚未生效或已到 valid_to，也不回退历史。不是 recorded-time as-of 查询。

普通调用在操作入口捕获一次服务器 UTC 时间，先于读配置和查询嵌入；SDK 等待期间时钟或配置改变不改本次点。
受信内部实验可传 `RetrieveOptions.validAt`，只接受有效 UTC Z ISO（年 0001–9999、小数最多6位），
原始字符串在首次等待前校验并复制，未经 Date 重新序列化就绑定为 timestamptz，保留 PostgreSQL 微秒。
非法时间以固定 `INVALID_RECALL_TIME` 在 DB/模型访问前拒绝，即使时间开关关闭也会校验显式畸形选项。

开关关闭时显式 validAt 不参与查询，默认检索行为不变；开启但未传 fusion 时仍使用原 A0 引擎，
只增加有效时间过滤，不引入实验池上限、权重变化或更短的查询长度限制。
显式融合继续使用 #128 的候选池和规则，RRF/weighted 及 #129 的预算可叠加相同过滤。
过滤不改变查询嵌入重试/计费策略；向量关闭仍不调用查询嵌入，两路全关仍返回拒答并留 trace。
默认读取不改信念/版本/强度，显式强化例外沿用既有开关。

## 轨迹与兼容

新增 nullable text 列 `retrieval_traces.query_valid_at`，记录**实际应用**的 UTC 查询参数，避免 timestamp 的
JS Date 驱动转换丢失微秒；不是另一个事实时间字段。拒答/空池也记录该点。关闭时为 null；旧行保持 null，
不从 created_at、当前时间或默认开关伪造过去的查询参数。

该列是服务端轨迹元数据，公共 Recall DTO 不新增键，旧 strict 客户端的响应形状保持兼容。
HTTP 请求仍仅接受 query，不能通过 body 覆盖 validAt、flags 或融合策略。
OpenAPI 只更新 flags PUT 的未支持字段清单；路径、组件和其他操作保持不变。

## 迁移、发布与回滚

本轮包含 `0017_retrieval_query_time.sql`、journal 和 snapshot，只增加可空 text 列，无默认、回填、重写或删除。
升级顺序必须是：

1. 保持 retrieval_time=false，先执行 `pnpm --filter @mnemic/server db:migrate`。
2. 确认迁移成功后部署新代码。新代码读写 trace schema，不能在缺新列的库上运行。
   仓库 Compose 继续依赖 migrate 服务成功后才启动 server；不得绕过这层顺序。
3. 先保持关闭验证普通召回与队列健康，再经 GET 获取 revision、PUT 启用时间开关。
   通过一个已知有效/一个已知过期事实验证结果，并检查新 trace 的 query_valid_at/flags_snapshot。

ADD COLUMN 仍需要表锁：选择无长事务的维护窗口，并用迁移会话的 lock_timeout 限制等锁，
超时则停止发布、处理锁等待后再重试。没有生产大表锁等待耗时的实测结论；本 PR 不执行真实部署或生产迁移。
SQL 的 IF NOT EXISTS 只支持重复应用，不承诺修复同名但类型错误的手工 schema。

回滚时**先用当前 revision 的 CAS PUT 关闭 retrieval_time，再切回旧代码**：
旧版 captureFeatureFlags 会拒绝 true，直接回滚代码可能导致检索降级/写回任务失败。
如果已回滚，旧版 GET/PUT 仍可把 time 修为 false；不清空整个配置、不倒退 revision。
保留新列和已记录的时间点，不回退迁移、不 DROP 数据；旧代码可忽略该 nullable 列。
若启用后已知有效事实意外拒答、5xx/检索降级或队列失败增加，先关闭开关恢复原路径，再检查时间、区间和锁等待。

## 验证范围

真实 PG 覆盖两种引擎、向量/关键词、端点与微秒、项目/当前/删除/历史约束、空池留点、
显式和默认时间冻结、RRF+预算、非法参数先拒绝、整行无修改，以及长聊天查询兼容。
迁移在真实临时表上保留旧行并重复应用；HTTP 测试经真实 TCP 鉴权 PUT→recall，独立 Ajv 校验提交的 OpenAPI 响应契约。
测试均用离线模型；未运行付费模型、#12 指标、真实部署或生产大表 DDL 压测。

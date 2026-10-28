# 特性开关配置（#22，拆分 1/3）

本轮仅交付配置契约、版本化持久化和变更审计。Refs #22，不关闭 Issue。
**应用尚未读取这份配置，修改它不会关闭或开启现有业务。** 未开放配置 HTTP API、CLI/Web 管理入口，
未向 retrieval_traces / resolution_traces 写快照，也不宣称已满足开关矩阵的运行时验收。
行为接线、认证 API 与实际使用的 trace 快照由后续 PR 完成；#9/#10 的业务仍由各自 Issue 实现。

## 作用域与契约

沿用 #42 的服务端全局配置作用域，不做按用户灰度。`feature_flags` 的 owner 是 flags；
UUIDv7 主键、唯一 scope='server' 保证最多一行。迁移 0013 插入初始配置，重放 SQL 不重置已修改的值。
没有新环境变量、依赖或 provider 配置，也不在读取失败时自动补默认值。

共享单源是 `@mnemic/shared/flags`，严格拒绝未知字段、缺失键和字符串/数字形式的布尔值。

| 开关                    | v1 默认 | 业务归属            |
| ----------------------- | ------- | ------------------- |
| retrieval_vector        | true    | #6/#9 向量路        |
| retrieval_keyword       | true    | #6/#9 关键词路      |
| retrieval_entity        | false   | #9 实体匹配         |
| retrieval_time          | false   | #9 时间过滤         |
| memory_gate             | true    | #15 准入判定        |
| decay                   | false   | #10 衰减任务        |
| reranker                | false   | #9 重排             |
| authority_resolution    | true    | #5 权威消解         |
| read_time_resolution    | false   | #9/#12 读时消解变体 |
| read_time_reinforcement | false   | #6/#12 读时强化实验 |

默认值描述未额外配置实验环境时的基线。未来模块的开关默认关闭不代表模块已经实现；
本轮也不接管已有 `MNEMIC_READ_REINFORCE` / `RetrieveOptions.reinforce` 路径。
十个布尔量互不绑定，契约可表达全部 1024 个组合；表达配置不等于已经执行相应消融。
后续关闭 Gate 仅影响 WRITE/SKIP/PENDING 判定，不能绕过 Secret 脱敏或来源权威边界。

```ts
// 完整快照，可序列化；schema_version 是契约版本，revision 是配置修订号。
{ schema_version: 1, revision: 0, flags: { /* 上表全部十项布尔值 */ } }
// 内部更新输入：完整替换，不做含糊的部分覆盖。
{ expected_revision: 0, flags: { /* 上表全部十项布尔值 */ } }
```

revision 为 0 到 Number.MAX_SAFE_INTEGER 的整数，PG bigint CHECK 同样限制该范围，
避免 JavaScript 精度损失。快照及其 flags 都是冻结的独立副本；调用方在 await 期间修改输入不改变待提交操作。
未知契约版本、不完整数据库行或缺失单例会拒绝读取，不能把损坏配置当成有效默认值。

## 内部仓储与审计

- `readFeatureFlags(db)` 返回冻结快照，不写库、不产生审计。
- `updateFeatureFlags(db, {expected_revision, flags})` 先同步校验并复制输入，再在事务中锁住单例。
  revision 不一致返回 `{kind:'conflict', snapshot}`，不会覆盖新配置或写审计。
  值完全相同返回 `unchanged`，不增加 revision、不伪造修改记录。
- 实际修改增加 revision 并更新 updated_at，返回 `updated`。若 revision 已耗尽则拒绝修改。
- 同事务写入 audit_log：actor='server'、action='flags.update'、target='server'、decision='updated'，
  meta 只有 schema_version、previous_revision、revision 以及完整 before/after 布尔映射。
  actor 表示当前应用写入方，不声称识别具体操作人员；后续 API 必须先经过既有鉴权。
  审计写入失败或外层事务回滚，配置与审计一起回滚；无重试、静默降级或原始异常日志旁路。

PG CHECK 同时限制单例 scope、契约版本、安全 revision、十个键齐全且无扩展字段、每项为布尔值。
SQL 迁移是冻结历史，初始种子与共享默认值的完整一致性由集成测试验证，不依赖维护者手工记住。

## 后续接线要求

运行路径必须在明确的操作边界冻结一份配置并传递给实际行为及 trace；不能在每阶段重新读取而混用 revision。
本轮的配置快照仅是可用的数据结构，**不是当前检索/消解已经使用它的证明**。
trace 的历史行不应以新默认值补写，未实现模块也不能靠开关状态伪造行为。
仅完成行为停用测试、retrieval/resolution 快照断言及 #12 矩阵接线后，才可以关闭 #22。

## 验证与回滚

共享测试覆盖严格契约、全部组合及快照隔离。真实 PG 测试覆盖原始 SQL 重放、八路同 revision 竞争、
无变化/旧 revision、调用方中途改对象、审计失败/外层回滚、新连接读取、CHECK/唯一约束、revision 耗尽及缺失配置。
不调用付费模型、不重启用户服务。配置没有运行时消费者，回滚本轮应用代码可保留新增表；
不要通过清空单例或重放种子来重置已修改配置。

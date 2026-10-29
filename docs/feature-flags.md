# 特性开关（#22，拆分 1/3 + 2/3）

已交付严格配置、持久化/审计，以及五项已有行为的接线：向量路、关键词路、Gate 评分、数值权威裁决、读时强化。
retrieval_traces / resolution_traces 新记录保存实际使用的配置快照。Refs #22，不关闭 Issue。
**尚未开放配置 HTTP API、CLI/Web 管理入口**；内部仓储不是权限边界。
实体/时间/衰减/Reranker/读时消解业务仍归 #9/#10，不能用配置状态冒充已实现。

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
兼容旧 reinforce env/options 的具体优先级见下文。
十个布尔量互不绑定，契约可表达全部 1024 个组合；表达配置不等于已经执行相应消融。
关闭 Gate 仅绕过评分/准入判定，不能绕过 Secret 脱敏与其审计；value/subject/attribute 和 entities 标签均脱敏。
旁路结果是 WRITE、scores=null，不伪造评分或创建 PENDING。既有 PENDING 的显式 retry 同样可旁路评分，
只标 promoted，正式写入仍由其消费方负责；本轮没有新增自动调度器。

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

## 运行时冻结边界与优先级

`captureFeatureFlags(db, options)` 是受信内部入口，拒绝非法/可空伪造快照，并复制冻结其值。
HTTP 或模型输出不能设置 flagsSnapshot；现有输入契约仍拒绝额外开关参数。

- 检索在查询嵌入前读取一次。向量关闭时不调用查询嵌入，关键词关闭时该 CTE 为空；两路全关会拒答并留 trace。
  写入侧的派生向量索引不随检索路开关停止，便于重新开启后召回。
- 旧进程内写回与持久 EXTRACT 均在每条物理 Evidence 的提取模型调用前冻结一次，随后所有候选、
  Gate、ingest、Resolver 共用；模型等待期间全局配置改变，不改本次决策或 trace。
  不同任务尝试可读到新 revision，不承诺跨重试固定整场实验；#12 仍需锁定实验配置。
- 直接 processCandidate/ingestCandidate/resolveObservation 各自在入口冻结一次，或沿用受信上游传下来的快照。
  关闭数值权威裁决只跳过 higher/lower 的胜负分支，仍执行 Intent/Temporal/Conflict；
  原始 source_type/authority/reliability 不改写，诊断中的原始权威比较信息仍保留。
  ASSERT 冲突及非用户 RETRACT 的 Intent 拦截不因权威开关关闭而放行。
- 强化的有效优先级：已冻结的 flagsSnapshot > 显式 reinforce 参数 > 已设置的旧 MNEMIC_READ_REINFORCE > 持久配置。
  为兼容旧语义，环境变量只有字符串 '1' 表示开启，其他已设置值表示关闭；未设置才读配置。
  该覆盖在读取配置前捕获，最终布尔值会写回本次完整快照及 reinforce_enabled。
  revision 标识基础持久配置修订，flags 则是包含受信覆盖的实际生效值，不能只靠 revision 复现实验。
- 手动 recall 固定 reinforce:false；即使全局开启也不强化。响应的 trace.flags_snapshot 提供实际快照，
  shared schema 拒绝与该只读约定矛盾的快照。消解历史 API 以 camelCase flagsSnapshot 返回，兼容旧服务器字段缺失。

当前不支持启用 retrieval_entity/retrieval_time/decay/reranker/read_time_resolution；内部配置可以表达它们，
但记忆操作入口检测到 true 会以固定错误拒绝，在查询嵌入/提取调用和记忆写入之前停止，不能静默当成已运行。
聊天仍沿用既有“检索失败→无记忆回答”降级：可能继续调用聊天模型、保存聊天消息，这不是整个聊天请求的计费关闭开关。
这可能让待提取任务退避、最终进入死信；修正配置不会自动重置既有死信。后续管理 API 必须阻止不受支持的启用。
既有未配置的路径没有降级到默认值：缺失/损坏配置同样拒绝执行。

## trace 快照与历史

迁移 0014 只增加两个可空 flags_snapshot jsonb 列，无默认值、无历史回填；null 表示未知，不能当作当前默认。
新检索（含拒答）保存完整快照；新消解的普通/ignore/retract 分支均沿用该次操作快照。
created 不是消解，SKIP/PENDING 也不强行制造 resolution trace。显式自定义 no-op writer 仍可不落库。
DbResolutionTraceWriter 不重新查配置；旧内部调用若未提供快照则保留 null，避免把后来配置套到旧决策上。
Resolver 新增受控 authority-off 分支，算法版本升为 0.2.0。
快照只含 schema_version、revision 和十个布尔值，不含正文、凭据或模型输出。

## 验证与回滚

1/3 覆盖配置严格性、1024 组合、CAS/事务审计/迁移重放。2/3 用离线模型和真实 PG 验证路线停用的
零查询嵌入调用、关键词排除、强化与 trace 一致性、Gate 旁路保留脱敏、权威裁决旁路且 Intent 仍有效，
以及模型调用中改变全局配置时旧写回/持久 worker/检索都使用已冻结值。
历史列保持 null，新增列 SQL 可重复执行；没有调用付费模型或重启用户服务。
回滚应用代码可保留新增列，不能通过默认回填或清空配置来伪造历史。
配置管理 API 和未实现模块的行为验收尚未完成，#22 保持 OPEN。

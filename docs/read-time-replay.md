# 读时消解的只读重放基座

#9/#22 的部分交付，采用已确认的历史 Observation 重放方案。本轮仅提供内部只读入口
`readReadTimeReplay(db, { projectId, beliefId, beliefVersionId, authorityEnabled })`，不接聊天、
recall、正式启动器或管理能力门控，`read_time_resolution=true` 仍拒绝。没有模型调用、写入、
新表、迁移、环境变量或公开契约变化；不能据此关闭 #9/#22 或宣称完整读时消解验收。

## 来源与完整性

调用方须传已召回的版本引用。单条 SELECT 同时验证：Belief 属于项目且 active，版本属于
该 Belief、仍被 current 指针引用、recorded_to 为空，其 source Observation 同项目、同
subject/attribute。不满足返回 null，不从历史复活 deleted/retracted/expired 或非当前版本。

仅取这一组同项目、同 subject/attribute 的完整历史 Observation，按 PostgreSQL 原始
recorded_at、id 升序重放。排序在 SQL 中保留微秒；不先把时间转成 JS Date 再排序。
每条 Evidence 经消息→会话重新核对项目，损坏的组内引用整体拒绝，不能凭 JSON/外键就信任归属。
其他组/项目不参与。锚点与所有证据共享一条 MVCC 语句快照，不额外加行锁。

最多200条，查询第201条作为超限哨兵；超过即整体拒绝，不把截断历史当作完整重放。
value 的 JSON 文本单条最多16KiB、总计64KiB，嵌套深度最多32；SQL 已在返回前省略过大的值
并报告错误，重放不会接受该 null 占位。任意合法 JSONB 标量/数组/对象/null 均可参与。
边界限制输出与本地比较成本，不保证数据库的组查找/排序/JSON尺寸计算是常量成本；未压测大表。

## 重放语义

`replayObservationGroup` 只接收同组、无重复 ID、完整且有序的事件，复制输入后计算；不修改
调用方对象。源读取器提供原始数据库顺序，纯函数保留等毫秒事件的输入次序，不重新排序 UUID。

- 首个非 RETRACT 事实建立本地值，对应写入路径创建 Belief 的阶段。
- 后续先走既有 AssertionIntentPolicy，再复用 classifyValues 和 decideRelation，
  保留 strengthen/weaken/extend/supersede 及人工修正保护；authorityEnabled 只跳过数值权威胜负。
- 使用创建时保存的 authority，不让模型重新申报权威。validTime 为 null 时使用 recordedAt。
- 用户来源 RETRACT 清空本地值；普通 ASSERT 不复活，显式 UPDATE/CORRECT 可重新建立；
  Agent RETRACT 被忽略。strengthen/weaken 只记录决定，不提高持久 confidence/evidence_count。
- 复用现有 Resolver 的 Date 时间比较口径（毫秒精度），不冒充完整微秒有效时间消解。
  当前没有 valid-time 查询点、历史 as-of 或基于旧版本 valid_to 的时间窗口过滤。

结果包含真正选中的 observationId、evidenceId、value 和 validFrom，及只含 ID/动作/关系/固定
原因的 decisions。anchorVersionId 仅是准入锚点，**不是替代结果的版本 ID**。不能把新值标在
该版本 ID 下送给旧 Recall DTO 或消息引用；后续生产接线必须扩展来源契约并明确投影。
decisions 不存正文，不写 resolution_traces/retrieval_traces；模型和日志都没有调用方。

## 验证与发布

纯规则测试覆盖四态、意图保护、权威消融、撤回/重新修正、空值、输入隔离和超限拒绝。
真实 PG 测试覆盖 active/current/项目/来源归属、微秒排序、200/201边界，并对整个 Belief、
版本、Observation 与两类轨迹的前后快照逐字比较，验证没有业务副作用。

内部准备能力默认无生产消费者，无需配置或迁移；回滚直接移除代码。历史不完整或损坏时
固定错误拒绝，不回显正文/SQL异常，不宣称已生成可用回答。后续接线前仍须验证模型上下文、
引用来源、开关冻结/关闭与 trace 语义，再开展 #12 真实指标和消融。

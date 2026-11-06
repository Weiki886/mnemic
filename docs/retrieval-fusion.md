# SQL 融合基座（#9，第一切片）

本轮只新增内部 `buildRankFusionQuery()`：对调用方已经提供的候选分数关系生成纯 SQL SELECT，支持 RRF / 加权两种模式。**尚未接入 retrieve()**；现有两路加权检索、拒答阈值、API、trace、默认开关与运行时行为保持不变。没有实体 / 时间召回、Reranker、读时消解或 Token 预算实现，不能据此关闭 #9 / #22。

后续按小 PR 接入：项目内当前 active 版本的实体 / 时间候选及四路查询；可关闭的 Reranker；不落库的读时消解；按 salience 降序、recorded_from 新者优先的 Token 预算及截断轨迹。完整矩阵 / 指标由 #12 消费，不以本轮 SQL 用例替代指标验收。

## 输入与 SQL 组合

调用方先定义 CTE：

```text
recall_scores(
  belief_version_id uuid,
  route text,                 -- vector / keyword / entity / time
  score double precision
)
```

再把 builder 返回的 SELECT 拼到该 WITH 之后。CTE 是当前 SQL 语句提供的关系，不是新增持久表；函数不接受可变表名 / SQL 字符串，也不执行查询、访问数据库或构造模型。示意：

```ts
const query = buildRankFusionQuery({
  mode: "rrf",
  flags: effectiveSnapshot.flags,
  k: 60,
  perRouteLimit: 200,
  maxCandidates: 200,
});
// Caller supplies recall_scores in the SAME statement, from its own authorized recall paths.
const result = await db.execute(sql`WITH recall_scores AS (...) ${query}`);
```

省略号表示尚未接线的上游召回，不是可直接运行的 API 示例。真实 PostgreSQL 测试使用完整 VALUES CTE，独立手算预期。

flags 直接校验 shared 的完整十键 `FeatureFlagsSchema`，只读取其中四个 retrieval_* 开关。调用方应传同一次操作捕获的受信快照，不接受 HTTP / 模型自报配置。此函数接受实体 / 时间布尔值，**不代表生产 captureFeatureFlags 已支持开启它们**；现有运行时仍拒绝未实现字段，管理 API 不变。

输入只接受普通内部配置对象。mode / flags / 上限 / 权重均严格校验；非法值同步抛固定 INVALID_FUSION_OPTIONS，不附输入或原始 Zod 错误。参数在生成时由 Zod 复制并绑定，调用方之后改对象不改变已生成 SQL。没有第二份环境配置、持久开关或公共 DTO。

## 处理顺序与公式

全部候选处理在 PostgreSQL 内完成，没有 JS 排序 / 合并：

1. 拒绝空版本 ID、未知 / 空路名、NULL / NaN / ±Infinity 分数及关闭的路。负的有限分数是分数，不当作缺失；语义是否足以回答由后续检索判定。
2. 同版本、同路多条记录取**最佳有限分数**；必须在 max 之前剔除 NaN。不同路的同一版本合并投票，各路至多一次。
3. 每路按 score 降序、版本 UUID 升序做 row_number，排名从1开始。并列分数按 UUID 打破，不使用 dense_rank 共享名次；不依赖来源行顺序 / 执行计划。
4. 每路只保留前 perRouteLimit，之后才融合。两种方法使用相同的去重、排序和裁剪池：
   - RRF：`sum(1 / (k + route_rank))`。k 为1..1000整数，默认60只是实验起点，不是 #12 校准结论；排名不受单路分数等比例缩放影响。
   - weighted：`sum(route_weight * route_score)`。调用方必须提供 vector / keyword / entity / time 四项权重，均为0..1有限值，总和与1的偏差不超过1e-9。**不重新归一化关闭路的权重**；如 vector0.7 / keyword0.3 时关闭向量，关键词1仍贡献0.3。权重0不等于关闭路，候选可存在但贡献0；要移除该路必须关闭对应 flag。
5. 融合分降序、版本 UUID 升序输出，最多 maxCandidates 条。components 按 C collation 路名排序，便于确定性比较。

RRF 和 weighted 产生可比较的结果形状，**不保证相同候选次序**。例如 A 的向量分0.99，B 的向量分0.01且关键词分0.01：RRF 中 B 得到两路投票，weighted0.7/0.3中 A 优先。对照数据需固定同一来源池、flags、上限和其他参数，不能把本模块的有界 weighted 说成当前 A0 全量扫描的位级等价实现。

SQL 用 numeric 运算 / 汇总，不通过 float8 累加把极端输入算成 Infinity；fused_score 是 PostgreSQL **numeric 文本字符串**。各路原始分数仍是 float8 近似值，numeric 不恢复此前丢失的浮点精度，循环小数也按 PostgreSQL numeric 除法精度返回。未来 HTTP 适配必须定义转换 / 合法范围，不能不经校验直接 Number()。components 只含 route、rank、score、contribution；结果仅有 belief_version_id、fused_score、components，没有证据正文 / 候选值副本。

## 边界与接线责任

- perRouteLimit 为1..200整数，默认200；maxCandidates 为1..800整数，默认200。四路各200最多800个不同版本。两项上限独立，默认参数不代表生产 Top-K、Reranker 或 Token 预算已确定。
- **输出有界不代表扫描 / 排序成本有界**：窗口排序前可能扫描上游全部输入。正式召回路径仍须限定每路输入池、索引和资源预算；本轮不承诺大数据查询性能。
- 上游负责项目隔离、current_version 与 belief 归属、active 状态、valid_from / valid_to、实体来源以及输入分数归一化口径。本 SELECT 不查这些业务表，也不修复损坏引用；不能把知道版本 ID 当作授权。时间查询理解仍为 B 阶段非目标。
- 模块不调用模型，所以 SQL flags 仅保证对应分数不参与；真正“关闭后零模型 / 查询调用”需要在上游执行前门控，后续接线测试再验。
- RRF 默认k60时四路最高约4/61，不能沿用 A0 的0.3拒答阈值。拒答策略、分数校准、salience、Reranker 与预算在各自阶段明确，不把投票高说成证据充分。
- 没有 trace 写入 / 内容快照 / 读时强化 / 版本更新，也没有开启未实现的运行时 flag。查询可在 read-only 事务执行；未增加迁移、依赖、HTTP 或客户端入口。

## 验证与回滚

真实 PG VALUES CTE 测试覆盖手算 RRF / weighted、分数尺度变化、并列、重复、非有限值、16种开关组合、最大800项及裁剪、参数捕获和 read-only 执行。纯配置测试覆盖边界与非法值，不访问数据库 / 模型。本模块与现有 retrieve() 没有调用边，原检索行为继续由原套件验证。

回滚移除 fusion.ts、对应测试和本说明即可；无数据 / schema 回退。#9 的实体 / 时间 / Reranker / 读时消解 / Token预算 / 轨迹和 #22 完整消融矩阵尚未完成，Issue 均保持打开。

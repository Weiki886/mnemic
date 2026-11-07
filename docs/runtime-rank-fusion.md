# 运行时融合实验（#9 部分交付）

`retrieve` 新增受信内部选项 `fusion`，把 #125 的 SQL 融合和 #126 的候选查询接入真正的检索与轨迹写入。
HTTP body 没有新增可控制算法、系数、阈值或 flags 的字段；聊天、手动 recall 的默认调用不改变。
本轮只连接已经受支持的向量/关键词源，未解锁实体/时间、Reranker 或读时消解开关，#9/#22 保持打开。

## 运行方式

内部调用示例（使用既有 `db`、`masterKey` 和 `projectId`，不是新增 HTTP 参数）：

```ts
await retrieve(db, masterKey, projectId, "PostgreSQL", {
  topK: 5,
  fusion: { mode: "rrf", k: 60, threshold: 0.015 },
});
await retrieve(db, masterKey, projectId, "PostgreSQL", {
  topK: 5,
  fusion: {
    mode: "weighted",
    weights: { vector: 0.7, keyword: 0.3, entity: 0, time: 0 },
    threshold: 0.3,
  },
});
```

示例阈值仅用于展示调用形态，不是 #12 校准结果。RRF 的分数量级与 A0 加权分不同，
**每次显式融合必须提供自己的 threshold**（有限 number、0–1）；不继承默认 0.3。
不能同时传顶层 `threshold`，避免两处控制源。实验路径的 topK 为 1–200 的整数。

系数、k、perRouteLimit、maxCandidates 复用 `RankFusionOptionsSchema`，只移除受信 flags 字段并增加必填阈值。
四项系数仍须各在 [0,1] 且总和为 1，关闭的路线不重新归一化；当前实体/时间不开启，不产生投票。
每路上限默认/最大 200，总候选默认 200、最大 800（当前两路最多 400 个不同版本）。
所有实验参数在第一次异步等待前校验/复制，未知字段或非法值抛固定 `INVALID_RUNTIME_FUSION_OPTIONS`，
不先访问数据库或调用模型；未传 fusion 时保留原路径的既有行为与边界。

## 数据与一致性

嵌入在 SQL 之前执行，使用既有 embedding 槽位、用量/配额/取消适配器，不新增模型或第四槽位。
向量关闭时零查询嵌入调用；失败/零向量/非有限值/错误维度降级为关键词，不自动重放旧检索路径。
实验路径只使用**本次选中的 modelId** 的索引；其他模型的向量不会混入。
底层已记录的向量行不能证明供应商版本或配置未变，既有 REEMBED 边界仍然适用。

评分 CTE 与内容投影在**同一条 SELECT** 内执行，共享 PostgreSQL statement snapshot，
不在两次查询之间出现“评分旧当前版本、读取新当前版本”的窗口。
project ID、current_version_id↔belief_id、active、recorded_to IS NULL 都被约束；历史、删除及跨项目引用不会返回。
本查询只读，不改变版本、置信、证据数或 salience；外层 `retrieve` 仍正常落检索轨迹，显式强化实验沿用原开关语义。

- 关键词沿用 simple/plainto 的 AND 语义，按匹配内最大值归一化。
- 向量沿用 cosine，输入安全归一化，重复索引取最佳有限分。
- SQL 对每路独立排序/截断后融合，版本 UUID 是最终稳定次序。
- SQL numeric 分数在内部保留文本，返回既有 DTO 时显式转成 number；不冒充任意精度 HTTP 数值。
- 拒答仍是最高分门槛：最高分不足则整体拒答；通过后取 topK，不是每条独立阈值。

未显式传 fusion 时不会走候选池上限、模型过滤和 recorded_to 过滤这些实验规则，保留原 A0 路径，
便于 #12 做真实对照；两条路径之间的这些差异应计入实验配置，不能只把差异归因于 RRF 公式。

## 轨迹与边界

每个被评分候选在 `retrieval_traces.candidates` 内保留既有 ID、vectorScore、keywordScore、fusedScore、selected、reason，
并额外写 `rankFusion`：mode、k 或 weights、threshold、池上限及各路 rank/score/contribution。
这些是 ID 与决策数据，不复制 subject、attribute、value 或 Provider 凭据。
返回调用方的候选 DTO 没有增加 rankFusion 字段；公开 recall 契约和已提交 OpenAPI 不变。

**空候选池的 candidates 仍是 []，不能从这个空数组反推算法配置。**
实验消费方需要用返回的 traceId 关联自己提交的配置；本轮没有新增 trace 元数据列或全局实验运行表。
flags_snapshot 只记录当次有效开关，不用于塞入算法选项或改写历史。

SQL/轨迹写入异常向调用方传播，不尝试第二次付费嵌入或静默改用旧算法。
既有聊天上层仍可能按“检索失败→无记忆回答”降级，这不等于整个聊天请求不计费。

现可叠加[运行时记忆块预算](runtime-context-budget.md)，将 #127 的裁剪与舍弃原因落轨迹；真实模型对应分词器尚未提供。
Reranker、实体/时间的生产输入策略、读时消解替代候选来源及 #12 指标对比仍待后续。
同项目 subject+attribute 唯一且默认只召回当前版本，因此不能把“对单个当前版本套 Policy”伪称为读时冲突消解实验。

## 验证与回滚

离线 SDK Mock + 真实 PG 验证 RRF/weighted 排序差异、阈值拒答、原路径兼容、模型过滤、
项目与当前版本约束、禁用/失败降级、参数变更隔离、池上限、只读事务及单语句读取。
未跑真实付费模型，没有指标提升声明。回退本 PR 即恢复原实现，无迁移/配置回滚。

# 受信内部检索的 Reranker 实验

#9/#22 的部分接线：显式内部 `retrieve` 选项现在可在融合候选上运行
[已计量的 Qwen Score API](reranker-usage-admission.md)，然后执行 Top-K 和既有 Token 预算。
正式 chat/recall 没有该配置来源或参数，管理 API 仍拒绝 `reranker=true`；默认值仍 false。
默认开启、生产配置接入、真实 Qwen 指标与读时消解仍未验收，不关闭 #9/#22。

## 调用条件

内部调用者同时提供：

- `fusion`：已有 RRF 或 weighted 配置，含它自己的 threshold，maxCandidates 不超过 200。
- `reranker`：显式 `{ endpoint, apiKey?, timeoutMs? }`，遵守 [协议适配器](qwen-reranker-adapter.md) 的规则。
- 明文 `reranker` 要求完整受信 `flagsSnapshot`；[持久 Provider 绑定](persisted-reranker-binding.md) 可省略快照并在操作入口读取持久开关。其中 `reranker` 为 true 才运行精排。
- `admitModelCall`：生产组装应复用服务级持久准入，不是 no-op。测试可注入离线计数器。

缺 fusion、明文配置缺显式快照、缺准入函数或候选上限过大，均在 DB/模型调用前拒绝为
`INVALID_RUNTIME_RERANK_OPTIONS`。显式提供的配置即使开关关闭也先校验；格式错误不是静默忽略。
配置、准入方法、signal、用量归属在操作入口捕获，快照由现有机制复制冻结。
等待查询 embedding 期间修改调用者对象，不能更换本次端点、凭据、准入方法或开关状态。

没有新环境变量、Provider 配置槽位、公开请求字段、API 或迁移；需已应用 #133 的 0018 迁移。
这不是一个远端用户可申请的能力授权。`captureFeatureFlags` 仅为持有有效内部绑定的本次
检索接受 reranker 能力；它不打开配置，不放行 decay/read_time_resolution，不改变管理侧拒绝列表，
其他消费者的未支持开关检查仍然有效。

## 排序与拒答顺序

1. 冻结本次开关，在原有 SQL 中按项目/current/active/recorded_to 及可选 valid 时间过滤。
2. 使用 RRF 或 weighted 产生有界融合池。正文和评分仍来自同一 SELECT 快照。
3. 原融合最高分未达到其阈值，或池为空，则拒答且不调用精排、不预留配额、不造 usage。
4. 对完整候选池构造 `memoryContent` 格式的文档，实际调用一次受计量 Score API。
5. 按返回排名重排候选，原 fusedScore 与分路评分保留，再取 Top-K。
6. 若显式提供 memoryBudget，继续按 salience 降序、recorded_from 新者优先打包 Top-K；
   所以最终上下文顺序可以不同于精排顺序。只强化最终入选的信念，默认仍不强化。

精排只排序，没有新增未经校准的 Qwen 拒答阈值；零分也是有效排序分，不自动代表拒答。
不发送 SQL 池以外的历史/跨项目/非当前候选，不用精排补回未召回事实。
候选是 SELECT 时刻的快照，不承诺远端推理等待期间数据库变更后自动再召回。
字节/基数超限时不截断或拆批；本轮回退到原融合顺序。

## 故障、取消与计费

传输失败、无效响应、超时或输入超限是可选增强失败：保留原融合顺序，写固定失败码。
配额耗尽/不可用、其他准入错误、用量归属错误、显式取消则直接拒绝，不伪造成功检索轨迹，
不尝试另一个模型或自动重试。查询 embedding 和 Score API 各自预留调用预算、各自记录用量。
关闭精排后，没有新增 Score API 请求/配额/usage，既有检索仍可完整运行。

入口、精排前后、最终预算后/轨迹派发前检查已捕获的取消信号，拒绝已观察到的取消。
轨迹 SQL 已派发之后的取消不承诺原子撤销已完成的写入；这也不是供应商停止计费的证明。
遥测、Scope 和配额 DB 等待仍不包含在 Score API timeout 内；详见用量文档。
超时回退可能增加一次调用预算且 token 未报告，不能把 fallback 当作未花费。

## 轨迹与兼容

不改变公开候选 DTO、OpenAPI 或表结构。仅内部 `retrieval_traces.candidates` 的每项增加
`reranker` 元数据（开关关闭时不出现）：

- `status=applied`：固定模型标签、score、rank。
- `status=failed`：固定模型标签及 INVALID_RERANK_INPUT / RERANK_FAILED /
  RERANK_INVALID_RESPONSE / RERANK_TIMEOUT 之一。
- `status=skipped`、`reason=below_threshold`：池非空但融合拒答，未调用模型。

原 rankFusion、entityMatch、memoryBudget、selected/reason 和 flags_snapshot 同时保留。
不复制候选正文、query、凭据、端点或供应商原始元数据到 candidates。空池仍为 []，仅快照表明
开关开启；不虚构一次调用或应用结果。`rank` 保留精排位置，预算后的最终位置见 memoryBudget。
模型回声不是权重/模板证明，服务配置与真实质量仍需在后续实验中单独核对。

回退本 PR 可移除内部绑定，公开行为不变；仍保留 0018 的扩展 CHECK 与历史用量，不能恢复
旧三类别读取契约。没有改动线上配置，也没有触发真实付费请求或重启用户服务。

验证使用真实 PG17 和独立临时端口 HTTP 服务，覆盖两种融合、四路/时间 16 组合、作用域、
关闭路径、真实用量记录、失败回退、配额/取消拒绝、快照与配置 mutation，以及精排后预算/强化。
真实 Qwen 推理、供应商账单与 #12 指标不在本轮验收中。

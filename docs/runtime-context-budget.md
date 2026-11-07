# 运行时记忆块预算（#9 部分交付）

`retrieve` 可在显式 SQL 融合实验后调用 #127 的 `packMemoryContext`，并将舍弃版本及原因写入
`retrieval_traces.candidates`。不增加 HTTP 参数、环境变量、依赖、迁移或默认开关。
未传 memoryBudget 时，原 A0 路径及 #128 的融合实验行为不变。

## 内部调用

```ts
await retrieve(db, masterKey, projectId, "PostgreSQL", {
  fusion: { mode: "rrf", threshold: 0.015 },
  topK: 5,
  memoryBudget: { maxTokens: 1024, countTokens },
});
```

`countTokens(text): number` 必须由可信调用方提供，且与**最终聊天模型的同步分词器**一致。
示例不提供伪造的字符/字节计数；本轮没有模型对应的 tokenizer 适配器或自动解析聊天模型的功能。
该选项用于受信服务端编排和实验，不能经 HTTP 请求、模型输出或文件选择回调。
普通 chat/recall 尚未自动启用预算，#9/#22 不关闭。

- memoryBudget 只可搭配显式 fusion，不能偷偷切换原 A0 算法。
- maxTokens 为 0–1,000,000 的整数，countTokens 必须为函数；严格拒绝未知字段、null 等畸形配置。
- 数值和函数引用在首次异步等待前校验、复制，调用方在 SDK 等待期间替换字段不改变本轮。
- 非法配置抛固定 `INVALID_RUNTIME_MEMORY_BUDGET`，先于数据库和模型访问。
- 计数必须同步；错误、非整数、负数或异步返回均拒绝，不估算、不接受部分结果。
  对意外返回的 Promise/thenable 处理其拒绝，防止操作已失败后再触发未处理拒绝；不会等待或接受异步计数。
  计数器必须是可信本地函数，此处理不能取消其自行启动的外部副作用。

## 处理顺序

1. 原有来源开关和冻结快照 → 查询嵌入 → 同语句评分与正文读取。
2. 最高融合分门槛；通过后按融合分取 topK，形成**本次候选上下文清单**。
3. 在这个清单内按 salience 降序、完整 `recorded_from` 微秒新者优先、UUID 升序排序。
4. 只接纳预算内的完整优先级前缀；首个超限条目及其后缀均舍弃，不跳过大条目去放更低优先级的小条目。
5. 返回最终选中上下文，落轨迹；若显式开启强化，只强化最终入选项。

salience 只决定候选清单内的预算优先级，不替代召回/融合评分；清单外仍为 below_topk。
阈值、topK、池上限与预算是不同阶段，#12 对比时需分别固定，不能把预算当成全库按 salience 检索。

元数据与评分/正文来自同一条 SELECT：salience 从 PG numeric 显式转换为 float8，null 保留最低优先级；
`recorded_from` 用 UTC `to_char(...US...)` 保留六位小数，不先经过 JS Date 丢失微秒。
不用 confidence、importance、valid_from 或 Observation 时间替代它。未知/非法元数据整体失败，不默认为零。

内容格式由 `memoryContent` 与 `renderMemoryContext` 共享，预算计数包含实际编号、分隔符和空记忆标记。
这只覆盖**记忆块**，不包括 system 规则、历史、用户消息、文件、聊天模板及输出预留，不能当作完整模型窗口保证。
调用方修改返回候选内容后必须重新计数。单条 16KiB、总 64KiB 等限制沿用[纯预算模块](retrieval-context-budget.md)。
资源超限、空块也放不下、计数失败时不写部分检索轨迹；查询嵌入可能已经发生，不自动重试或改走旧算法。
既有聊天上层仍可能按检索失败降级为无记忆回答；不宣称整个请求零计费。

## 返回和轨迹

返回的 candidates 只包含最终入选项，排列顺序与实际提示词编号一致，既有 DTO 不增加 salience/时间/计数器。
如果本来有相关候选但预算全部舍弃，返回 candidates=[]、abstained=true，trace 也记录 abstained=true。
默认关闭强化时，不修改 belief / belief_versions / confidence / evidence_count / salience / importance。

原 trace JSONB 候选保留 ID 和分量得分。预算参与的 topK 条目增加：

```json
{ "memoryBudget": { "maxTokens": 1024, "tokenCount": 987, "contextPosition": 1 } }
```

contextPosition 从 1 开始，舍弃项为 null；tokenCount 是最终整个记忆块的计数，不是该条的独立 token 数。
舍弃项 selected=false、reason="token_budget"；未被 topK 考虑的项仍为 below_topk，且无 memoryBudget 字段。
原始查询阈值拒答仍是 below_threshold。trace 先排列最终入选项，再保留其他项的融合顺序；
rankFusion.components 中仍能查看各路排名，数组次序不能再解释为纯融合分次序。

不保存正文、完整 prompt、计数回调、凭据或原始异常。公开 HTTP recall 仍没有该实验参数，
提交的 OpenAPI 和默认响应保持不变；将来公开预算实验轨迹时须扩展契约，不能直接套旧 reason 枚举。
当没有候选或查询阈值已拒答、未形成 topK 清单时，没有逐候选预算元数据；
实验消费方仍需用 traceId 关联提交配置，沿用 #128 的空池边界。

## 验证与回滚

真实 PG + 离线受控计数器验证优先级、微秒/NULL、与真实 chat prompt 相同文本、严格前缀、
最终拒答、舍弃原因、TopK 边界、计数失败不写部分轨迹、配置变更隔离、完整行不变和最终项强化。
意外异步回调的进程级回归验证固定错误后不会使 Node 因未处理拒绝崩溃。
这些测试验证算法和接线，不冒充某个模型的分词或账单验证。

回滚本 PR 即可，不需要迁移/重置配置。实体生产输入、Reranker、真实 tokenizer 适配、
读时消解的替代候选来源、完整消融矩阵与 #12 指标仍待后续；时间过滤见 [运行时文档](runtime-time-filter.md)，#9/#22 保持打开。

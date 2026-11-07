# Memory context Token 预算（#9 部分实现）

本模块提供纯内存裁剪，不调用模型、数据库或日志器。它与 #125 的融合、#126 的候选查询分别可测；
现已通过[运行时预算实验](runtime-context-budget.md)接入显式融合 `retrieve`，舍弃 ID/原因写入 `retrieval_traces`；普通 chat/recall 和真实 tokenizer 适配仍未自动接线。
`Refs #9`，不代表 Token 预算验收已完成；#9、#22 继续保持打开。

## 输入与计数

`apps/server/src/retrieval/context-budget.ts` 导出 `packMemoryContext(input, countTokens)`：

- `input.maxTokens` 是记忆块的非负整数预算，上限 1,000,000。
- `input.candidates` 最多 800 条，包含唯一 `beliefVersionId`、`salience`、`recordedFrom` 和预渲染的 `content`。
  ID 统一为小写；重复 ID 整体拒绝。`salience` 为 [0,1] 的有限 number 或 null，不接受 numeric 字符串。
  将来数据库适配器需先明确转换 PG numeric，不能用 confidence 或 importance 替代 salience。
- `recordedFrom` 必须是有效的 UTC ISO 时间（年 0001–9999、可带 1–6 位小数）。
  保留 PostgreSQL 微秒；不能先经 JS Date 丢掉后三位精度。
- `content` 非空、单条不超过 16 KiB UTF-8，总和不超过 64 KiB；不截断正文凑限制。
  非法 Unicode 孤代理、NUL、未知字段和超限输入整体拒绝，且不调用计数器。
- `countTokens` 是**可信调用方提供的同步分词器**，必须对应最终使用的聊天模型。
  没有默认字符数估算、字节数估算或额外计费调用。返回值必须是非负安全整数；失败或非法值只抛固定错误，
  不回显正文或分词器异常，不返回部分结果。输入在首次回调前完成校验和复制。

计数对象是完整渲染后的**记忆块**：`[1] 内容\n[2] 内容`，包括编号和分隔符；空块为 `（无相关记忆）`。
每一步重新计算整个候选前缀，不把独立条目的计数相加，避免分词边界误差。
共享的 `renderMemoryContext` 也用于既有聊天 system prompt；提示词文本保持不变。

此预算不包含 system 指令、历史、当前消息、文件、聊天模板或输出预留，不能冒充模型总上下文窗口限制。
SDK 返回的 usage 是调用后数据，也不能用于这一轮调用前的裁剪。

## 优先级与输出

按以下顺序排序，不改变调用方数组：

1. salience 降序；null 排在所有数值之后（包括 0）。
2. `recordedFrom` 降序，比较完整微秒精度，等值小数补齐到 6 位。
3. 版本 UUID 升序，保证同分同时间的结果稳定。

只接纳**完整优先级前缀**。当下一条加入后超过预算，该条和之后全部舍弃；
即使后面有更短、能单独放下的条目，也不能越过高优先级条目。
不拆正文、不重排成背包优化，不假设分词计数随文本长度严格单调。等于预算时允许接纳。
空块本身的计数也必须在预算内，否则抛 `MEMORY_BUDGET_TOO_SMALL`，不宣称返回了预算内的提示词。

成功输出：

- `text`、`tokenCount`：最终记忆块及实际回调计数。
- `selectedIds`：按提示词编号顺序排列的版本 ID。
- `discarded`：只含 `beliefVersionId`、`reason: "token_budget"`，不包含正文、得分、分词异常或凭据。

`text` 是业务 prompt 正文，**不能整体写入日志或轨迹**；后续轨迹接线仅持久化 ID/原因等元数据。
`INVALID_MEMORY_BUDGET_INPUT`、`MEMORY_TOKEN_COUNT_FAILED`、`MEMORY_BUDGET_TOO_SMALL` 均为内部固定错误，
没有新增 HTTP 错误码或接口。

## 验证与后续

测试使用明确标注的离线计数器，覆盖优先级、微秒、nullable salience、精确预算、前缀阻断、
非加法计数、输入变更隔离、资源上限、异常脱敏，以及共享渲染前后的提示词逐字一致性。
这些测试验证裁剪算法，不声称验证任何真实模型的分词器或账单。

#9 后续仍需模型对应的计数适配器、默认聊天集成、Reranker、只读消解，以及 #12 的对比数据。
显式实验的真实候选水合、运行时裁剪与舍弃记录落库见运行时预算文档。尚未解锁 #22 中未支持的开关，现有默认行为保持不变。

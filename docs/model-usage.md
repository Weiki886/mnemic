# 模型用量记录（#36，拆分 1/3）

本轮交付服务端记录基座：迁移 0011 新增 `model_usage`，三槽位 `resolveModel`
统一包装模型实例，在实际调用 SDK provider 时记录。仅解析配置不会产生记录。
后续 PR 交付项目/会话/时间聚合、CSV/JSON 导出、显式价格配置及 CLI/Web 展示；本轮不关闭 #36。
后续已实现的读取与估价口径见 [用量查询与导出](usage-reports.md)。

## 口径

一行对应一次 provider `doGenerate` / `doStream` / `doEmbed` 调用。
SDK 传输重试、提取 JSON 校验后的反馈重试均各自计一行，不能把失败尝试漏掉，
也不把高层 HTTP 请求或 batch 数量冒充模型调用次数。embedding SDK 拆批时按实际底层调用记录。

- 记录配置中选定的 Provider 名、模型名、槽位、用途、开始时间与单调时钟耗时（毫秒）。
- 用途区分 chat、extraction、embedding_query、embedding_index、probe。
- prompt/completion/total/reasoning/cached-input token 仅接受模型报告的非负安全整数。
  缺失、非有限、负数、非整数均为 `NULL`；有效的零保留为零。
- total 保留 provider 原值，不能假定等于 prompt + completion。embedding 只有输入 token，
  completion 为 NULL，total 与其报告的输入量相同。缓存 token 是输入的子集，不额外相加。
- `success` 表示 provider 调用正常结束，不表示提取 schema 合法、回答质量或最终消息已保存。
  流未收到 finish 就 EOF 或出现 error 为 `error`；中断为 `aborted`。
  错误/中断仍产生调用记录；未得到用量不估算为零，也不声称 provider 已停止计费。
- 费用单价受 Provider/模型/时间/缓存策略影响，本轮不内置或猜测价格，不输出费用数字。
  这些记录是后续估算的基础，不能替代服务商账单。

## 归属与数据边界

实际聊天归属本次物理会话；续聊使用新会话，不把加载的历史重复算成旧会话调用。
提取归属 Evidence 消息所在物理会话；索引 embedding 从版本→来源 Observation→Evidence 查询归属。
手动召回只属于项目，没有会话。诊断 probe 没有项目/会话，单独标记 probe；普通 doctor
仅解析配置无调用记录。内部直接使用槽位但未提供业务作用域时保留 NULL，不擅自猜测归属。
写入器校验 conversation/project 配对，跨项目归属拒绝入库；HTTP 入参不能指定用量上下文。

只保存上述计数与引用。没有提示词、回答正文、附件、向量、凭据、base URL、原始异常或
provider 响应快照。选定 Provider/模型名以调用时配置为准，配置后续修改不重写历史。

遥测写入在正常完成路径被等待；流式中断会尽快启动一次写入。记录失败只输出固定告警
`model usage persistence failed`，不输出 SQL/异常内容，不触发模型重试或改变既有成功回答。
这是可用性取舍：数据库故障或进程崩溃可能导致缺行，本轮没有持久队列补偿，不能承诺财务级不丢账。
未增加公开用量 API，后续查询必须先执行既有鉴权与项目作用域校验。

## 验证与范围

真实 PG 测试断言字段、归属、NULL、负值约束和迁移重复执行；真实 HTTP JSON/SSE 链路断言
聊天、检索、后台提取和索引均落记录。离线本地 HTTP provider 验证 SDK 503 重试单独计数。
单测覆盖流式完成/error/不完整 EOF/取消、计数缺失和遥测失败不重放付费调用；
直接取消在遥测写入挂起时仍立即转发给 provider，不等待数据库才请求上游停止。
测试模型与 HTTP 端点均为离线夹具，模型 key 显式置空。

统计范围是服务端三槽位运行路径；`scripts/spike`、手工 `verify:providers` 和测试直接构造的
SDK 模型不经生产槽位，不纳入项目用量。本轮不改变这些诊断脚本，也不主动调用真实模型。
回滚代码可停止新增记录，表中历史可以保留，不需要删除 Evidence 或更改现有对话数据。

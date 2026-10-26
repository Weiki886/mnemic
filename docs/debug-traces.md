# 调试轨迹（#37，拆分 1/3）

本轮交付服务端结构化元数据轨迹，以及应用日志的敏感信息边界；Refs #37，不关闭 Issue。
完整脱敏 prompt/模型生成文本捕获、客户端查看，以及其他记忆操作入口的接线归后续 PR。
不把内容复制到派生表，不新增数据库表、依赖、公开 debug API 或 Tools 执行器。

## 开关与输出

在服务端环境或 .env 中设置 `MNEMIC_DEBUG=1`，由现有启动入口读取；默认0/未配置时关闭。
仅接受0/1，其他值启动时以固定提示拒绝。Docker compose 转发该可选变量。
这是部署操作者的选择，HTTP 请求不能打开调试。没有修改或重启已运行服务的自动动作。

开启时应用 pino 强制使用 debug 级别，以便轨迹不会被默认 info 级别丢弃；此时优先于 LOG_LEVEL。
仅设置 LOG_LEVEL=debug 不会开启轨迹。关闭时事件接收器不检查传入内容、不调用日志输出。
当前只记录元数据，不是 Issue 要求的完整 prompt/原始模型输出功能。

每个事件由应用 pino 输出为单行 JSON，字段包含 `ts / event / target_id / detail`，
另有标准的 level/time/pid/msg 等字段；msg 固定为 `memory debug trace`，level=20。
可用现有 JSONL 工具按 msg 筛选。启动器可能额外输出普通文本，不能把 pnpm/tsx 全部 stdout
都当作纯 JSONL；应用轨迹本身始终是结构化 JSON 行，没有日志文本拼接。

| event                       | target_id           | detail                                              |
| --------------------------- | ------------------- | --------------------------------------------------- |
| memory.retrieval.completed  | retrieval_traces.id | 项目、可选会话、命中/入选数、拒答与强化开关         |
| memory.extraction.completed | 源 Evidence 消息 ID | 项目/物理会话、尝试/候选/丢弃数、是否降级           |
| memory.gate.decided         | 源 Evidence 消息 ID | 项目、WRITE/SKIP/PENDING、可选 pending ID           |
| memory.write.completed      | 源 Evidence 消息 ID | 项目、四路分流、Observation/Belief ID、消解关系     |
| memory.write.failed         | 源 Evidence 消息 ID | 项目、失败阶段 extraction/gate/ingest，不记录原异常 |

检索成功在持久化 trace 与可选强化完成后输出；写入完成在 ingest 与 embedding 钩子返回后输出。
失败事件不表示回滚：例如 Observation 已落库而索引失败，需沿 Evidence ID 查询已有结果。
提取降级是明确的 extraction.completed(degraded=true)，不会伪造写入成功。
同一条消息多个候选会有多个 gate/write 事件；这不是重复 Evidence 或新增佐证。
当前覆盖 JSON/SSE 聊天、commit/resume 写回与手动 recall；不声称已覆盖人工修正、
PENDING 生命周期、Resolver 所有分支或尚未实现的工具调用。完整得分与消解决策仍以原有
retrieval_traces/resolution_traces 为事实源，调试事件只存引用和计数。

## 安全与可用性

事件 schema 严格限定 UUID、枚举、布尔和非负安全整数，拒绝额外字段；没有任意 detail 对象
穿透、prompt、query、candidate/value、原始响应、URL、凭据或异常消息/堆栈。
校验失败或日志器异常会丢弃调试事件，不改变记忆/聊天结果、不触发模型重试；不再向其他
日志回退原对象。关闭时不读取事件对象，日志器收到的是校验后的副本。

普通访问日志仅记录请求方法、地址和经已知 Secret 模式过滤的路径；不记录查询值。
请求头只保留 authorization/cookie/x-api-key 的固定脱敏标记，其他头不序列化，
避免未知凭据头绕过正则。携带已知 Secret 模式的 x-request-id 改为生成 UUID。
未捕获异常与后台写回回调只记录固定消息/状态，不展开 SDK/SQL 异常、请求体、响应或堆栈。
既有普通请求 ID 与 problem+json 响应语义保持。

这不是完整 PII 或未知密钥检测：路径及请求 ID 的检测沿用 #15 已知模式，
不能把凭据放进 URL、请求 ID 或其他业务标识。应用无法承诺第三方库、启动器、数据库自身
输出的任意文本经过同样处理。操作者仍需管理 stdout 的收集、保留与权限。
调试日志不是持久审计：进程/输出目标故障可丢事件，没有事务回滚或队列补偿保证。

## 验证与回滚

单测覆盖默认关闭、非法配置、schema/未知字段/密钥拒绝、日志器失败与副本隔离；
普通日志回归覆盖错误对象、opaque 自定义凭据头、含已知 Secret 的路径及 request-id。
真实 HTTP/PG 测试通过 JSON、SSE、recall 检查事件字段、数量与表中 ID；debug 关闭但
LOG_LEVEL=debug 时仍无事件；提取降级与索引失败保留结构化结果，全文扫描无测试密钥/正文。
模型均为离线注入，不读取实际 .env、不调用付费模型、不重启用户服务。
设为0并按既有方式重启即可停止新增调试事件；回滚不改动任何 Evidence/trace/usage 历史。

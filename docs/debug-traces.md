# 调试轨迹（#37）

三部分交付：服务端元数据与日志安全、显式正文捕获、本地 CLI 查看器及人工记忆操作轨迹。
不把内容复制到派生表，不新增数据库表、依赖、公开 debug API 或 Tools 执行器。

## 开关与输出

在服务端环境或 .env 中设置 `MNEMIC_DEBUG=1`，由现有启动入口读取；默认0/未配置时关闭。
仅接受0/1，其他值启动时以固定提示拒绝。Docker compose 转发该可选变量。
这是部署操作者的选择，HTTP 请求不能打开调试。没有修改或重启已运行服务的自动动作。

开启时应用 pino 强制使用 debug 级别，以便轨迹不会被默认 info 级别丢弃；此时优先于 LOG_LEVEL。
仅设置 LOG_LEVEL=debug 不会开启轨迹。关闭时事件接收器不检查传入内容、不调用日志输出。
仅此开关始终只记录元数据，正文捕获另需下文的第二个开关。

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
当前覆盖 JSON/SSE 聊天、commit/resume 写回、手动 recall、人工修正、软删除/恢复与 PENDING 确认/拒绝。
PENDING retry/expire 函数提供显式 sink 参数；尚无自动调度器，不宣称后台自动产生这些事件。
尚未实现的工具执行没有虚构轨迹；现有审批决策可经 `/permissions history` 查看。
Resolver 的结果关系随写入事件提供，完整得分与消解决策仍以原有
retrieval_traces/resolution_traces 为事实源，调试事件只存引用和计数。

## 查看 prompt 与模型生成文本（2/3）

同时设置 `MNEMIC_DEBUG=1` 和 `MNEMIC_DEBUG_CONTENT=1`，按既有方式重启服务后生效。
第二个开关默认0/未配置关闭；只接受0/1。内容开关为1但元数据开关关闭时，以固定提示拒绝启动，
不回显非法值，也没有 HTTP 开关。compose 转发两者，示例配置均默认0。
已有仅开启 MNEMIC_DEBUG 的环境不会因此开始记录正文。

输出仍为操作者 stdout 的 pino JSONL，但 `msg` 是 `model debug content`，与元数据独立：

| event          | target_id                         | detail                                                                                                          |
| -------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| model.prompt   | 每次实际 SDK invocation 的新 UUID | project_id、物理 conversation_id、evidence_id、provider_name、model_id、slot、complete、omitted_reason、content |
| model.response | 与该次 prompt 相同                | 同上，另有 status=success/error/aborted                                                                         |

仅捕获受信上下文的 chat/extraction 槽位：JSON/SSE 回答、单条及文件提取、commit/resume 写回。
prompt 是 SDK 送给 provider 的有序文本结构，保留 system/user/assistant、text/reasoning、
系统提示、历史、注入记忆和文件边界。`content` 为数组，结构与 SDK 文本输入对应。
响应是模型生成的 text/reasoning，发生在提取 JSON 解析之前；不是 provider HTTP 原始响应体。
不读取或输出请求头、响应头、SDK/provider metadata、异常对象、base_url、图片/文件二进制、
工具参数/结果或 embedding 向量。doctor probe 不捕获，解析配置也不产生 invocation。
重试各有一对新 ID，不把两次付费调用合并。evidence_id 可与消息和记忆元数据事件对应。

`complete=true` 表示捕获了该快照的全部受支持文本，密钥已替换；不是模型质量或账单保证。
仅成功 stop 才记录响应全文；流式数据按 pull 透传，积累结束后脱敏，不逐 delta 输出。
错误、取消、缺失 finish、length/tool-calls 等结果整段省略（`content=null`，`complete=false`），
避免截断的密钥前缀穿透。status 描述调用结果，不能单独作为全文完整性的判断。

输入/输出每份原始文本最多1MiB、prompt最多256条消息、总计2048个文本块；
流式最多8192个 delta，块 ID 为1–128字符。超限不截取前缀，整份省略。
`omitted_reason` 为 size_limit / unsupported / cross_boundary_secret / incomplete，完整时为 null。
不支持的图片、工具等内容导致整份快照省略，不悄悄丢掉部分内容后宣称完整。
字段边界可能把秘密拆成多段时也保守省略，连续字段组合碰巧形成 Secret 模式时可能误省略。
日志器/投影故障不能改变成功回答、重放模型调用或阻止上游取消；不新增流复制/提前消费。

安全处理使用 #15 已知 Secret 模式（含未闭合私钥块），再加当前应用 auth token、
master key 的 hex/大写 hex/base64 及本次所选 provider key 的精确匹配。
这些凭据只用于内存脱敏，不进入记录；业务 prompt/模型返回不因日志脱敏而被改写。
未解密其他 provider 的 key，不保证未知凭据、编码后的密钥或完整 PII 检测。
**脱敏后的正文仍可能敏感**：只在受控排障窗口开启，操作者负责收集权限、保留和清理。
没有公开查询 API、数据库内容快照或 Web 查看器；CLI 只读本地文件，也不承诺防 prompt injection。

## 在 CLI 查看本地快照（3/3）

将操作者收集的应用 stdout 复制为一个稳定的本地文件，再运行（仓库开发入口）：

```sh
pnpm --filter @mnemic/cli start -- debug --file ./server.snapshot.jsonl --project <项目UUID>
pnpm --filter @mnemic/cli start -- debug --file ./server.snapshot.jsonl --project <项目UUID> --conversation <物理会话UUID> --content --json
```

先按 Quickstart 构建 CLI/shared；正式安装后同样可用 `mnemic debug ...`。
命令只读显式指定的文件，不连接服务、不读取服务端配置、不解密 provider key、不调用模型，
不接收 `--server`/`--probe`，也不能开启服务端正文捕获。默认只显示元数据，`--content` 才显示
已经捕获的完整受支持文本；完整性和省略原因原样保留，不补造缺失响应。

`--project` 必填，可加 `--conversation` 与 `--target`（事件的 target_id）精确筛选 UUID；大小写归一。
元数据写回事件新增物理 conversation_id，便于同轮查看；删除/恢复和 PENDING 等项目级事件没有
会话字段，因此设置会话筛选时不会显示这些事件。旧版不带会话的元数据同理，可用项目或 target 查看。
文件顺序保留，默认前50条、`--limit` 为1–1000；报告 matched/shown/ignored/limited，
达到条数限制时明确提示。可按单个 invocation target 筛选一对 prompt/response，重试使用不同 ID。

只接受 shared 契约中的事件、字段和文本类型，额外 detail 字段会使整行忽略。
普通访问日志、启动器文本、无效/未结束 JSON 与无效 UTF-8 只计 ignored，不回显原行或解析异常。
未知 pino 信封字段丢弃，不输出其中的异常/请求头。所有字符串按 JSON 转义展示，含 C0/C1、
方向控制符的文本不会作为终端指令执行；`--json` 输出可解析的单个对象，非直接复制原始 JSONL。

文件最多64MiB，单行最多16MiB，选中记录序列化总量最多8MiB（另有固定摘要开销）。
拒绝目录、FIFO、末组件符号链接；按已打开文件读取，发现读取期间大小/mtime/ctime 改变即失败。
读取失败、超限或变化时不会先输出部分记录，返回固定提示、退出码1；参数错误返回2。
不要直接读持续追加的日志，先复制并管理快照权限；过大时缩小采集范围或按 target/limit 降低输出。

文件读取权由操作系统决定，项目筛选只是操作便利，**不是项目鉴权或日志真实性证明**。
查看器没有额外密钥清单、没有重新脱敏承诺：使用受控来源已由服务端脱敏的快照。
恶意改写的文件可能伪造合法内容/来源；即使 schema 合法也不代表没有秘密，正文仍可能含 PII。
终端及重定向输出需要同等保护。没有 live-follow、轮转恢复或 Web/远程日志查询功能。

### 人工记忆操作事件

| event                        | target_id  | detail                                                                |
| ---------------------------- | ---------- | --------------------------------------------------------------------- |
| memory.belief.corrected      | belief ID  | project_id、专用修正 conversation_id、observation_id、route、relation |
| memory.belief.status_changed | belief ID  | project_id、active/deleted                                            |
| memory.pending.decided       | pending ID | project_id、evidence_id、confirmed/rejected/promoted/expired 等状态   |

人工修正仅在外层事务成功提交后输出，rollback/404/409/鉴权失败不产生成功事件。
删除/恢复仅在原子条件更新命中后输出；PENDING API 从已写入的行取项目和 Evidence。
retry/expire 的显式 sink 供未来调用者使用，未注入时保持原行为；状态记录不代表已提升为正式记忆。
不记录候选/修正值、subject/attribute、原始错误或密钥，不新增持久审计与内容快照。

## 安全与可用性

元数据事件 schema 严格限定 UUID、枚举、布尔和非负安全整数，拒绝额外字段；没有任意 detail 对象
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
新增捕获测试覆盖文本/推理、分块密钥、跨字段省略、超限/不支持、错误/取消、日志失败，
以及真实 HTTP/PG 的 JSON/SSE、历史/记忆/附件与 commit/resume 归属。
模型均为离线注入，不读取实际 .env、不调用付费模型、不重启用户服务。
将 MNEMIC_DEBUG_CONTENT 设为0并重启可仅停止新增正文；两者均设0并重启停止全部调试事件；回滚不改动任何 Evidence/trace/usage 历史。

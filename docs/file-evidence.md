# 文件附件与来源传递（#35，拆分 2/3）

Refs #35。本轮接在 [本地引用组件](file-context.md) 之后：实现共享附件契约、两种消息 API、
脱敏、prompt 数据边界、独立 Evidence 与来源权威映射。**CLI 的输入/Tab/加载提示尚未接线，
不能把本 PR 当作完整 @ 引用功能；#35 继续打开。** 本轮无新增依赖。

## 取舍与接口

选择继续用 `messages` 承载原始 Evidence，不另建文件内容表，也不把附件正文复制到用户消息或 trace。
每个文件/目录清单是一个独立的 `speaker=tool` 消息，正文只在 `raw_text` 保存一次。
新迁移 `0010_message_file_evidence` 只增加 nullable `messages.attachment` JSONB 元数据：

```json
{
  "version": 1,
  "kind": "file",
  "path": "src/index.ts",
  "truncated": false,
  "parent_message_id": "所属用户消息的 UUID",
  "source_type": "PROJECT_FILE"
}
```

这里的 `tool` 是既有 Evidence 的承载角色，不表示执行过工具；来源判断以服务端创建的 attachment 通道为准。
文件与口述有不同的 Evidence ID，避免混合一个去重键或把文件事实当成用户修正。
父消息必须为同一物理会话里的 user；它是 JSON 引用，没有数据库 FK，所以历史读取、模型上下文、
提取和提交都重新解析严格契约并校验父消息。损坏/缺失/跨会话引用拒绝处理，不静默丢弃来源。
读取/续聊/发送/提交遇不可用历史返回 409；提交校验失败不归档会话。

共享子入口为 `@mnemic/shared/file-context`，root 不增加运行时 schema 导出。
已有 JSON 与流式端点均接受：

```json
{
  "text": "解释这里的设计",
  "attachments": [
    { "kind": "file", "path": "README.md", "content": "文件内容", "truncated": false },
    { "kind": "directory", "path": ".", "content": "[\"README.md\",\"src/\"]", "truncated": false }
  ]
}
```

- JSON 为 `POST /projects/:projectId/conversations/:id/messages`；流式为同一路径加 `/stream`，
  项目和会话同时匹配；旧的无项目 JSON 消息端点返回 404，不做静默回退。
  复用既有全局 Bearer，不宣称多用户租户权限。服务器只接受数据，绝不会按 path 读取自己的磁盘。
- attachments 可省略或为空，旧调用的 JSON 形状不变；不接受客户端指定 source_type、authority、
  Evidence ID、parent 或 tool-output 通道。严格校验失败为带结构化 errors 的 400，入库前拒绝。
- 每个正文最多 16 KiB UTF-8，总计 64 KiB；最多 8 个文件加 8 个目录清单；同一 path 不可重复。
  只接受规范化的相对路径，`.` 仅用于目录。非法 Unicode、越界/绝对/敏感路径拒绝。
  `kind=directory` 的 content 是清单数据文本，服务端不扫描目录或证明内容真实性。
- 路径敏感名称规则由 CLI 与 HTTP 共享 `isBlockedProjectPath`，不维护第二份私钥名单。
  路径与内容字段均在保存前经过已有 Secret 扫描；命中字段替换为 `[REDACTED]`，审计只记录
  Evidence ID、模式名和命中数，不含密钥、原始路径或正文。审计与用户/附件消息同事务提交。
- `createApiClient.sendMessage(projectId, conversationId, text, attachments?)` 第四个参数为可选附件数组；`openMessageStream` 第五个参数为附件，
  保留第四个参数的 AbortSignal 位置。传输不增加自动重试或额外模型调用。

本轮限制作用于附件总正文，包含目录清单；3/3 若目录 JSON 超过预算，必须明确提示并阻断发送或由用户
减少引用，不能静默截断清单或只发送部分附件。`truncated` 来自读取方声明，当前 API 不验证本机原文件大小。

## 生命周期与权威

admission 在既有会话行锁事务中检查项目/归档/历史，保存用户指令与已脱敏的附件。
JSON、流式、后续历史和续聊都只使用已经保存的脱敏正文。
文件内容以带来源的 JSON 数据块提供，`<`/`>` 和双向控制字符转义，伪造结束标签不能关闭块；
文件不会提升到 system 指令或冒充 assistant 回复。系统提示允许依据引用文件回答，并明确文件是非可信数据。
边界编码仍不是 Prompt Injection 防御保证。

即时提取和 commit 分别按每个消息的 `extracted_at` 原子认领；助手消息、继承历史不重新提取。
正常完成或中断后持久化的流式回答沿用同一调度器；未调度的附件仍可在 commit 时处理。
同一条文件 Evidence 不因 commit/续聊重复累计佐证。重复上传文件是新的客户端 Evidence 声明，
本轮没有跨消息内容哈希去重或文件真实性证明。

来源权威由通道静态确定，在进入 Gate/PENDING/ingest 前重新调用既有权威映射表：

| 可信调用方通道 | source_type      | authority | reliability 初值 |
| -------------- | ---------------- | --------- | ---------------- |
| project-file   | PROJECT_FILE     | 50        | 0.9              |
| tool-output    | TOOL_OBSERVATION | 40        | 0.85             |

文件模型即使输出 USER_CORRECTION，也不能提升自己。工具输出只提供内部可信 writeback 参数及测试，
没有新增 HTTP 工具上传、命令执行或生产者；未来 #26/#30 必须在工具产出保存前先脱敏，不能从输出文字推断来源。
既有普通用户提取行为不变。

## 安全边界与验证

来源是经鉴权客户端的通道声明，不是服务器验证过磁盘、签名或文件属主的证明。
已持有全局 Token 的 owner 可以提交任意内容；不把此接口当作跨租户可信文件认证。
已存正文是脱敏后的 Evidence，不保存原始秘密的副本。沿用 #15 常见模式检测，并补齐截断私钥块缺少
结束标记时的脱敏；仍不承诺全部秘密/PII，未知格式或起始标记也被截掉的私钥片段可能无法识别。
本轮没有触碰真实 `.env`、授权目录、运行中的服务或付费模型。

新增契约/typed transport 与真实隔离 PG + 注入 SDK 测试覆盖：字段/字节/来源伪造拒绝、
JSON 与 SSE 同链路、存储/模型/审计不含已知秘密、独立 Evidence ID、PROJECT_FILE/TOOL_OBSERVATION
权威重算、PENDING、即时+commit 幂等、目录数据、历史与续聊、项目/鉴权负面，以及损坏父引用拒绝。
3/3 再做真实 CLI/PTY 的 @ 解析→本地加载→提示→发送→读取来源闭环；非法引用按 #91 决定阻断发送并保留输入。

回滚需同时回滚客户端/服务端新增接线。数据库列是 additive，不应回滚删除已有 Evidence；旧服务忽略附件元数据，
因此若已有文件 Evidence，降级前必须评估来源展示与历史语义。不要把降级后的工具文本当作用户来源重新提取。

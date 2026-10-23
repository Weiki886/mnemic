# Chat streaming protocol v1（#33，拆分 1/3–3/3）

1/3 交付 `@mnemic/shared/chat-stream` 的事件契约、编码器和可中断收流组件；
2/3 新增以下服务端生成、取消与持久化接口；3/3 将 CLI 默认对话切换为真实 SSE，
接入 ESC / Ctrl+C 中断和上下文续写。旧 JSON 接口继续兼容其他客户端；流式失败不回退重发。

## CLI（3/3）

- 每个 delta 实时渲染；finish 才展示最终引用及拒答信息。
- 生成中 ESC / Ctrl+C 只请求一次 scoped cancel；收到 start 前的按键会记住意图，取得 generation ID 后取消。
  继续读取至服务端保存确认，显示“已中断 · 已保存”，不退出、不重复发送用户输入。
- 取消过程最多 10 秒；超时、断网、畸形确认或无 finish 的 EOF 保留片段并标记保存未确认，
  不以本地 abort 伪装保存。未知状态禁止自动下一轮及提交；显式 `/resume 当前会话UUID`
  由服务端确认后加载已保存历史（生成仍忙时 409），并创建新续聊会话。没有自动重连/重发。
- 空闲 Ctrl+C 或 `/exit` 提交退出；非生成的其他命令处理中 Ctrl+C 等待命令再提交。
- 实际 PTY 测试驱动真实 CLI 源码、Fastify、SDK 测试模型和 PostgreSQL：ESC 与 Ctrl+C
  分别保存部分回答为 interrupted，第三轮模型上下文包含两段原文和中断标记，最后空闲 Ctrl+C 提交退出。
  测试使用离线模型替身，不证明真实提供商质量，也不覆盖工具中断或断线续传。

## 服务端 API（2/3）

两条路由均沿用全局 Bearer 鉴权。所有路径 ID 按 UUID 校验并规范化小写，且查询同时验证项目与会话归属。

- `POST /projects/:projectId/conversations/:id/messages/stream`，JSON `{ "text": "问题" }`，1–8000 字符、不接受其他字段。
  校验/鉴权/查找/已提交或坏历史分别返回 RFC7807 的 400/401/404/409；成功才进入 SSE。
- `POST /projects/:projectId/conversations/:id/generations/:generationId/cancel`，空对象或无 body。
  请求取消并等待保存结果，返回 `{ generation_id, message_id, status }`，status 为 complete/interrupted/failed。
  已保存的结果可重复查询，不会重新生成；跨项目或未知 ID 返回 404。对已知活动生成，若保存失败则返回安全的 500，绝不伪装取消成功。

`generation_id` 即本次新助手消息的 ID，和 start 的 `user_message_id` 分离。
先在会话行锁事务中写入用户 Evidence，再发送 start；复用检索、引用、续聊历史和异步提取写回。
生成结束后先保存助手原文、引用版本 ID 和状态，再发送 finish；数据库失败发 PERSISTENCE_FAILED，模型失败发 GENERATION_FAILED。
主生成调用采用 [AI SDK v5 streamText](https://ai-sdk.dev/v5/docs/reference/ai-sdk-core/stream-text)，显式 `maxRetries: 0`；检索与提取仍沿用原有实现。

调用方应在保持收流时发取消请求，然后读取 finish 或取消返回的持久化状态；仅 abort 本地 reader 不等于收到服务端确认。
连接在终态前关闭会取消模型并尝试保存部分回答；finish 后客户端主动关闭属于正常结束，不能回写为 interrupted。
模型适配器收到 AbortSignal，但不保证不合作的上游立刻停止计算或停止计费；本地不等待挂死的 SDK read。

### 状态与上下文

升级前先执行 `pnpm --filter @mnemic/server db:migrate`（新增 nullable `messages.generation_status`）。
新流式助手消息记录 complete/interrupted/failed；旧消息和用户消息为 null，旧响应不增加空字段。
消息读 API 对新流式回答返回可选 `generation_status`；部分/失败原文不改写，传给模型时另加“未完成回答”标记。
没有任何文本时取消也保存空的 interrupted 助手消息，用户 Evidence 仍保留。只提取用户消息，认领复用原去重规则，commit 不会重复提取。

同一服务实例内，活动流式生成与该会话的其他流、JSON 发消息、commit、resume（含 current_conversation_id）互斥，冲突返回 409。
旧 JSON 路径之间不增加全局并发名额限制；只有活动流式生成最多 32 个，保存结果后释放名额，名额满返回明确的 409 提示。
JSON 发消息/commit/resume 仍登记已校验的会话 UUID，用于与同会话流互斥，但不占用流式名额；不读取 JSON 发消息体里被忽略的字段来加锁。
这是当前单进程部署的协调器，不是分布式锁；不支持多个服务副本共享数据库同时处理聊天。

服务端检索/生成阶段默认总预算 **300 秒**（用户消息事务提交后开始，含背压等待；不是空闲超时），单次背压最多 30 秒。
服务端对文本 + 未向用户显示的 reasoning 合计限制 2 MiB；不转发或持久化 reasoning，SSE wire 总预算 8 MiB。
所有 SDK 事件均参与让出事件循环，不能通过纯推理流饿死取消请求。
数据库保存不受模型 AbortSignal 取消：中断后仍需完成保存，保存失败不确认成功。
[Fastify preClose](https://fastify.dev/docs/latest/Reference/Hooks/#preclose) 先停止接收新的聊天操作、取消活动流并等待保存，再进入连接关闭与后台写回排空。

进程崩溃、强杀或数据库不可用时，尚未保存的部分回答无法保证恢复；用户消息已单独持久化。
若外部进程在生成期间归档该会话，保存会拒绝追加，返回 PERSISTENCE_FAILED，而非确认中断成功；已保存的用户 Evidence 保留。
本轮没有逐 token 数据库日志、多副本路由、重启恢复或断线续传，也不自动部署或迁移用户开发库。

## 事件

响应须为 HTTP 200、`Content-Type: text/event-stream`，UTF-8。每条事件有同名 SSE `event` 和 JSON `type`：

```text
event: delta
data: {"type":"delta","generation_id":"01920000-0000-7000-8000-000000000002","text":"中文😀"}

```

生产方应使用 `encodeChatStreamEvent`；它验证字段、限制大小，将换行转为 JSON 转义，避免模型文本注入 SSE 帧。

| type   | 其余字段                                                                 | 语义                                                               |
| ------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| start  | version: 1、generation_id、conversation_id、user_message_id              | 接受本轮生成，三个 ID 均为 UUID                                    |
| delta  | generation_id、text                                                      | 非空增量，单条最多 16384 个 JS 字符单元                            |
| finish | generation_id、status、message_id、abstained、history_included、memories | 正常完成或服务端确认中断；不重复传整段 answer                      |
| error  | generation_id、code                                                      | 仅 GENERATION_FAILED / PERSISTENCE_FAILED，不接受原始 SDK 错误正文 |

`finish.status` 只接受 `complete` / `interrupted`；`memories` 沿用引用记忆字段，最多 100 条。
事件及引用对象字段严格校验，不认识的版本、事件、JSON 字段或不同会话/生成 ID 均失败关闭。
先且仅有一个 start，之后为 delta，最后是 finish/error；首个终态作为逻辑 EOF，主动停止读取，不等 TCP 关闭。
逻辑 EOF 后不检查后续字节，也不承诺能发现服务器在其后重复发送的终态。

评论、SSE 的 id/retry 和未知传输字段不触发业务或重连；多行 data、BOM 由标准解码器及
[eventsource-parser](https://github.com/rexxars/eventsource-parser) 处理，遵循 [SSE 分帧规范](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream)。
CR/LF/CRLF 在解析前统一为换行（跨块 CRLF 也只算一次）；CR 立即结束该行，不等待下一字节或物理 EOF。
没有空行终止的事件不会被补成完成。

## 收流与取消

```ts
import { consumeChatStream, ChatStreamReadError } from "@mnemic/shared/chat-stream";

// response 由调用方完成鉴权、POST 与 fetch；本组件不创建请求或自动重发。
try {
  const result = await consumeChatStream(response, {
    conversationId,
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === "delta") renderDelta(event.text);
    },
  });
  // result.reply.answer 为拼接的增量；status 是服务端确认的 complete/interrupted。
} catch (error) {
  if (error instanceof ChatStreamReadError) {
    // error.progress.answer 是已验证收到的前缀，不能据此认定已经渲染或持久化。
    // 不直接记录进度：它可能包含私密对话及引用。
  }
}
```

`onEvent` 可同步或异步，按顺序等待，并传递独立副本；慢异步回调也受取消/超时约束。
默认总预算 120 秒，`timeoutMs` 可设为 1–600000 的整数；总预算包含收流和回调等待。
这是收流器总时长上限，不是空闲超时。接入 Mnemic 服务端长回复的客户端应显式传 `timeoutMs: 600_000`，
留出服务端 300 秒生成及保存/传输余量；CLI 的 fetch 和收流器均显式采用 600 秒，不依赖 120 秒默认值。
定时器加单调时钟双重检查，避免已缓冲数据的微任务链延迟定时器；不能抢占调用方同步阻塞的 JavaScript 回调。
每 64 次读取/切片主动让出事件循环，空块或已缓冲流也不会一直占住微任务队列，阻止外部取消事件执行。
取消/超时会 cancel reader、移除监听、清理定时器并释放锁；不等待可能永不 settle 的底层 cancel。
已经开始的外部回调或底层任务不保证能被强制停止，但其迟到拒绝已接住，不重试。

需要严格区分：

- `finish.status=interrupted`：**生产方必须先保存用户消息及部分回答/中断标记，再发此确认**。本服务端已按此顺序实现；收流器自身只验证协议，不能检查数据库。
- 本地 AbortSignal、超时、断网或无终态 EOF：停止本地收流，保留前缀，但**不知道服务端是否停止或落库**；不伪装成已确认中断。
- 已收到 finish 但 UI 回调失败：异常进度仍保留该 terminal 确认，调用方可分别处理服务端确认和本地显示失败。

CLI 采用严格取消 receipt 校验（generation/message ID 与当前生成匹配）；即使保存已确认，
缺失 finish 时也不编造缺失文本或最终引用。历史显示 interrupted/failed 标记。
本轮没有自动重连、Last-Event-ID 续传、自动重发或工具执行中断。

## 资源与错误边界

- 编码后的规范事件（JSON + 固定 framing）最多 128 KiB UTF-8；SSE 不完整行/数据缓冲同时限制为 128 Ki 个字符。
- 累计回答最多 2 MiB UTF-8，本次读取的总 wire 最多 8 MiB（包含注释等流量）；逻辑 EOF 后的未消费后缀不计入。
- 输入按行边界及最多 16 KiB 切片解码，不能用多字节字符、无换行长帧或无限 keepalive 绕过有界内存/流量限制。
- EOF 无确认、非法 UTF-8、解析/跨 ID、大小超限、HTTP 错误、网络错误、回调错误和中断/超时均有类型化本地错误。
  错误 message/code 不包含原始 HTTP/SDK/网络异常、signal.reason 或 cause。
  私密 `progress` 为非枚举属性，避免普通 JSON 错误日志自动展开；显式读取或自行展开仍需自行保密。

限制不是完整 Token/计费配额；已经发生的模型调用不能靠取消回滚费用。
parser 版本固定为仓库已使用的 3.1.1，并在 shared 显式声明，不依赖 SDK 的隐式传递依赖。
root 只导出类型；新运行时入口独立，不让现有 Web/JSON client 无故加载收流器。

## 验证范围

共享层测试包含协议/编码、任意 UTF-8 分片、真实环回 HTTP 的增量到达/确认/取消/断开/超时，以及资源清理。
服务端测试使用真实 Fastify HTTP、AI SDK 和 PostgreSQL，模型为离线 MockLanguageModelV2：
覆盖显式取消后继续 JSON 对话、断连/超时/停机保存、项目隔离、非法输入、并发互斥、纯推理调度/预算和实际数据库 trigger 注入的保存失败。
尚未做真实付费模型、CLI 键盘交互、恶劣公网代理链路或 VPS 联调；不将测试模型的取消响应速度冒充上游厂商的保证。
测试不读取真实 .env；真实模型 Key 置空，不产生付费调用，不重启用户服务。

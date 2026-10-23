# Chat streaming protocol v1（#33，拆分 1/3）

本轮只交付 `@mnemic/shared/chat-stream` 的事件契约、编码器和可中断收流组件。
**尚未新增服务端 SSE/取消路由，也未切换 CLI：当前对话仍使用原 JSON API。**
后续 2/3 接服务端生成、取消与持久化，3/3 接 CLI 实时渲染、ESC/Ctrl+C。
`Refs #33`，Issue 保持打开；本轮测试不能代表“终端可打断且继续对话”已验收。

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
定时器加单调时钟双重检查，避免已缓冲数据的微任务链延迟定时器；不能抢占调用方同步阻塞的 JavaScript 回调。
每 64 次读取/切片主动让出事件循环，空块或已缓冲流也不会一直占住微任务队列，阻止外部取消事件执行。
取消/超时会 cancel reader、移除监听、清理定时器并释放锁；不等待可能永不 settle 的底层 cancel。
已经开始的外部回调或底层任务不保证能被强制停止，但其迟到拒绝已接住，不重试。

需要严格区分：

- `finish.status=interrupted`：**未来生产方必须先保存用户消息及部分回答/中断标记，再发此确认**。收流器只验证协议，不能检查服务端数据库。
- 本地 AbortSignal、超时、断网或无终态 EOF：停止本地收流，保留前缀，但**不知道服务端是否停止或落库**；不伪装成已确认中断。
- 已收到 finish 但 UI 回调失败：异常进度仍保留该 terminal 确认，调用方可分别处理服务端确认和本地显示失败。

服务端取消与上下文一致性必须在后续 PR 真正实现并测试，不能仅 abort fetch 就宣称完成 #33。
本轮没有自动重连、Last-Event-ID 续传、自动重发、模型请求或工具执行中断。

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

测试包含协议/编码、任意 UTF-8 分片、真实环回 HTTP 的增量到达/确认/取消/断开/超时，以及资源清理。
环回服务是一次性离线 fixture，不是新 Mnemic SSE API，也不是模型联调或 CLI 真实交互闭环。
没有模型 Key、付费调用、新数据库迁移或用户服务重启。

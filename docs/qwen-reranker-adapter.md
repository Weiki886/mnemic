# Qwen Reranker API 适配基座（#9 部分交付）

本轮提供受信内部 `createQwenReranker` API 客户端和排序组件，固定模型为 `Qwen/Qwen3-Reranker-0.6B`。
只调用操作者显式选择的 API，不下载模型、不安装 Python/GPU 依赖、不部署模型容器，也不增加三槽位之外的公开配置入口。

**尚无生产调用方。** 普通 chat/recall、特性开关、配额、用量表及检索 trace 均未接入此客户端。
`reranker=true` 仍被管理 API 和运行时拒绝，默认值仍为 false；不能凭这个组件宣称已实现默认开启的精排或指标提升。
#9/#22 保持 OPEN，后续需一起完成服务端加密配置来源、调用准入/用量记录、评分/拒答/预算顺序、轨迹和关闭时完整可用验收。

## 协议依据与 API 边界

- [Qwen 官方模型说明](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B)区分原始 logit 与激活后的分数。
- 对接 [vLLM v0.14.0 Score API](https://docs.vllm.ai/en/v0.14.0/serving/openai_compatible_server/#score-api) 的单 query / 多文档形态。
- 原始 Qwen 模型须由服务提供方按[官方 Qwen 示例](https://docs.vllm.ai/en/v0.14.0/examples/pooling/score/#qwen3-reranker-online)配置分类适配和模板。
  这里没有启动/转换模型；接口兼容测试不证明实际权重、模板或量化版本正确。

客户端固定发送 `model`、`text_1`、`text_2` 和 `use_activation:true`，不传本系统版本 ID、不覆盖模板或指令、不添加截断参数。
只接受同名模型回声、object=list、完整 data 中 object=score 且分数为有限的0..1；不把任意 logits 擅自当作概率。
模型回声只是协议一致性检查，不是远程权重证明。供应商别名、其他模型和其他 Rerank 协议不自动兼容。

内部调用形态（必须由未来可信服务端 owner 取得配置与正文，不能直接开放给 HTTP）：

```ts
const client = createQwenReranker({
  endpoint: "https://reranker.example/score",
  timeoutMs: 5000,
  // apiKey: decryptedServerKey, // 只允许服务端可信配置来源
});
const result = await client.rerank(
  { query: "数据库选型", documents: [{ beliefVersionId, content: renderedMemory }] },
  signal,
);
```

工厂严格校验 endpoint/apiKey/timeoutMs，不读环境文件、数据库或进程环境配置，也不尝试默认端点。
远程只允许 HTTPS；HTTP 仅允许 URL 规范化后的127.0.0.1/localhost/[::1]，方便独立测试或显式受信回环 API。
URL 不含 userinfo/query/hash/control 字符且路径以 /score 结尾；API Key 仅可见 ASCII，长度1..4096。
这些检查不替代可信服务选择、DNS/证书/网络策略，也不承诺防御恶意操作者配置。
超时为1..30000毫秒整数、默认5000；配置、回调和输入身份在首次等待前复制/固定。

## 输入、响应和排序

- 严格输入 `{query, documents:[{beliefVersionId, content}]}`，未知字段拒绝；ID 规范化小写后必须唯一。
- 最多200个文档，先检查数组基数再交给 Zod；query最多8192 UTF-8字节、每个content最多16384字节，总文本最多65536字节。
- 文本必须非空白、有效 Unicode 且不含NUL，保留正文空格/换行，不静默改写或截断。字节上限不是模型 token 上限；超出服务上下文的错误由上层按失败处理。
- 空文档不请求 API，返回空 items/usage=null，不制造“模型成功调用”或零费用记录。
- 响应在读取 Content-Length 后仍逐块检查实际字节，总计最多256KiB；使用固定大小缓冲区，完整收完后严格 UTF-8 解码/JSON解析。
- data须恰好覆盖全部输入索引：整数、非负、不越界、不重复。不接受漏行、重复、部分成功、NaN、字符串分数或未知模型。
- 按返回 index 绑定已复制的版本 ID，再按分数降序、输入次序升序打破同分，rank从1开始。不能靠上游数组顺序换绑来源。

结果仅含固定model、`items:[{beliefVersionId, score, rank}]` 和已投影的 usage。
忽略上游request-id、额外正文、端点、异常、Key和其他任意元数据；不把正文从响应抄回系统。
usage只取prompt_tokens/completion_tokens/total_tokens对应的安全非负整数；缺失或非法为null，不加总、不估零、不估费用。
这一投影不等于已接入model_usage，当前没有持久化副作用。

## 失败、取消和隐私

每批只发送一次 POST，不自动重试、不跟随重定向、不改走另一个模型或默认检索。
同一个期限覆盖等待响应头、读取body、解析和返回前检查；使用单调时钟复查，拒绝定时器尚未运行的迟到完成。
调用方已取消则零请求；中途取消即拒绝，即使注入的transport/body不响应AbortSignal也不会一直挂起。
迟到响应会取消body；清理不等待恶意/卡住的cancel Promise，拒绝和清理错误不携带上游 cause。

固定错误：INVALID_RERANK_CONFIG / INVALID_RERANK_INPUT / RERANK_INVALID_RESPONSE / RERANK_FAILED / RERANK_ABORTED / RERANK_TIMEOUT。
组件不写日志、不返回原始异常、HTTP错误正文或半批分数。它不会重放计费调用，但客户端超时/取消**不能证明远端停止推理或停止计费**。

真实接线会把 query/记忆正文发送到选定 API，服务提供方的日志和留存策略需独立确认；本组件的输出白名单不是上游存储保证。
API Key只在显式配置时放进该请求的Authorization，不借用全局 Mnemic Token或其他 Provider 凭据。
HTTP只读输入不替代调用者的项目范围/当前版本检查；后续检索接线必须从既有受作用域候选获得正文和ID。

## 验证和回滚

测试采用内存fetch替身及独立临时端口的真实Node HTTP服务；不读取真实配置、不访问模型服务、不运行付费模型。
覆盖乱序/同分/边界、整批拒绝、元数据和usage投影、Unicode/字节上限、mutation隔离、取消/期限/迟到回执、真实重定向拒绝和并发请求身份。
没有真实Qwen推理、GPU、质量指标或部署验收证据。

未改变生产入口/开关/数据库，回退本轮适配器不会影响既有检索和数据；没有迁移或配置回滚。
本 PR 还单独修正主干复验发现的worker测试夹具：仅以可控时钟触发首个受阻handler超时，后续任务不再依赖100ms内完成DB检查。
原“首任务不被重领、另一个槽位可执行新任务、attempts保持1”断言保留；不修改Worker生产代码，也不靠重跑掩盖失败。

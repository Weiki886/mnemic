# Provider 的独立精排能力

按用户确认的布局，精排复用 Provider 的服务端加密 Key，不增加第四个模型槽位。
这是 #9/#22 的配置切片；保存配置不会探测服务、调用模型、预留配额或启用 reranker 开关。
生产聊天/召回的自动选择与默认开启仍待后续接线，#9/#22 保持打开。

## 配置接口

均为全局操作者 Bearer 权限，需要 DB 和 master key 才注册路由，不是项目成员授权。
接口响应不返回密钥、密文、掩码或派生的完整端点。注册和更新只操作元数据，无计费副作用。

- `POST /v1/providers/reranker`：注册 Score-only Provider。输入 name、base_url、api_key、config。
  models 存为空对象，不会参与 chat/extraction/embedding 的默认槽位选择。
- `GET /v1/providers/:id/reranker`：返回 provider_id、固定 model_id、revision、config。
  旧 Provider 默认 `revision=0, config=null`；读取元数据不解密 Key。
- `PUT /v1/providers/:id/reranker`：输入 expected_revision 和 config，可为既有 Provider 添加精排能力，
  或以 config=null 禁用。Key 仍由同一 Provider 管理，此处不接受密钥或模型名。

示例输入（均为离线假值）：

```json
{
  "name": "offline-score-example",
  "base_url": "https://offline.invalid/v1",
  "api_key": "offline-provider-reranker-key-00000000",
  "config": { "endpoint_path": "/score", "timeout_ms": 5000 }
}
```

base_url 最多2048字符；新注册 Key 为8–4096位可见ASCII，沿用 AES-GCM 密文列。
endpoint_path 最多512个ASCII字符，采用 `/score` 或 `/v1/score` 等规范根相对路径；
路径段只允许字母、数字、下划线和短横线，末段必须为 score。不接受跨源URL、查询、片段或路径穿越。
timeout_ms 为1–30000整数，两个配置字段都必填，不隐式猜测模型或服务路径。

派生地址保留 Provider 的 origin，用 endpoint_path **替换整个 pathname**，不拼接旧 `/v1` 前缀。
上述示例派生为 `https://offline.invalid/score`。仅允许HTTPS或回环HTTP；URL凭据、查询、片段、
原始控制字符和无效编码拒绝。API路径属于可读元数据，不应包含秘密。复用 Key 的前提是相同服务
确实接受该 Key 和 Score API 协议；保存成功不证明服务兼容或凭据有效，没有自动付费 probe。

## CAS、审计与内部解析

更新先锁 Provider 行，再比较 expected_revision。过期返回409；内容相同返回 unchanged，
不增加 revision 或审计；实际更新为 revision+1，和审计在同一事务。最大安全整数耗尽返回409。
禁用不要求当前 base_url 安全，方便清理旧配置。其他 Provider API 后续更改地址/凭据时，内部解析
会重新验证；不能以历史保存成功冒充当前配置仍可用。

`provider.reranker.create/update` 审计只存 Provider ID、修订号及是否配置的布尔值，不存名称、
地址、路径、Key 或请求正文。审计失败会回滚注册/更新，可通过既有 `/v1/audit-log` 查询。
OpenAPI 的 AuditLogPage 增加这两个已知事件，严格生成的旧客户端应更新契约；其他旧路径和组件不变。

`resolveProviderRerankerConfig` 是服务端内部接口，按显式 Provider ID 一次读取配置和密文，
仅在能力启用时解密，返回供已计量适配器使用的配置；禁用返回null，不自动选择另一个 Provider。
损坏状态、密文或当前端点固定报 RERANKER_CONFIG_UNAVAILABLE，不返回原始异常或发送请求。
内部返回值含明文 Key，禁止出现在 HTTP、日志或客户端状态中。本轮还没有正式检索调用方。

## 迁移与回滚

0019 给 provider_configs 增加 reranker_config 状态列及 CHECK：默认0/null、严格键集、整数修订号、
路径和超时范围，数据库也拒绝不合法直改。重复执行不重置已配置状态；旧模型槽位和旧响应保持不变。
迁移涉及表锁和约束验证，大表应安排维护窗口；先迁移后部署应用。

回退代码时保留列、密文和审计，旧代码忽略新列、忽略空模型字典。旧审计投影会把未知动作作为
metadata_omitted 的不透明历史返回，不应删除历史或强制恢复数据来配合回退。

验证使用独立 mnemic_test、离线假值及本地临时HTTP端口，覆盖真实契约、加密、8路CAS、审计回滚、
拒绝非法状态、迁移重放、参数/传输错误、内部解析和调用方 mutation。没有真实 Provider 或付费请求。

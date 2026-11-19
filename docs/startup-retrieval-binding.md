# 显式安装启动检索绑定

正式启动器可从 MNEMIC_RETRIEVAL_BINDING_JSON 同时安装聊天和手动召回绑定。未配置或空字符串
保持原路径，空白字符串不等于关闭。接受现有 fusion + rerankerProvider 契约，以及可选的 chatReadTimeResolution:true，最多8192个UTF-8
字节；Key、端点、模型名、flagsSnapshot 和其他字段均不允许。Provider 密钥、模型及端点仍只
存服务端数据库，环境中只有算法参数和可选的 Provider ID 引用，不增加模型槽位。

```sh
export MNEMIC_RETRIEVAL_BINDING_JSON='{"fusion":{"mode":"rrf","threshold":0.001},"rerankerProvider":{}}'
```

示例阈值是显式实验参数，不是校准结果或生产推荐；亦支持现有 weighted 配方。非空配置必须
有 DATABASE_URL 和有效主密钥；绑定和密钥在连接数据库/监听端口前验证。非法 JSON/字段/大小
以固定错误拒绝且不回显输入。配置经复制冻结，不因运行中修改环境而改变；修改需重启。
默认值没有改变。安装绑定不会更新持久 flags、更改 revision 或开启 reranker；之后仍需用
当前 revision 显式调用已有管理 API。若数据库已经保存 true，新实例会沿用该配置。

Compose 显式转发此可选变量（默认空）；.env.example 和 deploy/.env.example 仅给注释示例，
没有自动开启。遵守[单进程及部署约束](reranker-management-capability.md)：安装绑定不是集群
readiness，不能用这个选项证明共享数据库的其他进程已就绪。管理更新不探测 Provider；实际
查询可能计费，配额和失败处理沿用既有规则，关闭不证明已发调用停止计费。

解析/安装绑定不发模型请求；已有持久 worker 启动后仍可能处理待执行任务，不应把启动服务
理解成零计费操作。测试只使用假配置、私有随机数据库、本地 Score 和离线模型，没有重启用户
服务或调用付费模型。验证覆盖非法配置子进程、解析边界及组装后的真实 HTTP，不代表真实
供应商兼容性或质量指标验收。#9/#22 保持打开，默认开启和完整消融仍未完成。

回滚前先关闭持久 reranker 并排空请求，再移除变量、切换旧版本；旧版不安装绑定但会读取全局
配置，直接回滚可能降级。无数据库迁移可回滚。

## Explicit chat replay capability

Add `"chatReadTimeResolution": true` to the same JSON profile to install the trusted chat-only
read-time-resolution capability. This property is absent by default; false, null, numbers and
strings are rejected with the fixed startup error. The 8192-byte limit, strict unknown-field
rejection and DB/master-key prerequisites still apply before connection or listening.

```json
{
  "fusion": { "mode": "rrf", "threshold": 0.001 },
  "rerankerProvider": {},
  "chatReadTimeResolution": true
}
```

The startup resolver projects this option only into `chatRetrievalBinding.readTimeResolution`;
`recallBinding` receives the original fusion/Provider fields and cannot consume replay. Both
bindings are copied/frozen. Parsing does not read or update persisted flags, reserve quota,
decrypt a Provider or probe a model. Existing Compose forwarding already carries this profile;
no additional environment variable is introduced.

This installs capability only. Each chat operation still captures its persisted flag snapshot;
flag-off uses legacy context. The management API continues rejecting read_time_resolution=true,
so this is an explicitly assembled experiment, not a complete deployment activation path or
quality/ablation acceptance. A pre-existing true state may affect chat after restart, while
recall without replay support can fail; shared-database instances must have consistent assembly.
Do not treat chat-only capability as cluster readiness. Write paths record this retrieval-only
flag without executing replay, as documented in the managed chat binding.

Before removing the option or rolling back, disable persisted read-time resolution through the
trusted experiment setup and drain requests; otherwise older/unbound consumers may degrade or
fail. Retain replay-aware clients/readers for existing source references. #9/#22 remain open.

Tests cover strict parsing, absent/legacy behavior, immutable distinct bindings, dependency
failure and a real entry subprocess rejecting malformed chat options before unreachable DB
access. Startup-resolved bindings also exercise real JSON chat routing with isolated PG and
offline models, without a retrieveFn substitute. No real credentials or paid models are used.

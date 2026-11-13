# 手动召回的受信检索绑定

#9/#22 的部分接线：库调用方可为 `buildApp` 显式提供 `recallBinding`，让手动召回端点
使用现有融合与已保存的 Provider 精排能力。该选项只在服务端代码中组装；不是 HTTP 输入，
不读取新环境变量。官方 `index.ts` 暂未提供该绑定；省略时仍走既有召回路径。

```ts
buildApp({
  // db、masterKey、authToken 使用既有服务端组装；不在客户端保存 Key。
  db,
  masterKey,
  authToken,
  modelDailyCallLimit: 100,
  recallBinding: {
    fusion: { mode: "rrf", threshold: 0.001 },
    rerankerProvider: {}, // 或 { providerId: "具体 Provider UUID" }
  },
});
```

阈值是此处调用方显式选择的实验参数，不是校准结果或生产推荐。fusion 复用已有 RRF/weighted
校验，必须给阈值，候选最多200；Provider 描述复用同一 schema。注册时解析、复制并冻结整份
绑定（含 weighted 权重），后续修改调用方对象不影响请求。明文 Key/端点、flagsSnapshot、
reinforce 等额外字段被拒绝；缺 DB、有效主密钥或显式日配额时在创建 app 前失败。

每次请求沿用鉴权、Origin 拒绝、项目存在性和严格 query-only body 校验，通过后才检索。
开关按 #137 的规则在操作入口从数据库捕获一次。关闭时仍使用所配融合，但不选择/解密精排
Provider、不发 Score 请求、不预留 Score 配额或写精排用量；开启时实际请求经过同一持久
准入器，并记录 `slot=reranker` 的用量。embedding 与 Score 各自计数，不因候选数重复记账。
配置缺失/损坏不切换 Provider；传输失败按既有策略回退，不自动重发。取消不能证明停止计费。

HTTP 返回结构与 OpenAPI schema 不变。数据库内部轨迹保留 rankFusion/reranker/Provider 修订号；
响应逐项只投影公开的版本 ID、分路分数、融合分数、selected/reason。未知内部字段不进入响应；
已知字段损坏仍由 RecallResultSchema 拒绝，不把坏数据投影成成功。最多200条和总数/截断标记
保持原规则，读时强化仍显式关闭。

手动召回沿用旧的宽 catch：精排配额拒绝、配置失败等返回固定500，不保证429；增强失败回退
可返回200且已计一次模型调用。30秒 signal 不是所有 SQL/遥测的总时限。本文没有承诺新增错误
语义、请求撤销、Provider 自动切换、默认开启或免费回退。

本轮未接聊天、未解锁管理 API 的 reranker=true、未修改持久默认值、未交付真实质量或消融指标；
直接改全局开关也不会给其他未绑定消费者授权。仅用测试自建隔离库和临时端口完成 HTTP/PG
验证，没有调用真实或付费模型。#9/#22 保持打开。回滚移除库组装选项即可，无迁移可回滚。

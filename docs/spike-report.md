# 可行性 Spike 报告（#2）

验证日期：2026-09-17 ｜ 环境：macOS（Apple Silicon）、Node 24、PostgreSQL 17 + pgvector 0.8.6（本地原生安装）

## 一、DeepSeek 结构化提取稳定性

脚本：`scripts/spike/deepseek-extraction.ts`（20 条中文编程场景样本，zod schema 对齐 #4 提取契约，temperature=0）

状态：**待 DEEPSEEK_API_KEY 运行**。运行方式：

```bash
DEEPSEEK_API_KEY=xxx pnpm --filter @mnemic/spike run spike:deepseek
```

通过门槛：schema 合法率 ≥ 95%（<95% 回 #1 讨论方案）。结果落盘 `docs/spike-deepseek-results.json`。

## 二、pgvector + 全文检索混合链路 —— PASS

脚本：`scripts/spike/pgvector-hybrid.ts`。500 行合成数据（4 主题质心 + 噪声，8 维向量），HNSW（cosine ops）+ GIN(tsvector)。

| 验证项 | 结果 | 延迟 |
|---|---|---|
| 纯向量检索（cosine，HNSW） | top5 全部命中目标主题 ✅ | 0.5ms |
| 全文检索（tsvector + ts_rank） | 命中 5 条 ✅ | 0.2ms |
| 加权混合（0.7 向量 + 0.3 全文，纯 SQL） | 返回 top5 ✅ | 0.4ms |

结论：向量 + 全文 + 加权融合可全部在 PostgreSQL 内完成，无需引入额外检索组件；支撑 #6（两路混合）与 #9（RRF）的技术路线。实现注意点：vector 维度是类型修饰符，不能走绑定参数；写库需显式 `::vector` 转换。

## 三、写入→检索→冲突改判最小闭环 —— PASS

脚本：`scripts/spike/conflict-loop.ts`（最丑实现：规则假提取器 + 两张临时表）。

```text
写入 "数据库用 PostgreSQL"（ASSERT）
  -> 检索 = PostgreSQL ✅
写入 "改用 SQLite"（UPDATE）
  -> 冲突检测命中旧值 PostgreSQL ✅
  -> 取代：旧版本 recorded_to/valid_to 关闭（失效留痕），新版本生效 ✅
  -> 改判后检索 = SQLite ✅
  -> as-of（改判前时点）= PostgreSQL ✅
版本链 = 2 条，旧版本留痕未物理覆盖 ✅
```

结论：双时态版本化 + 取代 + as-of 查询的 SQL 模式可行，验证 #3 数据模型与 #5 Resolver 的核心语义；recorded_to IS NULL 作为"当前版本"判定可行。

## 总结论

三项风险中两项已用真实数据排除；第一项待 API Key 运行后补充。骨架可进入 #3 数据模型阶段。

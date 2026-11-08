# 实体检索运行时接线（#9 部分交付）

`retrieval_entity` 已接入普通 `retrieve`（包括聊天和手动 recall）以及显式 RRF/weighted。
默认仍为 false，通过已有鉴权 `/v1/config/flags` CAS 更新启用；不新增 HTTP 参数、模型调用、配置键、依赖或迁移。
#9/#22 保持 OPEN：Reranker、读时消解、默认聊天预算及 #12 完整消融与质量指标仍未验收。

## 查询输入策略：query_labels_v1

查询标签来自本项目当前 active 版本所引用的 Observation.entities。只处理 JSON 字符串数组中的字符串，
非数组/数字/null/对象不作为标签；来源 Observation 必须独立匹配项目，版本 recorded_to 必须为空。
不读历史 Observation、subject/value 的隐式别名、外项目标签或实体图。

两侧使用 PostgreSQL NFKC 和 C collation 的 lower；存储标签再 btrim。
规范化后的空标签、含 POSIX control 字符和超过128个 PostgreSQL字符的标签不参与查询发现。
将标签作为**字面子串**用 strpos 查找；%/_/引号/正则符号均不解释为语法。
例如“我的数据库用PostgreSQL吗”可以命中“数据库”和“PostgreSQL”。
这不是 NER、词边界匹配或同义词扩展：“PostgreSQLPlus”也会命中已有“PostgreSQL”标签。
短标签、嵌套名称可能误召回；本轮没有精度提升承诺，后续由 #12 比较效果。C lower 不承诺完整 Unicode case-fold。

命中的规范化标签去重，按字符长度降序、C 标签升序选最多32个。
实体分 = 当前来源命中的不同查询标签数 / 本次选中的不同标签数；重复标签不增加分数或 evidence_count。
只在无命中时返回空实体池，不制造未知标签或用 query 中未匹配的词稀释分数。
因此同一查询分数可能随当前项目标签集合变化；时间过滤开启时，发现和评分均使用相同有效候选池。
每个实体池按分数降序、版本 UUID 升序截断：普通路径最多200个，显式融合采用既有 perRouteLimit。
这些上限限制输出，不限制数据库标签扫描/去重的 CPU、I/O 或既有 JSON 单行尺寸；未做生产大库压测。

纯 `readCandidateScores` 继续使用显式 `entities` 的原有规范化相等契约；没有 entityQuery 时不从 query 自动推断。
内部运行时显式传入 `entityQuery` 开启上述策略；它复用 query 的1000字符/非法Unicode校验，
显式 entities 非空时优先使用原契约。不向 HTTP 暴露 entityQuery/entities 或算法选项。
普通聊天仍用原查询长度边界，不因开启实体就强制进入实验融合或缩短为1000字符。

## 两种引擎与时间过滤

- 未传 fusion：保留 A0 的 vector/keyword 计算，实体开启时取
  `max(0.7 * vectorScore + 0.3 * keywordScore, entityScore或0)`。
  这是明确的 best-route 启发式，目的是让实体独立召回可通过原0.3阈值，不冒充 RRF 或校准结果。
  阈值/topK 和最高分不足时整体拒答规则不变。没有实体命中的既有正分候选不因改权重而降分。
- 显式 fusion：把实体票送入既有 SQL RRF/weighted，继续使用调用方提供的阈值/系数；
  禁用路线不重新归一化，Token 预算继续仅在显式 fusion 下生效。
- 实体关闭：不展开 observations.entities，原有普通检索评分、返回 DTO 和 trace candidate 形状不变。
- 时间开启：发现标签与所有评分路共同受当前版本 `[valid_from,valid_to)` 限制，沿用已捕获 UTC 点及微秒；
  不产生时间票、不回退旧版本、不改变 #10 的任务职责。

评分、实体发现、当前版本与正文投影在同一 SELECT，保持项目/current指针/active约束。
配置快照仍在嵌入等待前捕获；等待期间改配置不改变本次实体开关。
实体自身不调用模型；vector 开关开启仍可调用既有 embedding，失败时实体和关键词可独立工作。
默认读取不修改 Observation/Belief/版本/强度；显式读时强化沿用原边界。

## 轨迹与兼容

参与评分的实体候选在内部 retrieval_traces.candidates 增加
`entityMatch: {policy: 'query_labels_v1', score: number}`；显式融合另有原 rankFusion 的 entity rank/score/contribution。
不保存匹配标签、标签列表、来源正文或新的内容快照。query_text 沿用既有查询轨迹，并非本轮新增字段。
截断候选沿用 token_budget；无候选池仍为 []，无法从空池反推匹配参数。

公共 Recall DTO 保持原有 strict schema：响应投影只剥离新增 entityMatch，分数/引用/选择等原字段仍须通过完整校验。
实体分留在数据库内部，客户端不能通过新增请求字段选择标签或覆盖 flags。
OpenAPI 只更新 flags PUT 的未支持字段清单，既有 paths/components 和 recall响应形状不改。

## 发布、回滚和验证

保持实体关闭部署新代码，先验证旧召回与队列，再通过 GET revision + CAS PUT 启用。
回滚时先关闭 retrieval_entity 再切换旧代码；旧代码会拒绝 true，直接回滚可能使检索降级/提取任务失败。
若已回滚，旧版 GET/PUT 仍可修为 false；不重置配置 revision/死信，不删除历史轨迹。
本轮没有数据迁移，也不执行真实服务重启、生产部署或付费模型验证。

真实 PG 测试覆盖普通/显式两种引擎、16种 source/time 组合、模型调用计数、Unicode/字面/重复/坏JSON、
项目/当前/来源隔离、时间微秒端点、标签/候选池上限、预算、冻结配置、长查询、整行只读以及真实聊天 prompt 注入。
真实 TCP PUT→recall 使用提交的 OpenAPI 和独立 Ajv 验证原始响应，实体开关不会使旧 strict 客户端收到新键。

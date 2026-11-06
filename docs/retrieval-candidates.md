# 候选读取与时间过滤（#9，第二切片）

内部 `readCandidateScores(db, input)` 从真实 PostgreSQL 表召回并复用 [SQL 融合基座](retrieval-fusion.md)。当前支持**向量 / 关键词 / 实体三种分数来源，加当前版本的时间过滤**。这不是三路之外再给所有事实添加一个“时间票”；Issue #9 明确描述的是作用于当前 BeliefVersion 的 valid_from / valid_to 过滤。

**尚未接入生产 retrieve()、chat 或 recall HTTP。** 现有 A0 两路加权路径、默认值、拒答、API / trace schema、配置管理 API 都不改变；captureFeatureFlags 仍拒绝开启未实现字段。#9 / #22 保持打开，实体 / 时间公开接线、Reranker、只读消解、Token 预算及截断轨迹留后续。B 阶段实体关联图和自然语言时间理解不在本轮。

## 内部契约

input 是严格的普通配置对象：

- projectId：UUID，归一为小写；不接受额外资源名或 SQL 标识符。
- fusion：直接使用 #125 的 `RankFusionOptionsSchema`，包括完整受信十键 flags、rrf / weighted、每路 / 总上限和相应系数，避免另一份配置定义。
- query：可选，默认空串，trim 后最多1000字符；仅关键词路使用。不是 tsquery 语言或 SQL。
- entities：可选，默认空数组，最多32个非空标签，每个 trim 后最多128字符，拒绝控制字符 / 孤代理。与存储标签的标准化及去重在 SQL 内完成。
- embedding：可选 / null，形如 `{model, vector}`。vector 是1024个有限数字的非零数组；model 是 Provider 工厂选出的**原始 ID**，最长256字符，不做 trim / 大小写改写，拒绝纯空白和控制字符。模型解析、用量、配额和付费调用由未来上游执行；此函数既不查询 Provider，也不生成 embedding。
- validAt：可选的 UTC ISO 字符串，只接受 Z、最多6位小数、合法日历且年份0001..9999。时间开关开启时必须提供；关闭时该值不参与 SQL 过滤。验证日历时不把时间点重新序列化，原始微秒直接绑定为 timestamptz；当前不接受偏移量或自然语言。

集合在 Zod 遍历前先限长，防止用巨型实体 / 向量数组耗费逐项验证。非法输入在读取 db.execute 前返回固定 INVALID_RECALL_INPUT。参数 / flags / 数组由 Zod 复制，首次异步数据库等待前完成 SQL 构造，调用方随后改对象不能换项目、分数模式或查询条件。无可用输入源时返回空数组且不查询数据库；单开时间过滤不会凭空产生候选。

返回字段与 #125 相同：belief_version_id、numeric 文本 fused_score、只含 route/rank/score/contribution 的 components。当前 route 仅有 vector / keyword / entity。不返回正文、实体文本或历史来源副本；不是最终回答、拒答或授权回执。

## 范围与候选源

同一 SQL 语句内先确定 eligible，再执行各路和融合，使用同一个语句快照：

- beliefs.project_id 匹配请求项目，status=active；deleted / retracted / superseded / expired 均不进入池。
- current_version_id 必须匹配 bv.id **且 bv.belief_id=b.id**；拒绝指向他方信念的损坏指针，不遍历历史版本。
- 当前 bv.recorded_to 必须为空，关闭的版本即使被损坏指针设为 current 也不召回。
- 时间开关开启时，统一要求 `valid_from <= validAt AND (valid_to IS NULL OR validAt < valid_to)`。左闭右开，端点 / 零长区间 / 微秒均按 PG 判断。它作用于所有分数来源，不读 Observation.valid_time 或 recorded_from。

这是**当前版本的现实有效时间过滤**，不是历史 as-of / recorded-time 查询：如果当前版本从2026年生效，查询2025年的 validAt 不会自动回退到已关闭旧版本。时间开关关闭时不作有效期筛选；#10 的默认过期行为仍另行实现，不因本模块改变。

### 向量

只在 flag 开启且提供 embedding 时构造向量查询。先按最大绝对值缩放，再用 Math.hypot 做单位化，保留余弦方向，避免把1e300之类有限数字直接塞进 float4；全零 / NaN / Infinity 预先拒绝。只匹配 `memory_embeddings.model = embedding.model`，不混用同维度的不同模型索引。

同版本同模型多行先过滤非有限距离分（含零存储向量产生的 NaN），再取最佳分，按分降序 / 版本 UUID 升序截每路池。没有 embedding 时该路为空，不隐式调用模型或降级生成别的向量。

### 关键词

沿用 `to_tsvector('simple', value::text)` 和 `plainto_tsquery('simple', query)`，保留 AND 语义；不会解析用户 SQL / 自定义 tsquery。按原始 ts_rank / UUID 截池后，用入池最大值归一化。池上限至少1，最大值与同一 eligible 查询的最高匹配值一致；空集 / 零分用 nullif 防除零。simple 仍不切中文词，不宣称中文召回升级。

### 实体

只读当前版本的 `source_observation_id → observations.entities`，并独立要求 Observation.project_id 匹配请求项目。损坏跨项目来源不会使外项目实体标签参与分数；不使用同信念历史 Observation、subject/value 中的别名或隐式实体图。

标签两侧使用 PostgreSQL `normalize(NFKC) → btrim → lower(collate C)` 后做**相等**匹配，无 LIKE / 正则 / 子串。C 小写规则不承诺完整 Unicode case-fold；NFKC 可统一全角 ASCII，中文等标签按规范化后字面相等。查询同义词或实体关联不是本轮功能。

只遍历 JSON 数组中的字符串；NULL、非数组或数组中的数字 / 对象 / null 忽略。分数是“命中不同查询标签数 / 不同查询标签总数”；查询 / 存储重复不会增加佐证或权重。比如查询 PostgreSQL、Redis，而当前来源仅含重复 PostgreSQL，则分数0.5。

## 开关、资源与安全责任

vector / keyword / entity 各自在构造 SQL 前门控；关闭的分数源不会进入相应表 / 文本 / JSON 计算分支。时间 flag 只切换公共 eligible 条件，不发 time 路投票。测试覆盖16种组合，但这不等于生产四路与零付费调用矩阵已经终验：模型执行前的门控和公共入口仍由后续编排负责。

每路去重后在来源 SQL 即限制 perRouteLimit（1..200），然后同样交给 #125 融合层防御性截池；最多返回 maxCandidates（1..800）；由于这里只有三个分数来源，实际不同版本最多600个，通用融合层的800上限不会制造额外时间候选。关键词、实体、向量扫描及排序 / JSON 展开成本依然取决于项目数据量，**候选有界不等于数据库 CPU / I/O 或单行正文长度有硬上限**。无新索引 / 迁移，不承诺生产大库性能；后续接线需要相应预算与监测。

项目条件保证本次数据库候选属于该项目，不替代 HTTP Bearer / 项目授权；这些 ID 也不是后续无作用域读取的凭据。未来取正文 / 引用时必须继续复查项目、状态和引用；单语句快照不保证之后另一次查询仍是同一状态。

本函数不写 observation / belief / belief_versions / trace，不修改 confidence / salience / importance，也不执行读时强化；即使其他非候选 flags 为真也不代替它们的 owner 执行行为。只读事务测试和逐字 strength 不变断言覆盖这一点。数据库自身异常由调用方的既有安全错误边界处理，不能回显 SQL / 参数 / 原始异常。

## 验证与回滚

测试只创建 / 清理随机项目下的自有夹具，不读真实 Provider 或环境文件。覆盖两个项目、损坏 current 指针 / 来源、完整当前与历史版本、软删除 / 撤回 / 关闭版本、未知实体 JSON、重复 / Unicode / 字面匹配、选定模型、重复 / 零向量、极端查询尺度、关键词 AND、端点与微秒、16开关组合、有界输出、配置捕获和无写入。

当前变化是内部候选读取组件及共享内部融合 schema 的导出，不增加 API、默认配置或应用接线。回滚移除新仓储 / 输入校验 / 测试 / 本说明并恢复 fusion schema 的私有声明即可，无数据回退。#9 的默认 Reranker、拒答校准、salience优先预算、读时消解与截断 trace 尚未验收，#22 也不关闭。

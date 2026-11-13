# 写入操作与检索专用开关

#22/#9 的部分接线。Gate、PENDING retry、ingest、Resolver、legacy/applyExtraction 和持久 EXTRACT
在捕获开关时显式指定受信 `operation: "memory_write"`。写入操作接受并完整记录 reranker=true，
但不执行精排、不选择精排 Provider、不预留 Score 配额、不生成精排用量。
这不等于给写入操作授权调用 Score；它只让不相关的检索开关不再阻塞写回。

原始有效快照及 revision 保持不变，仍在模型调用前捕获并冻结，沿 Gate/Resolver 传递。
不把 reranker 改成 false，不在轨迹中伪造配置，也不跳过 Gate、权威、脱敏或事务协议。
未绑定检索及未声明操作范围的调用仍拒绝 reranker=true；decay/read_time_resolution 在写入
范围也继续 fail-closed。这个操作标签只由服务端源码传入，HTTP 和模型输出不能提供。

默认值、管理 API 拒绝列表、正式启动器、数据库结构及公开 API 均未改变。不关闭 #9/#22：
默认开启、正式配置来源、质量和完整消融矩阵仍未验收。旧聊天库绑定文档中“写回仍被全局
reranker 阻塞”的边界由本轮解决，但不代表全局开关现已可以从管理 API 启用。

私有随机 PG 数据库测试覆盖 Gate 开关、秘密脱敏、PENDING、legacy/durable 提取和消解轨迹。
测试在提取模型等待期间更新其他开关，确认当前写入沿用原快照；没有真实 Provider/付费模型。
回滚会恢复旧的全局 reranker=true 写入拒绝行为；需要先在实验配置中关闭它，无迁移回滚。

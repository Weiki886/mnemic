# 记忆 JSONL 格式基座（#25，拆分 1/3）

本轮只提供服务端内部的有界编码 / 解码器，**没有导出 HTTP API、下载按钮、文件写入器或数据导入器**，不会访问数据库、模型、磁盘或写审计。不能将函数可编码解释为已经可以导出整个实例，也不能据此关闭 #25。

后续拆分分别负责：一致性快照读取 + 鉴权下载 / 导出审计 / OpenAPI；PostgreSQL 备份脚本 + 隔离库清空恢复演练。现有用量 CSV/JSON 导出仍是另一类能力，不替代记忆归档。

## 表范围与数据边界

格式 v1 固定覆盖 #3 建立的八张核心表名：

- projects
- conversations
- messages
- observations
- beliefs
- belief_versions
- memory_embeddings
- audit_log

调用方提供每个来源行的完整 `to_jsonb(row)::text`，包括当前 schema 新增在这些表上的列。codec 不投影 / 删除行内容：版本、双时态时间、Observation.evidence_id、current_version_id、supersedes_version_id、source_observation_id、消息 / 附件元数据和向量可保留原值。未知的内层业务字段也不以当前默认值补造或丢弃。

表名单不包含后续 Issue 新增的 Provider 配置、特性开关、用量、任务、PENDING、检索 / 消解轨迹等表；**这不是完整数据库备份**。后续需要可恢复的整库备份，而不能把本格式当作 pg_dump。将来格式扩张需显式版本决策，不能默默加入 Provider 密文或私钥。

归档可能含原始会话、任意 JSONB 和原始 audit_log 元数据中的敏感内容；本 codec **不脱敏、不加密、不提供权限边界**。它不复用公共审计 API 的安全投影，因为那会丢失备份字段。实际导出入口必须单独落实鉴权、项目范围 / 引用校验、私密传输 / 文件权限与导出审计，不能直接公开这些函数返回值。不要把真实归档放进仓库、Issue、PR、日志或截图。

## v1 封装

UTF8、LF JSONL，最后一行也必须有 LF：

1. manifest：`kind="manifest"`、`format="mnemic-memory-jsonl"`、`schema_version=1`、UUID export_id、带时区 ISO created_at，以及按上方顺序列出的完整 tables。
2. 零或多条 row：`kind="row"`、固定表名 table、**字符串** row_json。
3. 唯一末行 end：`kind="end"`、record_count、八表 counts（包括零行表）与小写 hex sha256。

示意行（不是完整可校验归档）：

```json
{
  "kind": "row",
  "table": "projects",
  "row_json": "{\"id\":\"01900000-0000-7000-8000-000000000001\",\"name\":\"demo\"}"
}
```

row_json 是有意单独保留的 PostgreSQL 原始 JSON **文本**，不是被 JS 解析后重新序列化的对象。这样嵌套的 `9007199254740993`、高精度 numeric 和六位小数时间不会被 JS number / Date 舍入；原始字段顺序、空白和字符串转义也保留。消费方如果自己 `JSON.parse(row_json)` 再写回，仍可能失去数值精度；应使用支持精确数值的解析器，或将原始字符串作为绑定参数交给 PostgreSQL 的 JSONB / 类型化重建处理。不要用字符串拼接 SQL。

封装字段严格拒绝未知项 / 版本 / 表名。内层 row_json 只验证是无物理换行的 JSON object 且有 UUID id，不是数据库行 schema、FK、项目隔离或来源语义验证器。相同 table/id（不区分 UUID 大小写）重复被拒；不同表可有相同 UUID。codec 不检查是否漏了某行、引用是否闭合、数据是否来自同一快照，也不保证表行顺序适合直接恢复环形 FK。created_at 是调用方声明的归档时间，不是数据库事务快照证明。

sha256 覆盖 manifest 与所有 row 的实际 UTF8 字节，包含各自 LF，不包含 end 行。数量 / 每表计数 / hash 不一致、缺 end 或缺最后 LF 都拒绝。它用于检测偶发损坏和截断，**不是签名、加密或真实性证明**：能修改文件的人也能重算 hash。

## 资源与错误

固定 v1 上限：10000 条 row、每个编码后物理行 1 MiB（不含 LF）、整个文件 16 MiB（含 LF）。元数据和 end 也计入预算，JSON 转义扩张按实际 wire 字节计算；UTF8 多字节字符不能按 JS 字符数冒充字节。空归档有效，但仍需 manifest、完整零计数和 end。

编码器先限制集合数量，再逐行验证；字节限制在内层 JSON 解析前执行。解码器先限制输入字节，再 fatal UTF8 解码与逐行限制；不接受 BOM、CRLF、空行、部分文件、未知封装或自动修复。超限整体失败，没有截断、分页续传或部分成功。上限限制的是接受的格式 / 载荷，不是整个进程的精确内存或 CPU 硬隔离保证。

仅抛固定 `MemoryExportError`，code 为 EXPORT_INVALID、EXPORT_LIMIT_EXCEEDED 或 EXPORT_INTEGRITY_FAILED，不附原始 JSON / parser 异常。解码结果的 metadata / tables / records / counts 被独立复制并冻结，row_json 保留原文本；编码得到的 Buffer 是普通可变字节，不宣称不可修改。内部入口为 `apps/server/src/data-export/codec.ts`，未注册 shared SDK 或公开路由。

## 验证与未交付项

纯测试覆盖八表、精确数值 / Unicode / 转义、微秒、空归档、重复、未知字段、数量 / hash、UTF8 / framing、超限提前拒绝和调用方不可回改。PG 测试为八表创建独立夹具，包含两个版本、来源链、向量、NULL 与任意审计元数据；经 codec 后对每行用 **SELECT** `jsonb_populate_record` 重建 composite 并比较完整原始 JSON，不对现有表执行恢复写入。数据库会按会话时区表示 timestamptz，验证保留原始文本、微秒与同一时刻，不强制原始行输出 UTC。

这证明格式基座可保留所提供的关键数据，**不等于已经完成“备份 → 清空 → 恢复”演练**。快照仓储、授权导出与审计、完整恢复脚本 / 演练、版本兼容与实际大库操作均留后续。没有迁移、新依赖、运行时调用方或生产行为变更；回滚只移除 codec、格式定义、对应测试和说明，已有业务与用量导出不变。

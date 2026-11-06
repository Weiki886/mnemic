# 记忆 JSONL 导出（#25，拆分 1/3 + 2/3）

服务端现提供内部 codec 和显式实例级下载 API `POST /v1/exports/memory`。另有整库 PostgreSQL 备份脚本与“备份 → 清空 → 恢复”隔离演练现由[备份恢复文档](backup-recovery.md)的拆分 3/3 提供。已有用量 CSV/JSON 导出是另一类能力。

## 授权下载与审计

这是**实例所有者操作**：现有全局 Bearer Token 可读取所有项目及八张核心表，不是项目成员鉴权；没有项目、会话、表名或字段筛选。严格 JSON 请求体只能为 `{"scope":"instance"}`，查询参数不接受任何字段，不能用传入 project_id 假装隔离。只需数据库，不依赖 master key，不解析 Provider、不调用模型。无 DB 时路由不存在；GET 不执行导出。

在已配置 Token 的终端运行（`MNEMIC_AUTH_TOKEN`、`MNEMIC_BASE_URL` 由操作者配置；不把 Token 放进 URL）。示例使用 `umask 077` 和新建私有目录保护本地文件；服务端不创建本地文件。真实部署须用 HTTPS 或受控本机连接。

```sh
umask 077
archive_dir=$(mktemp -d)
curl --fail-with-body --silent --show-error \
  -X POST "${MNEMIC_BASE_URL}/v1/exports/memory" \
  -H "Authorization: Bearer ${MNEMIC_AUTH_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"scope":"instance"}' \
  --output "$archive_dir/memory.jsonl"
```

仅在 curl 成功且文件通过完整格式 / hash 校验后才作为归档使用；失败时该文件可能是 problem+json 或传输残片，不是可用备份。响应为 `application/x-ndjson`，带 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff` 和仅含服务端 UUID 的 attachment 文件名。没有 UI、客户端 SDK 或导入器。

准入沿用 IP 限流 → 全局 Bearer → Token 限流，早于请求体解析及数据库访问。路由 hook 要求 application/json（可带 charset）；缺失 / 其他媒体类型415。非法 JSON、非实例范围、未知 body/query 字段400；没有配置 DB404；HTTP 请求体或归档超限413；根限流429（Retry-After）；数据库、编码完整性或审计失败固定500。沿用 problem+json，schema 错误带字段详情。no-store 在路由 onRequest 设置，根鉴权 / 限流等更早响应遵循各自已有规则。

一次 **REPEATABLE READ** 事务覆盖八表全部读取与审计：按固定表顺序及 UUID 分页，每批最多8行；SQL 端先检查 `to_jsonb(row)::text` 字节，超大行不传给 JS；JS 逐行累计实际转义后的 wire 字节，最后 codec 校验 manifest/footer 总预算。每条 SQL statement_timeout=5s、lock_timeout=1s；这些是单语句上限，不是整个请求的硬时限，也不保证进程精确内存上限。超限整体拒绝，不能偷偷截断或用不一致的多页下载替代快照；大实例请等待整库备份方案。

快照包含 active/deleted/retracted 信念及全部历史版本，不过滤软删除内容；原始引用、JSONB、时间与向量不被修复或改写。不验证历史 JSONB 引用的业务有效性，也不补齐这八表之外的对象。并发事务在第一次快照建立后提交的新行 / 更新不混入后续表；manifest.created_at 为该事务内查询的数据库时间，不是 WAL/LSN 恢复点。

完整 payload 编码成功后，同事务写 `audit_log`：actor=server、action=memory.export、target=export_id、decision=prepared；meta 仅含 version/scope/format/schema_version/export_id/rows/bytes/sha256，不复制正文、路径、凭据或下载内容。审计提交成功才设置 attachment 并发送文件；审计失败回滚，无文件返回。**prepared 不证明客户端收到或保存文件**，COMMIT 附近断线可能留下回执；手动重试是新的导出及新回执，不自动重放。

本次回执在快照读取后插入，故不在自己的文件中；之前的原始审计记录正常包含。可通过 `GET /v1/audit-log?action=memory.export&target=<export_id>` 查询安全投影（仍需全局 Token）。实例级事件没有 meta.project_id，按 project_id 筛选会排除它。

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

归档可能含原始会话、任意 JSONB 和原始 audit_log 元数据中的敏感内容；本 codec **不脱敏、不加密**，下载入口使用全局实例所有者权限。它不复用公共审计 API 的安全投影，因为那会丢失备份字段。本下载入口有意提供实例全量原始数据，不采用公共审计安全投影；若未来新增项目级导出，必须另做作用域和 JSONB 引用校验。操作者仍需保护私密传输与文件权限。不要把真实归档放进仓库、Issue、PR、日志或截图。

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

编码器先限制集合数量，再逐行验证；每行 wire 字节限制在内层 JSON 解析前执行，累计文件预算在接收各行与 end 时检查。解码器先限制输入字节，再 fatal UTF8 解码与逐行限制；不接受 BOM、CRLF、空行、部分文件、未知封装或自动修复。超限整体失败，没有截断、分页续传或部分成功。上限限制的是接受的格式 / 载荷，不是整个进程的精确内存或 CPU 硬隔离保证。

仅抛固定 `MemoryExportError`，code 为 EXPORT_INVALID、EXPORT_LIMIT_EXCEEDED 或 EXPORT_INTEGRITY_FAILED，不附原始 JSON / parser 异常。解码结果的 metadata / tables / records / counts 被独立复制并冻结，row_json 保留原文本；编码得到的 Buffer 是普通可变字节，不宣称不可修改。内部 codec 入口为 `apps/server/src/data-export/codec.ts`；下载入口在 `data-export/routes.ts`，未增加 shared SDK。

## 验证与未交付项

纯测试覆盖八表、精确数值 / Unicode / 转义、微秒、空归档、重复、未知字段、数量 / hash、UTF8 / framing、超限提前拒绝和调用方不可回改。PG 测试为八表创建独立夹具，包含两个版本、来源链、向量、NULL 与任意审计元数据；经 codec 后对每行用 **SELECT** `jsonb_populate_record` 重建 composite 并比较完整原始 JSON，不对现有表执行恢复写入。数据库会按会话时区表示 timestamptz，验证保留原始文本、微秒与同一时刻，不强制原始行输出 UTC。

这证明格式基座可保留所提供的关键数据，**不等于已经完成“备份 → 清空 → 恢复”演练**。快照仓储、授权下载与审计已交付；完整 PostgreSQL 备份 / 隔离恢复演练见[备份恢复文档](backup-recovery.md)。JSONL 导入兼容与实际生产大库操作未交付。下载测试在随机私有 schema 的八张核心表副本上运行（复制真实列 / 默认值 / CHECK / 索引，不复制 FK），不读取或清理共享库的其他项目或 Provider。原有 codec PG 测试继续验证真实 FK 表上的来源链。新增并发提交验证、失败审计回滚、全版本 / 精度、真实 TCP + 提交 OpenAPI 校验、准入与字节上限。无迁移、新依赖；回滚本次路由注册、仓储、memory.export 审计契约及 OpenAPI 变更即可停止新导出，保留历史回执且不影响既有业务 / 用量导出。

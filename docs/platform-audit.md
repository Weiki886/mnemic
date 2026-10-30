# 平台审计（#23 拆分 3/3）

`audit_log` 延续 #3/#15/#34/#22 的表和既有记录。本轮补齐已有配置写入口、记忆软删除/恢复和当前数据导出入口，并提供全局操作者查询。使用 #20 的同一个 Bearer Token；`actor: server` 表示已鉴权的服务端操作，无法区分多人身份。CLI 审批仍标 `client_reported: true`，不能当作工具已执行或服务端授权的证据。

## 事件与原子性

| action                             | target        | decision   | meta 的内容                                                    |
| ---------------------------------- | ------------- | ---------- | -------------------------------------------------------------- |
| `provider.create`                  | Provider UUID | `created`  | 版本、协议枚举、已配置槽位名                                   |
| `provider.update`                  | Provider UUID | `updated`  | 版本、实际修改的字段名、修改前后协议枚举                       |
| `flags.update`                     | `server`      | `updated`  | 既有版本、revision 和 before/after 布尔快照                    |
| `belief.delete` / `belief.restore` | Belief UUID   | `updated`  | 版本、项目 UUID、修改前后状态                                  |
| `usage.export`                     | Project UUID  | `prepared` | 版本、项目/会话 UUID、格式、时间窗、本页行数、输入和下一页游标 |

新写入通过严格 schema，拒绝额外字段。Provider 名、端点、模型名、密钥明文/密文、记忆正文、导出内容均不复制到新审计中。库的 `createProvider` 保持允许空槽位的兼容行为，审计记空数组；HTTP 创建依然要求至少一个槽位。

配置创建/修改、记忆状态更新与对应审计处于同一事务，审计失败则不提交变更。相同 Provider 值的 PATCH 和 flags 的无变化/冲突不产出变更记录；删除/恢复的 404/409 不伪造成功。状态修改的调试事件在事务提交之后发送，审计失败时没有成功轨迹。

用量导出按**每个 HTTP 分页请求**准备完整 JSON/CSV、验证可序列化，再在同一数据库事务写审计，提交后才发送正文。写审计失败返回 500 problem+json，不返回导出数据或附件头。空页也记一条，重试和后续页各自有记录。`prepared` 只表示服务端已准备该页，网络中断、客户端收到/落盘情况不在证明范围。普通用量查询不记导出事件；非法作用域或参数不产生导出回执。

本轮覆盖当前存在的导出 `/projects/:projectId/usage/export`（JSON/CSV）；#25 的记忆导出尚未实现，将来需同步增加它的事件和查询契约。不会虚构尚不存在的入口。未记录环境变量编辑/服务启动、鉴权失败或全部只读访问，不是合规审计/防篡改存储，也不添加历史回填。

## 查询 API

`GET /v1/audit-log`：全局操作者范围，鉴权在参数解析/数据库访问前；所有业务响应和错误均 `Cache-Control: no-store`。没有匿名读接口、写入接口、CLI/Web 页面或原始表转储。

```sh
curl --get http://127.0.0.1:3000/v1/audit-log \
  -H "Authorization: Bearer $MNEMIC_AUTH_TOKEN" \
  --data-urlencode 'action=belief.delete' \
  --data-urlencode 'limit=50'
```

可选过滤：`actor`（server/cli/gate）、`action`（表中动作、redact、approval.file.read/create/overwrite/delete、approval.shell/invalid）、`target`（UUID、server、sha256 哈希、candidate.value/subject/attribute/entities）、`project_id`（UUID）、`from`、`to`、`after`；其他参数 400。项目筛选只是筛选审计自身的 `meta.project_id`，不是权限模型，且不会推测旧脱敏事件或全局配置的项目归属。

- 默认最近 30 天，时间 `[from,to)`；每次请求窗口须大于 0 且不超过 366 天。ISO 时间最多毫秒精度。更早历史可显式按窗口分段查询。
- `limit` 为 1–200，默认 50；不接受空值、小数、指数形式。响应含 `from/to/limit/items/next_after`。
- 按数据库 `(ts,id)` 升序，`ts` 输出 UTC 六位小数；游标是最后一行 UUID，服务端回查原始 PostgreSQL 微秒时间，避免 JS Date 截断造成漏读/重复。
- 下一页传 `after=next_after`，**同时沿用上一页回声 from/to 与其余筛选**。游标不在当前筛选窗口内返回 404；末页 `next_after: null`。分页不是跨请求数据库快照，不能保证捕获后插入的历史时间行。

记录含 `id/ts/actor/action/target/decision/meta/metadata_omitted`。查询不会相信 JSONB：已知平台事件按严格 schema 验证；既有脱敏和 CLI 审批还核对各自有限字段/来源标记/包络一致性。字段不兼容、未知事件或超过 64KiB 的元数据，只返回 `id/ts` 和 `metadata_omitted: true`，其余字段为 null，保留分页位置，不回显未知正文，也不让一行坏记录使整页 500。数据库先限制投影大小，应用每次最多取 `limit+1` 行。64KiB 是字段投影上限，不是对数据库内部 JSON 解压或查询成本的硬承诺；原始记录不被改写。

未知写入方需显式扩展契约后才能展示内容，不能依赖 API 原样转发任意 meta。旧记录中的未知字段不会用当前默认值补造；需要原始取证时由数据库操作者按自身权限处理。查询本身不新增审计行，避免递归增长。

## 部署、验证与范围

迁移 0016 仅给 `audit_log(ts,id)` 建幂等索引，不改旧列、旧值或表；先迁移再启动新服务。普通建索引期间可能等待/阻塞表写入，应在现有单机维护流程执行。无新依赖或启动变量。回滚服务会停止本轮新事件/查询，已有审计行和索引可以保留。

验证包括真实 PG 的并发删除、审计写失败回滚、JSON/CSV 分页导出回执、未知元数据/伪造审批投影、跨筛选游标拒绝与微秒分页，以及真实 TCP 鉴权查询；不触付费模型。审计范围内的操作者/时间/对象/结果均直接查表断言。#106 请求限流、#107 模型日配额与本轮审计查询合入后，#23 三条验收闭环；后续身份体系、审计保留/归档策略和新导出入口仍按各自 Issue 实施。

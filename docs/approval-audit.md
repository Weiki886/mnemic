# 审批审计（#34，拆分 3/3）

沿用 [策略基座](approval-policy.md) 和 [CLI 交互](approval-interaction.md) 的保守矩阵，
补齐审批结果落库与查询。前置交互与授权存储已由 #89 合入 main；本增量也以 main 为基线，合入后关闭 #34。

## 决策与信任边界

用户需要知道某次请求依据什么模式、选择和规则被允许或拒绝。备选为仅本地日志、
新增专用审计表或复用平台表。本轮选择现有 `audit_log`（#3 建表、#15 起有写入方），
按写入方约束 metadata，不增加第二份审计存储或迁移。

**这是经过 Bearer 鉴权的 CLI 客户端声明，不是执行记录、签名证明或远程批准接口。**
服务端固定 actor=`cli`，写入 `client_reported=true`、version=1；不能用 HTTP 输入申请执行或改变权限。
同一 Token 仍是项目现有的单用户权限模型，不提供 RBAC 或多租户身份断言。
服务端只检查数据契约及项目范围，不声称可以验证远端机器上的真实路径或真实键盘行为。

## 记录内容

- `actor`：服务端固定 `cli`。
- `action`：`approval.file.read/create/overwrite/delete` 或 `approval.shell`；非法请求为 `approval.invalid`。
- `target`：`sha256:` 加目标摘要，无有效目标时为 NULL。
- `decision`：allow / deny。
- `meta`：event/request/project/session UUID、模式、操作、原因、人工选择的 once/session/permanent、
  root/target/command SHA-256 摘要、目标依据 canonical/requested/none、客户端声明与格式版本。
- `ts`：数据库生成，查询按 ts、id 升序。

命令原文、目标/根目录明文、文件内容、Token 和自由文本错误都不会进入这个协议或审计表。
canonical 表示实际评估目标；拒绝时可能只有 requested 摘要，不能把它误读成已验证的真实路径。
摘要可用于关联，**不是加密或匿名化**，低熵路径/命令仍可被猜测。CLI 本地授权文件仍依 2/3 保存路径。

## 返回授权前的流程

`ApprovalController.create` 必须传入 audit sink；正式 CLI 绑定经过认证的 typed API，
仅隔离的策略/界面测试显式提供 no-op。没有默认“忽略审计”的生产降级。
请求入口只解析一次并持有不可变操作快照，后续提示、摘要和复核都不重新读取调用方对象。

1. 本地策略判定；需要人工时等待选择，不把等待中的 ask 当成已完成的授权。
2. 记录拟返回的 allow/deny，等待完整事件回执；CLI 校验全部字段与 event_id，5 秒超时，不自动重发。
3. 若审计确认且拟允许，再检查模式、会话及当前目标；通过后才发布本次会话/永久规则，发布后再检查。
4. 等待期间被取消、目标变化或规则发布失败，返回拒绝，并尽可能追加同一 request_id 的拒绝观察；
   已发布的新规则补偿撤销。审计失败则返回 `audit_error`，不发布本次新规则，不返回授权。

因此同一 request_id 可能有“拟允许”和后续“取消/变化/存储失败”两条观察，event_id 不同。
**看到一条 allow 不能证明允许已送达，更不能证明 Tool 执行。** API 响应丢失时，服务端也可能已存记录；
客户端仍按未确认拒绝。审计本身不可用时无法承诺拒绝记录已落库，也没有离线 outbox 或自动重放。
允许结果有最后一次同步模式/会话校验，随后不再异步等待才提交决定；之后的状态变化不能把旧结果
当作执行凭证，执行器仍须在使用时复核。关闭时等待答案任务独立由 drain 负责。

持久存储发生持续 I/O 故障时补偿撤销也可能失败，沿用 2/3 的人工检查要求，不能把错误当作磁盘无规则。
当前仍没有文件/命令执行器；allow 是元数据快照，不是 OS sandbox。后续 #26/#30 必须在执行系统调用处重新核验。

## HTTP 与 CLI 查询

```text
POST /projects/:projectId/approvals
GET  /projects/:projectId/approvals?limit=50&offset=0

/permissions history [--limit 1–200] [--offset 非负安全整数]
```

POST 只接受严格结构的摘要事件，项目 UUID 必须与 URL 一致，项目须存在。
相同 event_id、相同内容重交返回原回执，不再写行；相同 ID、不同内容返回 409，绝不覆盖平台旧事件。
GET 仅取当前项目、固定 actor/action 和审批格式标记的记录，排除脱敏等其他审计；UUID/分页非法为结构化 400，
不存在的项目为 404，鉴权在数据访问前执行。所有响应 `Cache-Control: no-store`。

CLI 展示 event_id、request_id、时间、操作、决定、原因、选择及目标摘要，明确标注“客户端声明，非执行记录”。
读取历史不加载本地授权目录、不调用模型，也不修改授权。服务端没有原始路径可回显。
默认 50、上限 200，稳定 offset 分页；并发写入不是跨页快照，A0 未实现保留策略、复杂过滤或专用查询索引（归 #23）。

## 取消、关闭与验证

记录回执期间按 ESC/Ctrl+C 取消本次授权，不提交退出；取消也不代表已发生的审计网络请求被撤销。
关闭时先 dispose，等待正在处理的审批记录及授权保存/撤销结束；HTTP sink 每次最多等待 5 秒，
本地文件系统仍受操作系统 I/O 行为影响。存在未确认审计时 CLI 最终返回非零退出码并给出检查提示。

真实 PG 测试覆盖 actor/action/target/decision/meta、幂等冲突、鉴权、项目隔离、分页与跨项目负面场景。
端到端测试把 CLI 控制器经 typed API 和 Fastify 注入传输接到真实 PG，验证授权矩阵、查询及数据库故障拒绝。
它没有启用 Tool、没有执行示例 shell，没有调用付费模型，也没有读写真实家目录授权存储。

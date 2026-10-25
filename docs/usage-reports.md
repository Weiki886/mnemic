# 用量查询、导出与估价（#36，拆分 2/3）

基于 [调用记录基座](model-usage.md)，本轮提供已鉴权的只读 API 与 typed client。
不触发模型请求，不关闭 #36；CLI `/status`、独立用量命令和 Web 面板留给 3/3。
费用是操作人员提供单价后的 token 估算，不是服务商账单。

## 查询

`GET /projects/:projectId/usage`，须带现有 Bearer Token。

| 参数            | 含义                                                                    |
| --------------- | ----------------------------------------------------------------------- |
| conversation_id | 可选物理会话 UUID；不属于该项目返回 404                                 |
| from / to       | 带时区的 ISO 时间，精度最多毫秒；from 包含、to 不包含                   |
| group_by        | day（默认，UTC 日）、model（Provider/模型/槽位）、purpose、conversation |
| group_limit     | 默认 200，上限 1000；只限制分组详情，始终保留完整 totals                |

默认 to 为查询时刻，from 为 to 前 30 天；有 to 无 from 时也向前取 30 天。
范围必须大于 0 且不超过 366 天；from/to 及默认派生边界均须在归一化 UTC 年份 0001–9999 内，
窗口在查询入口固定一次。非法 UUID、时间、逆序、额外字段、超限参数返回带 errors 的
problem+json 400。项目/会话/游标不在当前范围返回 404，鉴权先于参数与数据访问。

响应含实际 UTC 窗口、币种/价格配置指纹、totals 与 groups。`groups_truncated` 明示截断，
完整 totals 与已返回分组来自同一个 SQL statement snapshot；聚合在 PostgreSQL 执行，
不会先将整个项目的调用行加载到 JavaScript。

调用次数按 success/error/aborted 保留；五种 token 指标分别返回：

```json
{ "reported": "90071992547409930", "missing_calls": 2 }
```

`reported` 只加总已报告值；配合 missing_calls 读取，不能当成全部实际消耗。
没有报告值时 reported 是 `"0"`，覆盖缺口仍保留；embedding completion 的“不适用”NULL
同样计入未报告次数。累计 token、累计毫秒与逐行数值一律为十进制字符串，避免大数精度丢失。
调用次数为安全整数 JSON number，provider 的 total 不重算为 prompt+completion。
没有用量行时 calls=0、groups=[]，不凭空制造记录或费用。

## 显式价格配置

可在服务端环境配置 `MNEMIC_USAGE_PRICES_JSON`；未设置或入口读取为空字符串时不估价。
Docker 部署也转发该可选变量。配置错误在启动时以固定提示拒绝，不回显配置原文。
以下是格式示例，**数值仅用于说明，不代表任何供应商的真实定价**：

```json
{
  "currency": "USD",
  "rates": [
    {
      "provider_name": "my-provider",
      "model_id": "my-chat",
      "slot": "chat",
      "effective_from": "2026-10-01T00:00:00Z",
      "input_per_million": "2",
      "output_per_million": "4",
      "cached_input_per_million": "0.5"
    }
  ]
}
```

一个配置使用一个三字母币种代码，至多 100 条价格。单价是每百万 token 的非负十进制
字符串，最多 9 位整数、6 位小数；显式 `"0"` 合法，不接受负数、指数形式或额外字段。
按 Provider 名、模型名、槽位和 effective_from 匹配，每条调用采用开始时刻之前最新的有效配置。
同一组合与同一生效时刻不可重复；时间精度最多毫秒，时区先规范化再判断重复。

没有缓存单价时按 input_per_million 对全部 prompt tokens 平价估算；这是显式的单价策略。
配置缓存单价时，必须知道 cached_input_tokens 且 0≤cached≤prompt，才可分别计算。
语言模型还必须知道 prompt/completion；embedding 只需输入，不将不适用的输出误当缺失计价。
reasoning 已包含在 provider 报告的输出中，不再重复收费；total 保留原值而不拿来猜其他费用。
更复杂的折扣、梯度、请求费、税费和汇率不在模型中。

使用 PostgreSQL numeric 精确计算，费用字符串保留 12 位小数。无价格、必要 usage 缺失或
缓存数据不一致均为未知，不当作免费。汇总 `estimated_cost` 有 known_amount、priced_calls、
unpriced_calls：known_amount 只是已知部分加总，存在缺口时不能称为完整总价；全部未知时为 NULL。

这是**查询时配置**的估算：返回 SHA-256 pricing_revision 标识具体配置，修改价格会改变估算，
但不修改原调用计数。需复现实验时同时保留该价格 JSON 与指纹；指纹本身不是配置备份。
没有内置供应商价格、自动查价或调用付费模型的验证步骤。

## 分页导出

`GET /projects/:projectId/usage/export` 复用 conversation_id/from/to，支持：

- format=json（默认）/csv，limit 默认 200、上限 1000。
- after 为上一页最后一条记录的 UUID；按 started_at/id 稳定排序。游标查询保持项目、
  会话与时间筛选，内部保留 PG 微秒精度，不经过 JavaScript Date 截断。
- JSON 返回 records、next_after、实际窗口与价格配置指纹。只要 next_after 非 NULL 就还有下一页。
- CSV 返回 RFC4180 文本与附件头；非空 X-Next-After 表示仍需下载下一页。
  X-Usage-From/To 给出实际时间窗口；上述头对已允许的 CORS 源可读。

首轮未显式给窗口时，**后续页复用首轮 from/to**（CSV 读取相应响应头），不能让默认当前时刻
随每页漂移。导出是有界分页，不会把第一页冒充完整导出；跨页不是长期数据库快照，期间补写的
旧调用可能影响遍历，正式评测应在模型及后台写回完成后导出并保存窗口/配置。

CSV 每行保留项目、币种与价格指纹；未知值为空单元格，JSON 中仍为 NULL。Provider/模型名等
文本先中和 Excel 公式前缀，再按 RFC4180 转义引号、逗号、换行；因此 CSV 的危险文本会有
前导单引号，JSON 保留原始字符串。响应均 `Cache-Control: no-store`，不导出正文、URL、凭据或异常。

typed client：`getUsageReport(projectId, query)`、`exportUsage(projectId, query)`；后者始终请求
JSON，调用方依据 next_after 循环，并保留首轮窗口。CSV 可直接调用导出 URL，不把 Token 放在 URL。

## 日志与边界

#94 的遥测故障告警现经应用 pino 输出；非 HTTP 槽位调用使用独立的结构化 pino logger。
固定消息不含原异常，即使日志写入失败也不触发付费重试。正常完成等待遥测写入，中断尽快发起
一次记录；数据库故障、进程崩溃的缺行边界沿用 1/3，不承诺财务级完整性或中断后停止计费。
无公开写价接口、新迁移或新依赖。回滚本 PR 只移除读取/估价能力，不改动历史 usage 或 Evidence。

# ADR-002：完整双时态（valid / recorded）而非单时间戳

状态：已接受（2026-09-16，Proposal 决策 2 冻结）

## 上下文

单时间戳无法区分"事实何时在现实中为真"与"系统何时开始认为它为真"。迟到/乱序证据（今天补记上周的决定）在单时间戳下会污染"当前值"判定，as-of 查询（"系统在某时刻相信什么"）无法实现。

## 决策

每个 BeliefVersion 携带 `valid_from/valid_to`（现实时间）与 `recorded_from/recorded_to`（系统时间），区间开口端为 NULL；Observation 保留单点 `valid_time` + `time_precision`/`time_confidence` 表达模糊时间（"上周""最近"），落为 BeliefVersion 时展开为区间。

## 理由与取舍

双时态建模是成熟理论（Snodgrass），Graphiti 等同类系统亦采用；它为 Temporal Policy（迟到证据入版本链留痕、不直接改判）提供数据结构基础。代价是查询与写入 SQL 复杂度上升——已通过 spike ③ 的 as-of 查询模式验证可行。

## 后果

- as-of 查询模式固定于 #42 §11.1，禁止散写临时 SQL。
- Temporal Accuracy 成为六项专项指标之一（#12）。

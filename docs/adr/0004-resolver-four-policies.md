# ADR-004：Belief Resolver 四 Policy 拆分

状态：已接受（2026-09-16，Proposal 决策 5 冻结）

## 上下文

冲突消解同时受四个正交维度影响：用户这句话"想干什么"（断言意图）、"谁说的更可信"（权威）、"事实何时为真"（时序）、"新旧信息什么关系"（四态）。揉成单一规则函数将不可测、不可替换。

## 决策

Resolver 拆为四个 Policy：**Intent**（ASSERT/UPDATE/CORRECT/RETRACT 如何作用于 Belief）、**Authority**（可计算权威排序，低权威不可覆盖高权威）、**Temporal**（同权威按 valid_time 新者优先；迟到证据留痕不改判；过 valid_to 不参与比对）、**Conflict**（强化/削弱/扩展/取代）。IntentPolicy 以接口形式预留，#17 落地替换。

## 理由与取舍

四 Policy 各自可单测、可消融（#12 实验要求"关权威等级"等开关），Intent Policy 接口化使人工修正保护可演进。代价是 Resolver 内部编排复杂度——以 resolution_traces 记录各 Policy 决策数据对冲。

## 后果

- 每次消解落 resolution_traces（含 model_snapshot，决策 11）。
- 消融实验可独立关闭任一 Policy（#22）。

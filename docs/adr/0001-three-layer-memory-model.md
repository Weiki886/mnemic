# ADR-001：Evidence / Observation / Belief 三层记忆模型

状态：已接受（2026-09-16，Proposal 决策 1 冻结）

## 上下文

"用户曾经说过什么"与"系统当前应该相信什么"是两件事。若按常见做法"对话 → 提取 → 向量库"，旧值只能被覆盖或删除，无法回答"系统在某时刻相信什么"，也无法支撑冲突审计与错误恢复。

## 决策

- **Evidence**：原始会话（conversations/messages），全量持久化，即情景层。
- **Observation**：经提取与 Gate 放行后的结构化不可变事实事件（含 assertion_intent 与权威元数据），观察之间允许语义矛盾，不在此层消解。
- **Belief**：唯一被版本化与冲突消解的对象，维护 Observation 引用与证据计数。

## 理由与取舍

不可变 Observation + 版本化 Belief 使 Provenance（Belief→Observation→Evidence）与 Resolution Trace 两条可验证链成立，支撑时间旅行、审计与论文实验。代价是存储与写入路径复杂度高于单层向量库——接受，因为这是项目的核心创新主张。

## 后果

- 数据模型见 #42 §11；写入链路见 #42 §5。
- 任何"直接更新/删除 Observation"的需求均被拒绝；修正只能通过新 Observation + Resolver 完成。

# ADR-006：表驱动异步队列（不引入 Redis/BullMQ）

状态：已接受（2026-09-17，#21 范围确认）

## 上下文

批提取、REEMBED、画像重写等任务需要异步执行。常规做法是引入 Redis + BullMQ，但项目是单 VPS 单用户的中间件，额外有状态组件提高部署与运维成本。

## 决策

以 `memory_tasks` 表实现任务队列：显式任务类型（EXTRACT/REEMBED/DECAY/COMPILE_PROFILE）、状态机、lease + 指数退避重试、死信、幂等键；worker 与 server 同进程。

## 理由与取舍

PostgreSQL 单库承载全部状态，崩溃恢复 = 查询 queued/running 任务续跑，部署拓扑不变。代价是单节点吞吐上限与需自行实现调度细节——对本项目负载（个人项目量级）可接受；若未来超出，迁移到 BullMQ 的边界在 tasks 模块内，不影响其他模块。

## 后果

- 任务幂等与崩溃续跑为 #21 验收硬指标。
- COMPILE_PROFILE 等周期任务由同一队列调度（#41）。

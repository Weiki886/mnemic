# Mnemic

面向长周期编程任务的智能体长期记忆系统（设计事实来源：Issue #1 Proposal；架构：Issue #42）。

## Quickstart

前置：Node.js ≥ 22、pnpm ≥ 10、Docker。

```bash
# 1. 起依赖（PostgreSQL 17 + pgvector）
docker compose up -d

# 2. 安装与全量校验
pnpm install
pnpm -r run lint && pnpm -r run typecheck && pnpm -r run test && pnpm -r run build

# 3. 启动记忆服务
pnpm dev:server

# 4. 验证
curl http://localhost:3000/health   # {"status":"ok"}
```

环境变量见 `.env.example`（复制为 `.env` 后填写，**真实凭据不入库**）。

## 仓库结构

```text
apps/server        记忆服务（Fastify 5 + Drizzle + PostgreSQL/pgvector）
apps/cli           CLI 客户端（占位，实现归 Issue #19）
apps/web           Web 记忆中心（占位，实现归 Issue #8）
packages/shared    类型 + API 客户端 + 统一错误模型
scripts/spike      可行性验证脚本（报告见 docs/spike-report.md）
docs/adr           架构决策记录
```

## 工程约定

- 分支：`type>/<issue>-<slug>` 短生命周期分支，squash 合并后即删
- Commit：Conventional Commits；分支名与提交标题用英文的约定见 Issue #1 工程决策
- 统一错误模型：RFC 7807 problem+json（`packages/shared`）

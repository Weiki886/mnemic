# Mnemic

面向长周期编程任务的智能体长期记忆系统（设计事实来源：Issue #1 Proposal；架构：Issue #42）。

## Quickstart

前置：Node.js ≥ 22.9（dev 脚本依赖 --env-file-if-exists）、pnpm ≥ 10。

```bash
# 1. 起依赖（PostgreSQL 17 + pgvector）
#    本地开发（macOS，原生安装，推荐）：
brew install postgresql@17 pgvector
brew services start postgresql@17
createuser mnemic -d -P   # 密码示例：mnemic（仅本地）
createdb mnemic -O mnemic
psql -d mnemic -c "CREATE EXTENSION IF NOT EXISTS vector;"
#    集成测试独立库（#3 起；不碰开发库数据）：
createdb mnemic_test -O mnemic
psql -d mnemic_test -c "CREATE EXTENSION IF NOT EXISTS vector;"
#    等价容器环境（CI / 部署使用）：
#    docker compose up -d

# 2. 安装与全量校验
pnpm install
pnpm -r run lint && pnpm -r run typecheck && pnpm -r run test && pnpm -r run build

# 3. 执行数据库迁移（全新库必须；幂等，可重复执行）
pnpm --filter @mnemic/server db:migrate

# 4. 启动记忆服务
pnpm dev:server

# 5. 验证
curl http://localhost:3000/health   # {"status":"ok"}

# 6.（可选）启动 Web 记忆中心
pnpm dev:web                      # http://localhost:5173，首次打开输入项目 UUID
```

环境变量见 `.env.example`（复制为 `.env` 后填写，**真实凭据不入库**）。

## 记忆修正与消解历史 API

- `POST /projects/:projectId/beliefs/:id/correct`，JSON 请求体 `{ "value": "新值" }`
- `GET /projects/:projectId/beliefs/:id/resolutions`，按记录时间升序返回历史

路径参数必须为 UUID（非法返回带字段错误的 400）。信念不存在或不属于该项目均返回 404；
旧的 `/beliefs/:id/correct`、`/beliefs/:id/resolutions` 路由已移除。
shared client 对应方法为 `correctBelief(projectId, beliefId, value)` 和
`listResolutions(projectId, beliefId)`，Web 已同步调用。

已软删除的记忆修正返回 409，需先显式恢复；已撤回（retracted）的记忆仍可通过人工修正恢复生效。
修正的状态检查与写入共享数据库事务和行锁，避免并发删除被修正覆盖。
项目参数只限定数据范围，不代表用户权限；token 鉴权归 Issue #20。

## 仓库结构

```text
apps/server        记忆服务（Fastify 5 + Drizzle + PostgreSQL/pgvector）
apps/cli           CLI 客户端（占位，实现归 Issue #19）
apps/web           Web 记忆中心（Vue 3 + Vite + Tailwind 4）
packages/shared    类型 + API 客户端 + 统一错误模型
scripts/spike      可行性验证脚本
docs/adr           架构决策记录
```

## 工程约定

- 分支：`<type>/<issue>-<slug>` 短生命周期分支，squash 合并后即删
- Commit：Conventional Commits；分支名与提交/PR 标题用英文（项目约定，正文可中文）
- 统一错误模型：RFC 7807 problem+json（`packages/shared`）

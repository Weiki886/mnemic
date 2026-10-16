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

## CLI：诊断、对话与记忆查看（Issue #19）

### 检查服务与模型配置

服务启动后，构建并检查服务端连接与统一模型配置：

```bash
pnpm build
pnpm cli doctor
# 服务不在本机默认端口时
pnpm cli doctor --server http://127.0.0.1:3000
# 显式探测 chat / extraction / embedding：实际调用模型，可能计费
pnpm cli doctor --probe
# 供脚本读取的纯 JSON（直接调用构建产物，避开 pnpm 的脚本提示）
node apps/cli/dist/index.js doctor --json
```

CLI 只通过 shared HTTP client 调用服务端，不直连数据库，不保存或读取本地模型 Key。
从 shell 环境读取 `MNEMIC_SERVER_URL` 和 `MNEMIC_AUTH_TOKEN`，默认不自动加载 `.env`；
`--server` 优先于环境变量。只读诊断使用 `GET /v1/doctor`；计费探测使用
`POST /v1/doctor/probe`，要求 `Content-Type: application/json` 和请求体 `{}`。
GET 不接受 `probe` 等查询参数；探测接口仅供 CLI，任何携带 `Origin` 的浏览器请求均返回 403，
无 Origin 但非 JSON 的请求返回 415。这是跨站触发防护，不替代 #20 的 Token 鉴权。

默认仅读取数据库、向量列维度和加密的三槽位配置，模型可用性显示 `SKIP`；
`--probe` 使用固定的诊断文本探测两个文本槽位和一个 embedding 槽位，关闭自动重试，
每槽位 15 秒中止信号，doctor 每次 HTTP 请求 25 秒超时。探测不写入记忆、Evidence 或 Trace。
服务端鉴权尚待 #20，当前 `authentication` 始终显示 `SKIP`，不能据此认为 Token 已受到验证。

退出码：0 = 未检测到错误（仍可能有 `SKIP`），1 = 诊断或网络失败，2 = 参数错误。

### 对话与查看引用记忆

在交互终端中使用已有项目 UUID（替换下方尖括号占位）：

```bash
pnpm cli chat --project <项目UUID>
# 退出对话后，用回答中的记忆 ID 查看当前值和版本出处（只读）
pnpm cli memory <记忆ID> --project <项目UUID>
# 供脚本读取的纯 JSON
node apps/cli/dist/index.js memory <记忆ID> --project <项目UUID> --json
```

chat 使用服务端三槽位配置，输入会写入对话并触发后台记忆提取，调用模型可能计费。
回答展示引用的记忆 ID、版本 ID 和摘要；无足够记忆时明确显示“不记得”。
`/new` 提交旧会话后新建，`/exit` 或 Ctrl+C 等待进行中的请求结束并提交退出。
提交不等于提取和索引已完成，新会话立即查询可能尚未召回刚告知的事实。

回答是完整 HTTP 响应到达后的客户端分段展示，不是 SSE/token 流（#33）。
chat 请求超时 120 秒，memory 25 秒；请求失败不自动重试，服务端可能已经收到消息。
完整的“告知 → 新会话召回 → 更新 → 拒答”演示及排错见 [CLI 演示](docs/cli-demo.md)。

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

评分字段统一返回 JSON `number | null`：记忆列表/详情的 `confidence`、`salience`、`importance`，
版本的 `confidence`，以及消解历史的 `confidenceBefore`、`confidenceAfter`。
例如数据库 `0.875` 返回数字 `0.875`，0 和 null 保持原值；正文及其他 JSON 内容不转换。
数据库仍使用 numeric 存储，shared client 可直接使用数值方法。

`manual-corrections` 为项目专用的保留会话标题，每个项目最多一条；普通会话仍可重名。
普通创建接口 `POST /v1/conversations` 使用该保留标题时返回 400，并在 `errors` 中标明 `title` 字段。
迁移 `0008` 保留最早的专用会话，将历史重复项改名为 `manual-corrections:legacy:<原ID>`；
会话 ID、消息外键、时间和元数据不变，旧出处链接仍可访问。
升级时先停旧服务，执行 `pnpm --filter @mnemic/server db:migrate`，再启动新版；
迁移会短暂锁住会话表，旧代码不支持新的唯一冲突处理，不应与迁移并行运行或单独回退旧代码。

## 仓库结构

```text
apps/server        记忆服务（Fastify 5 + Drizzle + PostgreSQL/pgvector）
apps/cli           CLI 客户端（doctor、Ink 对话、只读记忆详情）
apps/web           Web 记忆中心（Vue 3 + Vite + Tailwind 4）
packages/shared    类型 + API 客户端 + 统一错误模型
scripts/spike      可行性验证脚本
docs/adr           架构决策记录
```

## 工程约定

- 分支：`<type>/<issue>-<slug>` 短生命周期分支，squash 合并后即删
- Commit：Conventional Commits；分支名与提交/PR 标题用英文（项目约定，正文可中文）
- 统一错误模型：RFC 7807 problem+json（`packages/shared`）

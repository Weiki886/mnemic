# Mnemic — Agent 工作约定

适用于整个仓库。Mnemic 是个人毕业设计项目：可独立接入的长期记忆中间件，加 CLI / Web 参考客户端。
保持实现和交付可验证，按任务风险裁剪流程，不引入与需求无关的平台能力或管理负担。

## 1. 开始任务与事实来源

- 先确认用户本轮目标、当前分支、工作区改动和关联 Issue；不要覆盖、回退或清理他人的改动。
- 产品范围以 [Proposal #1](https://github.com/Weiki886/mnemic/issues/1) 为准，模块职责和表所有权以
  [架构 #42](https://github.com/Weiki886/mnemic/issues/42) 及 [ADR](docs/adr/README.md) 为准。
  当前任务的验收条件、非目标和拆分范围从关联 Issue / PR 核对，不凭历史对话推断已完成。
- 入口与环境见 [README](README.md)，具体行为见对应 `docs/`、源码及测试。
  设计中的规划接口不等于已实现接口；实际 HTTP 契约需核对路由、共享 schema 和提交的 OpenAPI。
  发现冲突时明确记录差异，不静默更改冻结决策，也不把既有缺陷当作新的设计保证。
- 先复用现有模块、标准库和已安装依赖。只实现当前范围，不顺手重构、换框架或升级无关依赖。
- 当前仓库指导文件不等于产品的 AGENTS.md 自动生成功能（#40）；不能据此宣称交付该功能。

## 2. 技术栈与目录

| 位置                  | 职责                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `apps/server`         | Fastify 5、Drizzle、PostgreSQL 17 / pgvector；记忆与任务队列核心 |
| `apps/cli`            | TypeScript / Ink 终端客户端，只通过 HTTP 使用服务端能力          |
| `apps/web`            | Vue 3、Vite、Tailwind CSS 4 记忆中心，只通过 HTTP 使用服务端能力 |
| `packages/shared`     | Zod schema、类型、API client、错误与流式协议                     |
| `scripts/spike`       | 可行性验证；含需要数据库或真实模型的显式脚本                     |
| `docs/adr`            | 已接受的架构决策                                                 |
| `apps/server/drizzle` | SQL 迁移、journal 和生成 snapshot                                |

- Node.js 下限及 pnpm 版本以根 `package.json` 的 `engines` / `packageManager` 为准；使用 pnpm workspace。
- TypeScript ESM / NodeNext；沿用 `.js` 相对导入和 `import type`，遵守 strict、
  `noUncheckedIndexedAccess` 与 `exactOptionalPropertyTypes`，不以类型断言掩盖边界错误。
- 依赖方向为 `apps/* → packages/shared`；shared 不依赖 app，server 不依赖 cli / web，客户端不互相依赖。
- 新增 shared 子入口时同步检查 exports、相关 tsconfig、Vitest 和 Vite alias，以及生产构建解析。
  源码测试通过不能代替构建产物验证。
- 排版交给 Prettier，代码规则交给 ESLint；不手工维持另一套风格。

## 3. 记忆与架构不变式

- Evidence 是来源证据；Observation 是不可变的结构化事实事件；Belief 才是版本化与冲突消解对象。
  正常修正追加 Observation / BeliefVersion，不原地改写历史事实；专门删除需求按对应 Issue 实现传播。
- 保留 `valid_*` 与 `recorded_*` 双时态，区分现实有效时间与系统获知时间；不能混用或省略历史链。
- `confidence`、`salience`、`importance` 含义独立。默认读取不强化；读时强化仅为显式实验开关，
  不得把读取当作新证据提高 confidence，不得合并成一个持久化总分。
- Resolver 保持 Intent / Authority / Temporal / Conflict 四 Policy；人工修正保护、迟到证据留痕、
  RETRACT 和显式恢复的语义不能被新入口绕过。软删除不是撤回，不应因普通修正悄悄恢复。
- 来源权威由可信准入路径写入，不能相信 HTTP 或模型自报的高权威标签。
- 一表一主：新增变更通过 owner 的服务 / 仓储接口组合职责；新增表先明确 owner。
  不扩大既有跨模块访问，不能为小改动重排整个目录或掩盖既有边界偏差。
- 派生物引用不复制：版本、检索与消解轨迹保存既定引用及决策数据，不新增证据正文快照。
  显式开启的调试正文捕获属于独立敏感边界，遵守现有双开关、脱敏及省略规则。
- 模型配置单源在服务端，按 chat / extraction / embedding 三槽位经 `providers` 适配层解析。
  客户端不保存模型 Key、不直连数据库；embedding 变更遵守 REEMBED 边界。
- 队列使用 PostgreSQL 表驱动、租约 fencing、重试与死信。业务副作用和回执需要按既有事务协议处理；
  不引入 Redis / BullMQ，不把认领、入队或回答成功说成提取完成或业务 exactly-once。

## 4. API、数据与安全

- 复用 `@mnemic/shared` 的 problem+json 错误码、URI 和 `zodIssues` 字段错误；不另造错误包络。
- 在解析、数据访问和模型调用前保持既有鉴权 / 限流顺序；公开例外以共享判定函数为准，
  不能用前缀匹配放宽权限。全局单用户 Token 不等于项目成员权限。
- 项目范围操作同时约束资源 ID 与 project ID，跨项目与缺失资源按既有契约返回。
  JSONB 内的引用也要重新校验归属，不能因外层资源已检查就信任内部 ID。
- 外部输入用 Zod 验证，SQL 使用绑定参数。ILIKE 通配符转义是字面搜索规则，不等同于 SQL 参数绑定。
  状态迁移采用原子条件更新、CAS 或锁，不能只做 select → 检查 → 无条件 update。
- 配置、审计和业务变更的原子性不能拆开；审计中不复制凭据或业务正文。
  正常日志走现有 pino 安全投影，不展开 SDK / SQL 异常、请求头或任意对象。
- 不自动读取、打印或 `source` 真实 `.env`、`deploy/.env`、生产数据库或 Provider 凭据。
  示例使用明显的离线假值；真实配置与敏感产物不进入 Git、PR、Issue、日志或截图。
- 日常验证默认不调用付费模型；doctor probe、真实模型评测等有计费副作用的步骤需有明确授权。
  本地取消、断流、超时或用量记录都不能证明供应商停止计费。
- 不修改、重启或删除用户现有服务、数据库、容器或卷来完成测试。
  部署验证使用独立资源并只清理自己创建的资源；真实 VPS / 公共证书验收与本地冒烟分别报告。

## 5. 实现与测试流程

- 写维护代码必须使用可用的 `code-implementation` skill：先明确验收和非目标，写简短计划，
  按失败测试 → 确认 RED → 最小实现 → GREEN → 重构推进。计划变更与实际证据记入任务台账。
  使用 `code-testing` 设计有效断言，完成后交 `code-review` 独立收口；GitHub 交付遵守
  `github-engineering-workflow`。文档、UI 等任务按实际需要使用相应 skill。
- 回归测试应在修复前失败、修复后通过；模块不存在造成的收集失败与断言失败分别记录。
  不虚报父提交 RED；适合时用小范围变异验证关键断言，随后恢复并重跑。
- 接口契约验证读取**提交的** OpenAPI 产物，独立校验实际 HTTP 响应；需要数据库的关键行为使用真实 PG。
  模型边界用离线 Mock，不能把模型次数、引用、事务与副作用全部 mock 掉后宣称闭环通过。
- 集成测试复用 `apps/server/test/db-helper.ts`：本地优先独立 `mnemic_test`，不可达 / CI 可用
  Testcontainers；不得直接对开发库执行测试清理。测试连接串必须指向隔离测试环境。
- server 测试共享库并采用 singleFork；同一测试库的全量或集成套件不得被多个进程 / agent 并行执行。
  使用随机作用域、清理自有数据，需临时改全局表时在 finally 恢复，保留时间精度。
  加密夹具复用 `apps/server/test/test-keys.ts`。
- 不用固定 sleep 猜竞态，不加重试掩盖 flaky，不靠 `.only` / `.skip`、忽略标记、放宽断言或
  `--no-verify` 消除失败。保留已有显式 env-gated 付费评测，并如实报告跳过数量。
- UI / 终端交互按改动风险做组件、浏览器或 PTY 验证；自动测试不替代声称做过的人工检查。

## 6. 验证命令

在仓库根目录运行；实际门禁以 `package.json` 与 `.github/workflows/ci.yml` 为准。

```sh
pnpm install --frozen-lockfile
pnpm -r run lint
pnpm exec eslint scripts/*.mjs
pnpm run format:check
pnpm -r run typecheck
pnpm --filter @mnemic/server run openapi:check
DEEPSEEK_API_KEY= DASHSCOPE_API_KEY= pnpm -r run test
node --test scripts/*.test.mjs
pnpm -r run build
```

- 运行测试前核对环境，显式清空模型评测 Key，不通过加载真实环境文件准备测试。
  先跑受影响测试，再完成适用的完整门禁。纯文档改动验证路径、命令和格式，无需为文字添加行为测试。
- 数据库变更走 Drizzle schema + 新迁移，连同 journal / snapshot 提交；不手改已应用历史。
  按影响验证迁移结构、重复执行、约束、事务与升级说明，不随意重生成无关 snapshot。
- OpenAPI 变更先复用 / 抽取 Zod 单源，运行 `pnpm --filter @mnemic/server run openapi:generate`，
  提交 `docs/openapi.json` 后执行 check；不手改生成物、不禁用 lint 规则掩盖问题。
  新切片比对旧 paths / components 漂移，refinement 未被结构表达的规则要如实说明。
- 部署 / 打包改动按需运行 `node scripts/verify-deployment.mjs`；该步骤会构建并启动隔离 Docker 环境，
  不能当作普通无副作用检查。CI 有独立 `deployment-smoke` job。
- 报告实际退出码、通过 / 跳过数量、运行环境及未覆盖项；不把本地通过等同于 CI、部署或模型账单验证。

## 7. GitHub 交付与协作

- 分支采用 `<type>/<issue>-<slug>`；分支名、Commit / PR 标题用英文，Commit 遵循 Conventional Commits。
  正文可中文。每次交付范围小且可独立审查，PR / Issue 评论保持简短，不复述整份审查报告。
- PR 关联 Issue，补齐适用的 `type:*`、`phase:*`、`risk:*` 标签及对应 milestone；名称从仓库读取，
  不将所有任务固定为某个阶段或风险等级。
- 部分交付使用 `Refs #N`；只有所有验收条件真正满足才用 `Closes #N`。
  未完成的环境验收、依赖模块或人工步骤不能用一轮 CI 替代。
- PR 正文说明最终行为、范围、兼容性、验证证据、接受边界及适用回滚方式。
  SHA、路径、文件 / 测试数和 CI 用时必须与工具结果逐项核对，不保留过时的中间方案。
- 审查固定 base / head，分别检查规范符合度（轴 A）和需求符合度（轴 B）。处理意见先核对事实，
  修复 blocker；nit / fyi 按风险决定本轮处理或明确延后，不为已接受边界扩大范围。
- 新 PR 默认留待用户审查。只有获得针对该 PR 的明确合并指令后，才在对应 head 的必要 CI 通过后
  squash 合并并删除分支；已有授权不重复询问。不能把“继续开发”自动当成新 PR 的合并许可。
- 合并后向 GitHub 核对实际 merged 状态、同步本地 main，并检查主干 CI。
  命令报错不能直接推断远端未合并；先查状态，再决定恢复动作，不重复执行破坏性操作。
- 在授权范围内连续推进，不为常规、可逆实现选择反复请示；新增付费调用、真实部署或破坏性操作
  若缺少授权则先询问。未经要求，不向外部服务发送消息或发布额外内容。
- README 默认仅就地更新相关内容并保留其他内容；重写、删除或扩大说明范围需依据用户指令。
  临时计划、日志、截图和验证目录不混入交付；不把机器特定的路径、代理或凭据写进仓库规范。

<!-- codebase-memory-mcp:start -->

# Codebase Memory

## Codebase Knowledge Graph (codebase-memory-mcp)

This project uses codebase-memory-mcp to maintain a knowledge graph of the codebase.
ALWAYS prefer MCP graph tools over grep/glob/file-search for code discovery.

### Priority Order

1. `search_graph` — find functions, classes, routes, variables by pattern
2. `trace_path` — trace who calls a function or what it calls
3. `get_code_snippet` — read specific function/class source code
4. `check_index_coverage` — validate candidate paths and missed ranges before claims
5. `query_graph` — run Cypher queries for complex patterns
6. `get_architecture` — high-level project summary

### Evidence tiers

- **Scout (Tier 1):** quick positive lookup with few calls and targeted source checks. Mark it provisional; do not make negative or exhaustive claims.
- **Verify (Tier 2, default):** task-directed graph evidence, relevant trace directions, exact snippets for material claims, and relevant pagination.
- **Auditor (Tier 3):** bounded-scope full verification with current generation, complete relevant pagination, both call directions and broader relationships when material, and every limitation disclosed.
- After candidate paths are known in any tier, call `check_index_coverage` once with every evidence path. Add relevant scopes for negative or exhaustive claims. A clean result means no recorded gap, not proof of completeness. For partial, skipped, excluded, stale, pending, or unknown coverage, read/grep the reported ranges or scope before relying on graph results.

### When to fall back to grep/glob

- Searching for string literals, error messages, config values
- Searching non-code files (Dockerfiles, shell scripts, configs)
- When MCP tools return insufficient results

### Examples

- Find a handler: `search_graph(name_pattern=".*OrderHandler.*")`
- Who calls it: `trace_path(function_name="OrderHandler", direction="inbound")`
- Read source: `get_code_snippet(qualified_name="pkg/orders.OrderHandler")`

### Session resets and subagents

- At session start or after compaction, confirm the nearest graph project and generation with `list_projects` or `index_status`, then choose Scout, Verify, or Auditor.
- Before spawning a subagent, query the graph and coverage in the parent. Pass the tier, project, generation/freshness, bounded scope, queries and pagination state, qualified symbols, paths, call-chain findings, coverage evidence with ranges/reasons, source fallback already performed, and unresolved questions in the delegated task context.
- Do not assume subagents inherit MCP access or the parent conversation. If a child lacks MCP tools, it must not call or claim MCP access. It should use the supplied evidence and read/grep exact source, especially every reported missed-coverage range.

<!-- codebase-memory-mcp:end -->

图谱工具未提供、无法访问或覆盖不足时，明确说明限制并读取精确源码 / 使用 `rg` 补证；
不假称查询过图谱、不用其他服务的同名 project 工具代替索引状态，也不宣称未验证的完整覆盖。

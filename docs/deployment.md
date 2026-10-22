# 全栈部署（#20 拆分 2/2）

部署栈为 PostgreSQL 17/pgvector → 一次性迁移 → Fastify，以及 Web 静态服务和 Caddy。
仅 Caddy 发布主机端口；数据库、server:3000、web:8080 不直接对外。
这是单用户部署：持有 Bearer Token 的人可操作所有项目和模型配置，不提供账号/RBAC。

静态 Web 容器以 UID1000、只读根文件系统运行，撤销全部 capabilities 并禁止提权；
其 Caddy 二进制也移除低端口文件 capability，静态服务只监听 8080，不需要该权限。
仅 `/tmp`、`/data`、`/config` 可临时写入（后两处 tmpfs 显式设置 UID/GID，挂载会覆盖镜像中的目录权限，见 [Docker tmpfs 说明](https://docs.docker.com/engine/storage/tmpfs/)）。
公网 Caddy 也禁止提权，但保留原有低端口能力和证书持久卷；不把其 `/data`、`/config` 改为 tmpfs。

本轮交付部署配置、隔离容器冒烟和操作步骤。**真实 VPS、公共 CA 签发/续期、CLI/Web 公网连通待提供环境验收，#20 保持打开。**
本地 `localhost` 测试使用 Caddy 内部 CA，不等于公共 HTTPS 验收。

## 1. 准备主机、域名和凭据

在干净 Linux VPS 安装 [Docker Engine](https://docs.docker.com/engine/install/) 和 Compose v2 插件，
确认 `docker info`、`docker compose version` 成功。使用 Git 克隆仓库，切到经过审查的具体 commit。
不需要在 VPS 安装 Node/pnpm；镜像构建阶段使用 Node 22 和锁定的 pnpm 10.32.0。

将域名 A 记录指向 VPS；有 AAAA 时 IPv6 也必须可达。允许入站 TCP 80/443（UDP 443 可选，用于 HTTP/3），
不要开放 3000/5432/8080。SSH 应只允许可信来源。首次签发需公共 DNS 正确且挑战端口可达。
[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https) 负责公共证书申请和续期；
证书状态保存在 `mnemic-caddy-data` 卷，不能在升级时删除。确实完成公网签发后再检查证书和到期时间，不以配置存在视为验收完成。

在仓库根目录：

```bash
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
```

在可信编辑器填写：

- `MNEMIC_DOMAIN`：仅主机名，例如 `memory.example.com`，不带协议、端口或路径。
- `POSTGRES_PASSWORD`：独立执行 `openssl rand -hex 32` 生成的 64 位 hex；该值用于数据库 URI，不能直接填含 `@:/` 的未编码密码。
- `MNEMIC_AUTH_TOKEN`：另生成一份随机 Token（`openssl rand -hex 32`）。CLI/Web 使用同一个值。
- `MNEMIC_MASTER_KEY`：再独立生成 64 位 hex，用于加密模型 API Key，**不是** Bearer Token。
- `MNEMIC_IMAGE_TAG`：本次经过审查的 commit SHA，避免用可变 `local` 标签混淆版本。

不要把密钥贴进命令历史、URL、Issue、截图或 CI 输出。`deploy/.env` 被 Git 和 Docker 构建上下文忽略；
Web 产物只包含 `/api` 地址，不包含 Token。Docker/主机管理员仍能读取容器环境和数据库，不属于此门禁的隔离范围。
不要分享 `docker compose config`（会展开凭据）或 `docker inspect` 的完整输出；校验配置用 `config --quiet`。

**已有数据迁移不是全新部署**：备份数据库及原始 `MNEMIC_MASTER_KEY`，保留原 key，不能随机覆盖。
本机 `.env` 与服务器 `deploy/.env` 独立；未配置 master key 时不要把“新建 key”当作恢复旧 Provider 数据的方案。
旧 PG-only Compose 已移到 `docker-compose.dev.yml`；如需复用旧卷，必须核对原项目名、实际卷和账号，先备份再迁移。
本指南不自动导入、覆盖或删除你现有的原生 PostgreSQL/旧 Docker 卷。

## 2. 构建并启动

后文所有命令都从仓库根目录运行，固定项目名 `mnemic`：

```bash
docker compose --env-file deploy/.env -p mnemic config --quiet
docker compose --env-file deploy/.env -p mnemic up --build -d --wait
docker compose --env-file deploy/.env -p mnemic ps -a
curl --fail https://memory.example.com/api/health
```

最后一条将主机名替换成你的域名，预期 `{"status":"ok"}`。
server/Web 构建共用 `scripts/prepare-pnpm.mjs`，从根 `package.json` 读取固定 pnpm 版本。
仅 Corepack 下载遇到 HTTP 429/502/503/504 或明确的连接/超时错误时，最多执行 3 次，间隔 5 秒、15 秒；
每次子进程上限 150 秒。签名校验、权限、版本不存在及未知错误不重试，最终失败仍中止构建。
不切换 registry、不关闭完整性校验，也不自动重跑依赖安装、迁移或整个部署；上游持续故障时需等待恢复后重新构建。
迁移与 server 使用同一个服务端镜像；数据库健康后才执行迁移，迁移失败不会启动 server，server/Web 健康后才启动代理。
迁移进程成功退出是正常状态，不是应一直运行的服务。
启动失败先检查服务状态及本地日志（不要直接公开日志/环境）：

```bash
docker compose --env-file deploy/.env -p mnemic logs --tail 50 migrate server caddy
```

迁移错误只输出通用提示，避免连接 URL/密码泄露；核对私有环境、数据库连接和迁移文件。
不要通过移除鉴权、发布数据库端口或跳过 TLS 校验来解决启动问题。

## 3. 首次使用与验证

访问 `https://memory.example.com`，输入项目 UUID 和 Token。Web 刷新后需重新输入 Token，见[鉴权说明](authentication.md)。
CLI 安装/构建后，在可信本地 shell 中导出 Token（不回显），通过 **`/api` 前缀**连接同一服务：

```bash
read -r -s MNEMIC_AUTH_TOKEN
export MNEMIC_AUTH_TOKEN
pnpm cli doctor --server https://memory.example.com/api
```

无 Token 的业务调用应返回 401：

```bash
curl -i https://memory.example.com/api/v1/doctor
```

有效 Token 的 doctor 应报告 `authentication: OK`、`database: OK`。
全新库尚无模型配置，`configuration: ERROR` 是预期，不表示应取消鉴权。
目前没有 Web Provider 编辑页；使用已有的 `POST /providers` 配置接口经 `/api/providers` 登记模型三槽位（chat/extraction/embedding）。
请求格式见 `apps/server/src/providers/routes.ts`；用可信本地 HTTP 工具的秘密变量/私有请求文件设置 Bearer 和 JSON 中的 API Key，不要把它们直接贴到公开终端命令。
登记不会调用外部模型；只读 doctor 验证配置存在，模型可用性仍是 SKIP。
显式 `doctor --probe` 或 chat 才会实际调用模型，可能计费。服务端 embedding 配置必须匹配 1024 维。

目前没有项目创建 API；全新部署先在 VPS 的数据库容器中建立一个项目（只输入名称，不含凭据）：

```bash
docker compose --env-file deploy/.env -p mnemic exec postgres psql -U mnemic -d mnemic
```

在 psql 中执行，保存返回的项目 UUID，用于 Web/CLI：

```sql
INSERT INTO projects (id, name) VALUES (gen_random_uuid(), 'my-project') RETURNING id;
\q
```

完成模型配置后，用[CLI 演示](cli-demo.md)的告知/新会话/更新/拒答步骤验收。
公网最终验收还需浏览器检查证书可信、Web 详情页刷新可访问，以及 CLI 从另一台机器通过 HTTPS 连接。
Token、模型 Key 和记忆进入远端服务器；chat/提取/embedding 还会把相关输入发送到配置的模型服务。

## 4. 更新、备份与恢复

先在权限受控目录备份，并单独安全保管原始 master key；备份含对话正文及加密的模型 Key：

```bash
umask 077
mkdir -p /srv/mnemic-backups
chmod 700 /srv/mnemic-backups
docker compose --env-file deploy/.env -p mnemic exec -T postgres pg_dump -U mnemic -d mnemic -Fc > /srv/mnemic-backups/before-upgrade.dump
```

备份目录必须在仓库和 Docker 构建上下文之外；每次升级使用不同文件名，不能覆盖唯一备份。
保持部署项目名及卷不变。切到下一个已审查 commit，更新 `MNEMIC_IMAGE_TAG` 后：

```bash
docker compose --env-file deploy/.env -p mnemic build server web
docker compose --env-file deploy/.env -p mnemic stop caddy server
docker compose --env-file deploy/.env -p mnemic run --rm migrate
docker compose --env-file deploy/.env -p mnemic up -d --wait
```

迁移失败就停止后续步骤，不要重启旧写入进程与迁移并行运行。迁移可幂等重跑，但不提供自动逆向迁移。
回滚前确认 schema 兼容；不兼容时停止服务后恢复升级前数据库备份和对应 master key，再使用原 commit/tag 的镜像。
不要单独降级到没有鉴权的旧版本，也不要用 `down -v`：它会删除生产数据和证书卷。
常规停止用 `docker compose --env-file deploy/.env -p mnemic stop`，配置/Token 修改后用 `up -d --force-recreate` 重建容器。
初始 PG 密码写入后，单改 env 不会修改数据库角色密码；数据库口令轮换必须同时更新 PG 角色和服务连接配置。

## 5. 隔离容器冒烟（不访问真实模型）

Docker 引擎可用时执行：

```bash
node scripts/verify-deployment.mjs
```

脚本自建随机项目名、临时密钥、环回高端口和独立数据卷，构建镜像后验证迁移重跑、HTTPS、SPA、401/有效 Token、
离线假 Provider 的加密配置，以及健康/上游停机错误路径日志均不含本轮密钥。
另验证 Web 的 UID、只读静态目录、可写临时目录、零 capabilities 和禁止提权；代理重启后证书 CA 不变且 HTTPS 仍可访问。
Caddy 不启用访问日志，代理错误用通用状态响应收口；不要打开 debug 或自定义请求日志而不重新审查脱敏。
它提取测试栈内部 CA，仅交给本次 HTTPS 客户端验证，不写系统信任库。
不发送 chat 或 probe，不消耗模型费用；结束只清理该随机项目和测试卷，不操作你的原生 PG 或现有服务。
CI 的 `deployment-smoke` 运行同一脚本；不能代替真实域名的 ACME 签发/续期和 VPS 验收。

# PostgreSQL 备份与隔离恢复（#25，拆分 3/3）

`POST /v1/exports/memory` 提供八张核心表的有界 JSONL，含完整版本和来源引用，但不包含后续模块表。这里提供另一条**实例管理员维护路径**：用 PostgreSQL 原生 custom-format 备份全部数据库对象 / 数据，并在隔离库恢复。不是 JSONL 导入器、跨系统迁移、云备份、定时调度或 PITR。

## 前置条件与秘密边界

- Node.js 版本沿用仓库 engines；`pg_dump`、`pg_restore` 必须为 **17.x**，由 PATH 选择。服务端当前为 PG17；脚本不尝试跨主版本兼容。macOS 可将 `$(brew --prefix postgresql@17)/bin` 放在 PATH 前；Linux 安装 postgresql-client-17。
- 显式配置 PGHOST、PGPORT、PGUSER、PGDATABASE，不能为空；PGDATABASE 只接受最长63字符的普通标识符（首字符字母 / 下划线，其后字母 / 数字 / 下划线 / 连字符）。无 DATABASE_URL、PGSERVICE 或 `.env` 自动回退。备份角色必须有目标库全部表 / 序列的读取权限。
- 凭据通过 PGPASSWORD 或显式 PGPASSFILE 给 libpq，**不放在命令参数、URI 或仓库**。未指定 PGPASSFILE 时使用 /dev/null，不自动读用户默认 .pgpass。不要把密码直接写进 shell 历史；优先使用权限0600的独立 pgpass 文件。脚本只传递连接与显式 TLS 变量，不把应用 master key、Provider Key、PGOPTIONS / service 或整个进程环境转给工具。
- 远程连接显式设置 PGSSLMODE=verify-full 和 PGSSLROOTCERT；脚本不替操作者建立 TLS / 网络信任。PGSSLCERT、PGSSLKEY、PGSSLCRL、PGCHANNELBINDING 可显式传入。PGHOST 及输出目录均是管理员信任的配置，不是沙箱输入。
- 全库归档包含 Provider **密文**、全部会话 / 任意 JSONB / 原始审计 / 用量 / 队列 / flags 等。它不脱敏、不加密，也不包含**外部** `MNEMIC_MASTER_KEY`。原 master key 需单独安全备份，否则恢复后无法解密原 Provider 凭据。也不包含数据库角色 / 集群配置 / tablespace 目录、Caddy 证书卷、环境文件、CLI 本地状态或 pgvector 动态库。
- 恢复机须先安装兼容的 PG17 / pgvector；`CREATE EXTENSION vector` 通常需要管理员。dump 记录扩展定义，不携带扩展程序文件。本方案用 `--no-owner --no-acl`，不承诺恢复原角色所有权 / grants；恢复对象由执行角色拥有，切换应用前自行核对最小访问权限。

## 创建新备份

先由操作者在当前终端配置连接（下面仅为离线示例，替换成实际地址与受保护凭据文件）：

```sh
export PGHOST=127.0.0.1
export PGPORT=5432
export PGUSER=mnemic_backup
export PGDATABASE=mnemic
export PGPASSFILE=/private/location/mnemic.pgpass
```

输出必须位于可信的本地 POSIX 文件系统，父目录需已存在且无不可信写入者。创建私有目录，并且使用一个**不存在的新文件名**：

```sh
umask 077
backup_dir=$(mktemp -d)
node scripts/backup-database.mjs --output "$backup_dir/database.dump"
```

成功只输出 `BACKUP_CREATED`；不打印库名、连接串、路径、表名或工具输出。脚本用 `pg_dump --format=custom --no-owner --no-acl --no-password`，在线备份依赖 PostgreSQL 自己的事务一致性快照，不逐表拼接导出。新建0700临时目录和0600文件，stdout 直接传文件描述符，不把整库缓冲到 JS；工具 stderr 丢弃，错误只返回固定 code。单工具执行限10分钟、连接超时10秒，版本查询限10秒。

pg_dump 成功后 fsync 文件、用 pg_restore --list 检查 TOC，再通过同一文件系统的 hard link 原子发布。**TOC 检查不是数据恢复验证**。已有普通文件、目录或符号链接均拒绝；即使验证后发生同名创建竞态也不覆盖。失败通常删除自有临时目录、不产生最终文件；外部 SIGKILL / 掉电可能留下私有临时目录，不能据此认作成功备份。发布不是远端冗余或掉电持久性的保证；还需操作者的私有加密存储 / 复制 / 保留纪律。

输出大小不受 JSONL 的16MiB限制，也没有磁盘配额保证。确保空间充足，不要把备份放进 Git、Issue、日志或 CI artifact；仓库忽略 `*.dump` / `*.backup` 只是防误提交。每个备份用新文件名，没有自动覆盖 / 删除旧备份策略。

失败 code：BACKUP_ARGUMENTS_INVALID、BACKUP_CONNECTION_REQUIRED、BACKUP_CONNECTION_INVALID、BACKUP_OUTPUT_INVALID、BACKUP_OUTPUT_EXISTS、BACKUP_TOOL_VERSION、BACKUP_FAILED。底层错误不回显；用受控 DBA 排错方式检查权限、工具版本、连接或磁盘，不将敏感原始输出贴到公开报告。

## 恢复到全新隔离库

**只恢复可信备份**：PostgreSQL 归档可能包含会执行的 SQL / 函数，不能因为 --list 成功或文件可读就信任来源。先停应用及 worker，避免恢复过程中自动调用模型、重放队列或新旧实例同时写入；备份本身可在线执行。恢复不要先运行 Drizzle 迁移，先恢复已存的迁移 journal。

管理员使用**新名字**创建空库。下面命令没有 DROP / --clean / --create，也不覆盖既有数据库；创建失败就停止。PGHOST/PGPORT/PGUSER/凭据 / TLS 仍由当前终端显式配置，PGUSER 此时需具备创建库 / 扩展等恢复权限。

```sh
restore_db="mnemic_recovery_$(date +%Y%m%d%H%M%S)"
createdb --no-password --maintenance-db=postgres --template=template0 "$restore_db" &&
  pg_restore --single-transaction --exit-on-error --no-owner --no-privileges \
    --no-password --dbname "$restore_db" "$backup_dir/database.dump"
```

`--single-transaction --exit-on-error` 保证本次恢复 SQL 失败时回滚，不把部分表宣称为成功。不要盲目改为 --clean；也不要仅靠 PGDATABASE 环境运行 pg_restore，因为未指定 --dbname 时它会输出 SQL，而不是执行恢复。已有库不能按这条新库流程直接恢复。

恢复后至少核对：

1. public 全部表及 drizzle.__drizzle_migrations 存在，表行数、主键 / 外键 / CHECK / 索引 / 序列状态 / pgvector 版本与备份演练基线一致。
2. belief_versions 所有历史版本、valid_* / recorded_* 微秒、current_version_id / supersedes_version_id / source_observation_id，以及 Observation.evidence_id 来源链完整；不能只看当前 belief 数量。
3. 精确 JSONB bigint / numeric、NULL、向量、消息 / 附件元数据和原始审计未丢失；Provider 密文可用**原 master key**解密，不调用真实 Provider 验证。
4. flags、配额 / 用量、PENDING、租约 / 任务、后续模块表完整；先审阅恢复的任务状态，再启动 worker。恢复历史快照可能重复执行备份时未完成的外部副作用，租约 fencing 不提供跨灾难恢复的外部 exactly-once。
5. 保持服务关闭，用正确密钥 / 应用角色做无付费调用的检查；核对迁移 journal 后才按升级流程执行新迁移。切换新库是独立运维操作，本 PR 不自动切换连接、删除源库或验证真实 VPS。

数据库恢复不等于外部配置、角色、证书和服务器状态都恢复。原有 memory.export / usage.export 审计只证明相应应用动作；本脚本是可在应用停机时运行的直连 DBA 维护工具，**不通过 HTTP、不新增应用审计行**。管理员需另保留备份 / 恢复的受保护操作记录；不能把快照中的旧审计当作本次维护已被记录。应用 JSONL 导出的 prepared 审计由 #123 已覆盖。

## 自动演练与验证边界

`apps/server/test/database-backup.integration.test.ts` 使用 `db-helper.ts` 获取测试连接，再由本轮生成的 UUID 创建全新 `mnemic_recovery_*` 数据库并应用全部迁移；不读 Provider 实际配置、不运行模型，也不清空 mnemic / mnemic_test。

测试只在创建成功后设置本地标记；之后关闭自有连接，DROP 并按同一随机名重新 CREATE，明确断言空库，再运行 pg_restore。最后只删除这个测试自己创建的库；不使用 FORCE 或终止他人的数据库连接。完成后比较**所有用户表全文、FK / CHECK / 索引、扩展、序列**，核对原始 Provider 夹具密文可解密、版本 / Evidence 链，并验证重跑 migrate 不改数据。PG17 对两条历史 BETWEEN CHECK 的相邻 AND 括号会规范化；测试仅归一这两种明确等价写法，并额外实测原数值约束仍拒绝非法值，不泛化移除 SQL 括号。

CI 将 PostgreSQL17工具放进 PATH，Testcontainers 角色具备创建数据库 / 扩展权限；缺工具或权限会失败，**不跳过恢复验收**。本地也需 PG17 工具；若普通测试角色无权创建 vector，可显式设置 `MNEMIC_TEST_ADMIN_URL`，只允许与测试库同 host / port / database，区别仅为测试管理员身份；该变量和测试 DATABASE_URL 都不接受 query / fragment 或编码的数据库名，建立任何连接前即拒绝，防止 startup database/options 覆盖随机库名。它不能指向开发库或生产库；不得把含密码 URL 写进 Git / 输出。未设置时复用测试连接身份。

```sh
DEEPSEEK_API_KEY= DASHSCOPE_API_KEY= \
  pnpm --filter @mnemic/server exec vitest run test/database-backup.integration.test.ts
node --test scripts/backup-database.test.mjs
```

恢复演练证明当前迁移 / PG17 / pgvector 组合及离线夹具可恢复；不承诺所有未来 schema / 版本、生产大库耗时、外部系统副作用回滚或部署故障切换。没有定时云备份或恢复 API。本轮与 #122/#123 合起来满足 #25 的 JSONL、应用导出审计和实际隔离恢复验收；PR 合并前仍保留 Issue 打开，合入后再关闭。

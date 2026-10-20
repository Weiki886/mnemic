import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = new URL("../../../", import.meta.url);
function source(path: string): string {
  const url = new URL(path, root);
  expect(existsSync(url), path + " must exist").toBe(true);
  return readFileSync(url, "utf8");
}
// 配置是运行时的公开契约；容器实际运行另由独立 deployment-smoke CI 验证。
describe("#20 全栈部署契约", () => {
  it("静态 Web 只读根文件系统、撤销 capabilities，仅临时目录允许 UID1000 写入", () => {
    const { web } = parse(source("docker-compose.yml")).services;
    expect(web.read_only).toBe(true);
    expect(web.cap_drop).toEqual(["ALL"]);
    expect(web.security_opt).toContain("no-new-privileges:true");
    expect(web.tmpfs).toEqual([
      "/tmp",
      "/data:uid=1000,gid=1000,mode=0700",
      "/config:uid=1000,gid=1000,mode=0700",
    ]);
  });

  it("公网 Caddy 禁止提权但仍保留证书持久卷和原有低端口能力", () => {
    const { caddy } = parse(source("docker-compose.yml")).services;
    expect(caddy.security_opt).toEqual(["no-new-privileges:true"]);
    expect(caddy.volumes).toContain("mnemic-caddy-data:/data");
    expect(caddy.volumes).toContain("mnemic-caddy-config:/config");
    expect(caddy.tmpfs).toBeUndefined();
    expect(caddy.cap_drop).toBeUndefined();
  });

  it("CI 实际构建并通过 HTTPS 验证隔离测试栈，而非只检查模板", () => {
    const ci = parse(source(".github/workflows/ci.yml"));
    expect(ci.jobs["deployment-smoke"]).toBeDefined();
    expect(
      ci.jobs["deployment-smoke"].steps.some(
        (step: { run?: string }) => step.run === "node scripts/verify-deployment.mjs",
      ),
    ).toBe(true);
    expect(source("scripts/verify-deployment.mjs")).toContain("rejectUnauthorized: true");
  });
  it("只 Caddy 对外，数据库就绪→迁移成功→服务健康→代理，数据与证书持久化", () => {
    const stack = parse(source("docker-compose.yml"));
    expect(Object.keys(stack.services).sort()).toEqual([
      "caddy",
      "migrate",
      "postgres",
      "server",
      "web",
    ]);
    const { postgres, migrate, server, web, caddy } = stack.services;
    for (const service of [postgres, migrate, server, web]) expect(service.ports).toBeUndefined();
    expect(caddy.ports).toHaveLength(3);
    expect(migrate.depends_on.postgres.condition).toBe("service_healthy");
    expect(server.depends_on.migrate.condition).toBe("service_completed_successfully");
    expect(caddy.depends_on.server.condition).toBe("service_healthy");
    expect(caddy.depends_on.web.condition).toBe("service_healthy");
    expect(migrate.image).toBe(server.image);
    expect(migrate.command).toEqual(["node", "dist/db/migrate.js"]);
    expect(server.environment.HOST).toBe("0.0.0.0");
    expect(server.environment.MNEMIC_AUTH_TOKEN).toContain(":?");
    expect(server.environment.MNEMIC_MASTER_KEY).toContain(":?");
    expect(server.environment.DATABASE_URL).toContain("@postgres:5432/mnemic");
    expect(postgres.volumes).toContain("mnemic-pgdata:/var/lib/postgresql/data");
    expect(caddy.volumes).toContain("mnemic-caddy-data:/data");
    expect(caddy.volumes).toContain("mnemic-caddy-config:/config");
    expect(stack.volumes).toHaveProperty("mnemic-pgdata");
  });

  it("开发 PG 保留独立入口且只绑定环回，不影响原生 PG 工作流", () => {
    const dev = parse(source("docker-compose.dev.yml"));
    expect(Object.keys(dev.services)).toEqual(["postgres"]);
    expect(dev.services.postgres.ports[0]).toContain("127.0.0.1:");
  });

  it("Docker 构建排除凭据与本地产物；运行包仅包含生产文件，应用非 root", () => {
    const ignore = source(".dockerignore").split(/\r?\n/);
    for (const pattern of [
      ".git",
      "**/node_modules",
      "**/dist",
      "**/.env",
      "**/.env.*",
      "**/*.dump",
      "**/backups",
    ])
      expect(ignore).toContain(pattern);
    const server = source("apps/server/Dockerfile");
    expect(server).toContain("--frozen-lockfile");
    expect(server).toContain("install --prod --frozen-lockfile");
    expect(server).not.toContain("--legacy");
    expect(server).toContain("USER node");
    expect(server).not.toMatch(/(?:ARG|ENV) MNEMIC_(?:AUTH_TOKEN|MASTER_KEY)/);
    expect(server).toContain("/workspace/apps/server/drizzle");
    expect(server).toContain("/workspace/packages/shared/dist");
    const web = source("apps/web/Dockerfile");
    expect(web).toContain("VITE_API_BASE_URL=/api");
    expect(web).not.toMatch(/VITE_.*TOKEN/);
  });

  it("Caddy 提供域名 HTTPS、API 前缀转发与 SPA 路由，无访问日志泄露查询值", () => {
    const caddy = source("deploy/Caddyfile");
    expect(caddy).toContain("{$MNEMIC_DOMAIN}");
    expect(caddy).toContain("handle_path /api/*");
    expect(caddy).toContain("reverse_proxy server:3000");
    expect(caddy).toContain("reverse_proxy web:8080");
    expect(caddy).toContain("handle_errors");
    expect(caddy).toContain('respond "{err.status_code} {err.status_text}"');
    expect(caddy).not.toMatch(/tls_insecure_skip_verify|auto_https off|\blog\s*\{/);
    expect(source("deploy/Caddyfile.web")).toContain("try_files {path} /index.html");
    expect(existsSync(fileURLToPath(new URL("deploy/.env.example", root)))).toBe(true);
  });
});

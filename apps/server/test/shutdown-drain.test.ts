import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { trackJob } from "../src/chat/jobs.js";

describe("优雅停机等待异步写回（#62）", () => {
  it("app.close() 等待 chat 写回任务排空后才返回（停机不丢已 commit 的写回）", async () => {
    const app = buildApp();
    let settled = false;
    trackJob(
      async () => {
        await new Promise((r) => setTimeout(r, 300));
        settled = true;
      },
      () => {},
    );

    await app.close();
    expect(settled).toBe(true);
  });

  it("任务挂死时 close 在超时上限内放行（不无限等待），并落告警日志", async () => {
    const lines: string[] = [];
    const app = buildApp({
      shutdownDrainMs: 50,
      logStream: {
        write: (chunk: string) => {
          lines.push(chunk);
        },
      },
    });
    trackJob(
      () => new Promise<void>(() => {}),
      () => {},
    ); // 永不 settle

    const t0 = Date.now();
    await app.close();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(lines.join("")).toContain("shutdown drain timeout");
  });
});

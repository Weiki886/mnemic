import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixture = fileURLToPath(new URL("./fixtures/graceful-server.ts", import.meta.url));

describe("优雅停机", () => {
  it("SIGTERM 后在途请求完成、进程以 0 退出", async () => {
    // 直接以 node --import tsx 启动，避免 pnpm 包装进程吞掉 SIGTERM 信号
    const child = spawn(process.execPath, ["--import", "tsx", fixture], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // 等待服务就绪，并从 stdout 读出内核分配的实际端口
    let port: number | undefined;
    let slowEntered = false;
    const childOut: string[] = [];
    child.stdout.on("data", (d: Buffer) => {
      childOut.push(d.toString());
      const match = /graceful-fixture listening on (\d+)/.exec(d.toString());
      if (match) port = Number(match[1]);
      if (d.toString().includes("graceful-fixture slow-entered")) slowEntered = true;
    });
    child.stderr.on("data", (d: Buffer) => childOut.push(d.toString()));
    const deadline = Date.now() + 15000;
    while (port === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(port, childOut.join("")).toBeTypeOf("number");

    // 发起在途慢请求，等 fixture 确认请求已进入处理（而非固定 sleep）再 SIGTERM
    const inFlight = fetch(`http://127.0.0.1:${port}/slow`).then((r) => r.json());
    while (!slowEntered && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(slowEntered, childOut.join("")).toBe(true);
    child.kill("SIGTERM");

    const body = await inFlight.catch((err: unknown) => {
      console.log("CHILD OUTPUT SO FAR:\n", childOut.join(""));
      throw err;
    });
    expect(body).toEqual({ done: true });

    // 进程应自行以 0 退出；超时则强杀并判失败，避免 CI 悬挂
    const [code] = (await Promise.race([
      once(child, "exit") as Promise<[number | null]>,
      new Promise<[null]>((resolve) =>
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve([null]);
        }, 10000),
      ),
    ])) as [number | null];
    expect(code).toBe(0);
  }, 30000);
});

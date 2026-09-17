import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixture = fileURLToPath(new URL("./fixtures/graceful-server.ts", import.meta.url));
const PORT = 19876;

describe("优雅停机", () => {
  it("SIGTERM 后在途请求完成、进程以 0 退出", async () => {
    // 直接以 node --import tsx 启动，避免 pnpm 包装进程吞掉 SIGTERM 信号
    const child = spawn(process.execPath, ["--import", "tsx", fixture], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // 等待服务就绪
    let ready = false;
    const childOut: string[] = [];
    child.stdout.on("data", (d: Buffer) => {
      childOut.push(d.toString());
      if (d.toString().includes("graceful-fixture listening")) ready = true;
    });
    child.stderr.on("data", (d: Buffer) => childOut.push(d.toString()));
    const deadline = Date.now() + 15000;
    while (!ready && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(ready).toBe(true);

    // 发起在途慢请求，随后立即 SIGTERM
    const inFlight = fetch(`http://127.0.0.1:${PORT}/slow`).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 100)); // 确保请求已进入处理
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

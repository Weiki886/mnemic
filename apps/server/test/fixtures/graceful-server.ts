import { buildApp } from "../../src/app.js";
import { listenWithGracefulShutdown } from "../../src/server.js";

const app = buildApp();

app.get("/slow", async () => {
  // 就绪信号：测试等这行再发 SIGTERM，替代固定的 sleep 等待（#62）
  console.log("graceful-fixture slow-entered");
  await new Promise((resolve) => setTimeout(resolve, 400));
  return { done: true };
});

// 端口 0 = 由内核分配空闲端口，实际端口经 stdout 传给测试，避免写死端口冲突
await listenWithGracefulShutdown(app, { host: "127.0.0.1", port: 0 });
const address = app.server.address();
if (address === null || typeof address === "string") {
  throw new Error("fixture 未能取得监听端口");
}
console.log(`graceful-fixture listening on ${address.port}`);

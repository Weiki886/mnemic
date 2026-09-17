import { buildApp } from "../../src/app.js";
import { listenWithGracefulShutdown } from "../../src/server.js";

const app = buildApp();

app.get("/slow", async () => {
  await new Promise((resolve) => setTimeout(resolve, 400));
  return { done: true };
});

const port = Number(process.env.PORT ?? 19876);
await listenWithGracefulShutdown(app, { host: "127.0.0.1", port });
console.log(`graceful-fixture listening on ${port}`);

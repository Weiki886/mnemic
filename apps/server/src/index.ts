import { buildApp } from "./app.js";
import { listenWithGracefulShutdown } from "./server.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

const app = buildApp();

await listenWithGracefulShutdown(app, { host, port });

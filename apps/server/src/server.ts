import type { FastifyInstance } from "fastify";

export interface ListenOptions {
  host: string;
  port: number;
}

/**
 * 监听并注册优雅停机：收到 SIGTERM/SIGINT 后停止接收新连接，
 * 完成在途请求（fastify.close 语义）再以 0 退出。
 * 生产入口与测试 fixture 共用同一实现，禁止各自重写信号处理。
 */
export async function listenWithGracefulShutdown(
  app: FastifyInstance,
  options: ListenOptions,
): Promise<void> {
  await app.listen({ host: options.host, port: options.port });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, "shutting down gracefully");
      // 周期性关闭空闲 keep-alive 连接（Node >=18.2）：一次性调用只覆盖
      // 当下空闲的 socket，在途请求完成后转为空闲的连接同样需要关闭，
      // 否则 server.close() 会永远等待这些连接，进程无法退出
      const closeIdleTimer = setInterval(() => app.server.closeIdleConnections(), 100);
      closeIdleTimer.unref();
      app.server.closeIdleConnections();
      app
        .close()
        .then(() => {
          clearInterval(closeIdleTimer);
          process.exit(0);
        })
        .catch((err: unknown) => {
          clearInterval(closeIdleTimer);
          app.log.error({ err }, "error during shutdown");
          process.exit(1);
        });
    });
  }
}

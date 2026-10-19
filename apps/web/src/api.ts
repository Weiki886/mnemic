import { createApiClient } from "@mnemic/shared";

/** Token 只在调用方持有的 client 闭包中；不从 Web Storage/构建环境读取凭据。 */
export function createWebApi(token: string) {
  return createApiClient({
    baseUrl: import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000",
    token,
  });
}

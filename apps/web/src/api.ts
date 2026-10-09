import { createApiClient } from "@mnemic/shared";

/** server API client 单例（#8）：baseUrl 走 VITE_API_BASE_URL，默认本地 server */
export const api = createApiClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000",
});

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@mnemic/shared/chat-stream": fileURLToPath(
        new URL("../../packages/shared/src/chat-stream.ts", import.meta.url),
      ),
      "@mnemic/shared/management": fileURLToPath(
        new URL("../../packages/shared/src/management.ts", import.meta.url),
      ),
      "@mnemic/shared/memory": fileURLToPath(
        new URL("../../packages/shared/src/memory.ts", import.meta.url),
      ),
      "@mnemic/shared/chat": fileURLToPath(
        new URL("../../packages/shared/src/chat.ts", import.meta.url),
      ),
      "@mnemic/shared/doctor": fileURLToPath(
        new URL("../../packages/shared/src/doctor.ts", import.meta.url),
      ),
      "@mnemic/shared": fileURLToPath(
        new URL("../../packages/shared/src/index.ts", import.meta.url),
      ),
    },
  },
});

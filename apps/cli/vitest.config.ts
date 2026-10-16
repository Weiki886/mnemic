import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@mnemic/shared/doctor": fileURLToPath(
        new URL("../../packages/shared/src/doctor.ts", import.meta.url),
      ),
      "@mnemic/shared": fileURLToPath(
        new URL("../../packages/shared/src/index.ts", import.meta.url),
      ),
    },
  },
});

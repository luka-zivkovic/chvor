import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      "@chvor/shared": resolve(__dirname, "../../packages/shared/src/index.ts"),
      "@chvor/pc-agent": resolve(__dirname, "../../packages/pc-agent/src/lib/index.ts"),
    },
  },
});

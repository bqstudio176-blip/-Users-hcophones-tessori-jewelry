import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // DB suites share one database; run files sequentially for determinism.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    globalSetup: ["tests/global-setup.ts"],
  },
});

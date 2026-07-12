import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["apps/**/test/**/*.test.ts", "packages/**/test/**/*.test.ts"],
    coverage: { reporter: ["text", "json"] },
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      "@model-router/contracts": new URL("./packages/contracts/src/index.ts", import.meta.url)
        .pathname,
      "@model-router/config": new URL("./packages/config/src/index.ts", import.meta.url).pathname,
      "@model-router/router-core": new URL("./packages/router-core/src/index.ts", import.meta.url)
        .pathname,
      "@model-router/providers": new URL("./packages/providers/src/index.ts", import.meta.url)
        .pathname,
      "@model-router/telemetry": new URL("./packages/telemetry/src/index.ts", import.meta.url)
        .pathname,
    },
  },
});

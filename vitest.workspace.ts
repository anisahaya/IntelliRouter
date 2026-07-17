import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "apps/**/test/**/*.test.ts",
      "packages/**/test/**/*.test.ts",
      "skills/**/test/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
      include: ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts"],
      exclude: [
        "apps/proxy/src/server.ts",
        "apps/mcp-server/src/index.ts",
        "packages/cli/src/index.ts",
        "packages/cli/src/native-doctor.ts",
        "packages/cli/src/serve.ts",
      ],
      thresholds: { statements: 80, lines: 80, functions: 80, branches: 70 },
    },
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

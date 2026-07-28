import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const workspacePath = (relativePath: string) =>
  fileURLToPath(new URL(relativePath, import.meta.url));

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
      "@model-router/contracts": workspacePath("./packages/contracts/src/index.ts"),
      "@model-router/config": workspacePath("./packages/config/src/index.ts"),
      "@model-router/router-core": workspacePath("./packages/router-core/src/index.ts"),
      "@model-router/providers": workspacePath("./packages/providers/src/index.ts"),
      "@model-router/telemetry": workspacePath("./packages/telemetry/src/index.ts"),
      "@model-router/evaluation": workspacePath("./packages/evaluation/src/index.ts"),
    },
  },
});

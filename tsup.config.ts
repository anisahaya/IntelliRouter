import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "proxy/server": "apps/proxy/src/server.ts",
    "proxy/app": "apps/proxy/src/app.ts",
    "mcp-server/index": "apps/mcp-server/src/index.ts",
    "cli/index": "packages/cli/src/index.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  sourcemap: true,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
  external: ["better-sqlite3"],
});

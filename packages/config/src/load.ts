import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { type RouterConfig, routerConfigSchema } from "@model-router/contracts";
import { parse } from "yaml";
import { CONFIG_ENV, DEFAULT_CONFIG_PATH } from "./defaults.js";
import { validateEnvironment } from "./env.js";

export function expandHome(path: string): string {
  return path === "~"
    ? homedir()
    : path.startsWith("~/")
      ? resolve(homedir(), path.slice(2))
      : resolve(path);
}

export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MODEL_ROUTER_DATA_DIR) return resolve(env.MODEL_ROUTER_DATA_DIR);
  return resolve(homedir(), ".model-router");
}

export function assertWithinDataRoot(
  label: string,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (path === ":memory:") return;
  const resolved = resolve(path);
  const root = dataRoot(env);
  const rel = relative(root, resolved);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new Error(
    `${label} "${resolved}" is outside the model router data directory (${root}); set MODEL_ROUTER_DATA_DIR or place the file under ~/.model-router`,
  );
}

export async function assertPathConfinement(
  label: string,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  assertWithinDataRoot(label, path, env);
  const root = resolve(dataRoot(env));
  let cursor = resolve(path);
  while (true) {
    try {
      const [realRoot, realCursor] = await Promise.all([
        import("node:fs/promises").then((fs) => fs.realpath(root)),
        import("node:fs/promises").then((fs) => fs.realpath(cursor)),
      ]);
      const rel = relative(realRoot, realCursor);
      if (rel.startsWith("..") || isAbsolute(rel))
        throw new Error(`${label} resolves outside the model router data directory`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof Error && error.message.includes("outside")) throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) return;
      cursor = parent;
    }
  }
}

export async function loadConfig(
  path = process.env[CONFIG_ENV] ?? DEFAULT_CONFIG_PATH,
  options: { validateEnv?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<RouterConfig> {
  const configPath = expandHome(path);
  const text = await readFile(configPath, "utf8");
  const config = routerConfigSchema.parse(parse(text));
  config.server.databasePath = expandHome(config.server.databasePath);
  await assertPathConfinement("databasePath", config.server.databasePath, options.env);
  if (options.validateEnv !== false) validateEnvironment(config, options.env);
  return config;
}

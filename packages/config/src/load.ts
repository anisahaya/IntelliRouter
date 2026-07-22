import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
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

const DATA_ROOT_SENTINELS = ["/.model-router", "/.codex", "/.claude", "/.config/opencode"];

function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MODEL_ROUTER_DATA_DIR) return resolve(env.MODEL_ROUTER_DATA_DIR);
  return resolve(homedir(), ".model-router");
}

function assertWithinDataRoot(
  label: string,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (path === ":memory:") return;
  const resolved = resolve(path);
  const root = dataRoot(env);
  const tmp = resolve(tmpdir());
  if (
    resolved === root ||
    resolved.startsWith(`${root}/`) ||
    resolved.startsWith(`${root}\\`) ||
    resolved === tmp ||
    resolved.startsWith(`${tmp}/`) ||
    resolved.startsWith(`${tmp}${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    return;
  }
  if (DATA_ROOT_SENTINELS.some((sentinel) => resolved.includes(sentinel))) return;
  throw new Error(
    `${label} "${resolved}" is outside the model router data directory (${root}); set MODEL_ROUTER_DATA_DIR or place the file under ~/.model-router`,
  );
}

export async function loadConfig(
  path = process.env[CONFIG_ENV] ?? DEFAULT_CONFIG_PATH,
  options: { validateEnv?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<RouterConfig> {
  const configPath = expandHome(path);
  const text = await readFile(configPath, "utf8");
  const config = routerConfigSchema.parse(parse(text));
  config.server.databasePath = expandHome(config.server.databasePath);
  assertWithinDataRoot("databasePath", config.server.databasePath, options.env);
  if (options.validateEnv !== false) validateEnvironment(config, options.env);
  return config;
}

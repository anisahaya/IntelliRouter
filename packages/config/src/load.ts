import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
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

export async function loadConfig(
  path = process.env[CONFIG_ENV] ?? DEFAULT_CONFIG_PATH,
  options: { validateEnv?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<RouterConfig> {
  const text = await readFile(expandHome(path), "utf8");
  const config = routerConfigSchema.parse(parse(text));
  config.server.databasePath = expandHome(config.server.databasePath);
  if (options.validateEnv !== false) validateEnvironment(config, options.env);
  return config;
}

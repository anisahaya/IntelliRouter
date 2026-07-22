import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AutoCandidate, ReasoningEffort } from "@model-router/contracts";

const execFileAsync = promisify(execFile);
const defaultAliases = ["opus", "sonnet", "haiku"];

export interface ClaudeCommandRunner {
  execFile(
    file: string,
    args: string[],
    options: {
      timeout: number;
      maxBuffer: number;
      shell: false;
      encoding: "utf8";
      env: NodeJS.ProcessEnv;
    },
  ): Promise<{ stdout: string }>;
}

export interface ClaudeDiscoveryOptions {
  runner?: ClaudeCommandRunner;
  executable?: string;
  env?: NodeJS.ProcessEnv;
  availableModels?: string[];
  settingsPath?: string;
}

export async function discoverClaudeModels(
  options: ClaudeDiscoveryOptions = {},
): Promise<AutoCandidate[]> {
  const sourceEnv = options.env ?? process.env;
  const executable = options.executable ?? sourceEnv.CLAUDE_BIN ?? "claude";
  const result = await (options.runner ?? systemRunner).execFile(
    executable,
    ["auth", "status", "--json"],
    {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      shell: false,
      encoding: "utf8",
      env: discoveryEnvironment(sourceEnv),
    },
  );
  const auth = parseClaudeAuth(result.stdout);
  if (!auth.loggedIn) throw new Error("Claude Code is not signed in");
  const configured =
    options.availableModels ??
    (await readAvailableModels(options.settingsPath ?? defaultSettingsPath(sourceEnv)));
  const models = configured === undefined ? defaultAliases : configured;
  const candidates = [...new Set(models)]
    .map(mapClaudeModel)
    .filter((value): value is AutoCandidate => value !== undefined);
  if (candidates.length === 0) {
    throw new Error("Claude Code settings expose no routable model aliases");
  }
  return candidates.sort((left, right) => left.id.localeCompare(right.id));
}

export function parseClaudeAuth(output: string): { loggedIn: boolean; authMethod?: string } {
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    return {
      loggedIn: value.loggedIn === true,
      authMethod: typeof value.authMethod === "string" ? value.authMethod : undefined,
    };
  } catch {
    throw new Error("Claude Code returned invalid authentication status");
  }
}

function mapClaudeModel(id: string): AutoCandidate | undefined {
  const normalized = id.trim();
  if (!normalized || normalized === "default") return undefined;
  const text = normalized.toLowerCase();
  const isOpus = text === "best" || text.includes("opus");
  const isSonnet = text.includes("sonnet");
  const isHaiku = text.includes("haiku");
  const supportedEfforts: ReasoningEffort[] = isOpus
    ? ["low", "medium", "high", "xhigh", "max"]
    : isSonnet
      ? ["low", "medium", "high", "max"]
      : ["low"];
  return {
    id: normalized,
    kind: "harness-model",
    harness: "claude-code",
    displayName: displayName(normalized),
    description: "Claude Code signed-in model alias",
    available: true,
    capabilities: {
      tools: true,
      vision: true,
      search: true,
      edit: true,
      maxContextTokens: text.includes("[1m]") ? 1_000_000 : 200_000,
    },
    strengths: [
      ...(isOpus ? ["complex", "architecture", "research", "review"] : []),
      ...(isSonnet ? ["implementation", "debug", "general", "review"] : []),
      ...(isHaiku ? ["mechanical", "speed", "docs"] : []),
    ],
    quality: isOpus ? 0.98 : isSonnet ? 0.9 : isHaiku ? 0.74 : 0.84,
    speed: isHaiku ? 0.96 : isSonnet ? 0.8 : isOpus ? 0.58 : 0.7,
    economy: isHaiku ? 0.97 : isSonnet ? 0.82 : isOpus ? 0.52 : 0.7,
    supportedEfforts,
  };
}

function displayName(value: string): string {
  return value
    .split(/[-_]/)
    .map((part) => (part ? `${part[0]?.toUpperCase()}${part.slice(1)}` : part))
    .join(" ");
}

async function readAvailableModels(path: string): Promise<string[] | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    return Array.isArray(value.availableModels)
      ? value.availableModels.filter((item): item is string => typeof item === "string")
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Unable to read Claude Code model settings: ${String(error)}`);
  }
}

function defaultSettingsPath(env: NodeJS.ProcessEnv): string {
  if (env.CLAUDE_CONFIG_DIR) return join(env.CLAUDE_CONFIG_DIR, "settings.json");
  if (env.HOME) return join(env.HOME, ".claude", "settings.json");
  throw new Error("HOME or CLAUDE_CONFIG_DIR is required to locate Claude Code settings");
}

function discoveryEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  for (const key of ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "CLAUDE_CONFIG_DIR"]) {
    if (source[key]) result[key] = source[key];
  }
  return result;
}

const systemRunner: ClaudeCommandRunner = {
  async execFile(file, args, options) {
    const result = await execFileAsync(file, args, options);
    return { stdout: result.stdout };
  },
};

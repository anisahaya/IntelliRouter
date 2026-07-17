import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AutoCandidate, ReasoningEffort } from "@model-router/contracts";

const execFileAsync = promisify(execFile);
const allowedEfforts = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh", "max", "ultra"]);

interface RawModel {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  visibility?: unknown;
  supported_in_api?: unknown;
  priority?: unknown;
  supported_reasoning_levels?: unknown;
  input_modalities?: unknown;
  context_window?: unknown;
  supports_search_tool?: unknown;
}

export interface CodexCommandRunner {
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

export interface CodexDiscoveryOptions {
  runner?: CodexCommandRunner;
  executable?: string;
  env?: NodeJS.ProcessEnv;
}

export async function discoverCodexModels(
  options: CodexDiscoveryOptions = {},
): Promise<AutoCandidate[]> {
  return discoverCodexCandidates(
    options.runner ?? systemRunner,
    options.env ?? process.env,
    options.executable,
  );
}

export async function discoverCodexCandidates(
  runner: CodexCommandRunner = systemRunner,
  env: NodeJS.ProcessEnv = process.env,
  executableOverride?: string,
): Promise<AutoCandidate[]> {
  const executable = executableOverride || env.CODEX_BIN || "codex";
  const result = await runner.execFile(executable, ["debug", "models"], {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    encoding: "utf8",
    env: discoveryEnvironment(env),
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("codex debug models returned invalid JSON");
  }
  const values = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { models?: unknown }).models)
      ? (parsed as { models: unknown[] }).models
      : undefined;
  if (!values) throw new Error("codex debug models returned an invalid catalog");
  const candidates = values
    .map((value) => mapModel(value as RawModel))
    .filter((value): value is AutoCandidate => value !== undefined);
  if (candidates.length === 0) throw new Error("Codex reported no visible executable models");
  return candidates.sort((left, right) => left.id.localeCompare(right.id));
}

function mapModel(model: RawModel): AutoCandidate | undefined {
  if (
    typeof model.slug !== "string" ||
    model.slug.length === 0 ||
    model.visibility !== "list" ||
    model.supported_in_api !== true
  )
    return undefined;
  const description = typeof model.description === "string" ? model.description : "";
  const displayName = typeof model.display_name === "string" ? model.display_name : model.slug;
  const text = `${model.slug} ${displayName} ${description}`.toLowerCase();
  const priority =
    typeof model.priority === "number" && Number.isFinite(model.priority)
      ? Math.max(1, model.priority)
      : 25;
  const frontier = /frontier|latest|most capable|complex|ambitious/.test(text);
  const strong = /\bstrong\b/.test(text);
  const fast = /fast|small|mini|efficient|affordable|simple/.test(text);
  const balanced = /balanced|everyday|general/.test(text);
  const quality = clamp(
    0.7 +
      (frontier ? 0.22 : 0) +
      (strong ? 0.06 : 0) +
      (balanced && !frontier ? 0.1 : 0) -
      (fast ? 0.08 : 0) -
      Math.min(0.18, priority / 150),
  );
  const speed = clamp(0.48 + (fast ? 0.38 : 0) + (balanced ? 0.15 : 0) - (frontier ? 0.08 : 0));
  const economy = clamp(0.45 + (fast ? 0.42 : 0) + (balanced ? 0.12 : 0) - (frontier ? 0.1 : 0));
  const supportedEfforts = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels.flatMap((value) => {
        const effort =
          value && typeof value === "object" ? (value as { effort?: unknown }).effort : value;
        return typeof effort === "string" && allowedEfforts.has(effort as ReasoningEffort)
          ? [effort as ReasoningEffort]
          : [];
      })
    : [];
  const modalities = Array.isArray(model.input_modalities)
    ? model.input_modalities.filter((value): value is string => typeof value === "string")
    : [];
  return {
    id: model.slug,
    kind: "codex-model",
    harness: "codex",
    displayName,
    description,
    available: true,
    capabilities: {
      tools: true,
      vision: modalities.includes("image"),
      search: model.supports_search_tool === true,
      edit: true,
      maxContextTokens:
        typeof model.context_window === "number" && model.context_window > 0
          ? Math.floor(model.context_window)
          : 1,
    },
    strengths: extractStrengths(text),
    quality,
    speed,
    economy,
    supportedEfforts,
  };
}

function extractStrengths(text: string): string[] {
  const strengths = [
    ["complex", /frontier|complex|ambitious|most capable/],
    ["architecture", /architecture|design|ambitious/],
    ["implementation", /coding|code|agentic|everyday/],
    ["research", /research|search/],
    ["mechanical", /small|simple|efficient|fast/],
  ] as const;
  return strengths.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function discoveryEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "PATH", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL"]) {
    if (source[key]) result[key] = source[key];
  }
  return result;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

const systemRunner: CodexCommandRunner = {
  async execFile(file, args, options) {
    const result = await execFileAsync(file, args, options);
    return { stdout: result.stdout };
  },
};

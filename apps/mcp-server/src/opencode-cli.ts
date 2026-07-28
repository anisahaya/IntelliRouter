import type { AutoCandidate, ReasoningEffort } from "@model-router/contracts";
import { parseBoundedJSON } from "@model-router/telemetry";
import { captureCommand } from "./command.js";

const allowedEfforts = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh", "max", "ultra"]);

interface RawOpenCodeModel {
  id?: unknown;
  providerID?: unknown;
  name?: unknown;
  family?: unknown;
  status?: unknown;
  limit?: { context?: unknown };
  capabilities?: {
    toolcall?: unknown;
    attachment?: unknown;
    input?: { image?: unknown };
  };
  variants?: unknown;
}

export interface OpenCodeCommandRunner {
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

export interface OpenCodeDiscoveryOptions {
  runner?: OpenCodeCommandRunner;
  executable?: string;
  env?: NodeJS.ProcessEnv;
  provider?: string;
}

export async function discoverOpenCodeModels(
  options: OpenCodeDiscoveryOptions = {},
): Promise<AutoCandidate[]> {
  const sourceEnv = options.env ?? process.env;
  const executable = options.executable ?? sourceEnv.OPENCODE_BIN ?? "opencode";
  const args = ["models", ...(options.provider ? [options.provider] : []), "--verbose"];
  const result = await (options.runner ?? systemRunner).execFile(executable, args, {
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    encoding: "utf8",
    env: discoveryEnvironment(sourceEnv),
  });
  const parsed = parseVerboseModels(result.stdout);
  const candidates = parsed
    .map(({ qualifiedId, model }) => mapModel(qualifiedId, model))
    .filter((value): value is AutoCandidate => value !== undefined);
  if (candidates.length === 0) throw new Error("OpenCode reported no visible executable models");
  return candidates.sort((left, right) => left.id.localeCompare(right.id));
}

export function parseVerboseModels(
  output: string,
): Array<{ qualifiedId: string; model: RawOpenCodeModel }> {
  const result: Array<{ qualifiedId: string; model: RawOpenCodeModel }> = [];
  const lines = output.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const qualifiedId = lines[index]?.trim() ?? "";
    if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(qualifiedId)) continue;
    let json = "";
    let depth = 0;
    let started = false;
    let inString = false;
    let escaped = false;
    for (index += 1; index < lines.length; index++) {
      const line = lines[index] ?? "";
      json += `${line}\n`;
      for (const character of line) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (character === "\\" && inString) {
          escaped = true;
          continue;
        }
        if (character === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (character === "{") {
          depth++;
          started = true;
        } else if (character === "}") depth--;
      }
      if (started && depth === 0) break;
    }
    try {
      const model = parseBoundedJSON(json, 256 * 1024) as RawOpenCodeModel;
      result.push({ qualifiedId, model });
    } catch {
      throw new Error(`OpenCode returned invalid metadata for ${qualifiedId}`);
    }
  }
  return result;
}

function mapModel(qualifiedId: string, model: RawOpenCodeModel): AutoCandidate | undefined {
  if (model.status !== "active" || typeof model.id !== "string") return undefined;
  const displayName = typeof model.name === "string" ? model.name : model.id;
  const text = `${qualifiedId} ${displayName} ${String(model.family ?? "")}`.toLowerCase();
  const isSol = /(?:^|[- /])sol(?:$|[- /])/.test(text);
  const isTerra = /(?:^|[- /])terra(?:$|[- /])/.test(text);
  const isLuna = /(?:^|[- /])luna(?:$|[- /])/.test(text);
  const isFast = /fast|spark|mini/.test(text);
  const quality = clamp(isSol ? 0.98 : isTerra ? 0.9 : isLuna ? 0.8 : isFast ? 0.7 : 0.84);
  const speed = clamp(isLuna ? 0.94 : isTerra ? 0.8 : isSol ? 0.58 : isFast ? 0.88 : 0.68);
  const economy = clamp(isLuna ? 0.95 : isTerra ? 0.85 : isSol ? 0.58 : isFast ? 0.92 : 0.72);
  const variants =
    model.variants && typeof model.variants === "object" && !Array.isArray(model.variants)
      ? Object.keys(model.variants)
      : [];
  const supportedEfforts = variants.filter((value): value is ReasoningEffort =>
    allowedEfforts.has(value as ReasoningEffort),
  );
  const toolcall = model.capabilities?.toolcall === true;
  return {
    id: qualifiedId,
    kind: "harness-model",
    harness: "opencode",
    displayName,
    description: `OpenCode ${String(model.family ?? "model")}`,
    available: true,
    capabilities: {
      tools: toolcall,
      vision: model.capabilities?.attachment === true || model.capabilities?.input?.image === true,
      search: toolcall,
      edit: toolcall,
      maxContextTokens:
        typeof model.limit?.context === "number" && model.limit.context > 0
          ? Math.floor(model.limit.context)
          : 1,
    },
    strengths: [
      ...(isSol ? ["complex", "architecture", "research", "review"] : []),
      ...(isTerra ? ["implementation", "debug", "general"] : []),
      ...(isLuna || isFast ? ["mechanical", "speed", "docs"] : []),
    ],
    quality,
    speed,
    economy,
    supportedEfforts,
  };
}

function discoveryEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  for (const key of [
    "HOME",
    "PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
  ]) {
    if (source[key]) result[key] = source[key];
  }
  return result;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

const systemRunner: OpenCodeCommandRunner = {
  async execFile(file, args, options) {
    const result = await captureCommand(file, args, options);
    return { stdout: result.stdout };
  },
};

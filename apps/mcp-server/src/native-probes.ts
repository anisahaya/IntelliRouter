import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { AutoCandidate, HarnessId } from "@model-router/contracts";

const execFileAsync = promisify(execFile);
export type ProbeFailure = "auth" | "quota" | "model-invalid";

export interface NativeProbeEvidence {
  harness: HarnessId;
  candidateId: string;
  catalogObservedAt: string;
  probedAt: string;
  lastSuccessAt?: string;
  latencyMs: number;
  outcome: "success" | ProbeFailure;
}

export interface NativeProbeRunner {
  probe(input: {
    harness: HarnessId;
    candidate: AutoCandidate;
    env: NodeJS.ProcessEnv;
  }): Promise<void>;
}

export interface NativeProbeOptions {
  enabled?: boolean;
  path?: string;
  ttlMs?: number;
  timeoutMs?: number;
  runner?: NativeProbeRunner;
  now?: () => number;
}

export async function collectNativeProbeEvidence(
  harness: HarnessId,
  candidates: readonly AutoCandidate[],
  catalogObservedAt: string,
  env: NodeJS.ProcessEnv,
  options: NativeProbeOptions = {},
): Promise<Record<string, NativeProbeEvidence>> {
  if (!options.enabled || candidates.length === 0) return {};
  const now = options.now?.() ?? Date.now();
  const ttlMs = options.ttlMs ?? 15 * 60 * 1_000;
  const cached = await readProbeCache(options.path);
  const result: Record<string, NativeProbeEvidence> = {};
  for (const candidate of candidates) {
    const key = `${harness}\0${candidate.id}`;
    const prior = cached.get(key);
    if (prior && now - Date.parse(prior.probedAt) < ttlMs) {
      result[candidate.id] = { ...prior, catalogObservedAt };
      continue;
    }
    const started = options.now?.() ?? Date.now();
    try {
      await (options.runner ?? systemProbeRunner(options.timeoutMs)).probe({
        harness,
        candidate,
        env,
      });
      const observedAt = new Date(options.now?.() ?? Date.now()).toISOString();
      const evidence: NativeProbeEvidence = {
        harness,
        candidateId: candidate.id,
        catalogObservedAt,
        probedAt: observedAt,
        lastSuccessAt: observedAt,
        latencyMs: Math.max(0, (options.now?.() ?? Date.now()) - started),
        outcome: "success",
      };
      result[candidate.id] = evidence;
      await appendProbe(evidence, options.path);
    } catch (error) {
      const failure = classifyProbeFailure(error);
      if (!failure) continue;
      const evidence: NativeProbeEvidence = {
        harness,
        candidateId: candidate.id,
        catalogObservedAt,
        probedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
        lastSuccessAt: prior?.lastSuccessAt,
        latencyMs: Math.max(0, (options.now?.() ?? Date.now()) - started),
        outcome: failure,
      };
      result[candidate.id] = evidence;
      await appendProbe(evidence, options.path);
    }
  }
  return result;
}

function systemProbeRunner(timeoutMs = 20_000): NativeProbeRunner {
  return {
    async probe({ harness, candidate, env }) {
      const prompt = "Reply with exactly OK.";
      const [file, args] =
        harness === "codex"
          ? [
              env.CODEX_BIN ?? "codex",
              [
                "exec",
                "--model",
                candidate.id,
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
                prompt,
              ],
            ]
          : harness === "opencode"
            ? [env.OPENCODE_BIN ?? "opencode", ["run", "--model", candidate.id, prompt]]
            : [env.CLAUDE_BIN ?? "claude", ["-p", "--model", candidate.id, prompt]];
      await execFileAsync(file, args, {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        shell: false,
        encoding: "utf8",
        env,
      });
    },
  };
}

function classifyProbeFailure(error: unknown): ProbeFailure | undefined {
  const value = error as { message?: unknown; stderr?: unknown; stdout?: unknown };
  const text =
    `${String(value.message ?? "")} ${String(value.stderr ?? "")} ${String(value.stdout ?? "")}`.toLowerCase();
  if (
    /unauthori[sz]ed|not signed in|authentication|invalid.*(?:token|api key)|forbidden/.test(text)
  )
    return "auth";
  if (/quota|rate.?limit|too many requests|usage limit|capacity/.test(text)) return "quota";
  if (/model.*(?:not found|invalid|unknown|unavailable)|invalid.*model/.test(text))
    return "model-invalid";
  return undefined;
}

async function readProbeCache(path?: string): Promise<Map<string, NativeProbeEvidence>> {
  const result = new Map<string, NativeProbeEvidence>();
  if (!path) return result;
  try {
    for (const line of (await readFile(path, "utf8")).split("\n")) {
      if (!line) continue;
      try {
        const value = JSON.parse(line) as NativeProbeEvidence;
        if (value.candidateId && value.harness)
          result.set(`${value.harness}\0${value.candidateId}`, value);
      } catch {
        // Ignore a truncated final append; earlier evidence remains usable.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return result;
}

async function appendProbe(evidence: NativeProbeEvidence, path?: string): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(evidence)}\n`, { encoding: "utf8", mode: 0o600 });
}

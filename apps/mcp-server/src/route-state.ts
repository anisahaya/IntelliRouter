import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  AutoRouteDecision,
  AutoRouteProfile,
  AutoRouteRequirements,
  AutoTaskProfile,
  HarnessId,
  HarnessRouteRecord,
  ReasoningEffort,
  RouteOutcome,
} from "@model-router/contracts";
import { parseBoundedJSON } from "@model-router/telemetry";

export interface RouteStateOptions {
  path?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RouteIdentityInput {
  harness: HarnessId;
  sessionId?: string;
  objective: string;
  workspaceRoot: string;
  requirements?: AutoRouteRequirements;
}

export function routeIdentity(input: RouteIdentityInput): {
  taskFingerprint: string;
  workspaceFingerprint: string;
  sessionHash?: string;
} {
  const normalized = input.objective.toLowerCase().replace(/\s+/g, " ").trim();
  return {
    taskFingerprint: digest(
      `${input.harness}\0${normalized}\0${JSON.stringify(input.requirements ?? {})}`,
    ),
    workspaceFingerprint: digest(input.workspaceRoot),
    sessionHash: input.sessionId ? digest(input.sessionId) : undefined,
  };
}

export async function persistDecision(
  decision: AutoRouteDecision,
  identity: ReturnType<typeof routeIdentity>,
  options: RouteStateOptions = {},
): Promise<HarnessRouteRecord> {
  if (!decision.harness) throw new Error("Cannot persist a route without a harness");
  const now = new Date().toISOString();
  const record: HarnessRouteRecord = {
    routeId: decision.routeId ?? randomUUID(),
    createdAt: now,
    updatedAt: now,
    harness: decision.harness,
    sessionHash: identity.sessionHash,
    taskFingerprint: identity.taskFingerprint,
    workspaceFingerprint: identity.workspaceFingerprint,
    selectedCandidate: decision.selected?.id,
    reasoningEffort: decision.selected?.reasoningEffort,
    fallbackModel: decision.fallback.model,
    profile: decision.profile,
    outcome: "planned",
    featureSummary: featureSummary(decision.taskProfile),
    partialWriteDetected: false,
  };
  await appendRecord(record, options);
  return record;
}

export async function findAffinity(
  harness: HarnessId,
  identity: ReturnType<typeof routeIdentity>,
  options: RouteStateOptions = {},
): Promise<HarnessRouteRecord | undefined> {
  if (!identity.sessionHash) return undefined;
  const latest = new Map<string, HarnessRouteRecord>();
  for (const record of await readRecords(options)) latest.set(record.routeId, record);
  return [...latest.values()]
    .filter(
      (record) =>
        record.harness === harness &&
        record.sessionHash === identity.sessionHash &&
        record.workspaceFingerprint === identity.workspaceFingerprint &&
        record.taskFingerprint === identity.taskFingerprint &&
        record.selectedCandidate &&
        !["failure", "timed-out", "abandoned"].includes(record.outcome),
    )
    .at(-1);
}

export async function updateRouteOutcome(
  routeId: string,
  outcome: RouteOutcome,
  input: { rerouteReason?: string; partialWriteDetected?: boolean } = {},
  options: RouteStateOptions = {},
): Promise<HarnessRouteRecord> {
  const current = await getRouteRecord(routeId, options);
  if (!current) throw new Error(`Unknown harness route: ${routeId}`);
  const updated: HarnessRouteRecord = {
    ...current,
    updatedAt: new Date().toISOString(),
    outcome,
    rerouteReason: sanitizeReason(input.rerouteReason),
    partialWriteDetected: input.partialWriteDetected ?? current.partialWriteDetected,
  };
  await appendRecord(updated, options);
  await compactStateIfLarge(options);
  return updated;
}

export async function getRouteRecord(
  routeId: string,
  options: RouteStateOptions = {},
): Promise<HarnessRouteRecord | undefined> {
  return (await readRecords(options)).filter((record) => record.routeId === routeId).at(-1);
}

export function newRouteId(): string {
  return randomUUID();
}

export function affinityDecision(input: {
  record: HarnessRouteRecord;
  candidates: AutoRouteDecision["ranked"];
  taskProfile: AutoTaskProfile;
  repoSignals: AutoRouteDecision["repoSignals"];
  profile: AutoRouteProfile;
  context: AutoRouteDecision["context"];
  fallbackModel?: string;
  execution: "codex-exec" | "opencode-run" | "claude-print";
}): AutoRouteDecision | undefined {
  const selected = input.candidates.find(
    (candidate) => candidate.id === input.record.selectedCandidate,
  );
  if (!selected) return undefined;
  return {
    routeId: newRouteId(),
    harness: input.record.harness,
    taskFingerprint: input.record.taskFingerprint,
    affinityReused: true,
    status: "planned",
    selected: {
      id: selected.id,
      kind: selected.kind,
      displayName: selected.displayName,
      reasoningEffort: (input.record.reasoningEffort ?? selected.reasoningEffort) as
        | ReasoningEffort
        | undefined,
      execution: input.execution,
    },
    profile: input.profile,
    taskProfile: input.taskProfile,
    repoSignals: input.repoSignals,
    ranked: [selected, ...input.candidates.filter((candidate) => candidate.id !== selected.id)],
    excluded: [],
    fallback: {
      kind: "current-model",
      model: input.fallbackModel,
      harness: input.record.harness,
    },
    context: input.context,
  };
}

function featureSummary(task: AutoTaskProfile): HarnessRouteRecord["featureSummary"] {
  return {
    taskType: task.taskType,
    complexity: task.complexity,
    risk: task.risk,
    scope: task.scope,
    requiredCapabilities: [
      ...(task.toolsRequired ? ["tools"] : []),
      ...(task.visionRequired ? ["vision"] : []),
      ...(task.searchRequired ? ["search"] : []),
      ...(task.editRequired ? ["edit"] : []),
    ],
  };
}

async function appendRecord(record: HarnessRouteRecord, options: RouteStateOptions): Promise<void> {
  const path = statePath(options);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify(record)}\n`;
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(line);
  } finally {
    await handle.close();
  }
}

async function readRecords(options: RouteStateOptions): Promise<HarnessRouteRecord[]> {
  const path = statePath(options);
  const info = await stat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return [];
  if (info.size > MAX_STATE_FILE_BYTES) {
    await compactStateFile(options);
  }
  try {
    const source = await readFile(path, "utf8");
    return source
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        if (line.length > MAX_RECORD_BYTES) return [];
        try {
          return [parseBoundedJSON(line, 64 * 1024) as HarnessRouteRecord];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const STATE_MAX_RECORDS = 5_000;
const STATE_MAX_AGE_DAYS = 30;
const MAX_STATE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const SECRET_PATTERN = /\b(?:sk|ghp|github_pat|xox[abprs]|key-|bearer)[-._~+\\/A-Za-z0-9]{8,}\b/gi;
const REDACTION_PAIR_PATTERN =
  /(["'](?:token|secret|password|credential|api[_-]?key|authorization)["']\s*:\s*["'])[^"']+(["'])/gi;

function sanitizeReason(value?: string): string | undefined {
  if (!value) return undefined;
  let safe = value
    .slice(0, 512)
    .replace(SECRET_PATTERN, "[REDACTED]")
    .replace(REDACTION_PAIR_PATTERN, "$1[REDACTED]$2");
  if (process.env.HOME && process.env.HOME.length > 2)
    safe = safe.split(process.env.HOME).join("~");
  return safe;
}

async function compactStateIfLarge(options: RouteStateOptions): Promise<void> {
  const path = statePath(options);
  const info = await stat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (info && info.size > MAX_STATE_FILE_BYTES) await compactStateFile(options);
}

async function compactStateFile(options: RouteStateOptions): Promise<void> {
  const path = statePath(options);
  const records = await readRecordsRaw(path);
  const latest = new Map<string, HarnessRouteRecord>();
  for (const record of records) latest.set(record.routeId, record);
  const cutoff = Date.now() - STATE_MAX_AGE_DAYS * 24 * 60 * 60 * 1_000;
  const kept = [...latest.values()]
    .filter((record) => Date.parse(record.updatedAt) >= cutoff)
    .slice(-STATE_MAX_RECORDS);
  const serialized = kept.map((record) => JSON.stringify(record)).join("\n");
  const temp = `${path}.tmp`;
  await writeFile(temp, `${serialized}\n`, { encoding: "utf8", mode: 0o600 });
  await import("node:fs/promises").then((fs) => fs.rename(temp, path));
}

async function readRecordsRaw(path: string): Promise<HarnessRouteRecord[]> {
  try {
    const source = await readFile(path, "utf8");
    return source
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        if (line.length > MAX_RECORD_BYTES) return [];
        try {
          return [parseBoundedJSON(line, 64 * 1024) as HarnessRouteRecord];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function statePath(options: RouteStateOptions): string {
  const env = options.env ?? process.env;
  const candidate = options.path ?? env.MODEL_ROUTER_STATE_PATH;
  if (candidate) {
    const resolved = resolve(candidate);
    const home = env.HOME ?? "";
    const dataRoot =
      env.MODEL_ROUTER_DATA_DIR ?? (home ? join(home, ".model-router") : join("/.model-router"));
    const rel = relative(resolve(dataRoot), resolved);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      // Existing symlinks must not escape the configured data root.
      try {
        const rootReal = realpathSync(resolve(dataRoot));
        let probe = resolved;
        while (true) {
          try {
            probe = realpathSync(probe);
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            const parent = dirname(probe);
            if (parent === probe) throw error;
            probe = parent;
          }
        }
        const pathReal = probe;
        const realRel = relative(rootReal, pathReal);
        if (realRel === "" || (!realRel.startsWith("..") && !isAbsolute(realRel))) return resolved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolved;
      }
    }
    throw new Error(
      `MODEL_ROUTER_STATE_PATH "${resolved}" is outside the model router data directory (${dataRoot})`,
    );
  }
  const home = env.HOME;
  if (!home) throw new Error("HOME or MODEL_ROUTER_STATE_PATH is required for route persistence");
  return join(home, ".model-router", "harness-routes.jsonl");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

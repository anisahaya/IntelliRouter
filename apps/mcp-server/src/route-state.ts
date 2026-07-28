import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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
  SafeReceipt,
  VerificationKind,
} from "@model-router/contracts";
import { parseBoundedJSON, TelemetryStore } from "@model-router/telemetry";

export interface RouteStateOptions {
  path?: string;
  env?: NodeJS.ProcessEnv;
  telemetryStore?: TelemetryStore;
  databasePath?: string;
  legacyJsonlPath?: string;
}

interface StoreLease {
  store: TelemetryStore;
  owned: boolean;
}

function acquireStore(options: RouteStateOptions): StoreLease {
  if (options.telemetryStore) return { store: options.telemetryStore, owned: false };
  const env = options.env ?? process.env;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const dataRoot = env.MODEL_ROUTER_DATA_DIR ?? join(home, ".model-router");
  const path =
    options.databasePath ?? env.MODEL_ROUTER_DATABASE_PATH ?? join(dataRoot, "router.db");
  return { store: new TelemetryStore(path), owned: true };
}

function processForRouteOutcome(outcome: RouteOutcome) {
  switch (outcome) {
    case "planned":
      return "planned" as const;
    case "running":
    case "fallback":
      return "running" as const;
    case "success":
    case "corrected":
      return "completed" as const;
    case "failure":
      return "failed" as const;
    case "timed-out":
      return "timed-out" as const;
    case "abandoned":
      return "canceled" as const;
  }
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
    selectionSnapshot: {
      selectionRule: "min-expected-cost-subject-to-quality-floor-v1",
      coldStart: decision.coldStart ?? false,
      coldStartReason: decision.coldStartReason,
      selected: decision.ranked.find((candidate) => candidate.id === decision.selected?.id),
    },
    partialWriteDetected: false,
  };
  await appendRecord(record, options);
  const lease = acquireStore(options);
  try {
    await syncLegacyRoutes(lease.store, options);
    lease.store.taskRuns.createRun({
      routeId: record.routeId,
      origin: "native",
      taskFingerprint: lease.store.taskRuns.fingerprint(record.taskFingerprint, "native-task"),
      workspaceFingerprint: lease.store.taskRuns.fingerprint(
        record.workspaceFingerprint,
        "native-workspace",
      ),
      algorithm: "hmac-sha256-v1",
      selectedModel: record.selectedCandidate,
      effort: record.reasoningEffort,
      harness: record.harness,
      profile: record.profile,
      derivedFeatures: record.featureSummary,
      repoTags: decision.taskProfile.repoTags,
      context: {
        estimatedTokens: decision.taskProfile.estimatedContextTokens,
        objectiveTruncated: decision.context.objectiveTruncated,
        conversationTruncated: decision.context.conversationTruncated,
      },
      cache: { status: "unknown" },
    });
  } finally {
    if (lease.owned) lease.store.close();
  }
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
  input: {
    rerouteReason?: string;
    partialWriteDetected?: boolean;
    latencyMs?: number;
    recordAttempt?: boolean;
  } = {},
  options: RouteStateOptions = {},
): Promise<HarnessRouteRecord> {
  const current = await getRouteRecord(routeId, options);
  if (!current) throw new Error(`Unknown harness route: ${routeId}`);
  const updated: HarnessRouteRecord = {
    ...current,
    updatedAt: new Date().toISOString(),
    outcome,
    rerouteReason: sanitizeReason(input.rerouteReason, options.env),
    partialWriteDetected: input.partialWriteDetected ?? current.partialWriteDetected,
  };
  await appendRecord(updated, options);
  const lease = acquireStore(options);
  try {
    await syncLegacyRoutes(lease.store, options);
    lease.store.database.transaction(() => {
      lease.store.taskRuns.completeProcess(routeId, processForRouteOutcome(outcome), {
        latencyMs: input.latencyMs,
        partialWriteDetected: updated.partialWriteDetected,
        safeToFallback: !updated.partialWriteDetected,
        tokenBasis: "unknown",
        costBasis: "unknown",
        cache: { status: "unknown" },
      });
      if (input.recordAttempt) {
        lease.store.taskRuns.recordAttempt(routeId, {
          attemptOrder: 1,
          model: updated.selectedCandidate,
          harness: updated.harness,
          effort: updated.reasoningEffort,
          outcome: processForRouteOutcome(outcome),
          retry: false,
          fallback: false,
          tokenBasis: "unknown",
          latencyMs: input.latencyMs,
          costBasis: "unknown",
          partialWriteDetected: updated.partialWriteDetected,
          safeToFallback: !updated.partialWriteDetected,
        });
      }
      if (outcome === "corrected" || outcome === "abandoned")
        lease.store.taskRuns.event(routeId, "feedback", {
          outcome,
          reasonCategory: "unknown",
        });
    })();
  } finally {
    if (lease.owned) lease.store.close();
  }
  await compactStateIfLarge(options);
  return updated;
}

export async function recordTaskRunFeedback(
  input: {
    routeId: string;
    outcome: "success" | "failure" | "corrected" | "abandoned" | "reverted";
    score?: number;
    tags?: string[];
    reasonCategory?:
      | "correctness"
      | "instruction"
      | "cost"
      | "latency"
      | "changed-scope"
      | "user-choice"
      | "unknown";
  },
  options: RouteStateOptions = {},
): Promise<SafeReceipt> {
  const lease = acquireStore(options);
  try {
    await syncLegacyRoutes(lease.store, options);
    lease.store.taskRuns.event(input.routeId, "feedback", {
      outcome: input.outcome,
      score: input.score,
      tags: input.tags ?? [],
      reasonCategory: input.reasonCategory ?? "unknown",
    });
    const receipt = lease.store.getSafeReceipt(input.routeId);
    if (!receipt) throw new Error(`Unknown harness route: ${input.routeId}`);
    return receipt;
  } finally {
    if (lease.owned) lease.store.close();
  }
}

export async function getRouteRecord(
  routeId: string,
  options: RouteStateOptions = {},
): Promise<HarnessRouteRecord | undefined> {
  const records = await readRecords(options);
  let lease: StoreLease | undefined;
  try {
    // JSONL is the authoritative native route record. SQLite is additive telemetry;
    // an open, migration, or import failure must not make route reads unavailable.
    lease = acquireStore(options);
    await syncLegacyRoutes(lease.store, options, records);
  } catch {
    // Preserve the JSONL result and let telemetry repair happen on a later write.
  } finally {
    if (lease?.owned) lease.store.close();
  }
  return records.filter((record) => record.routeId === routeId).at(-1);
}

export async function getTaskRunReceipt(
  routeId: string,
  options: RouteStateOptions = {},
): Promise<SafeReceipt | undefined> {
  const lease = acquireStore(options);
  try {
    await syncLegacyRoutes(lease.store, options);
    return lease.store.getSafeReceipt(routeId);
  } finally {
    if (lease.owned) lease.store.close();
  }
}

export async function recordTaskRunVerification(
  input: {
    routeId: string;
    kind: VerificationKind;
    result: "passed" | "failed" | "inconclusive";
    checkName: string;
    latencyMs?: number;
    evidenceHash?: string;
  },
  options: RouteStateOptions = {},
): Promise<SafeReceipt> {
  const lease = acquireStore(options);
  try {
    await syncLegacyRoutes(lease.store, options);
    lease.store.taskRuns.verify(input.routeId, input);
    const receipt = lease.store.getSafeReceipt(input.routeId);
    if (!receipt) throw new Error(`Unknown harness route: ${input.routeId}`);
    return receipt;
  } finally {
    if (lease.owned) lease.store.close();
  }
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
  if (!selected.scores.meetsQualityThreshold || !selected.scores.expectedCostComparable)
    return undefined;
  const affinitySelected = {
    ...selected,
    scores: {
      ...selected.scores,
      selectionReason:
        "eligible session affinity reused; continuity avoids an observable model/cache switch",
    },
  };
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
    ranked: [
      affinitySelected,
      ...input.candidates.filter((candidate) => candidate.id !== selected.id),
    ],
    excluded: [],
    fallback: {
      kind: "current-model",
      model: input.fallbackModel,
      harness: input.record.harness,
    },
    context: input.context,
    selectionRule: "min-expected-cost-subject-to-quality-floor-v1",
    coldStart: false,
  };
}

function featureSummary(task: AutoTaskProfile): HarnessRouteRecord["featureSummary"] {
  return {
    taskType: task.taskType,
    complexity: task.complexity,
    ambiguity: task.ambiguity,
    risk: task.risk,
    mechanical: task.mechanical,
    scope: task.scope,
    requiredCapabilities: [
      ...(task.toolsRequired ? ["tools"] : []),
      ...(task.visionRequired ? ["vision"] : []),
      ...(task.searchRequired ? ["search"] : []),
      ...(task.editRequired ? ["edit"] : []),
    ],
    estimatedContextTokens: task.estimatedContextTokens,
    repoTags: task.repoTags,
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

function sanitizeReason(value?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!value) return undefined;
  let safe = value
    .slice(0, 512)
    .replace(SECRET_PATTERN, "[REDACTED]")
    .replace(REDACTION_PAIR_PATTERN, "$1[REDACTED]$2");
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  if (home.length > 2) safe = safe.split(home).join("~");
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
  const candidate = options.legacyJsonlPath ?? options.path ?? env.MODEL_ROUTER_STATE_PATH;
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
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return join(home, ".model-router", "harness-routes.jsonl");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function syncLegacyRoutes(
  store: TelemetryStore,
  options: RouteStateOptions,
  knownRecords?: HarnessRouteRecord[],
): Promise<void> {
  const path = statePath(options);
  const records = knownRecords ?? (await readRecords(options));
  const source = await readFile(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!source) return;
  store.taskRuns.importLegacyNativeRoutes(
    records,
    createHash("sha256").update(source).digest("hex"),
  );
}

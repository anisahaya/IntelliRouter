import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type {
  AutoObservedMetrics,
  AutoRouteDecision,
  AutoRouteRequirements,
  AutoTaskProfile,
  HarnessAttemptRecord,
  HarnessFeedbackRecord,
  HarnessHealthWindow,
  HarnessId,
  HarnessRouteRecord,
  NativeRouteHistoryFilters,
  NativeRouteJob,
  NativeRouteStats,
  ReasoningEffort,
  RouteOutcome,
} from "@model-router/contracts";
import { TelemetryStore } from "@model-router/telemetry";
import type { NativePolicyUsage } from "./native-policy.js";

export interface RouteStateOptions {
  path?: string;
  databasePath?: string;
  env?: NodeJS.ProcessEnv;
  affinityTtlMs?: number;
  now?: () => number;
}

export interface RouteIdentityInput {
  harness: HarnessId;
  sessionId?: string;
  taskId?: string;
  objective: string;
  workspaceRoot: string;
  requirements?: AutoRouteRequirements;
}

export function routeIdentity(input: RouteIdentityInput): {
  taskFingerprint: string;
  workspaceFingerprint: string;
  sessionHash?: string;
  taskIdHash?: string;
  requirementsFingerprint: string;
} {
  const normalized = input.objective.toLowerCase().replace(/\s+/g, " ").trim();
  const taskIdHash = input.taskId ? digest(input.taskId) : undefined;
  const requirementsFingerprint = digest(JSON.stringify(input.requirements ?? {}));
  return {
    taskFingerprint: digest(
      taskIdHash
        ? `${input.harness}\0task-id\0${taskIdHash}`
        : `${input.harness}\0${normalized}\0${JSON.stringify(input.requirements ?? {})}`,
    ),
    workspaceFingerprint: digest(input.workspaceRoot),
    sessionHash: input.sessionId ? digest(input.sessionId) : undefined,
    taskIdHash,
    requirementsFingerprint,
  };
}

export async function persistDecision(
  decision: AutoRouteDecision,
  identity: ReturnType<typeof routeIdentity>,
  options: RouteStateOptions = {},
): Promise<HarnessRouteRecord> {
  const record = buildRouteRecord(decision, identity, options);
  await appendRecord(record, options);
  return record;
}

export function buildRouteRecord(
  decision: AutoRouteDecision,
  identity: ReturnType<typeof routeIdentity>,
  options: RouteStateOptions = {},
): HarnessRouteRecord {
  if (!decision.harness) throw new Error("Cannot persist a route without a harness");
  const now = new Date().toISOString();
  const record: HarnessRouteRecord = {
    routeId: decision.routeId ?? randomUUID(),
    createdAt: now,
    updatedAt: now,
    harness: decision.harness,
    sessionHash: identity.sessionHash,
    taskIdHash: identity.taskIdHash,
    taskFingerprint: identity.taskFingerprint,
    workspaceFingerprint: identity.workspaceFingerprint,
    requirementsFingerprint: identity.requirementsFingerprint,
    affinityExpiresAt: new Date(
      (options.now?.() ?? Date.now()) + (options.affinityTtlMs ?? 60 * 60 * 1_000),
    ).toISOString(),
    confidence: decision.confidence,
    selectedCandidate: decision.selected?.id,
    reasoningEffort: decision.selected?.reasoningEffort,
    fallbackModel: decision.fallback.model,
    profile: decision.profile,
    policy: decision.policy,
    outcome: "planned",
    featureSummary: featureSummary(decision.taskProfile),
    candidateRankings: decision.ranked.map((candidate, index) => ({
      candidateId: candidate.id,
      rank: index + 1,
      totalScore: candidate.scores.total,
      kind: candidate.kind,
      reasoningEffort: candidate.reasoningEffort,
    })),
    attempts: [],
    feedback: [],
    healthWindows: [],
    partialWriteDetected: false,
  };
  return record;
}

export async function persistDecisionAndJob(
  decision: AutoRouteDecision,
  identity: ReturnType<typeof routeIdentity>,
  job: NativeRouteJob,
  options: RouteStateOptions = {},
): Promise<{ route: HarnessRouteRecord; job: NativeRouteJob }> {
  const route = buildRouteRecord(decision, identity, options);
  const store = await openNativeStore(options);
  try {
    return { route, job: store.saveNativeRouteAndJob(route, job) };
  } finally {
    store.close();
  }
}

export async function recordRouteAttempt(
  routeId: string,
  attempt: Omit<HarnessAttemptRecord, "observedAt"> & { observedAt?: string },
  options: RouteStateOptions = {},
): Promise<HarnessRouteRecord> {
  return appendRouteObservation(routeId, options, (current, now) => ({
    ...current,
    attempts: [...(current.attempts ?? []), { ...attempt, observedAt: attempt.observedAt ?? now }],
  }));
}

export async function recordRouteFeedback(
  routeId: string,
  feedback: Omit<HarnessFeedbackRecord, "observedAt"> & { observedAt?: string },
  options: RouteStateOptions = {},
): Promise<HarnessRouteRecord> {
  return appendRouteObservation(routeId, options, (current, now) => ({
    ...current,
    feedback: [
      ...(current.feedback ?? []),
      { ...feedback, observedAt: feedback.observedAt ?? now },
    ],
  }));
}

export async function updateRouteHealthWindow(
  routeId: string,
  window: HarnessHealthWindow,
  options: RouteStateOptions = {},
): Promise<HarnessRouteRecord> {
  return appendRouteObservation(routeId, options, (current) => ({
    ...current,
    healthWindows: [
      ...(current.healthWindows ?? []).filter((item) => item.candidateId !== window.candidateId),
      window,
    ],
  }));
}

async function appendRouteObservation(
  routeId: string,
  options: RouteStateOptions,
  update: (current: HarnessRouteRecord, now: string) => HarnessRouteRecord,
): Promise<HarnessRouteRecord> {
  const current = await getRouteRecord(routeId, options);
  if (!current) throw new Error(`Unknown harness route: ${routeId}`);
  const now = new Date().toISOString();
  const updated = { ...update(current, now), updatedAt: now };
  await appendRecord(updated, options);
  return updated;
}

export async function findAffinity(
  harness: HarnessId,
  identity: ReturnType<typeof routeIdentity>,
  options: RouteStateOptions = {},
): Promise<HarnessRouteRecord | undefined> {
  if (!identity.taskIdHash && !identity.sessionHash) return undefined;
  const now = options.now?.() ?? Date.now();
  const latest = new Map<string, HarnessRouteRecord>();
  for (const record of await readRecords(options)) latest.set(record.routeId, record);
  return [...latest.values()]
    .filter(
      (record) =>
        record.harness === harness &&
        (identity.taskIdHash
          ? record.taskIdHash === identity.taskIdHash
          : record.sessionHash === identity.sessionHash &&
            record.taskFingerprint === identity.taskFingerprint) &&
        record.workspaceFingerprint === identity.workspaceFingerprint &&
        (!record.requirementsFingerprint ||
          record.requirementsFingerprint === identity.requirementsFingerprint) &&
        (!record.affinityExpiresAt || Date.parse(record.affinityExpiresAt) > now) &&
        record.selectedCandidate &&
        !["failure", "timed-out", "abandoned"].includes(record.outcome),
    )
    .at(-1);
}

export async function observedMetrics(
  harness: HarnessId,
  candidateIds: readonly string[],
  options: RouteStateOptions = {},
): Promise<Record<string, AutoObservedMetrics>> {
  const latest = new Map<string, HarnessRouteRecord>();
  for (const record of await readRecords(options)) latest.set(record.routeId, record);
  const allowed = new Set(candidateIds);
  const buckets = new Map<
    string,
    {
      successes: number;
      attempts: number;
      latency: number;
      feedback: number;
      feedbackCount: number;
      last?: string;
    }
  >();
  const empty = (): {
    successes: number;
    attempts: number;
    latency: number;
    feedback: number;
    feedbackCount: number;
    last?: string;
  } => ({
    successes: 0,
    attempts: 0,
    latency: 0,
    feedback: 0,
    feedbackCount: 0,
  });
  for (const record of latest.values()) {
    if (record.harness !== harness) continue;
    for (const attempt of record.attempts ?? []) {
      if (!allowed.has(attempt.candidateId)) continue;
      const bucket = buckets.get(attempt.candidateId) ?? empty();
      bucket.attempts++;
      bucket.successes += attempt.outcome === "success" ? 1 : 0;
      bucket.latency += attempt.latencyMs;
      if (!bucket.last || attempt.observedAt > bucket.last) bucket.last = attempt.observedAt;
      buckets.set(attempt.candidateId, bucket);
    }
    if (!record.selectedCandidate || !allowed.has(record.selectedCandidate)) continue;
    for (const feedback of record.feedback ?? []) {
      const bucket = buckets.get(record.selectedCandidate) ?? empty();
      bucket.feedback += feedback.score ?? (feedback.outcome === "success" ? 1 : 0);
      bucket.feedbackCount++;
      if (!bucket.last || feedback.observedAt > bucket.last) bucket.last = feedback.observedAt;
      buckets.set(record.selectedCandidate, bucket);
    }
  }
  return Object.fromEntries(
    [...buckets].map(([id, value]) => [
      id,
      {
        successRate: value.attempts ? value.successes / value.attempts : 0.5,
        averageLatencyMs: value.attempts ? value.latency / value.attempts : 0,
        feedbackPrior: value.feedbackCount ? value.feedback / value.feedbackCount - 0.5 : 0,
        attemptSamples: value.attempts,
        feedbackSamples: value.feedbackCount,
        lastObservedAt: value.last,
      },
    ]),
  );
}

export async function nativePolicyUsage(
  input: { harness: HarnessId; profile: string; since: string },
  options: RouteStateOptions = {},
): Promise<NativePolicyUsage> {
  const records = (await readRecords(options)).filter(
    (record) =>
      record.harness === input.harness &&
      record.profile === input.profile &&
      record.createdAt >= input.since,
  );
  const candidateRoutes: Record<string, number> = {};
  let attempts = 0;
  for (const record of records) {
    attempts += record.attempts?.length ?? 0;
    if (record.selectedCandidate) {
      candidateRoutes[record.selectedCandidate] =
        (candidateRoutes[record.selectedCandidate] ?? 0) + 1;
    }
  }
  return { routes: records.length, attempts, candidateRoutes };
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
    rerouteReason: input.rerouteReason?.slice(0, 512),
    partialWriteDetected: input.partialWriteDetected ?? current.partialWriteDetected,
  };
  await appendRecord(updated, options);
  return updated;
}

export async function getRouteRecord(
  routeId: string,
  options: RouteStateOptions = {},
): Promise<HarnessRouteRecord | undefined> {
  const store = await openNativeStore(options);
  try {
    return store.getNativeRoute(routeId);
  } finally {
    store.close();
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
  profile: string;
  policy?: AutoRouteDecision["policy"];
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
    policy: input.policy,
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
  const store = await openNativeStore(options);
  try {
    store.saveNativeRoute(record);
  } finally {
    store.close();
  }
}

async function readRecords(options: RouteStateOptions): Promise<HarnessRouteRecord[]> {
  const store = await openNativeStore(options);
  try {
    return store.getAllNativeRoutes();
  } finally {
    store.close();
  }
}

export async function getNativeRouteHistory(
  filters: NativeRouteHistoryFilters = {},
  options: RouteStateOptions = {},
): Promise<HarnessRouteRecord[]> {
  const store = await openNativeStore(options);
  try {
    return store.getNativeRouteHistory(filters);
  } finally {
    store.close();
  }
}

export async function getNativeRouteStats(
  filters: Omit<NativeRouteHistoryFilters, "limit"> = {},
  options: RouteStateOptions = {},
): Promise<NativeRouteStats> {
  const store = await openNativeStore(options);
  try {
    return store.getNativeRouteStats(filters);
  } finally {
    store.close();
  }
}

export async function pruneNativeRoutes(
  input: { before: string; now?: number },
  options: RouteStateOptions = {},
): Promise<number> {
  const store = await openNativeStore(options);
  try {
    return store.pruneNativeRoutes(input);
  } finally {
    store.close();
  }
}

export async function openNativeStore(options: RouteStateOptions): Promise<TelemetryStore> {
  const store = new TelemetryStore(databasePath(options), { now: options.now });
  try {
    const legacy = await readLegacyRecords(options);
    if (legacy.length) store.importNativeRoutes(legacy, digest(statePath(options)));
    return store;
  } catch (error) {
    store.close();
    throw error;
  }
}

async function readLegacyRecords(options: RouteStateOptions): Promise<unknown[]> {
  try {
    const source = await readFile(statePath(options), "utf8");
    return source
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as unknown];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function databasePath(options: RouteStateOptions): string {
  if (options.databasePath) return options.databasePath;
  const env = options.env ?? process.env;
  if (env.MODEL_ROUTER_NATIVE_DATABASE_PATH) return env.MODEL_ROUTER_NATIVE_DATABASE_PATH;
  if (options.path) {
    const extension = extname(options.path);
    return extension
      ? `${options.path.slice(0, -extension.length)}.sqlite`
      : `${options.path}.sqlite`;
  }
  if (env.MODEL_ROUTER_STATE_PATH) return `${env.MODEL_ROUTER_STATE_PATH}.sqlite`;
  const home = env.HOME;
  if (!home) {
    throw new Error(
      "HOME, MODEL_ROUTER_NATIVE_DATABASE_PATH, or an explicit databasePath is required",
    );
  }
  return join(home, ".model-router", "router.db");
}

function statePath(options: RouteStateOptions): string {
  if (options.path) return options.path;
  const env = options.env ?? process.env;
  if (env.MODEL_ROUTER_STATE_PATH) return env.MODEL_ROUTER_STATE_PATH;
  const home = env.HOME;
  if (!home) throw new Error("HOME or MODEL_ROUTER_STATE_PATH is required for route persistence");
  return join(home, ".model-router", "harness-routes.jsonl");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

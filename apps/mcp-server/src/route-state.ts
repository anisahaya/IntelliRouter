import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AutoObservedMetrics,
  AutoRouteDecision,
  AutoRouteProfile,
  AutoRouteRequirements,
  AutoTaskProfile,
  HarnessAttemptRecord,
  HarnessFeedbackRecord,
  HarnessHealthWindow,
  HarnessId,
  HarnessRouteRecord,
  ReasoningEffort,
  RouteOutcome,
} from "@model-router/contracts";

export interface RouteStateOptions {
  path?: string;
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
  await appendRecord(record, options);
  return record;
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
  await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function readRecords(options: RouteStateOptions): Promise<HarnessRouteRecord[]> {
  try {
    const source = await readFile(statePath(options), "utf8");
    return source
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as HarnessRouteRecord];
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

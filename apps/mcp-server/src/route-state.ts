import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  execution: "codex-exec" | "opencode-run";
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

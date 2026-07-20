import type {
  HarnessAttemptRecord,
  HarnessId,
  ReasoningEffort,
  RepoSignals,
} from "@model-router/contracts";
import { type ClaudeExecOptions, executeClaudeTask } from "./claude-exec.js";
import { type CodexExecOptions, executeCodexTask } from "./codex-exec.js";
import { decodeNormalizedCandidateId } from "./harness-candidate.js";
import { executeOpenCodeTask, type OpenCodeExecOptions } from "./opencode-exec.js";
import { collectRepoSignals, type RepoSignalOptions } from "./repo-signals.js";
import {
  getRouteRecord,
  type RouteStateOptions,
  recordRouteAttempt,
  updateRouteHealthWindow,
  updateRouteOutcome,
} from "./route-state.js";
import { resolveTaskTimeout } from "./timeout.js";

export interface HarnessTaskInput {
  routeId: string;
  harness: HarnessId;
  model: string;
  reasoningEffort: ReasoningEffort;
  objective: string;
  conversationSummary?: string;
  acceptanceChecks?: string[];
  searchRequired?: boolean;
  visionRequired?: boolean;
  imagePaths?: string[];
  repoSignals: RepoSignals;
  workspaceRoot: string;
  permission: "read-only" | "workspace-write";
  allowWriteFallback?: boolean;
  resumeSessionId?: string;
  timeoutMs?: number;
}

export interface HarnessExecutionAttempt {
  candidateId: string;
  executionHarness?: HarnessId;
  executionModel?: string;
  reasoningEffort: ReasoningEffort;
  attemptOrder: number;
  outcome: "success" | "failure" | "timed-out";
  latencyMs: number;
  errorClass?: HarnessAttemptRecord["errorClass"];
  errorDisposition?: "transient" | "permanent";
  partialWriteDetected: boolean;
  childSessionId?: string;
}

export interface HarnessTaskResult {
  routeId: string;
  harness: HarnessId;
  model: string;
  executionHarness?: HarnessId;
  executionModel?: string;
  reasoningEffort: ReasoningEffort;
  output: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  redacted: boolean;
  outcome: "success" | "failure" | "timed-out";
  partialWriteDetected: boolean;
  safeToFallback: boolean;
  childSessionId?: string;
  attemptChain: HarnessExecutionAttempt[];
}

export interface HarnessExecOptions {
  codex?: CodexExecOptions;
  opencode?: OpenCodeExecOptions;
  claude?: ClaudeExecOptions;
  repo?: RepoSignalOptions;
  state?: RouteStateOptions;
  env?: NodeJS.ProcessEnv;
  adapter?: (input: HarnessTaskInput & { harness: Exclude<HarnessId, "pi"> }) => Promise<{
    output: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
    truncated: boolean;
    redacted: boolean;
    childSessionId?: string;
  }>;
}

export async function executeHarnessTask(
  input: HarnessTaskInput,
  options: HarnessExecOptions = {},
): Promise<HarnessTaskResult> {
  const env = options.env ?? process.env;
  const stateOptions = { ...options.state, env };
  const record = await getRouteRecord(input.routeId, stateOptions);
  if (!record) throw new Error("Unknown or expired harness route");
  const selectedExecution = decodeNormalizedCandidateId(input.model);
  if (
    record.harness !== input.harness ||
    (selectedExecution && selectedExecution.harness !== input.harness)
  )
    throw new Error("Harness does not match the route decision");
  if (record.selectedCandidate !== input.model) {
    throw new Error("Model does not match the route decision");
  }
  if (record.reasoningEffort !== input.reasoningEffort) {
    throw new Error("Reasoning effort does not match the route decision");
  }
  await updateRouteOutcome(input.routeId, "running", {}, stateOptions);
  const candidates = executionCandidates(input, record);
  const selectedTarget = executionTarget(input.model, input.harness);
  const attemptChain: HarnessExecutionAttempt[] = [];
  let lastResult: Omit<HarnessTaskResult, "attemptChain"> | undefined;
  for (const [index, candidate] of candidates.entries()) {
    const before =
      input.permission === "workspace-write"
        ? await collectRepoSignals(input.workspaceRoot, options.repo)
        : undefined;
    const started = performance.now();
    let raw: Awaited<ReturnType<typeof executeWithAdapter>> | undefined;
    let thrownMessage: string | undefined;
    try {
      raw = await executeWithAdapter(
        {
          ...input,
          harness: candidate.harness,
          model: candidate.model,
          reasoningEffort: candidate.reasoningEffort,
          resumeSessionId:
            candidate.harness === selectedTarget.harness ? input.resumeSessionId : undefined,
        },
        options,
        env,
        record.featureSummary,
      );
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error);
    }
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    const outputUsable = Boolean(
      raw && raw.exitCode === 0 && raw.output.trim().length > 0 && !raw.timedOut,
    );
    const outcome = raw?.timedOut ? "timed-out" : outputUsable ? "success" : "failure";
    const after =
      input.permission === "workspace-write"
        ? await collectRepoSignals(input.workspaceRoot, options.repo)
        : undefined;
    const partialWriteDetected = Boolean(
      !outputUsable && before && after && workspaceChanged(before, after),
    );
    const errorText = thrownMessage ?? raw?.stderr ?? "";
    const classification = outputUsable
      ? undefined
      : classifyHarnessError(errorText, raw?.exitCode ?? null, Boolean(raw?.timedOut));
    const attempt: HarnessExecutionAttempt = {
      candidateId: candidate.model,
      executionHarness: candidate.harness,
      executionModel: candidate.executionModel,
      reasoningEffort: candidate.reasoningEffort,
      attemptOrder: index + 1,
      outcome,
      latencyMs,
      errorClass: classification?.errorClass,
      errorDisposition: classification?.disposition,
      partialWriteDetected,
      childSessionId: raw?.childSessionId,
    };
    attemptChain.push(attempt);
    await recordRouteAttempt(
      input.routeId,
      {
        candidateId: candidate.model,
        attemptOrder: index + 1,
        outcome,
        latencyMs,
        errorClass: classification?.errorClass,
      },
      stateOptions,
    );
    await updateHealth(input.routeId, candidate.model, attempt, stateOptions);
    lastResult = {
      routeId: input.routeId,
      harness: input.harness,
      model: candidate.model,
      executionHarness: candidate.harness,
      executionModel: candidate.executionModel,
      reasoningEffort: candidate.reasoningEffort,
      output: raw?.output ?? "",
      stderr: (thrownMessage ?? raw?.stderr ?? "").slice(0, 8_000),
      exitCode: raw?.exitCode ?? null,
      timedOut: Boolean(raw?.timedOut),
      truncated: raw?.truncated ?? Boolean(thrownMessage && thrownMessage.length > 8_000),
      redacted: raw?.redacted ?? false,
      outcome,
      partialWriteDetected,
      safeToFallback: !partialWriteDetected,
      childSessionId: raw?.childSessionId,
    };
    if (outputUsable) break;
    if (!mayTryNext(input, partialWriteDetected, classification)) break;
  }
  if (!lastResult) throw new Error("The persisted route has no executable native candidate");
  await updateRouteOutcome(
    input.routeId,
    lastResult.outcome,
    {
      rerouteReason:
        lastResult.outcome === "success"
          ? undefined
          : lastResult.timedOut
            ? "delegation timed out"
            : "unusable child result",
      partialWriteDetected: lastResult.partialWriteDetected,
    },
    stateOptions,
  );
  return { ...lastResult, attemptChain };
}

function executionCandidates(
  input: HarnessTaskInput,
  record: Awaited<ReturnType<typeof getRouteRecord>> & {},
): Array<{
  model: string;
  harness: Exclude<HarnessId, "pi">;
  executionModel: string;
  reasoningEffort: ReasoningEffort;
}> {
  const initial = executionTarget(input.model, input.harness);
  const candidates = [
    {
      model: input.model,
      harness: initial.harness,
      executionModel: initial.model,
      reasoningEffort: input.reasoningEffort,
    },
  ];
  for (const ranked of [...(record.candidateRankings ?? [])].sort((a, b) => a.rank - b.rank)) {
    if (ranked.candidateId === input.model || ranked.candidateId === record.fallbackModel) continue;
    // Older records did not persist kind. They are deliberately not eligible for automatic
    // fallback because a missing kind could conceal a user-defined agent.
    if (ranked.kind !== "codex-model" && ranked.kind !== "harness-model") continue;
    const health = record.healthWindows?.find(
      (window) => window.candidateId === ranked.candidateId,
    );
    if (health?.cooldownUntil && Date.parse(health.cooldownUntil) > Date.now()) continue;
    const target = executionTarget(ranked.candidateId, input.harness);
    candidates.push({
      model: ranked.candidateId,
      harness: target.harness,
      executionModel: target.model,
      reasoningEffort: ranked.reasoningEffort ?? input.reasoningEffort,
    });
  }
  return candidates;
}

function executionTarget(
  candidateId: string,
  fallbackHarness: HarnessId,
): { harness: Exclude<HarnessId, "pi">; model: string } {
  const decoded = decodeNormalizedCandidateId(candidateId);
  if (decoded) return decoded;
  if (fallbackHarness === "pi") throw new Error("pi native execution is not available yet");
  return { harness: fallbackHarness, model: candidateId };
}

function mayTryNext(
  input: HarnessTaskInput,
  partialWriteDetected: boolean,
  classification: ReturnType<typeof classifyHarnessError> | undefined,
): boolean {
  if (partialWriteDetected) return false;
  if (input.permission === "workspace-write" && input.allowWriteFallback !== true) return false;
  return classification?.retryable === true;
}

export function classifyHarnessError(
  message: string,
  exitCode: number | null,
  timedOut: boolean,
): {
  errorClass: NonNullable<HarnessAttemptRecord["errorClass"]>;
  disposition: "transient" | "permanent";
  retryable: boolean;
} {
  const text = message.toLowerCase();
  if (timedOut || /timed?\s*out|deadline exceeded/.test(text))
    return { errorClass: "timeout", disposition: "transient", retryable: true };
  if (/429|rate.?limit|too many requests/.test(text))
    return { errorClass: "rate_limit", disposition: "transient", retryable: true };
  if (/overload|capacity|temporarily unavailable/.test(text))
    return { errorClass: "overloaded", disposition: "transient", retryable: true };
  if (/\b5\d\d\b|upstream.*(?:error|fail)/.test(text))
    return { errorClass: "upstream_5xx", disposition: "transient", retryable: true };
  if (/econn|enotfound|network|socket|connection (?:reset|refused)/.test(text))
    return { errorClass: "network", disposition: "transient", retryable: true };
  if (
    /model.*(?:not found|no longer available|unsupported)|unknown model|reasoning effort.*(?:unsupported|no longer supported)/.test(
      text,
    )
  )
    return { errorClass: "model_not_found", disposition: "permanent", retryable: true };
  if (/unauthori[sz]ed|forbidden|authentication|invalid.*(?:token|key)|\b401\b|\b403\b/.test(text))
    return { errorClass: "auth", disposition: "permanent", retryable: false };
  if (/invalid (?:request|argument)|bad request|\b400\b|\b422\b/.test(text))
    return { errorClass: "invalid_request", disposition: "permanent", retryable: false };
  if (exitCode !== null && exitCode > 0)
    return { errorClass: "client", disposition: "permanent", retryable: false };
  return { errorClass: "unknown", disposition: "permanent", retryable: false };
}

async function updateHealth(
  routeId: string,
  candidateId: string,
  attempt: HarnessExecutionAttempt,
  options: RouteStateOptions,
): Promise<void> {
  const current = await getRouteRecord(routeId, options);
  const prior = current?.healthWindows?.find((window) => window.candidateId === candidateId);
  const attempts = (prior?.attempts ?? 0) + 1;
  const failed = attempt.outcome !== "success";
  const failures = (prior?.failures ?? 0) + (failed ? 1 : 0);
  const averageLatencyMs = Math.round(
    ((prior?.averageLatencyMs ?? 0) * (attempts - 1) + attempt.latencyMs) / attempts,
  );
  const opensCooldown = failed && attempt.errorDisposition === "transient";
  await updateRouteHealthWindow(
    routeId,
    {
      candidateId,
      state: failed ? (opensCooldown ? "unhealthy" : "degraded") : "healthy",
      attempts,
      failures,
      averageLatencyMs,
      updatedAt: new Date().toISOString(),
      cooldownUntil: opensCooldown ? new Date(Date.now() + 30_000).toISOString() : undefined,
    },
    options,
  );
}

async function executeWithAdapter(
  input: HarnessTaskInput,
  options: HarnessExecOptions,
  env: NodeJS.ProcessEnv,
  featureSummary: { taskType: string; scope: string; complexity: number; risk: number },
) {
  const target = executionTarget(input.model, input.harness);
  if (options.adapter) {
    return options.adapter({ ...input, harness: target.harness, model: target.model });
  }
  const common = {
    model: target.model,
    reasoningEffort: input.reasoningEffort,
    objective: input.objective,
    conversationSummary: input.conversationSummary,
    acceptanceChecks: input.acceptanceChecks,
    searchRequired: input.searchRequired,
    visionRequired: input.visionRequired,
    imagePaths: input.imagePaths,
    repoSignals: input.repoSignals,
    workspaceRoot: input.workspaceRoot,
    permission: input.permission,
    resumeSessionId: input.resumeSessionId,
    timeoutMs: resolveTaskTimeout({
      timeoutMs: input.timeoutMs,
      objective: input.objective,
      repoSignals: input.repoSignals,
      permission: input.permission,
      featureSummary,
    }),
  };
  if (target.harness === "codex") {
    if (input.resumeSessionId) {
      throw new Error(
        "Codex trajectory resume is disabled because `codex exec resume --help` does not expose the required workspace sandbox controls",
      );
    }
    const result = await executeCodexTask(common, { ...options.codex, env });
    return { ...result, childSessionId: undefined };
  }
  if (target.harness === "opencode") {
    const result = await executeOpenCodeTask(common, { ...options.opencode, env });
    return { ...result, childSessionId: result.sessionId };
  }
  if (target.harness === "claude-code") {
    const result = await executeClaudeTask(common, { ...options.claude, env });
    return { ...result, childSessionId: result.sessionId };
  }
  throw new Error("pi native execution is not available yet");
}

function workspaceChanged(before: RepoSignals, after: RepoSignals): boolean {
  return (
    before.changedFileCount !== after.changedFileCount ||
    before.diffInsertions !== after.diffInsertions ||
    before.diffDeletions !== after.diffDeletions ||
    before.changedFiles.join("\0") !== after.changedFiles.join("\0")
  );
}

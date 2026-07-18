import type { HarnessId, ReasoningEffort, RepoSignals } from "@model-router/contracts";
import { type ClaudeExecOptions, executeClaudeTask } from "./claude-exec.js";
import { type CodexExecOptions, executeCodexTask } from "./codex-exec.js";
import { executeOpenCodeTask, type OpenCodeExecOptions } from "./opencode-exec.js";
import { collectRepoSignals, type RepoSignalOptions } from "./repo-signals.js";
import { getRouteRecord, type RouteStateOptions, updateRouteOutcome } from "./route-state.js";
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
  timeoutMs?: number;
}

export interface HarnessTaskResult {
  routeId: string;
  harness: HarnessId;
  model: string;
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
}

export interface HarnessExecOptions {
  codex?: CodexExecOptions;
  opencode?: OpenCodeExecOptions;
  claude?: ClaudeExecOptions;
  repo?: RepoSignalOptions;
  state?: RouteStateOptions;
  env?: NodeJS.ProcessEnv;
}

export async function executeHarnessTask(
  input: HarnessTaskInput,
  options: HarnessExecOptions = {},
): Promise<HarnessTaskResult> {
  const env = options.env ?? process.env;
  const stateOptions = { ...options.state, env };
  const record = await getRouteRecord(input.routeId, stateOptions);
  if (!record) throw new Error("Unknown or expired harness route");
  if (record.harness !== input.harness)
    throw new Error("Harness does not match the route decision");
  if (record.selectedCandidate !== input.model) {
    throw new Error("Model does not match the route decision");
  }
  if (record.reasoningEffort !== input.reasoningEffort) {
    throw new Error("Reasoning effort does not match the route decision");
  }
  await updateRouteOutcome(input.routeId, "running", {}, stateOptions);
  const before =
    input.permission === "workspace-write"
      ? await collectRepoSignals(input.workspaceRoot, options.repo)
      : undefined;
  let raw: Awaited<ReturnType<typeof executeWithAdapter>>;
  try {
    raw = await executeWithAdapter(input, options, env, record.featureSummary);
  } catch (error) {
    const after =
      input.permission === "workspace-write"
        ? await collectRepoSignals(input.workspaceRoot, options.repo)
        : undefined;
    const partialWriteDetected =
      before !== undefined && after !== undefined && workspaceChanged(before, after);
    const message = error instanceof Error ? error.message : String(error);
    await updateRouteOutcome(
      input.routeId,
      "failure",
      { rerouteReason: message, partialWriteDetected },
      stateOptions,
    );
    return {
      routeId: input.routeId,
      harness: input.harness,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      output: "",
      stderr: message.slice(0, 8_000),
      exitCode: null,
      timedOut: false,
      truncated: message.length > 8_000,
      redacted: false,
      outcome: "failure",
      partialWriteDetected,
      safeToFallback: !partialWriteDetected,
    };
  }
  const outputUsable = raw.exitCode === 0 && raw.output.trim().length > 0 && !raw.timedOut;
  const outcome = raw.timedOut ? "timed-out" : outputUsable ? "success" : "failure";
  const after =
    input.permission === "workspace-write"
      ? await collectRepoSignals(input.workspaceRoot, options.repo)
      : undefined;
  const partialWriteDetected =
    !outputUsable && before !== undefined && after !== undefined && workspaceChanged(before, after);
  await updateRouteOutcome(
    input.routeId,
    outcome,
    {
      rerouteReason: outputUsable
        ? undefined
        : raw.timedOut
          ? "delegation timed out"
          : "unusable child result",
      partialWriteDetected,
    },
    stateOptions,
  );
  return {
    routeId: input.routeId,
    harness: input.harness,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    output: raw.output,
    stderr: raw.stderr,
    exitCode: raw.exitCode,
    timedOut: raw.timedOut,
    truncated: raw.truncated,
    redacted: raw.redacted,
    outcome,
    partialWriteDetected,
    safeToFallback: !partialWriteDetected,
    childSessionId: raw.childSessionId,
  };
}

async function executeWithAdapter(
  input: HarnessTaskInput,
  options: HarnessExecOptions,
  env: NodeJS.ProcessEnv,
  featureSummary: { taskType: string; scope: string; complexity: number; risk: number },
) {
  const common = {
    model: input.model,
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
    timeoutMs: resolveTaskTimeout({
      timeoutMs: input.timeoutMs,
      objective: input.objective,
      repoSignals: input.repoSignals,
      permission: input.permission,
      featureSummary,
    }),
  };
  if (input.harness === "codex") {
    const result = await executeCodexTask(common, { ...options.codex, env });
    return { ...result, childSessionId: undefined };
  }
  if (input.harness === "opencode") {
    const result = await executeOpenCodeTask(common, { ...options.opencode, env });
    return { ...result, childSessionId: result.sessionId };
  }
  if (input.harness === "claude-code") {
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

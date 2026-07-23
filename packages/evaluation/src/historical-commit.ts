import type { SafeReceipt } from "@model-router/contracts";
import type { TaskRunStore } from "@model-router/telemetry";

export interface CandidateExecutor {
  execute(input: {
    cwd: string;
    objective: string;
    allowedPaths: string[];
    timeoutMs: number;
    maxOutputBytes: number;
    networkDisabled: true;
  }): Promise<{ output?: string }>;
}

export interface CommandRunner {
  run(
    argv: string[],
    options: {
      cwd: string;
      timeoutMs: number;
      maxOutputBytes: number;
      networkDisabled: true;
    },
  ): Promise<{ code: number; output: string }>;
}

export interface HistoricalSandbox {
  cwd: string;
  /**
   * Returns controller-observed changes before held-out material is installed.
   * Symlinks are reported explicitly so the controller can reject them.
   */
  changedPaths(): Promise<Array<{ path: string; kind: "file" | "symlink" }>>;
  /**
   * Installs controller-owned held-out test material. Candidate workspaces call
   * this only after candidate execution has ended.
   */
  installHeldOut(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface SandboxFactory {
  /**
   * Materializes a tree snapshot without .git history and with network disabled.
   * The implementation is responsible for enforcing both properties.
   */
  materialize(
    ref: string,
    options: { includeHistory: false; networkDisabled: true },
  ): Promise<HistoricalSandbox>;
}

export interface HistoricalEvaluationInput {
  baseSha: string;
  targetSha: string;
  clean: boolean;
  allowedPaths: string[];
  objective: string;
  heldOut: string[][];
  candidateExecutor: CandidateExecutor;
  commandRunner: CommandRunner;
  sandboxFactory: SandboxFactory;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface HistoricalEvaluationResult {
  label: "correct" | "incorrect" | "unknown";
  comparative: false;
  reason: string;
  processCompleted: boolean;
  verification: "not-run" | "passed" | "failed" | "inconclusive";
}

export interface HistoricalEvaluationRecordInput {
  routeId: string;
  taskFingerprint: string;
  workspaceFingerprint?: string;
  selectedModel?: string;
  effort?: string;
  harness?: string;
  repoTags?: string[];
  checkName: string;
  evidenceHash?: string;
  result: HistoricalEvaluationResult;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HMAC_FINGERPRINT = /^hmac-sha256-v1:[0-9a-f]{64}$/i;
const EVIDENCE_HASH = /^(?:sha256|hmac-sha256-v1):[0-9a-f]{64}$/i;

/**
 * Persists only controller-supplied safe metadata and the evaluator's derived result.
 * The objective, reference patch, held-out commands, output, and repository paths are
 * deliberately absent from this boundary.
 */
export function recordHistoricalEvaluation(
  store: TaskRunStore,
  input: HistoricalEvaluationRecordInput,
): SafeReceipt {
  if (
    !UUID.test(input.routeId) ||
    !HMAC_FINGERPRINT.test(input.taskFingerprint) ||
    (input.workspaceFingerprint && !HMAC_FINGERPRINT.test(input.workspaceFingerprint)) ||
    (input.evidenceHash && !EVIDENCE_HASH.test(input.evidenceHash))
  )
    throw new Error("historical evaluation identifiers must be opaque versioned hashes");
  store.createRun({
    routeId: input.routeId,
    origin: "evaluation",
    taskFingerprint: input.taskFingerprint,
    workspaceFingerprint: input.workspaceFingerprint,
    selectedModel: input.selectedModel,
    effort: input.effort,
    harness: input.harness,
    repoTags: input.repoTags,
  });
  if (input.result.processCompleted) {
    store.completeProcess(input.routeId, "completed", {
      tokenBasis: "unknown",
      costBasis: "unknown",
    });
  }
  if (input.result.verification !== "not-run") {
    store.verify(input.routeId, {
      kind: "held-out-test",
      result: input.result.verification,
      checkName: input.checkName,
      evidenceHash: input.evidenceHash,
    });
  }
  const receipt = store.receipt(input.routeId);
  if (!receipt) throw new Error("historical evaluation receipt was not created");
  return receipt;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;
const SHELL_EXECUTABLES = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
]);

function validPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:[\\/]/.test(value) &&
    !/^\\\\/.test(value) &&
    !value.split(/[\\/]/).includes("..") &&
    !value.split(/[\\/]/).includes(".git")
  );
}

function validCommand(argv: string[]): boolean {
  if (argv.length === 0 || argv.length > 64) return false;
  if (
    argv.some(
      (argument) => argument.length === 0 || argument.length > 4096 || argument.includes("\0"),
    )
  )
    return false;
  const executable = argv[0]?.split(/[\\/]/).pop()?.toLowerCase();
  return Boolean(executable && !SHELL_EXECUTABLES.has(executable));
}

function allowedChange(
  change: { path: string; kind: "file" | "symlink" },
  allowedPaths: string[],
): boolean {
  if (change.kind !== "file" || !validPath(change.path)) return false;
  const normalized = change.path.replaceAll("\\", "/").replace(/^\.\/+/, "");
  return allowedPaths.some((allowedPath) => {
    const allowed = allowedPath
      .replaceAll("\\", "/")
      .replace(/^\.\/+/, "")
      .replace(/\/+$/, "");
    return normalized === allowed || normalized.startsWith(`${allowed}/`);
  });
}

function bounded(input: HistoricalEvaluationInput): {
  timeoutMs: number;
  maxOutputBytes: number;
} | null {
  const timeoutMs = input.timeoutMs ?? 120_000;
  const maxOutputBytes = input.maxOutputBytes ?? 64 * 1024;
  if (
    !FULL_SHA.test(input.baseSha) ||
    !FULL_SHA.test(input.targetSha) ||
    input.baseSha === input.targetSha ||
    !input.clean ||
    input.objective.length === 0 ||
    input.objective.length > 12_000 ||
    input.objective.includes("\0") ||
    input.allowedPaths.length === 0 ||
    input.allowedPaths.length > 128 ||
    input.allowedPaths.some((path) => !validPath(path)) ||
    input.heldOut.length === 0 ||
    input.heldOut.length > 32 ||
    input.heldOut.some((command) => !validCommand(command)) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > 600_000 ||
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 1024 * 1024
  )
    return null;
  return { timeoutMs, maxOutputBytes };
}

async function runChecks(
  sandbox: HistoricalSandbox,
  commands: string[][],
  runner: CommandRunner,
  bounds: { timeoutMs: number; maxOutputBytes: number },
): Promise<Array<{ code: number; output: string }> | null> {
  await sandbox.installHeldOut();
  const results: Array<{ code: number; output: string }> = [];
  for (const argv of commands) {
    const result = await runner.run(argv, {
      cwd: sandbox.cwd,
      timeoutMs: bounds.timeoutMs,
      maxOutputBytes: bounds.maxOutputBytes,
      networkDisabled: true,
    });
    if (Buffer.byteLength(result.output, "utf8") > bounds.maxOutputBytes) return null;
    results.push(result);
  }
  return results;
}

export async function evaluateHistoricalCommit(
  input: HistoricalEvaluationInput,
): Promise<HistoricalEvaluationResult> {
  const bounds = bounded(input);
  if (!bounds)
    return {
      label: "unknown",
      comparative: false,
      reason: "invalid evaluation boundary",
      processCompleted: false,
      verification: "not-run",
    };

  const sandboxes: HistoricalSandbox[] = [];
  try {
    const baseline = await input.sandboxFactory.materialize(input.baseSha, {
      includeHistory: false,
      networkDisabled: true,
    });
    sandboxes.push(baseline);
    const baselineResults = await runChecks(baseline, input.heldOut, input.commandRunner, bounds);
    if (!baselineResults || baselineResults.every((result) => result.code === 0))
      return {
        label: "unknown",
        comparative: false,
        reason: baselineResults
          ? "base does not fail held-out checks"
          : "held-out output exceeded its bound",
        processCompleted: false,
        verification: "inconclusive",
      };

    const target = await input.sandboxFactory.materialize(input.targetSha, {
      includeHistory: false,
      networkDisabled: true,
    });
    sandboxes.push(target);
    const targetResults = await runChecks(target, input.heldOut, input.commandRunner, bounds);
    if (!targetResults || !targetResults.every((result) => result.code === 0))
      return {
        label: "unknown",
        comparative: false,
        reason: targetResults
          ? "target fails held-out checks"
          : "held-out output exceeded its bound",
        processCompleted: false,
        verification: "inconclusive",
      };

    const candidate = await input.sandboxFactory.materialize(input.baseSha, {
      includeHistory: false,
      networkDisabled: true,
    });
    sandboxes.push(candidate);
    const execution = await input.candidateExecutor.execute({
      cwd: candidate.cwd,
      objective: input.objective,
      allowedPaths: [...input.allowedPaths],
      timeoutMs: bounds.timeoutMs,
      maxOutputBytes: bounds.maxOutputBytes,
      networkDisabled: true,
    });
    if (
      Buffer.byteLength(execution.output ?? "", "utf8") > bounds.maxOutputBytes ||
      execution.output?.includes(input.targetSha)
    )
      return {
        label: "unknown",
        comparative: false,
        reason: "candidate output violated the evaluation boundary",
        processCompleted: true,
        verification: "inconclusive",
      };

    const changes = await candidate.changedPaths();
    if (
      changes.length > 10_000 ||
      changes.some((change) => !allowedChange(change, input.allowedPaths))
    )
      return {
        label: "unknown",
        comparative: false,
        reason: "candidate changed paths outside the evaluation boundary",
        processCompleted: true,
        verification: "inconclusive",
      };

    const candidateResults = await runChecks(candidate, input.heldOut, input.commandRunner, bounds);
    if (!candidateResults)
      return {
        label: "unknown",
        comparative: false,
        reason: "held-out output exceeded its bound",
        processCompleted: true,
        verification: "inconclusive",
      };
    const passed = candidateResults.every((result) => result.code === 0);
    return {
      label: passed ? "correct" : "incorrect",
      comparative: false,
      reason: passed ? "held-out checks passed" : "held-out checks failed",
      processCompleted: true,
      verification: passed ? "passed" : "failed",
    };
  } finally {
    for (const sandbox of sandboxes.reverse()) await sandbox.cleanup();
  }
}

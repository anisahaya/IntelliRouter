import type { RepoSignals } from "@model-router/contracts";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const REPOSITORY_TASK_TIMEOUT_MS = 300_000;
export const MAX_TIMEOUT_MS = 600_000;

type FeatureSummary = {
  taskType?: string;
  scope?: string;
  complexity?: number;
  risk?: number;
};

export function resolveTaskTimeout(input: {
  timeoutMs?: number;
  objective: string;
  repoSignals?: RepoSignals;
  permission?: "read-only" | "workspace-write";
  featureSummary?: FeatureSummary;
}): number {
  if (input.timeoutMs !== undefined) return Math.min(input.timeoutMs, MAX_TIMEOUT_MS);
  const summary = input.featureSummary;
  const taskType = summary?.taskType ?? inferTaskType(input.objective);
  const scope = summary?.scope ?? inferScope(input.objective);
  const mechanical = inferMechanical(input.objective);
  const repositoryScale =
    scope === "repo" || /\b(repository|codebase|monorepo|entire|whole)\b/i.test(input.objective);
  const longTask = ["review", "debug", "general"].includes(taskType);
  const isMechanical = mechanical !== undefined && mechanical > 0.55;
  if (
    repositoryScale &&
    longTask &&
    !isMechanical &&
    input.repoSignals !== undefined &&
    (input.permission ?? "read-only") === "read-only"
  ) {
    return REPOSITORY_TASK_TIMEOUT_MS;
  }
  return DEFAULT_TIMEOUT_MS;
}

function inferTaskType(objective: string): string {
  if (/\b(debug|bug|error|failing|failure|stack trace|regression)\b/i.test(objective))
    return "debug";
  if (/\b(review|audit|critique|findings|vulnerability)\b/i.test(objective)) return "review";
  return "general";
}

function inferScope(objective: string): string {
  return /\b(entire|whole|repository|codebase|architecture|monorepo)\b/i.test(objective)
    ? "repo"
    : "single";
}

function inferMechanical(objective: string): number {
  return /\b(rename|format|extract|convert|classify|sort|copy|boilerplate|simple|small|straightforward|repetitive|mechanical)\b/i.test(
    objective,
  )
    ? 0.7
    : 0.15;
}

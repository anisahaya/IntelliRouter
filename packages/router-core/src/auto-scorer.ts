import type {
  AutoCandidate,
  AutoRankedCandidate,
  AutoRouteProfile,
  AutoTaskProfile,
  ReasoningEffort,
} from "@model-router/contracts";
import {
  type CostContext,
  estimateVerifiedSuccess,
  expectedCompletedTaskCost,
  normalizeEconomy,
  qualityThreshold,
  type RoutingEvidence,
} from "./routing-math.js";

const effortOrder: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

export const AUTO_PROFILE_WEIGHTS: Record<
  AutoRouteProfile,
  { fit: number; quality: number; speed: number; economy: number }
> = {
  balanced: { fit: 0.38, quality: 0.32, speed: 0.1, economy: 0.2 },
  quality: { fit: 0.35, quality: 0.55, speed: 0.05, economy: 0.05 },
  speed: { fit: 0.35, quality: 0.2, speed: 0.4, economy: 0.05 },
  economy: { fit: 0.35, quality: 0.2, speed: 0.1, economy: 0.35 },
};

export interface AutoScoreResult {
  ranked: AutoRankedCandidate[];
  excluded: Array<{ id: string; reasons: string[] }>;
  selected?: AutoRankedCandidate;
  coldStart: boolean;
  coldStartReason?: string;
}

export function scoreAutoCandidates(
  candidates: AutoCandidate[],
  task: AutoTaskProfile,
  profile: AutoRouteProfile,
  currentModel?: string,
  evidence: RoutingEvidence[] = [],
  costContextByCandidate: ReadonlyMap<string, CostContext> = new Map(),
): AutoScoreResult {
  const excluded: Array<{ id: string; reasons: string[] }> = [];
  const eligible: Array<{
    candidate: AutoCandidate;
    specialization: number;
    taskFit: number;
    success: ReturnType<typeof estimateVerifiedSuccess>;
    cost: ReturnType<typeof expectedCompletedTaskCost>;
  }> = [];

  for (const candidate of candidates) {
    const reasons = exclusions(candidate, task, currentModel);
    if (reasons.length > 0) {
      excluded.push({ id: candidate.id, reasons });
      continue;
    }
    const specialization = specializationScore(candidate, task);
    const taskFit = clamp(
      0.35 +
        specialization * 0.45 +
        (task.complexity > 0.7 ? candidate.quality * 0.2 : 0) +
        (task.mechanical > 0.55 ? (candidate.speed + candidate.economy) * 0.1 : 0),
    );
    eligible.push({
      candidate,
      specialization,
      taskFit,
      success: estimateVerifiedSuccess(task, candidate.id, evidence),
      cost: expectedCompletedTaskCost(
        task,
        candidate,
        evidence,
        costContextByCandidate.get(candidate.id),
      ),
    });
  }

  const comparableUnits = new Set(
    eligible.flatMap((item) => (item.cost.comparable && item.cost.unit ? [item.cost.unit] : [])),
  );
  const canNormalizeCosts = comparableUnits.size === 1;
  const normalizedEconomy = normalizeEconomy(
    eligible.map((item) =>
      canNormalizeCosts && item.cost.comparable ? item.cost.value : undefined,
    ),
  );
  const threshold = qualityThreshold(task.risk);
  const configured = AUTO_PROFILE_WEIGHTS[profile];
  const ranked: AutoRankedCandidate[] = eligible.map((item, index) => {
    const economySignal =
      canNormalizeCosts && item.cost.comparable
        ? (normalizedEconomy[index] ?? 0.5)
        : item.candidate.economy;
    const total = clamp(
      item.taskFit * configured.fit +
        item.candidate.quality * configured.quality +
        item.candidate.speed * configured.speed +
        economySignal * configured.economy,
    );
    const meetsQualityThreshold =
      !item.success.priorOnly && item.success.conservativeSuccess >= threshold;
    return {
      id: item.candidate.id,
      kind: item.candidate.kind,
      displayName: item.candidate.displayName,
      reasoningEffort:
        item.candidate.kind !== "user-agent"
          ? clampEffort(task.desiredEffort, item.candidate.supportedEfforts ?? [])
          : undefined,
      scores: {
        taskFit: item.taskFit,
        quality: item.candidate.quality,
        qualityHeuristic: item.candidate.quality,
        speed: item.candidate.speed,
        economy: economySignal,
        specialization: item.specialization,
        total,
        qualityThreshold: threshold,
        estimatedVerifiedSuccess: item.success.estimatedVerifiedSuccess,
        conservativeSuccess: item.success.conservativeSuccess,
        meetsQualityThreshold,
        evidence: {
          rawCount: item.success.rawCount,
          neighborCount: item.success.neighborCount,
          effectiveCount: item.success.effectiveCount,
          priorOnly: item.success.priorOnly,
          calibrated: false,
          strength: item.success.evidenceStrength,
          priorAlpha: item.success.priorAlpha,
          priorBeta: item.success.priorBeta,
          similarityRange: item.success.similarityRange,
        },
        expectedCost: item.cost.value,
        expectedCostUnit: item.cost.unit,
        expectedCostBasis: item.cost.basis,
        expectedCostComparable: item.cost.comparable,
        expectedCostComponents: item.cost.components,
        expectedCostComponentBasis: item.cost.componentBasis,
        pricingProvenance: item.cost.pricingProvenance,
        cacheState: item.cost.cacheState,
        selectionReason: meetsQualityThreshold
          ? item.cost.comparable
            ? "clears the risk-adjusted quality floor with comparable expected cost"
            : "clears the quality floor but completed-task cost is not comparable"
          : item.success.priorOnly
            ? "cold start: no verified similar-task evidence"
            : "conservative verified-success estimate is below the quality threshold",
      },
    };
  });

  const qualityQualified = ranked.filter((item) => item.scores.meetsQualityThreshold);
  const costQualified = qualityQualified.filter((item) => item.scores.expectedCostComparable);
  const costUnits = new Set(
    costQualified.flatMap((item) =>
      item.scores.expectedCostUnit ? [item.scores.expectedCostUnit] : [],
    ),
  );
  let selected: AutoRankedCandidate | undefined;
  let coldStart = false;
  let coldStartReason: string | undefined;
  if (
    qualityQualified.length > 0 &&
    costQualified.length === qualityQualified.length &&
    costUnits.size === 1
  ) {
    selected = [...costQualified].sort(
      (left, right) =>
        (left.scores.expectedCost ?? Number.POSITIVE_INFINITY) -
          (right.scores.expectedCost ?? Number.POSITIVE_INFINITY) ||
        (right.scores.conservativeSuccess ?? 0) - (left.scores.conservativeSuccess ?? 0) ||
        right.scores.total - left.scores.total ||
        left.id.localeCompare(right.id),
    )[0];
  } else if (!currentModel && ranked.length > 0) {
    coldStart = true;
    coldStartReason =
      costUnits.size > 1
        ? "verified candidates use incomparable cost units; deterministic heuristic fallback"
        : "measured verified-success or comparable completed-task cost is unavailable";
    selected = [...ranked].sort(
      (left, right) => right.scores.total - left.scores.total || left.id.localeCompare(right.id),
    )[0];
  } else {
    coldStart = true;
    coldStartReason =
      costUnits.size > 1
        ? "verified candidates use incomparable cost units; use the current-model fallback"
        : qualityQualified.length > costQualified.length
          ? "at least one quality-qualified route lacks comparable completed-task cost"
          : "no candidate clears the quality floor with comparable completed-task cost";
  }

  if (selected) {
    selected.scores.selectionReason = coldStart
      ? `deterministic cold-start fallback: ${coldStartReason}`
      : "lowest expected completed-task cost among candidates clearing the quality threshold";
  }
  ranked.sort((left, right) => {
    if (left.id === selected?.id && right.id !== selected?.id) return -1;
    if (right.id === selected?.id && left.id !== selected?.id) return 1;
    return (
      Number(Boolean(right.scores.meetsQualityThreshold)) -
        Number(Boolean(left.scores.meetsQualityThreshold)) ||
      right.scores.total - left.scores.total ||
      left.id.localeCompare(right.id)
    );
  });
  excluded.sort((left, right) => left.id.localeCompare(right.id));
  return { ranked, excluded, selected, coldStart, coldStartReason };
}

export function clampEffort(
  desired: ReasoningEffort,
  supported: ReasoningEffort[],
): ReasoningEffort {
  const allowed = effortOrder.filter((effort) => supported.includes(effort));
  if (allowed.length === 0) return "medium";
  const target = effortOrder.indexOf(desired);
  return allowed.reduce((best, effort) => {
    const distance = Math.abs(effortOrder.indexOf(effort) - target);
    const bestDistance = Math.abs(effortOrder.indexOf(best) - target);
    return distance < bestDistance ||
      (distance === bestDistance && effortOrder.indexOf(effort) < effortOrder.indexOf(best))
      ? effort
      : best;
  }, allowed[0] as ReasoningEffort);
}

function exclusions(
  candidate: AutoCandidate,
  task: AutoTaskProfile,
  currentModel?: string,
): string[] {
  const reasons: string[] = [];
  if (!candidate.available) reasons.push("unavailable");
  if (candidate.kind !== "user-agent" && candidate.supportedEfforts?.length === 0)
    reasons.push("no supported reasoning effort");
  if (candidate.kind !== "user-agent" && currentModel && candidate.id === currentModel)
    reasons.push("reserved as the current-model fallback");
  if (task.toolsRequired && !candidate.capabilities.tools) reasons.push("tools are unsupported");
  if (task.visionRequired && !candidate.capabilities.vision) reasons.push("vision is unsupported");
  if (task.searchRequired && !candidate.capabilities.search) reasons.push("search is unsupported");
  if (task.editRequired && !candidate.capabilities.edit) reasons.push("editing is unsupported");
  if (task.estimatedContextTokens > candidate.capabilities.maxContextTokens)
    reasons.push("context window is too small");
  return reasons;
}

function specializationScore(candidate: AutoCandidate, task: AutoTaskProfile): number {
  const strengths = candidate.strengths.map((value) => value.toLowerCase()).join(" ");
  const terms = new Set<string>([task.taskType]);
  if (task.complexity > 0.65) terms.add("complex");
  if (task.ambiguity > 0.55) terms.add("architecture");
  if (task.mechanical > 0.55) terms.add("mechanical");
  if (task.scope === "repo") terms.add("repository");
  if (task.editRequired) terms.add("implementation");
  for (const tag of task.repoTags) terms.add(tag);
  const matches = [...terms].filter((term) => strengths.includes(term)).length;
  return clamp(matches / Math.max(1, terms.size));
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(6))));
}

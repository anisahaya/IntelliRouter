import type {
  AutoCandidate,
  AutoTaskProfile,
  RoutingAttemptEvidence,
  RoutingEvidence,
  RoutingEvidenceQuery,
  RoutingEvidenceReader,
} from "@model-router/contracts";

export type MeasurementBasis = "observed" | "estimated" | "mixed" | "unknown";
export type CostUnit = "usd" | "tokens";

export type {
  RoutingAttemptEvidence,
  RoutingEvidence,
  RoutingEvidenceQuery,
  RoutingEvidenceReader,
};

export interface SuccessEstimate {
  estimatedVerifiedSuccess: number;
  conservativeSuccess: number;
  rawCount: number;
  neighborCount: number;
  effectiveCount: number;
  priorOnly: boolean;
  calibrated: false;
  similarityRange?: [number, number];
  evidenceStrength: "prior-only" | "sparse" | "moderate" | "strong";
  priorAlpha: 2;
  priorBeta: 2;
}

export interface ExpectedCostComponents {
  firstAttempt: number;
  retries: number;
  escalations: number;
  cacheSwitch: number;
  routingOverhead: number;
  verification: number;
}

export interface ExpectedCost {
  value?: number;
  unit?: CostUnit;
  basis: MeasurementBasis | "catalog-fallback";
  comparable: boolean;
  components: ExpectedCostComponents;
  componentBasis: Record<keyof ExpectedCostComponents, MeasurementBasis>;
  pricingProvenance: string[];
  cacheState: "observed" | "unknown";
}

export interface CostContext {
  routingOverhead?: { value: number; unit: CostUnit; basis: Exclude<MeasurementBasis, "mixed"> };
  verification?: { value: number; unit: CostUnit; basis: Exclude<MeasurementBasis, "mixed"> };
  cacheSwitch?: { value: number; unit: CostUnit; basis: Exclude<MeasurementBasis, "mixed"> };
}

const PRIOR_ALPHA = 2 as const;
const PRIOR_BETA = 2 as const;
const MIN_SIMILARITY = 0.5;
const MAX_NEIGHBORS = 20;

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function jaccard(left: string[], right: string[]): number {
  const normalizedLeft = new Set(left.map((value) => value.toLowerCase()));
  const normalizedRight = new Set(right.map((value) => value.toLowerCase()));
  const union = new Set([...normalizedLeft, ...normalizedRight]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const value of normalizedLeft) if (normalizedRight.has(value)) intersection += 1;
  return intersection / union.size;
}

function requiredCapabilities(task: AutoTaskProfile): string[] {
  return [
    ...(task.toolsRequired ? ["tools"] : []),
    ...(task.visionRequired ? ["vision"] : []),
    ...(task.searchRequired ? ["search"] : []),
    ...(task.editRequired ? ["edit"] : []),
  ];
}

export function routingSimilarity(task: AutoTaskProfile, evidence: RoutingEvidence): number {
  return clamp(
    0.3 * (task.taskType === evidence.taskType ? 1 : 0) +
      0.15 * (task.scope === evidence.scope ? 1 : 0) +
      0.2 * (1 - Math.min(1, Math.abs(task.complexity - (evidence.complexity ?? 0.5)))) +
      0.15 * (1 - Math.min(1, Math.abs(task.risk - (evidence.risk ?? 0.5)))) +
      0.1 * jaccard(requiredCapabilities(task), evidence.capabilities ?? []) +
      0.1 * jaccard(task.repoTags, evidence.repoTags ?? []),
  );
}

function comparableNeighbors(
  task: AutoTaskProfile,
  model: string,
  evidence: RoutingEvidence[],
): Array<{ evidence: RoutingEvidence; similarity: number }> {
  const eligible = evidence
    .filter(
      (item) =>
        item.model === model &&
        (item.labelStrength === "verified" || item.labelStrength === "comparative") &&
        (item.origin === "native" ||
          item.origin === "compatibility" ||
          item.origin === "evaluation") &&
        ((item.label === "correct" && item.verification === "passed") ||
          (item.label === "incorrect" && item.verification === "failed")) &&
        (item.process === "completed" || item.process === "failed"),
    )
    .sort(
      (left, right) =>
        evidenceTimestamp(right).localeCompare(evidenceTimestamp(left)) ||
        left.id.localeCompare(right.id),
    );

  const newestByTask = new Map<string, RoutingEvidence>();
  for (const item of eligible) {
    const key = `${item.taskFingerprint}\0${item.model}`;
    if (!newestByTask.has(key)) newestByTask.set(key, item);
  }

  return [...newestByTask.values()]
    .map((item) => ({ evidence: item, similarity: routingSimilarity(task, item) }))
    .filter((item) => item.similarity >= MIN_SIMILARITY)
    .sort(
      (left, right) =>
        right.similarity - left.similarity ||
        evidenceTimestamp(right.evidence).localeCompare(evidenceTimestamp(left.evidence)) ||
        left.evidence.id.localeCompare(right.evidence.id),
    )
    .slice(0, MAX_NEIGHBORS);
}

function evidenceTimestamp(item: RoutingEvidence): string {
  return item.updatedAt ?? item.createdAt;
}

function singleModelSuccessNeighbors(
  task: AutoTaskProfile,
  model: string,
  evidence: RoutingEvidence[],
): Array<{ evidence: RoutingEvidence; similarity: number }> {
  return comparableNeighbors(task, model, evidence).filter(
    (item) =>
      item.evidence.attempts.length > 0 &&
      item.evidence.attempts.every(
        (attempt) => !attempt.fallback && (!attempt.model || attempt.model === model),
      ),
  );
}

export function estimateVerifiedSuccess(
  task: AutoTaskProfile,
  model: string,
  evidence: RoutingEvidence[] = [],
): SuccessEstimate {
  const rawCount = evidence.filter((item) => item.model === model).length;
  const neighbors = singleModelSuccessNeighbors(task, model, evidence);
  let successWeight = 0;
  let failureWeight = 0;
  let totalWeight = 0;

  for (const item of neighbors) {
    const weight = item.similarity ** 2;
    totalWeight += weight;
    if (item.evidence.label === "correct") successWeight += weight;
    else failureWeight += weight;
  }

  const alpha = PRIOR_ALPHA + successWeight;
  const beta = PRIOR_BETA + failureWeight;
  const estimatedVerifiedSuccess = alpha / (alpha + beta);
  // This is a deterministic policy margin, not a statistical confidence interval.
  // The Beta prior supplies shrinkage while the margin keeps sparse evidence below a hard floor.
  const conservativeSuccess = clamp(
    estimatedVerifiedSuccess - 0.05 / Math.sqrt(Math.max(1, totalWeight)),
  );
  const similarities = neighbors.map((item) => item.similarity);
  const evidenceStrength =
    neighbors.length === 0
      ? "prior-only"
      : neighbors.length < 3
        ? "sparse"
        : neighbors.length < 8
          ? "moderate"
          : "strong";

  return {
    estimatedVerifiedSuccess,
    conservativeSuccess,
    rawCount,
    neighborCount: neighbors.length,
    effectiveCount: Number(totalWeight.toFixed(6)),
    priorOnly: neighbors.length === 0,
    calibrated: false,
    similarityRange:
      similarities.length > 0 ? [Math.min(...similarities), Math.max(...similarities)] : undefined,
    evidenceStrength,
    priorAlpha: PRIOR_ALPHA,
    priorBeta: PRIOR_BETA,
  };
}

interface RunCost {
  value: number;
  unit: CostUnit;
  basis: MeasurementBasis;
  components: ExpectedCostComponents;
  componentBasis: Record<keyof ExpectedCostComponents, MeasurementBasis>;
  pricingProvenance: string[];
  cacheState: "observed" | "unknown";
}

function emptyComponents(): ExpectedCostComponents {
  return {
    firstAttempt: 0,
    retries: 0,
    escalations: 0,
    cacheSwitch: 0,
    routingOverhead: 0,
    verification: 0,
  };
}

function unknownComponentBasis(): Record<keyof ExpectedCostComponents, MeasurementBasis> {
  return {
    firstAttempt: "unknown",
    retries: "unknown",
    escalations: "unknown",
    cacheSwitch: "unknown",
    routingOverhead: "unknown",
    verification: "unknown",
  };
}

function combinedBasis(values: MeasurementBasis[]): MeasurementBasis {
  const known = new Set(values.filter((value) => value !== "unknown"));
  if (known.size === 0) return "unknown";
  if (known.size === 1) return [...known][0] as MeasurementBasis;
  return "mixed";
}

function runCost(item: RoutingEvidence): RunCost | undefined {
  if (item.attempts.length === 0) return undefined;
  const allUsd = item.attempts.every(
    (attempt) =>
      attempt.costUsd !== undefined &&
      (attempt.costBasis === "actual" ||
        (attempt.costBasis === "estimated" && Boolean(attempt.pricingProvenance))),
  );
  const allTokens = item.attempts.every(
    (attempt) =>
      attempt.inputTokens !== undefined &&
      attempt.outputTokens !== undefined &&
      attempt.tokenBasis !== "unknown",
  );
  if (!allUsd && !allTokens) return undefined;

  const unit: CostUnit = allUsd ? "usd" : "tokens";
  const components = emptyComponents();
  const componentBasis = unknownComponentBasis();
  const bases: MeasurementBasis[] = [];
  const provenance = new Set<string>();
  let cacheObserved = true;

  for (const attempt of item.attempts) {
    const basis: MeasurementBasis =
      unit === "usd"
        ? attempt.costBasis === "actual"
          ? "observed"
          : "estimated"
        : attempt.tokenBasis === "actual"
          ? "observed"
          : "estimated";
    const value =
      unit === "usd"
        ? (attempt.costUsd ?? 0)
        : (attempt.inputTokens ?? 0) + (attempt.outputTokens ?? 0);
    const category = attempt.fallback ? "escalations" : attempt.retry ? "retries" : "firstAttempt";
    components[category] += value;
    componentBasis[category] = combinedBasis([componentBasis[category], basis]);
    bases.push(basis);
    if (attempt.pricingProvenance) provenance.add(attempt.pricingProvenance);

    if (attempt.cacheWriteTokens === undefined) {
      cacheObserved = false;
    }
  }

  // Attempt input/output or billed USD already contains provider token accounting.
  // A separate cache-switch charge is added only from explicit session-switch context.
  const value = components.firstAttempt + components.retries + components.escalations;
  return {
    value,
    unit,
    basis: combinedBasis(bases),
    components,
    componentBasis,
    pricingProvenance: [...provenance].sort(),
    cacheState: cacheObserved ? "observed" : "unknown",
  };
}

function addContextCost(cost: RunCost, context: CostContext): RunCost | undefined {
  const additions: Array<
    ["routingOverhead" | "verification" | "cacheSwitch", CostContext["routingOverhead"] | undefined]
  > = [
    ["routingOverhead", context.routingOverhead],
    ["verification", context.verification],
    ["cacheSwitch", context.cacheSwitch],
  ];
  const next: RunCost = {
    ...cost,
    components: { ...cost.components },
    componentBasis: { ...cost.componentBasis },
  };
  const bases: MeasurementBasis[] = [cost.basis];
  for (const [component, addition] of additions) {
    if (!addition) continue;
    if (addition.unit !== cost.unit) {
      if (component === "cacheSwitch") next.cacheState = "unknown";
      continue;
    }
    next.components[component] += addition.value;
    next.componentBasis[component] = addition.basis;
    next.value += addition.value;
    bases.push(addition.basis);
    if (component === "cacheSwitch") next.cacheState = "observed";
  }
  next.basis = combinedBasis(bases);
  return next;
}

export function observableCacheSwitchCost(
  task: AutoTaskProfile,
  candidate: AutoCandidate,
  evidence: RoutingEvidence[] = [],
): CostContext["cacheSwitch"] | undefined {
  const observed = singleModelSuccessNeighbors(task, candidate.id, evidence)
    .map((neighbor) => {
      if (
        neighbor.evidence.attempts.length === 0 ||
        neighbor.evidence.attempts.some(
          (attempt) => attempt.cacheWriteTokens === undefined || attempt.tokenBasis === "unknown",
        )
      )
        return undefined;
      const value = neighbor.evidence.attempts.reduce(
        (sum, attempt) => sum + (attempt.cacheWriteTokens ?? 0),
        0,
      );
      const basis = combinedBasis(
        neighbor.evidence.attempts.map((attempt) =>
          attempt.tokenBasis === "actual" ? "observed" : "estimated",
        ),
      );
      if (basis === "mixed" || basis === "unknown") return undefined;
      return { value, weight: neighbor.similarity ** 2, basis };
    })
    .filter(
      (
        item,
      ): item is {
        value: number;
        weight: number;
        basis: "observed" | "estimated";
      } => Boolean(item),
    );
  if (observed.length === 0) return undefined;
  const weight = observed.reduce((sum, item) => sum + item.weight, 0);
  const bases = new Set(observed.map((item) => item.basis));
  if (bases.size !== 1) return undefined;
  return {
    value: observed.reduce((sum, item) => sum + item.value * item.weight, 0) / weight,
    unit: "tokens",
    basis: observed[0]?.basis ?? "estimated",
  };
}

export function expectedCompletedTaskCost(
  task: AutoTaskProfile,
  candidate: AutoCandidate,
  evidence: RoutingEvidence[] = [],
  context: CostContext = {},
): ExpectedCost {
  const neighbors = comparableNeighbors(task, candidate.id, evidence);
  const observed = neighbors
    .map((neighbor) => {
      const cost = runCost(neighbor.evidence);
      return cost
        ? { cost: addContextCost(cost, context), weight: neighbor.similarity ** 2 }
        : undefined;
    })
    .filter((item): item is { cost: RunCost; weight: number } => Boolean(item?.cost));
  const units = new Set(observed.map((item) => item.cost.unit));
  if (observed.length > 0 && units.size === 1) {
    const totalWeight = observed.reduce((sum, item) => sum + item.weight, 0);
    const components = emptyComponents();
    const componentBasis = unknownComponentBasis();
    const provenance = new Set<string>();
    for (const item of observed) {
      for (const component of Object.keys(components) as Array<keyof ExpectedCostComponents>) {
        components[component] += (item.cost.components[component] * item.weight) / totalWeight;
        componentBasis[component] = combinedBasis([
          componentBasis[component],
          item.cost.componentBasis[component],
        ]);
      }
      for (const value of item.cost.pricingProvenance) provenance.add(value);
    }
    return {
      value: observed.reduce((sum, item) => sum + item.cost.value * item.weight, 0) / totalWeight,
      unit: observed[0]?.cost.unit,
      basis: combinedBasis(observed.map((item) => item.cost.basis)),
      comparable: true,
      components,
      componentBasis,
      pricingProvenance: [...provenance].sort(),
      cacheState: observed.every((item) => item.cost.cacheState === "observed")
        ? "observed"
        : "unknown",
    };
  }

  if (candidate.expectedCost !== undefined && candidate.costUnit) {
    const basis =
      candidate.costBasis === "observed"
        ? "observed"
        : candidate.costBasis === "estimated"
          ? candidate.costProvenance
            ? "estimated"
            : "unknown"
          : "unknown";
    return {
      value: candidate.expectedCost,
      unit: candidate.costUnit,
      basis,
      comparable: basis !== "unknown",
      components: { ...emptyComponents(), firstAttempt: candidate.expectedCost },
      componentBasis: { ...unknownComponentBasis(), firstAttempt: basis },
      pricingProvenance: candidate.costProvenance ? [candidate.costProvenance] : [],
      cacheState: "unknown",
    };
  }

  return {
    value: 1 - candidate.economy,
    unit: undefined,
    basis: "catalog-fallback",
    comparable: false,
    components: emptyComponents(),
    componentBasis: unknownComponentBasis(),
    pricingProvenance: [],
    cacheState: "unknown",
  };
}

export function normalizeEconomy(costs: Array<number | undefined>): number[] {
  const known = costs.filter((value): value is number => value !== undefined);
  if (known.length === 0) return costs.map(() => 0.5);
  const minimum = Math.min(...known);
  const maximum = Math.max(...known);
  return costs.map((value) => {
    if (value === undefined || maximum === minimum) return 0.5;
    return 1 - (value - minimum) / (maximum - minimum);
  });
}

export function qualityThreshold(risk: number): number {
  return risk < 0.33 ? 0.6 : risk < 0.67 ? 0.75 : 0.9;
}

export interface EscalationPlanInput {
  cheapCost: number;
  verifyCost: number;
  cheapSuccess: number;
  frontierCost: number;
  switchCost: number;
  routingCost: number;
  threshold: number;
  objectiveVerifier: boolean;
  verifierIsIndependent: boolean;
  frontierClearsThreshold: boolean;
  safeFallback: boolean;
  partialWriteDetected: boolean;
  workspaceWrite: boolean;
  disposableWorkspace?: boolean;
  sameUnit: boolean;
}

export interface EscalationPlan {
  allowed: boolean;
  expectedCost: number;
  directFrontierCost: number;
  reason: string;
}

export function planVerifyThenEscalate(input: EscalationPlanInput): EscalationPlan {
  const expectedCost =
    input.cheapCost +
    input.verifyCost +
    (1 - input.cheapSuccess) * (input.frontierCost + input.switchCost + input.routingCost);
  const directFrontierCost = input.frontierCost + input.routingCost;
  const result = (allowed: boolean, reason: string): EscalationPlan => ({
    allowed,
    expectedCost,
    directFrontierCost,
    reason,
  });

  if (!input.objectiveVerifier || !input.verifierIsIndependent)
    return result(false, "missing independent objective verifier");
  if (!input.frontierClearsThreshold)
    return result(false, "frontier fallback does not clear the quality threshold");
  if (!input.safeFallback || input.partialWriteDetected)
    return result(false, "unsafe fallback or partial write blocks a second writer");
  if (input.workspaceWrite && !input.disposableWorkspace)
    return result(false, "workspace writes are not isolated");
  if (!input.sameUnit) return result(false, "plan costs are not comparable");
  if (input.cheapSuccess >= input.threshold)
    return result(false, "cheap route already clears the direct quality threshold");
  if (expectedCost >= directFrontierCost)
    return result(false, "plan is not cheaper than direct frontier execution");
  return result(true, "isolated verification and safe fallback make escalation cheaper");
}

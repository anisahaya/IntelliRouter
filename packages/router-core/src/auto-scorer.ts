import type {
  AutoCandidate,
  AutoObservedMetrics,
  AutoRankedCandidate,
  AutoRouteProfile,
  AutoTaskProfile,
  ReasoningEffort,
} from "@model-router/contracts";

const effortOrder: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

const weights: Record<
  AutoRouteProfile,
  { fit: number; quality: number; speed: number; economy: number }
> = {
  balanced: { fit: 0.4, quality: 0.35, speed: 0.15, economy: 0.1 },
  quality: { fit: 0.35, quality: 0.55, speed: 0.05, economy: 0.05 },
  speed: { fit: 0.35, quality: 0.2, speed: 0.4, economy: 0.05 },
  economy: { fit: 0.35, quality: 0.2, speed: 0.1, economy: 0.35 },
};

export interface AutoScoreResult {
  ranked: AutoRankedCandidate[];
  excluded: Array<{ id: string; reasons: string[] }>;
}

export interface AutoObservationOptions {
  minimumAttemptSamples?: number;
  minimumFeedbackSamples?: number;
  halfLifeMs?: number;
  now?: number;
  maximumAdjustment?: number;
}

export function scoreAutoCandidates(
  candidates: AutoCandidate[],
  task: AutoTaskProfile,
  profile: AutoRouteProfile,
  currentModel?: string,
  observations: Readonly<Record<string, AutoObservedMetrics>> = {},
  observationOptions: AutoObservationOptions = {},
): AutoScoreResult {
  const excluded: Array<{ id: string; reasons: string[] }> = [];
  const ranked: AutoRankedCandidate[] = [];

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
    const configured = weights[profile];
    const observed = observedAdjustment(observations[candidate.id], observationOptions);
    const total = clamp(
      taskFit * configured.fit +
        candidate.quality * configured.quality +
        candidate.speed * configured.speed +
        candidate.economy * configured.economy +
        observed.adjustment,
    );
    ranked.push({
      id: candidate.id,
      kind: candidate.kind,
      displayName: candidate.displayName,
      reasoningEffort:
        candidate.kind !== "user-agent"
          ? clampEffort(task.desiredEffort, candidate.supportedEfforts ?? [])
          : undefined,
      scores: {
        taskFit,
        quality: candidate.quality,
        speed: candidate.speed,
        economy: candidate.economy,
        specialization,
        total,
        ...(observations[candidate.id]
          ? {
              observedAdjustment: observed.adjustment,
              observedSampleCount: observed.sampleCount,
            }
          : {}),
      },
    });
  }

  ranked.sort(
    (left, right) => right.scores.total - left.scores.total || left.id.localeCompare(right.id),
  );
  excluded.sort((left, right) => left.id.localeCompare(right.id));
  return { ranked, excluded };
}

function observedAdjustment(
  metrics: AutoObservedMetrics | undefined,
  options: AutoObservationOptions,
): { adjustment: number; sampleCount: number } {
  if (!metrics) return { adjustment: 0, sampleCount: 0 };
  const minimumAttempts = options.minimumAttemptSamples ?? 8;
  const minimumFeedback = options.minimumFeedbackSamples ?? 3;
  const sampleCount = metrics.attemptSamples + metrics.feedbackSamples;
  if (metrics.attemptSamples < minimumAttempts && metrics.feedbackSamples < minimumFeedback)
    return { adjustment: 0, sampleCount };

  const halfLifeMs = options.halfLifeMs ?? 30 * 24 * 60 * 60 * 1_000;
  const now = options.now ?? Date.now();
  const ageMs = metrics.lastObservedAt
    ? Math.max(0, now - Date.parse(metrics.lastObservedAt))
    : halfLifeMs;
  const decay = Number.isFinite(ageMs) ? 0.5 ** (ageMs / halfLifeMs) : 0;
  const attemptConfidence = Math.min(1, metrics.attemptSamples / 24);
  const feedbackConfidence = Math.min(1, metrics.feedbackSamples / 8);
  const reliabilityPrior = (metrics.successRate - 0.5) * 0.1 * attemptConfidence;
  const speedPrior =
    (0.5 - Math.min(1, metrics.averageLatencyMs / 10_000)) * 0.04 * attemptConfidence;
  const feedbackPrior = metrics.feedbackPrior * 0.06 * feedbackConfidence;
  const cap = options.maximumAdjustment ?? 0.08;
  const adjustment = Math.max(-cap, Math.min(cap, reliabilityPrior + speedPrior + feedbackPrior));
  return { adjustment: Number((adjustment * decay).toFixed(6)), sampleCount };
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

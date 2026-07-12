import type { ModelDefinition, RouteCandidate, TaskFeatures } from "@model-router/contracts";

export interface ObservedModelMetrics {
  averageLatencyMs: number;
  failureRate: number;
  feedbackPrior: number;
}

export function scoreCandidate(
  model: ModelDefinition,
  weights: { quality: number; cost: number; latency: number },
  features: TaskFeatures,
  exclusions: string[],
  metrics: ObservedModelMetrics,
): RouteCandidate {
  if (exclusions.length > 0) {
    return {
      modelId: model.id,
      eligible: false,
      exclusionReasons: exclusions,
      scores: { quality: 0, cost: 0, latency: 0, feedback: 0, total: 0 },
    };
  }
  const reasoningBoost =
    features.reasoningIntensity === "high" && model.tags.includes("reasoning") ? 0.08 : 0;
  const quality = clamp(model.quality + reasoningBoost - metrics.failureRate * 0.2);
  const blendedPrice = model.cost.inputPerMillion * 0.6 + model.cost.outputPerMillion * 0.4;
  const cost = 1 / (1 + blendedPrice);
  const latency = 1 / (1 + metrics.averageLatencyMs / 1000);
  const feedback = Math.max(-0.15, Math.min(0.15, metrics.feedbackPrior));
  const total =
    quality * weights.quality + cost * weights.cost + latency * weights.latency + feedback;
  return {
    modelId: model.id,
    eligible: true,
    exclusionReasons: [],
    scores: { quality, cost, latency, feedback, total },
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

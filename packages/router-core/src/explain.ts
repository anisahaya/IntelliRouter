import type { RouteDecision } from "@model-router/contracts";

export function safeExplanation(decision: RouteDecision): RouteDecision {
  return structuredClone(decision);
}

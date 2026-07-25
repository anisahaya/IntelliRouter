import type { AutoCandidate, AutoTaskProfile } from "@model-router/contracts";
import {
  type CostContext,
  observableCacheSwitchCost,
  type RoutingEvidence,
  type RoutingEvidenceReader,
} from "@model-router/router-core";

export function readRoutingEvidence(
  reader: RoutingEvidenceReader | undefined,
  candidates: AutoCandidate[],
  harness?: string,
): RoutingEvidence[] {
  if (!reader) return [];
  return candidates.flatMap((candidate) =>
    reader.queryRoutingEvidence({
      model: candidate.id,
      ...(harness ? { harness } : {}),
      limit: 256,
    }),
  );
}

export function cacheSwitchContexts(
  task: AutoTaskProfile,
  candidates: AutoCandidate[],
  evidence: RoutingEvidence[],
  cacheResidentModel?: string,
): ReadonlyMap<string, CostContext> {
  const contexts = new Map<string, CostContext>();
  if (!cacheResidentModel) return contexts;
  for (const candidate of candidates) {
    if (candidate.id === cacheResidentModel) continue;
    const cacheSwitch = observableCacheSwitchCost(task, candidate, evidence);
    if (cacheSwitch) contexts.set(candidate.id, { cacheSwitch });
  }
  return contexts;
}

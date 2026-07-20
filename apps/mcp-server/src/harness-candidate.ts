import type { HarnessId } from "@model-router/contracts";

export const nativeHarnesses: Exclude<HarnessId, "pi">[] = ["codex", "opencode", "claude-code"];

export function normalizedCandidateId(harness: HarnessId, model: string): string {
  return `${harness}:${model}`;
}

export function decodeNormalizedCandidateId(
  id: string,
): { harness: Exclude<HarnessId, "pi">; model: string } | undefined {
  for (const harness of nativeHarnesses) {
    const prefix = `${harness}:`;
    if (id.startsWith(prefix) && id.length > prefix.length) {
      return { harness, model: id.slice(prefix.length) };
    }
  }
  return undefined;
}

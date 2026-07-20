import type { AutoCandidate, AutoTaskProfile } from "@model-router/contracts";
import { nativeRoutingConfigSchema } from "@model-router/contracts";
import { describe, expect, it } from "vitest";
import {
  applyNativeMetadata,
  resolveNativePolicy,
  scoreWithNativePolicy,
} from "../src/native-policy.js";

const task: AutoTaskProfile = {
  taskType: "implementation",
  complexity: 0.5,
  ambiguity: 0.2,
  risk: 0.2,
  mechanical: 0.2,
  scope: "multi",
  toolsRequired: true,
  visionRequired: false,
  searchRequired: false,
  editRequired: true,
  estimatedContextTokens: 1_000,
  desiredEffort: "high",
  repoTags: [],
};

function candidate(id: string, input: Partial<AutoCandidate> = {}): AutoCandidate {
  return {
    id,
    kind: "harness-model",
    harness: "opencode",
    displayName: id,
    description: "test model",
    available: true,
    capabilities: {
      tools: true,
      vision: true,
      search: true,
      edit: true,
      maxContextTokens: 100_000,
    },
    strengths: [],
    quality: 0.5,
    speed: 0.5,
    economy: 0.5,
    supportedEfforts: ["low", "medium", "high"],
    ...input,
  };
}

describe("native routing policy", () => {
  it("selects explicit, repository, and default profiles deterministically", () => {
    const config = nativeRoutingConfigSchema.parse({
      defaultProfile: "economical",
      repositoryProfiles: { important: "careful" },
      profiles: {
        economical: { extends: "economy" },
        careful: { extends: "quality" },
      },
    });
    expect(resolveNativePolicy({ config, repository: "important" }).decision).toMatchObject({
      profile: "careful",
      baseProfile: "quality",
      source: "repository",
    });
    expect(
      resolveNativePolicy({ config, repository: "important", requestedProfile: "speed" }).decision,
    ).toMatchObject({ profile: "speed", baseProfile: "speed", source: "explicit" });
    expect(resolveNativePolicy({ config, repository: "other" }).decision).toMatchObject({
      profile: "economical",
      baseProfile: "economy",
      source: "default",
    });
  });

  it("never lets explicit requests or preferences bypass hard requirements, fallback, or deny", () => {
    const config = nativeRoutingConfigSchema.parse({
      profiles: {
        strict: {
          extends: "quality",
          policy: {
            candidates: {
              deny: ["denied"],
              prefer: { denied: 0.5, current: 0.5 },
            },
          },
        },
      },
    });
    const resolved = resolveNativePolicy({
      config,
      repository: "repo",
      requestedProfile: "strict",
    });
    const result = scoreWithNativePolicy({
      candidates: [
        candidate("current", { quality: 1 }),
        candidate("denied", { quality: 1 }),
        candidate("unsafe", {
          capabilities: {
            tools: false,
            vision: true,
            search: true,
            edit: true,
            maxContextTokens: 100_000,
          },
        }),
        candidate("eligible", { quality: 0.1 }),
      ],
      task,
      currentModel: "current",
      harness: "opencode",
      resolved,
      override: { candidate: "unsafe" },
    });
    expect(result.ranked.map((item) => item.id)).toEqual(["eligible"]);
    expect(result.excluded).toEqual(
      expect.arrayContaining([
        { id: "current", reasons: ["reserved as the current-model fallback"] },
        { id: "denied", reasons: ["denied by native candidate policy"] },
        { id: "unsafe", reasons: ["tools are unsupported"] },
      ]),
    );
    expect(result.policy.ignored).toContainEqual(
      expect.objectContaining({ code: "request-candidate-unsafe", candidateId: "unsafe" }),
    );
    expect(result.policy.applied).not.toContainEqual(
      expect.objectContaining({ code: "candidate-preferred", candidateId: "denied" }),
    );
  });

  it("applies aliases, bounded metadata, score adjustments, effort caps, and stable ties", () => {
    const config = nativeRoutingConfigSchema.parse({
      profiles: {
        tuned: {
          extends: "balanced",
          policy: {
            aliases: { quick: "a" },
            overrides: { quick: { quality: 0.6 } },
            candidates: { prefer: { quick: 0.1 }, penalize: { quick: 0.1 } },
            effort: { cap: "medium" },
          },
        },
      },
    });
    const resolved = resolveNativePolicy({
      config,
      repository: "repo",
      requestedProfile: "tuned",
    });
    const metadata = applyNativeMetadata([candidate("b"), candidate("a")], resolved);
    const result = scoreWithNativePolicy({
      candidates: metadata.candidates,
      task,
      harness: "opencode",
      resolved,
      metadataApplied: metadata.applied,
      override: { reasoningEffort: "high" },
    });
    expect(result.ranked.map((item) => item.id)).toEqual(["a", "b"]);
    expect(result.ranked.every((item) => item.reasoningEffort === "medium")).toBe(true);
    expect(result.policy.applied).toContainEqual(
      expect.objectContaining({ code: "metadata-override-applied", candidateId: "a" }),
    );
    expect(result.policy.ignored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "request-effort-unsafe", candidateId: "a" }),
        expect.objectContaining({ code: "request-effort-unsafe", candidateId: "b" }),
      ]),
    );
  });

  it("never lets metadata overrides fabricate live safety capabilities", () => {
    const config = nativeRoutingConfigSchema.parse({
      profiles: {
        unsafe: {
          policy: {
            overrides: {
              limited: {
                available: true,
                capabilities: { tools: true, edit: true, maxContextTokens: 200_000 },
                supportedEfforts: ["ultra"],
              },
            },
          },
        },
      },
    });
    const resolved = resolveNativePolicy({
      config,
      repository: "repo",
      requestedProfile: "unsafe",
    });
    const metadata = applyNativeMetadata(
      [
        candidate("limited", {
          available: false,
          capabilities: {
            tools: false,
            vision: false,
            search: false,
            edit: false,
            maxContextTokens: 1_000,
          },
          supportedEfforts: ["low"],
        }),
      ],
      resolved,
    );
    expect(metadata.candidates[0]).toMatchObject({
      available: false,
      capabilities: { tools: false, edit: false, maxContextTokens: 1_000 },
      supportedEfforts: [],
    });
    expect(metadata.ignored).toContainEqual(
      expect.objectContaining({ code: "metadata-override-unsafe", candidateId: "limited" }),
    );
  });

  it("enforces locally measurable route and candidate budgets", () => {
    const config = nativeRoutingConfigSchema.parse({
      profiles: {
        bounded: {
          policy: {
            budget: { windowHours: 24, maxRoutes: 2, candidateMaxRoutes: { a: 1 } },
          },
        },
      },
    });
    const resolved = resolveNativePolicy({
      config,
      repository: "repo",
      requestedProfile: "bounded",
    });
    const result = scoreWithNativePolicy({
      candidates: [candidate("a"), candidate("b")],
      task,
      harness: "opencode",
      resolved,
      usage: { routes: 1, attempts: 0, candidateRoutes: { a: 1 } },
    });
    expect(result.ranked.map((item) => item.id)).toEqual(["b"]);
    expect(result.excluded).toContainEqual({
      id: "a",
      reasons: ["native candidate usage budget exhausted"],
    });
    const exhausted = scoreWithNativePolicy({
      candidates: [candidate("a"), candidate("b")],
      task,
      harness: "opencode",
      resolved,
      usage: { routes: 2, attempts: 0, candidateRoutes: {} },
    });
    expect(exhausted.ranked).toEqual([]);
    expect(exhausted.policy.applied).toContainEqual(
      expect.objectContaining({ code: "budget-exhausted" }),
    );
  });
});

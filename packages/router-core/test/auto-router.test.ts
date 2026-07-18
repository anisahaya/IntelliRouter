import type { AutoCandidate, RepoSignals } from "@model-router/contracts";
import { buildAutoTaskProfile, clampEffort, scoreAutoCandidates } from "@model-router/router-core";
import { describe, expect, it } from "vitest";

const repo: RepoSignals = {
  rootName: "example",
  languages: [{ name: "TypeScript", count: 20 }],
  fileCount: 30,
  testFileCount: 5,
  manifests: ["package.json"],
  changedFileCount: 0,
  diffInsertions: 0,
  diffDeletions: 0,
  hasTests: true,
  monorepo: false,
  dirty: false,
  truncated: false,
  changedFiles: [],
  topLevelDirectories: [],
  dependencyNames: [],
  packageCount: 1,
  hasCi: false,
};

const commonCapabilities = {
  tools: true,
  vision: true,
  search: true,
  edit: true,
  maxContextTokens: 200_000,
};

function candidate(overrides: Partial<AutoCandidate> & Pick<AutoCandidate, "id">): AutoCandidate {
  const { id, ...rest } = overrides;
  return {
    id,
    kind: "codex-model",
    displayName: overrides.id,
    description: "",
    available: true,
    capabilities: commonCapabilities,
    strengths: [],
    quality: 0.8,
    speed: 0.8,
    economy: 0.8,
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    ...rest,
  };
}

describe("automatic model routing", () => {
  it("derives higher effort for risky repository-wide architecture work", () => {
    const profile = buildAutoTaskProfile({
      objective:
        "Architect and implement a repository-wide authentication migration with security tradeoffs",
      conversationSummary: "The change spans several packages and production permissions.",
      repoSignals: repo,
      requirements: {
        tools: true,
        vision: false,
        search: false,
        edit: true,
        minimumContextTokens: 0,
      },
    });
    expect(profile.scope).toBe("repo");
    expect(profile.taskType).toBe("implementation");
    expect(["high", "xhigh", "max"]).toContain(profile.desiredEffort);
  });

  it("changes winners by profile and resolves ties deterministically", () => {
    const task = buildAutoTaskProfile({
      objective: "Implement a complex multi-file feature",
      repoSignals: repo,
      requirements: {
        tools: true,
        vision: false,
        search: false,
        edit: true,
        minimumContextTokens: 0,
      },
    });
    const quality = candidate({ id: "quality", quality: 1, speed: 0.3, economy: 0.2 });
    const fast = candidate({ id: "fast", quality: 0.65, speed: 1, economy: 1 });
    expect(scoreAutoCandidates([fast, quality], task, "quality").ranked[0]?.id).toBe("quality");
    expect(scoreAutoCandidates([quality, fast], task, "speed").ranked[0]?.id).toBe("fast");
    const tied = [candidate({ id: "z" }), candidate({ id: "a" })];
    expect(scoreAutoCandidates(tied, task, "balanced").ranked.map((item) => item.id)).toEqual([
      "a",
      "z",
    ]);
  });

  it("uses only sufficiently sampled, capped, and decayed observed priors", () => {
    const task = buildAutoTaskProfile({
      objective: "Implement a complex multi-file feature",
      repoSignals: repo,
      requirements: {
        tools: true,
        vision: false,
        search: false,
        edit: true,
        minimumContextTokens: 0,
      },
    });
    const now = Date.parse("2026-07-18T12:00:00.000Z");
    const candidates = [candidate({ id: "learned" }), candidate({ id: "baseline" })];
    const sparse = scoreAutoCandidates(candidates, task, "balanced", undefined, {
      learned: {
        successRate: 1,
        averageLatencyMs: 1,
        feedbackPrior: 1,
        attemptSamples: 2,
        feedbackSamples: 1,
        lastObservedAt: new Date(now).toISOString(),
      },
    });
    expect(sparse.ranked.find((item) => item.id === "learned")?.scores.observedAdjustment).toBe(0);

    const learned = scoreAutoCandidates(
      candidates,
      task,
      "balanced",
      undefined,
      {
        learned: {
          successRate: 1,
          averageLatencyMs: 1,
          feedbackPrior: 1,
          attemptSamples: 100,
          feedbackSamples: 100,
          lastObservedAt: new Date(now).toISOString(),
        },
      },
      { now },
    );
    expect(learned.ranked[0]?.id).toBe("learned");
    expect(learned.ranked[0]?.scores.observedAdjustment).toBeLessThanOrEqual(0.08);

    const decayed = scoreAutoCandidates(
      candidates,
      task,
      "balanced",
      undefined,
      {
        learned: {
          successRate: 1,
          averageLatencyMs: 1,
          feedbackPrior: 1,
          attemptSamples: 100,
          feedbackSamples: 100,
          lastObservedAt: new Date(now - 60 * 24 * 60 * 60 * 1_000).toISOString(),
        },
      },
      { now },
    );
    expect(decayed.ranked[0]?.scores.observedAdjustment).toBeCloseTo(0.02, 5);
  });

  it("reserves the host model for fallback and enforces hard capabilities", () => {
    const task = buildAutoTaskProfile({
      objective: "Inspect this screenshot and edit the repository",
      repoSignals: repo,
      requirements: {
        tools: true,
        vision: true,
        search: false,
        edit: true,
        minimumContextTokens: 0,
      },
    });
    const result = scoreAutoCandidates(
      [
        candidate({ id: "current" }),
        candidate({ id: "no-vision", capabilities: { ...commonCapabilities, vision: false } }),
      ],
      task,
      "balanced",
      "current",
    );
    expect(result.ranked).toEqual([]);
    expect(result.excluded.find((item) => item.id === "current")?.reasons[0]).toContain("fallback");
    expect(result.excluded.find((item) => item.id === "no-vision")?.reasons).toContain(
      "vision is unsupported",
    );
  });

  it("clamps unavailable reasoning levels toward the desired effort", () => {
    expect(clampEffort("max", ["low", "high"])).toBe("high");
    expect(clampEffort("medium", ["low", "high"])).toBe("low");
  });

  it("honors explicit hard capabilities instead of treating negated prompt words as requirements", () => {
    const task = buildAutoTaskProfile({
      objective: "Inspect only supplied metadata. Do not edit files, run tools, or use search.",
      repoSignals: repo,
      requirements: {
        tools: false,
        vision: false,
        search: false,
        edit: false,
        minimumContextTokens: 0,
      },
    });
    expect(task).toMatchObject({
      toolsRequired: false,
      visionRequired: false,
      searchRequired: false,
      editRequired: false,
    });
  });
});

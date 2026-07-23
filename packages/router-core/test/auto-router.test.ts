import type { AutoCandidate, RepoSignals } from "@model-router/contracts";
import {
  AUTO_PROFILE_WEIGHTS,
  buildAutoTaskProfile,
  clampEffort,
  type RoutingEvidence,
  scoreAutoCandidates,
} from "@model-router/router-core";
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
  it("uses the provisional Balanced weights and keeps their total at one", () => {
    expect(AUTO_PROFILE_WEIGHTS.balanced).toEqual({
      fit: 0.38,
      quality: 0.32,
      speed: 0.1,
      economy: 0.2,
    });
    expect(
      Object.values(AUTO_PROFILE_WEIGHTS.balanced).reduce((sum, value) => sum + value, 0),
    ).toBe(1);
  });

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

  it("chooses the lowest completed-task cost only after the quality floor", () => {
    const task = buildAutoTaskProfile({
      objective: "Implement a small exact feature with tests",
      repoSignals: repo,
      requirements: {
        tools: true,
        vision: false,
        search: false,
        edit: true,
        minimumContextTokens: 0,
      },
    });
    const cheap = candidate({ id: "cheap", quality: 0.7, economy: 0.1 });
    const expensive = candidate({ id: "expensive", quality: 1, economy: 1 });
    const records = [
      ...verifiedRecords(task, "cheap", 8, 1),
      ...verifiedRecords(task, "expensive", 8, 5),
    ];
    const result = scoreAutoCandidates([expensive, cheap], task, "balanced", "current", records);
    expect(result.selected?.id).toBe("cheap");
    expect(result.ranked[0]?.scores).toMatchObject({
      economy: 1,
      meetsQualityThreshold: true,
      expectedCost: 1,
      expectedCostUnit: "usd",
      expectedCostBasis: "observed",
      expectedCostComparable: true,
    });
  });

  it("raises the high-risk floor so cheapness cannot offset weak verified success", () => {
    const task = buildAutoTaskProfile({
      objective:
        "Implement a repository-wide production security permission migration with exact tests",
      repoSignals: repo,
      requirements: {
        tools: true,
        vision: false,
        search: false,
        edit: true,
        minimumContextTokens: 0,
      },
    });
    const cheap = candidate({ id: "cheap", economy: 1 });
    const proven = candidate({ id: "proven", economy: 0.1 });
    const records = [
      ...verifiedRecords(task, "cheap", 10, undefined),
      ...verifiedRecords(task, "cheap", 2, undefined, "incorrect"),
      ...verifiedRecords(task, "proven", 20, 4),
    ];
    const result = scoreAutoCandidates([cheap, proven], task, "balanced", "current", records);
    expect(result.ranked.find((item) => item.id === "cheap")?.scores).toMatchObject({
      qualityThreshold: 0.9,
      meetsQualityThreshold: false,
    });
    expect(result.selected?.id).toBe("proven");
  });

  it("abstains when a quality-qualified route has unknown cost", () => {
    const task = buildAutoTaskProfile({
      objective: "Implement a small exact feature with tests",
      repoSignals: repo,
      requirements: {
        tools: true,
        vision: false,
        search: false,
        edit: true,
        minimumContextTokens: 0,
      },
    });
    const measured = candidate({ id: "measured" });
    const unknown = candidate({ id: "unknown" });
    const unknownEvidence = verifiedRecords(task, "unknown", 8).map((record) => ({
      ...record,
      attempts: record.attempts.map((attempt) => ({
        ...attempt,
        inputTokens: undefined,
        outputTokens: undefined,
        tokenBasis: "unknown" as const,
      })),
    }));
    const result = scoreAutoCandidates([measured, unknown], task, "balanced", "current", [
      ...verifiedRecords(task, "measured", 8, 1),
      ...unknownEvidence,
    ]);
    expect(result.ranked.every((item) => item.scores.meetsQualityThreshold)).toBe(true);
    expect(result.ranked.find((item) => item.id === "unknown")?.scores.expectedCostComparable).toBe(
      false,
    );
    expect(result.selected).toBeUndefined();
    expect(result.coldStartReason).toContain("comparable");
  });

  it("falls back on cold start and is independent of candidate input order", () => {
    const task = buildAutoTaskProfile({
      objective: "Implement a small feature",
      repoSignals: repo,
      requirements: {
        tools: true,
        vision: false,
        search: false,
        edit: true,
        minimumContextTokens: 0,
      },
    });
    const candidates = [candidate({ id: "z" }), candidate({ id: "a" })];
    const left = scoreAutoCandidates(candidates, task, "balanced", "current");
    const right = scoreAutoCandidates([...candidates].reverse(), task, "balanced", "current");
    expect(left.selected).toBeUndefined();
    expect(left.coldStartReason).toContain("no candidate clears");
    expect(left.ranked.map((item) => item.id)).toEqual(right.ranked.map((item) => item.id));
  });
});

function verifiedRecords(
  task: ReturnType<typeof buildAutoTaskProfile>,
  model: string,
  count: number,
  costUsd?: number,
  label: "correct" | "incorrect" = "correct",
): RoutingEvidence[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${model}-${label}-${index}`,
    model,
    taskFingerprint: `${model}-${label}-${index}`,
    taskType: task.taskType,
    scope: task.scope,
    complexity: task.complexity,
    risk: task.risk,
    capabilities: [
      ...(task.toolsRequired ? ["tools"] : []),
      ...(task.visionRequired ? ["vision"] : []),
      ...(task.searchRequired ? ["search"] : []),
      ...(task.editRequired ? ["edit"] : []),
    ],
    repoTags: task.repoTags,
    label,
    labelStrength: "verified",
    origin: "native",
    verification: label === "correct" ? "passed" : "failed",
    process: "completed",
    createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    attempts: [
      {
        attemptOrder: 0,
        model,
        outcome: "completed",
        retry: false,
        fallback: false,
        inputTokens: 100,
        outputTokens: 20,
        tokenBasis: "actual",
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd,
        costBasis: costUsd === undefined ? "unknown" : "actual",
        partialWriteDetected: false,
        safeToFallback: true,
      },
    ],
  }));
}

import type { AutoCandidate, AutoTaskProfile } from "@model-router/contracts";
import { describe, expect, it } from "vitest";
import {
  estimateVerifiedSuccess,
  expectedCompletedTaskCost,
  normalizeEconomy,
  observableCacheSwitchCost,
  planVerifyThenEscalate,
  qualityThreshold,
  type RoutingEvidence,
} from "../src/routing-math.js";

const task: AutoTaskProfile = {
  taskType: "implementation",
  complexity: 0.5,
  ambiguity: 0.3,
  risk: 0.2,
  mechanical: 0.2,
  scope: "single",
  toolsRequired: true,
  visionRequired: false,
  searchRequired: false,
  editRequired: true,
  estimatedContextTokens: 1_000,
  desiredEffort: "medium",
  repoTags: ["typescript", "tests"],
};

const candidate: AutoCandidate = {
  id: "cheap",
  kind: "harness-model",
  harness: "opencode",
  displayName: "Cheap",
  description: "",
  available: true,
  capabilities: {
    tools: true,
    vision: false,
    search: false,
    edit: true,
    maxContextTokens: 100_000,
  },
  strengths: [],
  quality: 0.7,
  speed: 0.8,
  economy: 0.9,
};

function evidence(
  id: string,
  label: "correct" | "incorrect" = "correct",
  overrides: Partial<RoutingEvidence> = {},
): RoutingEvidence {
  return {
    id,
    model: "cheap",
    taskFingerprint: id,
    taskType: task.taskType,
    scope: task.scope,
    complexity: task.complexity,
    risk: task.risk,
    capabilities: ["tools", "edit"],
    repoTags: task.repoTags,
    label,
    labelStrength: "verified",
    origin: "native",
    verification: label === "correct" ? "passed" : "failed",
    process: "completed",
    createdAt: `2026-01-${String(Number(id.replace(/\D/g, "")) || 1).padStart(2, "0")}T00:00:00.000Z`,
    attempts: [
      {
        attemptOrder: 0,
        model: "cheap",
        outcome: "completed",
        retry: false,
        fallback: false,
        inputTokens: 100,
        outputTokens: 50,
        tokenBasis: "actual",
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        costUsd: 0.1,
        costBasis: "actual",
        partialWriteDetected: false,
        safeToFallback: true,
      },
    ],
    ...overrides,
  };
}

describe("routing math safety", () => {
  it("uses discrete risk floors and a cautious non-calibrated cold start", () => {
    expect(qualityThreshold(0.2)).toBe(0.6);
    expect(qualityThreshold(0.5)).toBe(0.75);
    expect(qualityThreshold(0.9)).toBe(0.9);
    const estimate = estimateVerifiedSuccess(task, "cheap", []);
    expect(estimate).toMatchObject({
      estimatedVerifiedSuccess: 0.5,
      priorOnly: true,
      calibrated: false,
      priorAlpha: 2,
      priorBeta: 2,
      evidenceStrength: "prior-only",
    });
    expect(estimate.conservativeSuccess).toBeLessThan(0.6);
  });

  it("shrinks sparse evidence and reacts cautiously to contradictory verified outcomes", () => {
    const sparse = estimateVerifiedSuccess(task, "cheap", [evidence("run-1")]);
    const contradictory = estimateVerifiedSuccess(task, "cheap", [
      evidence("run-1"),
      evidence("run-2", "incorrect"),
    ]);
    expect(sparse.evidenceStrength).toBe("sparse");
    expect(sparse.conservativeSuccess).toBeLessThan(0.6);
    expect(contradictory.estimatedVerifiedSuccess).toBeLessThan(sparse.estimatedVerifiedSuccess);
  });

  it("deduplicates task fingerprints, excludes unverified origins, and bounds neighbors", () => {
    const records = Array.from({ length: 30 }, (_, index) => evidence(`run-${index + 1}`));
    records.push(
      evidence("imported", "correct", { origin: "imported" }),
      evidence("attested", "correct", {
        labelStrength: "verified",
        verification: "inconclusive",
      }),
      evidence("newer-duplicate", "incorrect", {
        taskFingerprint: "run-1",
        createdAt: "2027-01-01T00:00:00.000Z",
      }),
    );
    const estimate = estimateVerifiedSuccess(task, "cheap", records);
    expect(estimate.neighborCount).toBe(20);
    expect(estimate.effectiveCount).toBeLessThanOrEqual(20);
    expect(estimate.rawCount).toBe(records.length);
    expect(estimate.calibrated).toBe(false);
  });

  it("aggregates first attempts, retries, escalation, and observable cache cost", () => {
    const record = evidence("cost", "correct", {
      attempts: [
        {
          attemptOrder: 0,
          model: "cheap",
          outcome: "failed",
          retry: false,
          fallback: false,
          inputTokens: 100,
          outputTokens: 20,
          tokenBasis: "actual",
          cacheReadTokens: 0,
          cacheWriteTokens: 30,
          costBasis: "unknown",
          partialWriteDetected: false,
          safeToFallback: true,
        },
        {
          attemptOrder: 1,
          model: "cheap",
          outcome: "failed",
          retry: true,
          fallback: false,
          inputTokens: 80,
          outputTokens: 20,
          tokenBasis: "actual",
          cacheReadTokens: 10,
          cacheWriteTokens: 0,
          costBasis: "unknown",
          partialWriteDetected: false,
          safeToFallback: true,
        },
        {
          attemptOrder: 2,
          model: "frontier",
          outcome: "completed",
          retry: false,
          fallback: true,
          inputTokens: 120,
          outputTokens: 40,
          tokenBasis: "actual",
          cacheReadTokens: 0,
          cacheWriteTokens: 40,
          costBasis: "unknown",
          partialWriteDetected: false,
          safeToFallback: true,
        },
      ],
    });
    const withoutSwitch = expectedCompletedTaskCost(task, candidate, [record]);
    expect(withoutSwitch.value).toBe(380);
    expect(withoutSwitch.components.cacheSwitch).toBe(0);
    const cost = expectedCompletedTaskCost(task, candidate, [record]);
    expect(cost).toMatchObject({
      unit: "tokens",
      basis: "observed",
      comparable: true,
      cacheState: "observed",
      components: {
        firstAttempt: 120,
        retries: 100,
        escalations: 160,
        cacheSwitch: 0,
      },
    });
    expect(cost.value).toBe(380);

    const direct = evidence("direct-cache", "correct", {
      attempts: [
        {
          attemptOrder: 0,
          model: "cheap",
          outcome: "completed",
          retry: false,
          fallback: false,
          inputTokens: 100,
          outputTokens: 50,
          tokenBasis: "actual",
          cacheReadTokens: 20,
          cacheWriteTokens: 10,
          costBasis: "unknown",
          partialWriteDetected: false,
          safeToFallback: true,
        },
      ],
    });
    const cacheSwitch = observableCacheSwitchCost(task, candidate, [direct]);
    expect(cacheSwitch?.value).toBe(10);
    expect(expectedCompletedTaskCost(task, candidate, [direct], { cacheSwitch })).toMatchObject({
      value: 160,
      components: { firstAttempt: 150, cacheSwitch: 10 },
    });
  });

  it("does not credit a cheap model for a frontier fallback's verified success", () => {
    const fallbackRun = evidence("fallback-plan", "correct", {
      attempts: [
        {
          attemptOrder: 0,
          model: "cheap",
          outcome: "failed",
          retry: false,
          fallback: false,
          inputTokens: 100,
          outputTokens: 10,
          tokenBasis: "actual",
          cacheReadTokens: 0,
          cacheWriteTokens: 20,
          costBasis: "unknown",
          partialWriteDetected: false,
          safeToFallback: true,
        },
        {
          attemptOrder: 1,
          model: "frontier",
          outcome: "completed",
          retry: false,
          fallback: true,
          inputTokens: 200,
          outputTokens: 50,
          tokenBasis: "actual",
          cacheReadTokens: 0,
          cacheWriteTokens: 40,
          costBasis: "unknown",
          partialWriteDetected: false,
          safeToFallback: true,
        },
      ],
    });
    expect(estimateVerifiedSuccess(task, "cheap", [fallbackRun])).toMatchObject({
      priorOnly: true,
      neighborCount: 0,
    });
    expect(expectedCompletedTaskCost(task, candidate, [fallbackRun])).toMatchObject({
      value: 360,
      components: { firstAttempt: 110, escalations: 250 },
    });
  });

  it("requires provenance for estimated USD and labels unknown cache state", () => {
    const withoutProvenance = evidence("estimated", "correct", {
      attempts: [
        {
          attemptOrder: 0,
          retry: false,
          fallback: false,
          tokenBasis: "unknown",
          costUsd: 0.5,
          costBasis: "estimated",
          partialWriteDetected: false,
          safeToFallback: true,
        },
      ],
    });
    expect(expectedCompletedTaskCost(task, candidate, [withoutProvenance])).toMatchObject({
      basis: "catalog-fallback",
      comparable: false,
      cacheState: "unknown",
    });
    const withProvenance = evidence("estimated-provenance", "correct", {
      attempts: [
        {
          attemptOrder: 0,
          retry: false,
          fallback: false,
          tokenBasis: "unknown",
          costUsd: 0.5,
          costBasis: "estimated",
          pricingProvenance: "provider-published-price-table@2026-01-01",
          partialWriteDetected: false,
          safeToFallback: true,
        },
      ],
    });
    expect(expectedCompletedTaskCost(task, candidate, [withProvenance])).toMatchObject({
      value: 0.5,
      unit: "usd",
      basis: "estimated",
      comparable: true,
      cacheState: "unknown",
    });
  });

  it("classifies a non-retry attempt as first attempt regardless of attempt order", () => {
    const reordered = evidence("reordered", "correct", {
      attempts: [
        {
          ...evidence("seed").attempts[0]!,
          attemptOrder: 1,
          retry: false,
          fallback: false,
        },
      ],
    });
    expect(expectedCompletedTaskCost(task, candidate, [reordered])).toMatchObject({
      components: { firstAttempt: 0.1, retries: 0, escalations: 0 },
    });
  });

  it("does not infer observable cache-switch cost without cache-write telemetry", () => {
    const missingWrite = evidence("missing-cache-write", "correct", {
      attempts: [
        {
          ...evidence("seed").attempts[0]!,
          attemptOrder: 0,
          retry: false,
          fallback: false,
          cacheWriteTokens: undefined,
        },
      ],
    });
    expect(observableCacheSwitchCost(task, candidate, [missingWrite])).toBeUndefined();
    expect(expectedCompletedTaskCost(task, candidate, [missingWrite])).toMatchObject({
      cacheState: "unknown",
    });
  });

  it("normalizes economy without inventing distinctions for equal costs", () => {
    expect(normalizeEconomy([1, 3])).toEqual([1, 0]);
    expect(normalizeEconomy([2, 2])).toEqual([0.5, 0.5]);
    expect(normalizeEconomy([undefined, undefined])).toEqual([0.5, 0.5]);
  });

  it("allows only isolated objective verify-then-escalate plans and blocks partial writes", () => {
    const base = {
      cheapCost: 1,
      verifyCost: 0.5,
      cheapSuccess: 0.5,
      frontierCost: 10,
      switchCost: 0.25,
      routingCost: 0.25,
      threshold: 0.6,
      objectiveVerifier: true,
      verifierIsIndependent: true,
      frontierClearsThreshold: true,
      safeFallback: true,
      partialWriteDetected: false,
      workspaceWrite: false,
      sameUnit: true,
    };
    expect(planVerifyThenEscalate(base).allowed).toBe(true);
    expect(planVerifyThenEscalate({ ...base, objectiveVerifier: false }).reason).toContain(
      "verifier",
    );
    expect(
      planVerifyThenEscalate({
        ...base,
        partialWriteDetected: true,
        safeFallback: false,
      }),
    ).toMatchObject({ allowed: false, reason: expect.stringContaining("second writer") });
    expect(
      planVerifyThenEscalate({
        ...base,
        workspaceWrite: true,
        disposableWorkspace: false,
      }).reason,
    ).toContain("not isolated");
  });
});

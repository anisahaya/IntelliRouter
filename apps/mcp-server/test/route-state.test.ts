import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutoRouteDecision } from "@model-router/contracts";
import { describe, expect, it } from "vitest";
import {
  findAffinity,
  getRouteRecord,
  newRouteId,
  observedMetrics,
  persistDecision,
  recordRouteAttempt,
  recordRouteFeedback,
  routeIdentity,
  updateRouteHealthWindow,
  updateRouteOutcome,
} from "../src/route-state.js";

function decision(routeId: string): AutoRouteDecision {
  return {
    routeId,
    harness: "opencode",
    affinityReused: false,
    status: "planned",
    selected: {
      id: "openai/gpt-5.6-terra",
      kind: "harness-model",
      displayName: "Terra",
      reasoningEffort: "high",
      execution: "opencode-run",
    },
    profile: "balanced",
    taskProfile: {
      taskType: "implementation",
      complexity: 0.6,
      ambiguity: 0.2,
      risk: 0.3,
      mechanical: 0.1,
      scope: "multi",
      toolsRequired: true,
      visionRequired: false,
      searchRequired: false,
      editRequired: true,
      estimatedContextTokens: 1000,
      desiredEffort: "high",
      repoTags: ["typescript"],
    },
    repoSignals: {
      rootName: "repo",
      languages: [],
      fileCount: 1,
      testFileCount: 0,
      manifests: [],
      changedFileCount: 0,
      diffInsertions: 0,
      diffDeletions: 0,
      hasTests: false,
      monorepo: false,
      dirty: false,
      truncated: false,
      changedFiles: [],
      topLevelDirectories: [],
      dependencyNames: [],
      packageCount: 0,
      hasCi: false,
    },
    ranked: [],
    excluded: [],
    fallback: { kind: "current-model", harness: "opencode" },
    context: { objectiveTruncated: false, conversationTruncated: false },
  };
}

describe("harness route state", () => {
  it("persists privacy-safe affinity and outcome updates as append-only records", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-router-state-"));
    const options = { path: join(root, "routes.jsonl") };
    const identity = routeIdentity({
      harness: "opencode",
      sessionId: "private-session",
      objective: "Implement the feature",
      workspaceRoot: "/tmp/workspace",
    });
    const routeId = newRouteId();
    await persistDecision(decision(routeId), identity, options);
    expect((await findAffinity("opencode", identity, options))?.selectedCandidate).toContain(
      "terra",
    );
    const updated = await updateRouteOutcome(
      routeId,
      "failure",
      { rerouteReason: "child failed", partialWriteDetected: true },
      options,
    );
    expect(updated).toMatchObject({ outcome: "failure", partialWriteDetected: true });
    expect((await getRouteRecord(routeId, options))?.outcome).toBe("failure");
    expect(await findAffinity("opencode", identity, options)).toBeUndefined();
    const stored = await readFile(options.path, "utf8");
    expect(stored).not.toContain("private-session");
    expect(stored).not.toContain("Implement the feature");
    expect(stored.trim().split("\n")).toHaveLength(2);
  });

  it("returns no records for a missing store and rejects unknown updates", async () => {
    const options = { path: join(tmpdir(), `missing-${newRouteId()}`, "routes.jsonl") };
    expect(await getRouteRecord(newRouteId(), options)).toBeUndefined();
    await expect(updateRouteOutcome(newRouteId(), "success", {}, options)).rejects.toThrow(
      "Unknown harness route",
    );
  });

  it("reuses opaque task affinity across rewording, but honors TTL and requirements", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-router-task-affinity-"));
    let now = Date.parse("2026-07-18T12:00:00.000Z");
    const options = {
      path: join(root, "routes.jsonl"),
      affinityTtlMs: 1_000,
      now: () => now,
    };
    const original = routeIdentity({
      harness: "opencode",
      taskId: "opaque-task-123",
      objective: "Implement it one way",
      workspaceRoot: "/tmp/workspace",
      requirements: {
        tools: true,
        vision: false,
        search: false,
        edit: true,
        minimumContextTokens: 0,
      },
    });
    await persistDecision(decision(newRouteId()), original, options);
    const reworded = routeIdentity({
      harness: "opencode",
      taskId: "opaque-task-123",
      objective: "A completely different wording",
      workspaceRoot: "/tmp/workspace",
      requirements: {
        tools: true,
        vision: false,
        search: false,
        edit: true,
        minimumContextTokens: 0,
      },
    });
    expect(await findAffinity("opencode", reworded, options)).toBeDefined();
    const incompatible = routeIdentity({
      harness: "opencode",
      taskId: "opaque-task-123",
      objective: "A completely different wording",
      workspaceRoot: "/tmp/workspace",
      requirements: {
        tools: true,
        vision: true,
        search: false,
        edit: true,
        minimumContextTokens: 0,
      },
    });
    expect(await findAffinity("opencode", incompatible, options)).toBeUndefined();
    now += 1_001;
    expect(await findAffinity("opencode", reworded, options)).toBeUndefined();
    const stored = await readFile(options.path, "utf8");
    expect(stored).not.toContain("opaque-task-123");
    expect(stored).not.toContain("different wording");
  });

  it("records rankings, attempts, feedback, and bounded health data without raw task content", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-router-observations-"));
    const options = { path: join(root, "routes.jsonl") };
    const routeId = newRouteId();
    const routed = decision(routeId);
    if (routed.selected) {
      routed.selected.id = "candidate-a";
      routed.selected.displayName = "A";
    }
    routed.ranked = [
      {
        id: "candidate-a",
        kind: "harness-model",
        displayName: "A",
        scores: { taskFit: 1, quality: 1, speed: 1, economy: 1, specialization: 1, total: 0.9 },
      },
    ];
    await persistDecision(
      routed,
      routeIdentity({
        harness: "opencode",
        objective: "private objective text",
        workspaceRoot: "/private/workspace",
      }),
      options,
    );
    await recordRouteAttempt(
      routeId,
      {
        candidateId: "candidate-a",
        attemptOrder: 1,
        outcome: "failure",
        latencyMs: 25,
        errorClass: "timeout",
      },
      options,
    );
    await recordRouteFeedback(routeId, { outcome: "corrected", score: 0.25, tags: [] }, options);
    const updatedAt = new Date().toISOString();
    const record = await updateRouteHealthWindow(
      routeId,
      {
        candidateId: "candidate-a",
        state: "degraded",
        attempts: 8,
        failures: 3,
        averageLatencyMs: 40,
        updatedAt,
      },
      options,
    );
    expect(record).toMatchObject({
      candidateRankings: [{ candidateId: "candidate-a", rank: 1, totalScore: 0.9 }],
      attempts: [{ candidateId: "candidate-a", attemptOrder: 1, errorClass: "timeout" }],
      feedback: [{ outcome: "corrected", score: 0.25 }],
      healthWindows: [{ candidateId: "candidate-a", attempts: 8, failures: 3 }],
    });
    expect(await observedMetrics("opencode", ["candidate-a"], options)).toMatchObject({
      "candidate-a": {
        successRate: 0,
        averageLatencyMs: 25,
        feedbackPrior: -0.25,
        attemptSamples: 1,
        feedbackSamples: 1,
      },
    });
    const stored = await readFile(options.path, "utf8");
    expect(stored).not.toContain("private objective text");
    expect(stored).not.toContain("/private/workspace");
  });
});

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutoRouteDecision } from "@model-router/contracts";
import { describe, expect, it } from "vitest";
import {
  findAffinity,
  getNativeRouteHistory,
  getNativeRouteStats,
  getRouteRecord,
  newRouteId,
  observedMetrics,
  persistDecision,
  pruneNativeRoutes,
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
  it("persists privacy-safe affinity and outcome updates in SQLite", async () => {
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
    const stored = (await readFile(join(root, "routes.sqlite"))).toString();
    expect(stored).not.toContain("private-session");
    expect(stored).not.toContain("Implement the feature");
    expect(stored).not.toContain("child failed");
    expect(stored).toContain(routeId);
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
    const stored = (await readFile(join(root, "routes.sqlite"))).toString();
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
    const stored = (await readFile(join(root, "routes.sqlite"))).toString();
    expect(stored).not.toContain("private objective text");
    expect(stored).not.toContain("/private/workspace");
  });

  it("imports the latest valid legacy JSONL record idempotently and leaves the source untouched", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "model-router-source-"));
    const sourceOptions = { path: join(sourceRoot, "source.jsonl") };
    const routeId = newRouteId();
    const original = await persistDecision(
      decision(routeId),
      routeIdentity({
        harness: "opencode",
        objective: "safe source",
        workspaceRoot: "/tmp/source",
      }),
      sourceOptions,
    );
    const root = await mkdtemp(join(tmpdir(), "model-router-import-"));
    const options = { path: join(root, "routes.jsonl") };
    const latest = {
      ...original,
      updatedAt: "2099-01-01T00:00:00.000Z",
      outcome: "success",
      objective: "must-not-be-imported",
      sessionId: "must-not-be-imported",
      workspaceRoot: "/must/not/be/imported",
    };
    const legacy = `${JSON.stringify(original)}\nnot-json\n${JSON.stringify(latest)}\n`;
    await writeFile(options.path, legacy);

    expect(await getRouteRecord(routeId, options)).toMatchObject({ outcome: "success" });
    expect(await getRouteRecord(routeId, options)).toMatchObject({ outcome: "success" });
    expect(await readFile(options.path, "utf8")).toBe(legacy);
    const stored = (await readFile(join(root, "routes.sqlite"))).toString();
    expect(stored).not.toContain("must-not-be-imported");
    expect(stored).not.toContain("/must/not/be/imported");
    expect(
      await pruneNativeRoutes(
        {
          before: "2100-01-01T00:00:00.000Z",
          now: Date.parse("2100-01-01T00:00:00.000Z"),
        },
        options,
      ),
    ).toBe(1);
    expect(await getRouteRecord(routeId, options)).toBeUndefined();
    expect(await readFile(options.path, "utf8")).toBe(legacy);
  });

  it("exposes filtered history and aggregate native statistics", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-router-history-"));
    const options = { path: join(root, "routes.jsonl") };
    const successful = newRouteId();
    await persistDecision(
      decision(successful),
      routeIdentity({ harness: "opencode", objective: "one", workspaceRoot: "/tmp/one" }),
      options,
    );
    await recordRouteAttempt(
      successful,
      { candidateId: "candidate-a", attemptOrder: 1, outcome: "success", latencyMs: 20 },
      options,
    );
    await updateRouteOutcome(successful, "success", {}, options);
    await persistDecision(
      decision(newRouteId()),
      routeIdentity({ harness: "opencode", objective: "two", workspaceRoot: "/tmp/two" }),
      options,
    );

    expect(await getNativeRouteHistory({ outcome: "success", limit: 10 }, options)).toHaveLength(1);
    expect(await getNativeRouteStats({ harness: "opencode" }, options)).toMatchObject({
      totalRoutes: 2,
      activeRoutes: 1,
      totalAttempts: 1,
      successfulAttempts: 1,
      averageAttemptLatencyMs: 20,
      byHarness: { opencode: 2 },
      byOutcome: { planned: 1, success: 1 },
    });
  });

  it("prunes expired terminal history while preserving active routes and live affinity", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-router-retention-"));
    const activeOptions = { path: join(root, "routes.jsonl"), affinityTtlMs: 1 };
    const expired = newRouteId();
    await persistDecision(
      decision(expired),
      routeIdentity({ harness: "opencode", objective: "expired", workspaceRoot: "/tmp/a" }),
      activeOptions,
    );
    await updateRouteOutcome(expired, "failure", {}, activeOptions);
    const active = newRouteId();
    await persistDecision(
      decision(active),
      routeIdentity({ harness: "opencode", objective: "active", workspaceRoot: "/tmp/b" }),
      activeOptions,
    );
    const liveAffinity = newRouteId();
    await persistDecision(
      decision(liveAffinity),
      routeIdentity({ harness: "opencode", objective: "affinity", workspaceRoot: "/tmp/c" }),
      { ...activeOptions, affinityTtlMs: 60_000 },
    );
    await updateRouteOutcome(liveAffinity, "success", {}, activeOptions);

    expect(
      await pruneNativeRoutes(
        { before: "2099-01-01T00:00:00.000Z", now: Date.now() + 2 },
        activeOptions,
      ),
    ).toBe(1);
    expect(await getRouteRecord(expired, activeOptions)).toBeUndefined();
    expect(await getRouteRecord(active, activeOptions)).toBeDefined();
    expect(await getRouteRecord(liveAffinity, activeOptions)).toBeDefined();
  });
});

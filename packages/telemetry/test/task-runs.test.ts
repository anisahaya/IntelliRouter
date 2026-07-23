import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/migrations.js";
import { TaskRunStore } from "../src/task-runs.js";

describe("task runs", () => {
  it("records process separately and returns safe receipt", () => {
    const db = new Database(":memory:");
    migrate(db);
    const s = new TaskRunStore(db, "salt");
    s.createRun({ routeId: "r", origin: "native", taskFingerprint: "t" });
    s.completeProcess("r", "completed");
    const receipt = s.receipt("r");
    expect(receipt?.verification).toBe("not-run");
    expect(receipt).not.toHaveProperty("content");
    db.close();
  });
  it("rejects invalid embeddings", () => {
    const db = new Database(":memory:");
    migrate(db);
    const s = new TaskRunStore(db, "salt");
    s.createRun({ routeId: "r", origin: "evaluation", taskFingerprint: "t" });
    expect(
      s.embedding(
        "r",
        { locallyGenerated: true, model: "m", dimensions: 2, values: [NaN, 1] },
        true,
      ),
    ).toBe(false);
    db.close();
  });

  it("returns bounded verified positive and negative evidence with normalized attempts", () => {
    const db = new Database(":memory:");
    migrate(db);
    const store = new TaskRunStore(db, "salt");
    for (const [routeId, result, origin] of [
      ["passed", "passed", "native"],
      ["failed", "failed", "evaluation"],
    ] as const) {
      store.createRun({
        id: routeId,
        routeId,
        origin,
        taskFingerprint: `task-${routeId}`,
        selectedModel: "model-a",
        harness: "opencode",
        derivedFeatures: {
          taskType: "implementation",
          scope: "single",
          complexity: 0.4,
          risk: 0.2,
          requiredCapabilities: ["tools", "edit"],
        },
        repoTags: ["typescript"],
      });
      store.recordAttempt(routeId, {
        attemptOrder: 0,
        model: "model-a",
        outcome: result === "passed" ? "completed" : "failed",
        retry: false,
        fallback: false,
        inputTokens: 100,
        outputTokens: 20,
        tokenBasis: "actual",
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        costUsd: 0.25,
        costBasis: "actual",
        pricingProvenance: "observed-receipt",
        partialWriteDetected: false,
        safeToFallback: true,
      });
      store.recordAttempt(routeId, {
        attemptOrder: 1,
        model: "model-a",
        outcome: "completed",
        retry: true,
        fallback: false,
        inputTokens: 80,
        outputTokens: 10,
        tokenBasis: "actual",
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
        costUsd: 0.1,
        costBasis: "actual",
        pricingProvenance: "observed-receipt",
        partialWriteDetected: false,
        safeToFallback: true,
      });
      store.completeProcess(routeId, result === "passed" ? "completed" : "failed");
      store.verify(routeId, {
        kind: "test",
        result,
        checkName: `${routeId}-check`,
      });
    }

    store.createRun({
      routeId: "attested-only",
      origin: "native",
      taskFingerprint: "attested",
      selectedModel: "model-a",
    });
    store.completeProcess("attested-only", "completed");

    const results = store.queryRoutingEvidence({
      model: "model-a",
      harness: "opencode",
      limit: 256,
    });
    expect(results).toHaveLength(2);
    expect(results.map((item) => item.label).sort()).toEqual(["correct", "incorrect"]);
    expect(results.find((item) => item.id === "failed")).toMatchObject({
      label: "incorrect",
      labelStrength: "verified",
      verification: "failed",
      process: "failed",
    });
    expect(results.every((item) => item.updatedAt.length > 0)).toBe(true);
    expect(results[0]?.attempts.map((attempt) => attempt.attemptOrder)).toEqual([0, 1]);
    expect(results[0]?.attempts[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      costBasis: "actual",
      retry: false,
      fallback: false,
    });
    expect(results[0]).not.toHaveProperty("content");
    expect(store.queryRoutingEvidence({ model: "model-a", limit: 1 })).toHaveLength(1);
    expect(store.queryRoutingEvidence({ model: "other", limit: 256 })).toEqual([]);
    db.close();
  });
});

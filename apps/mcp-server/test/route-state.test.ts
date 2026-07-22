import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutoRouteDecision } from "@model-router/contracts";
import { describe, expect, it } from "vitest";
import {
  findAffinity,
  getRouteRecord,
  newRouteId,
  persistDecision,
  routeIdentity,
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
    const options = {
      path: join(root, "routes.jsonl"),
      env: { ...process.env, MODEL_ROUTER_DATA_DIR: root },
    };
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
    const root = await mkdtemp(join(tmpdir(), "model-router-state-missing-"));
    const options = {
      path: join(root, "routes.jsonl"),
      env: { ...process.env, MODEL_ROUTER_DATA_DIR: root },
    };
    expect(await getRouteRecord(newRouteId(), options)).toBeUndefined();
    await expect(updateRouteOutcome(newRouteId(), "success", {}, options)).rejects.toThrow(
      "Unknown harness route",
    );
  });

  it("compacts oversized append-only stores and preserves latest records", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-router-state-large-"));
    const path = join(root, "routes.jsonl");
    const record = decision(newRouteId());
    const line =
      JSON.stringify({
        routeId: record.routeId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        harness: "opencode",
        taskFingerprint: "x",
        workspaceFingerprint: "y",
        selectedCandidate: "m",
        fallbackModel: "m",
        profile: "balanced",
        outcome: "planned",
        featureSummary: record.taskProfile,
        partialWriteDetected: false,
      }) + "\n";
    await writeFile(path, line.repeat(120_000), { mode: 0o600 });
    const found = await getRouteRecord(record.routeId, {
      path,
      env: { ...process.env, MODEL_ROUTER_DATA_DIR: root },
    });
    expect(found?.routeId).toBe(record.routeId);
  });
});

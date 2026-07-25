import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutoRouteDecision } from "@model-router/contracts";
import { describe, expect, it } from "vitest";
import {
  findAffinity,
  getRouteRecord,
  getTaskRunReceipt,
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
      repoTags: ["c++"],
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
    await updateRouteOutcome(routeId, "running", {}, options);
    expect(await getTaskRunReceipt(routeId, options)).toMatchObject({
      process: "running",
      verification: "not-run",
    });
    const updated = await updateRouteOutcome(
      routeId,
      "failure",
      { rerouteReason: "child failed", partialWriteDetected: true },
      options,
    );
    expect(updated).toMatchObject({ outcome: "failure", partialWriteDetected: true });
    expect((await getRouteRecord(routeId, options))?.outcome).toBe("failure");
    expect(await getTaskRunReceipt(routeId, options)).toMatchObject({
      origin: "native",
      process: "failed",
      verification: "not-run",
      algorithm: "hmac-sha256-v1",
      selectedModel: "openai/gpt-5.6-terra",
      effort: "high",
      harness: "opencode",
      repoTags: ["c++"],
    });
    expect(await findAffinity("opencode", identity, options)).toBeUndefined();
    const stored = await readFile(options.path, "utf8");
    expect(stored).not.toContain("private-session");
    expect(stored).not.toContain("Implement the feature");
    expect(stored.trim().split("\n")).toHaveLength(3);
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
    const found = await getRouteRecord(record.routeId!, {
      path,
      env: { ...process.env, MODEL_ROUTER_DATA_DIR: root },
    });
    expect(found?.routeId).toBe(record.routeId);
  });

  it("imports changed legacy JSONL records idempotently without rewriting them", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-router-state-import-"));
    const path = join(root, "routes.jsonl");
    const routeId = newRouteId();
    const createdAt = new Date().toISOString();
    const base = {
      routeId,
      createdAt,
      updatedAt: createdAt,
      harness: "opencode",
      taskFingerprint: "legacy-task-hash",
      workspaceFingerprint: "legacy-workspace-hash",
      selectedCandidate: "legacy/model",
      reasoningEffort: "medium",
      profile: "balanced",
      outcome: "running",
      featureSummary: {
        taskType: "implementation",
        complexity: 0.4,
        risk: 0.2,
        scope: "single",
        requiredCapabilities: ["tools"],
      },
      partialWriteDetected: false,
    };
    const options = {
      path,
      env: { ...process.env, MODEL_ROUTER_DATA_DIR: root },
    };
    await writeFile(path, `${JSON.stringify(base)}\n`, { mode: 0o600 });
    expect((await getRouteRecord(routeId, options))?.outcome).toBe("running");
    expect(await getTaskRunReceipt(routeId, options)).toMatchObject({
      process: "running",
      algorithm: "legacy-sha256-v0",
      taskFingerprint: "legacy-sha256-v0:legacy-task-hash",
    });

    const completed = {
      ...base,
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
      outcome: "success",
    };
    await writeFile(path, `${JSON.stringify(base)}\n${JSON.stringify(completed)}\n`, {
      mode: 0o600,
    });
    expect(await getTaskRunReceipt(routeId, options)).toMatchObject({
      process: "completed",
      verification: "not-run",
    });
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("keeps authoritative JSONL reads available when the telemetry database cannot open", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-router-state-telemetry-failure-"));
    const path = join(root, "routes.jsonl");
    const routeId = newRouteId();
    const record = {
      routeId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      harness: "opencode",
      taskFingerprint: "task-hash",
      workspaceFingerprint: "workspace-hash",
      profile: "balanced",
      outcome: "planned",
      featureSummary: {},
      partialWriteDetected: false,
    };
    await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await expect(
      getRouteRecord(routeId, {
        path,
        databasePath: root,
        env: { ...process.env, MODEL_ROUTER_DATA_DIR: root },
      }),
    ).resolves.toMatchObject({
      routeId,
      outcome: "planned",
    });
  });
});

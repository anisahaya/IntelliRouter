import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutoRouteDecision } from "@model-router/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistDecision, routeIdentity } from "../../../apps/mcp-server/src/route-state.js";
import { initConfig } from "../src/config-init.js";
import { doctor } from "../src/doctor.js";
import { explainRoute } from "../src/explain.js";
import { submitFeedback } from "../src/feedback.js";
import { controlRequest } from "../src/http.js";
import { nativeHistory, nativeStats } from "../src/native-state.js";
import { routeTask } from "../src/route.js";
import { getStats } from "../src/stats.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MODEL_ROUTER_BASE_URL;
  delete process.env.MODEL_ROUTER_AUTH_TOKEN;
  delete process.env.DOCTOR_MISSING_KEY;
  delete process.env.MODEL_ROUTER_STATE_PATH;
});

describe("CLI clients", () => {
  it("sends route, stats, feedback, and explain options", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    process.env.MODEL_ROUTER_BASE_URL = "http://router/";
    process.env.MODEL_ROUTER_AUTH_TOKEN = "secret";
    await routeTask("task", "custom", { protocol: "openai-responses", model: "a" });
    await getStats("1h", "a", "code");
    await submitFeedback("r1", "success", 1, ["accepted"]);
    await explainRoute("r1");
    expect(calls).toHaveLength(4);
    expect(calls[0]?.url).toBe("http://router/router/route");
    expect(calls[1]?.url).toContain("model=a");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer secret");
  });

  it("handles non-json errors and absolute since values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("plain failure", { status: 502 })),
    );
    await expect(controlRequest("/bad")).rejects.toThrow("plain failure");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    await getStats("2026-01-01T00:00:00Z");
  });

  it("creates a safe example config without overwriting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-cli-"));
    const path = join(directory, "router.yaml");
    expect(await initConfig(path)).toBe(path);
    const original = await readFile(path, "utf8");
    expect(original).toContain("storePrompts: false");
    await writeFile(path, "mine");
    await expect(initConfig(path)).rejects.toThrow();
  });

  it("diagnoses configuration, placeholders, missing keys, and optional probes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-doctor-"));
    const path = join(directory, "router.yaml");
    const databasePath = join(directory, "router.db");
    await writeFile(
      path,
      `server:\n  databasePath: ${databasePath}\nmodels:\n  - id: example\n    provider: openai-compatible\n    upstreamModel: provider/model\n    baseUrl: https://api.example/v1\n    apiKeyEnv: DOCTOR_MISSING_KEY\n    capabilities:\n      protocols: [openai-chat]\n      maxContextTokens: 1000\nrouting:\n  defaultProfile: balanced\n  profiles:\n    balanced:\n      weights: { quality: 0.5, cost: 0.3, latency: 0.2 }\n`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: "probe" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const result = await doctor(path, true);
    expect(result).toMatchObject({ config: "ok", database: "ok", models: 1 });
    expect(result.missingEnvironment).toContain("DOCTOR_MISSING_KEY");
    expect(result.placeholders).toHaveLength(2);
    expect(result.probes).toEqual([{ model: "example", reachable: false }]);
    process.env.DOCTOR_MISSING_KEY = "probe-key";
    expect((await doctor(path, true)).probes).toEqual([
      { model: "example", reachable: true, status: 200 },
    ]);
  });

  it("reads native history and statistics from the SQLite route store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-cli-native-"));
    process.env.MODEL_ROUTER_STATE_PATH = join(directory, "legacy.jsonl");
    const decision = {
      routeId: "3ac7206b-3d86-4eb4-a240-f9f07852568b",
      harness: "opencode",
      affinityReused: false,
      status: "planned",
      selected: {
        id: "candidate-a",
        kind: "harness-model",
        displayName: "A",
        execution: "opencode-run",
      },
      profile: "balanced",
      taskProfile: {
        taskType: "implementation",
        complexity: 0.5,
        ambiguity: 0.2,
        risk: 0.2,
        mechanical: 0.3,
        scope: "single",
        toolsRequired: true,
        visionRequired: false,
        searchRequired: false,
        editRequired: true,
        estimatedContextTokens: 100,
        desiredEffort: "medium",
        repoTags: [],
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
    } satisfies AutoRouteDecision;
    await persistDecision(
      decision,
      routeIdentity({ harness: "opencode", objective: "private", workspaceRoot: "/tmp/private" }),
    );
    expect(await nativeHistory({ harness: "opencode" })).toHaveLength(1);
    expect(await nativeStats({ harness: "opencode" })).toMatchObject({
      totalRoutes: 1,
      activeRoutes: 1,
      byHarness: { opencode: 1 },
    });
  });
});

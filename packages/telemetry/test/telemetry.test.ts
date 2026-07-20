import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessRouteRecord, RouteDecision } from "@model-router/contracts";
import { redactValue, TelemetryStore } from "@model-router/telemetry";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const decision: RouteDecision = {
  id: "r1",
  requestId: "req1",
  logicalModel: "cheap",
  upstreamModel: "upstream",
  profile: "balanced",
  features: {
    taskType: "code",
    hasCode: true,
    agentic: true,
    reasoningIntensity: "medium",
    estimatedInputTokens: 12,
  },
  candidates: [
    {
      modelId: "cheap",
      eligible: true,
      exclusionReasons: [],
      scores: { quality: 1, cost: 1, latency: 1, feedback: 0, total: 1 },
    },
  ],
  fallbackChain: [],
  affinityUsed: false,
  createdAt: new Date().toISOString(),
};

function nativeRecord(
  routeId: string,
  outcome: HarnessRouteRecord["outcome"],
  affinityExpiresAt?: string,
): HarnessRouteRecord {
  return {
    routeId,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    harness: "opencode",
    taskFingerprint: "task-hash",
    workspaceFingerprint: "workspace-hash",
    affinityExpiresAt,
    confidence: {
      score: 0.7,
      level: "medium",
      winnerMargin: 0.2,
      evidenceSources: ["catalog"],
      sampleSize: 1,
      abstained: false,
      reasons: [],
    },
    selectedCandidate: "candidate-a",
    profile: "balanced",
    outcome,
    featureSummary: {
      taskType: "implementation",
      complexity: 0.5,
      risk: 0.2,
      scope: "single",
      requiredCapabilities: ["tools"],
    },
    attempts: [],
    feedback: [],
    healthWindows: [],
    partialWriteDetected: false,
  };
}

describe("telemetry", () => {
  it("redacts nested secrets and URL query secrets case-insensitively", () => {
    const result = redactValue({
      Authorization: "Bearer secret",
      nested: { apiKey: "secret" },
      url: "https://x.test?a=1&token=secret",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).toContain("%5BREDACTED%5D");
  });

  it("stores explanations, metrics and feedback without raw content", () => {
    const store = new TelemetryStore(":memory:");
    store.saveDecision(decision);
    store.recordMetric({ routeId: "r1", status: 200, latencyMs: 25, estimatedCostUsd: 0.01 });
    store.recordFeedback({ routeId: "r1", outcome: "success", tags: [] });
    expect(store.getDecision("r1")?.logicalModel).toBe("cheap");
    expect(store.getStats().successfulRequests).toBe(1);
    expect(store.metricsFor("cheap", "code").feedbackPrior).toBeGreaterThan(0);
    const schema = store.database.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all();
    expect(JSON.stringify(schema)).not.toMatch(/prompt|response_text|raw_content/i);
    store.close();
  });

  it("preserves candidate rank and exposes privacy-safe observed sample aggregates", () => {
    const store = new TelemetryStore(":memory:");
    store.saveDecision({
      ...decision,
      candidates: [
        { ...decision.candidates[0]!, modelId: "z-first" },
        { ...decision.candidates[0]!, modelId: "a-second" },
      ],
    });
    store.recordAttempt({
      routeId: "r1",
      modelId: "z-first",
      attemptOrder: 1,
      outcome: "success",
      status: 200,
      latencyMs: 20,
    });
    store.recordFeedback({ routeId: "r1", outcome: "success", tags: ["useful"] });
    expect(store.getDecision("r1")?.candidates.map((item) => item.modelId)).toEqual([
      "z-first",
      "a-second",
    ]);
    expect(store.autoMetricsFor("z-first", "code")).toMatchObject({
      successRate: 1,
      averageLatencyMs: 20,
      attemptSamples: 1,
      feedbackSamples: 0,
    });
    expect(store.autoMetricsFor("cheap", "code")).toMatchObject({
      attemptSamples: 0,
      feedbackSamples: 1,
      feedbackPrior: 1,
    });
    const serialized = JSON.stringify(store.autoMetricsFor("cheap", "code"));
    expect(serialized).not.toMatch(/prompt|objective|conversation|secret/i);
    store.close();
  });

  it("persists an installation salt and separates dry runs from request stats", () => {
    const store = new TelemetryStore(":memory:");
    expect(store.sessionSalt()).toBe(store.sessionSalt());
    store.saveDecision({ ...decision, id: "dry", kind: "dry_run" });
    store.saveDecision({ ...decision, id: "request", kind: "compatibility" });
    store.recordAttempt({
      routeId: "request",
      modelId: "cheap",
      attemptOrder: 1,
      outcome: "failure",
      errorClass: "timeout",
      status: 504,
      latencyMs: 10,
    });
    store.recordAttempt({
      routeId: "request",
      modelId: "cheap",
      attemptOrder: 2,
      outcome: "success",
      status: 200,
      latencyMs: 5,
    });
    store.recordMetric({
      routeId: "request",
      status: 200,
      latencyMs: 15,
      outcome: "success",
      finalModel: "cheap",
      fallbackCount: 1,
    });
    const stats = store.getStats();
    expect(stats.totalRequests).toBe(1);
    expect(stats.totalAttempts).toBe(2);
    expect(stats.fallbackAttempts).toBe(1);
    expect(stats.byOutcome).toEqual({ success: 1 });
    store.close();
  });

  it("opens and recovers model health and prunes expired affinity", () => {
    const store = new TelemetryStore(":memory:");
    store.configureHealth({ minimumObservations: 1, cooldownSeconds: 1 });
    store.saveDecision({ ...decision, id: "health" });
    store.recordAttempt({
      routeId: "health",
      modelId: "cheap",
      attemptOrder: 1,
      outcome: "failure",
      errorClass: "auth",
      status: 401,
      latencyMs: 1,
    });
    store.observeAttempt("cheap", false, 1, "auth");
    expect(store.isHealthy("cheap")).toBe(false);
    store.setHealth("cheap", true, 2);
    expect(store.isHealthy("cheap")).toBe(true);
    store.setAffinity("expired", "cheap", Date.now() - 1);
    expect(store.getAffinity("expired")).toBeUndefined();
    store.close();
  });

  it("uses only the exact qualifying health window and deterministic recovery", () => {
    let now = 1_000;
    const store = new TelemetryStore(":memory:", { now: () => now });
    store.configureHealth({
      windowSize: 3,
      minimumObservations: 2,
      failureThreshold: 0.6,
      cooldownSeconds: 30,
    });
    const add = (id: string, outcome: "success" | "failure" | "canceled", errorClass?: string) => {
      store.saveDecision({ ...decision, id });
      store.recordAttempt({
        routeId: id,
        modelId: "windowed",
        attemptOrder: 1,
        outcome,
        errorClass,
        status: outcome === "success" ? 200 : 500,
        latencyMs: 10,
      });
      store.observeAttempt("windowed", outcome === "success", 10, errorClass);
    };
    add("client", "canceled", "client");
    expect(store.healthStatus("windowed").state).toBe("unknown");
    add("failure-1", "failure", "timeout");
    expect(store.healthStatus("windowed").state).toBe("unknown");
    add("failure-2", "failure", "network");
    expect(store.isHealthy("windowed")).toBe(false);
    now += 30_001;
    expect(store.isHealthy("windowed")).toBe(true);
    expect(store.healthStatus("windowed").state).toBe("recovering");
    add("recovery-failure", "failure", "timeout");
    expect(store.isHealthy("windowed")).toBe(false);
    now += 30_001;
    expect(store.isHealthy("windowed")).toBe(true);
    add("recovery-success", "success");
    expect(store.healthStatus("windowed")).toMatchObject({
      state: "healthy",
      recentFailureRate: 0,
    });
    add("after-reset", "success");
    expect(store.healthStatus("windowed")).toMatchObject({
      state: "healthy",
      recentFailureRate: 0,
    });
    store.close();
  });

  it("opens immediately for auth/model errors and honors manual probe override", () => {
    const store = new TelemetryStore(":memory:");
    for (const errorClass of ["auth", "model_not_found"] as const) {
      const id = `route-${errorClass}`;
      store.saveDecision({ ...decision, id });
      store.recordAttempt({
        routeId: id,
        modelId: errorClass,
        attemptOrder: 1,
        outcome: "failure",
        errorClass,
        status: 401,
        latencyMs: 2,
      });
      store.observeAttempt(errorClass, false, 2, errorClass);
      expect(store.isHealthy(errorClass)).toBe(false);
      store.setHealth(errorClass, true, 1);
      expect(store.healthStatus(errorClass)).toMatchObject({
        state: "healthy",
        recentFailureRate: 0,
      });
    }
    store.close();
  });

  it("retains queued native jobs and live affinity while pruning terminal history", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const store = new TelemetryStore(":memory:", { now: () => now });
    const expired = "11111111-1111-4111-8111-111111111111";
    const queued = "22222222-2222-4222-8222-222222222222";
    const affinity = "33333333-3333-4333-8333-333333333333";
    store.saveNativeRoute(nativeRecord(expired, "failure"));
    store.saveNativeRoute(nativeRecord(queued, "success"));
    store.saveNativeRoute(nativeRecord(affinity, "success", "2026-01-01T00:01:00.000Z"));
    store.database
      .prepare(
        "INSERT INTO native_route_jobs(job_id, route_id, status, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("job-1", queued, "queued", "2025-01-01T00:00:00.000Z");
    expect(store.pruneNativeRoutes({ before: "2025-02-01T00:00:00.000Z", now })).toBe(1);
    expect(store.getNativeRoute(expired)).toBeUndefined();
    expect(store.getNativeRoute(queued)).toBeDefined();
    expect(store.getNativeRoute(affinity)).toBeDefined();
    store.close();
  });

  it("migrates a populated v1 database additively and idempotently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-v1-"));
    const path = join(directory, "router.db");
    const v1 = new Database(path);
    v1.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, '2025-01-01T00:00:00.000Z');
      CREATE TABLE route_decisions(id TEXT PRIMARY KEY, request_id TEXT NOT NULL, logical_model TEXT NOT NULL,
        upstream_model TEXT NOT NULL, profile TEXT NOT NULL, task_type TEXT NOT NULL, features_json TEXT NOT NULL,
        fallback_chain_json TEXT NOT NULL, affinity_used INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE route_candidates(route_id TEXT NOT NULL, model_id TEXT NOT NULL, eligible INTEGER NOT NULL,
        exclusions_json TEXT NOT NULL, scores_json TEXT NOT NULL, PRIMARY KEY(route_id, model_id));
      CREATE TABLE request_metrics(route_id TEXT PRIMARY KEY, status INTEGER NOT NULL, latency_ms REAL NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0, provider_request_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE feedback_events(id INTEGER PRIMARY KEY AUTOINCREMENT, route_id TEXT NOT NULL, outcome TEXT NOT NULL,
        score REAL, tags_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE model_health_windows(model_id TEXT PRIMARY KEY, healthy INTEGER NOT NULL DEFAULT 1,
        average_latency_ms REAL NOT NULL DEFAULT 500, failures INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
      CREATE TABLE session_affinity(session_hash TEXT PRIMARY KEY, model_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      INSERT INTO route_decisions VALUES ('served','req','cheap','upstream','balanced','code','{"taskType":"code","hasCode":true,"agentic":false,"reasoningIntensity":"low","estimatedInputTokens":3}','["failed"]',0,'2025-01-01T00:00:00.000Z');
      INSERT INTO route_decisions VALUES ('dry','req2','cheap','upstream','balanced','code','{"taskType":"code","hasCode":true,"agentic":false,"reasoningIntensity":"low","estimatedInputTokens":3}','[]',0,'2025-01-01T00:00:01.000Z');
      INSERT INTO route_candidates VALUES ('served','cheap',1,'[]','{"quality":1,"cost":1,"latency":1,"feedback":0,"total":1}');
      INSERT INTO request_metrics VALUES ('served',503,12,3,1,0.01,'provider-id','2025-01-01T00:00:02.000Z');
      INSERT INTO feedback_events(route_id,outcome,score,tags_json,created_at) VALUES ('served','failure',0.2,'["kept"]','2025-01-01T00:00:03.000Z');
      INSERT INTO session_affinity VALUES ('hash','cheap',9999999999999);
    `);
    v1.close();
    const migrated = new TelemetryStore(path);
    expect(migrated.getDecision("served")?.candidates).toHaveLength(1);
    const metric = migrated.database
      .prepare(
        "SELECT outcome, final_model, fallback_count FROM request_metrics WHERE route_id='served'",
      )
      .get();
    expect(metric).toEqual({ outcome: "failure", final_model: "cheap", fallback_count: 1 });
    expect(
      migrated.database.prepare("SELECT kind FROM route_decisions WHERE id='served'").pluck().get(),
    ).toBe("compatibility");
    expect(
      migrated.database.prepare("SELECT kind FROM route_decisions WHERE id='dry'").pluck().get(),
    ).toBe("legacy");
    expect(migrated.database.prepare("SELECT tags_json FROM feedback_events").pluck().get()).toBe(
      '["kept"]',
    );
    expect(migrated.getAffinity("hash")).toBe("cheap");
    const indexes = migrated.database
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .pluck()
      .all() as string[];
    expect(indexes).toContain("idx_metrics_outcome_created");
    expect(indexes).toContain("idx_health_state_updated");
    expect(() =>
      migrated.recordAttempt({
        routeId: "missing",
        modelId: "x",
        attemptOrder: 1,
        outcome: "failure",
        status: 500,
        latencyMs: 1,
      }),
    ).toThrow();
    migrated.close();
    const reopened = new TelemetryStore(path);
    expect(
      reopened.database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get(),
    ).toBe(8);
    expect(reopened.getDecision("served")?.logicalModel).toBe("cheap");
    reopened.close();
  });
});

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/migrations.js";
import { type TaskRunPrivacyPolicy, TaskRunStore } from "../src/task-runs.js";

function taskStore(privacy: TaskRunPrivacyPolicy = {}): {
  database: Database.Database;
  store: TaskRunStore;
} {
  const database = new Database(":memory:");
  migrate(database);
  return { database, store: new TaskRunStore(database, "installation-salt", privacy) };
}

describe("task-run receipts and measurements", () => {
  it("redacts secrets from opt-in prompt, response, and source content", () => {
    const { database, store } = taskStore({
      storePrompts: true,
      storeResponses: true,
      storeSource: true,
    });
    store.createRun({
      routeId: "redaction",
      origin: "compatibility",
      taskFingerprint: store.fingerprint("t", "t"),
    });
    const values = [
      "Bearer bearer-secret token=tok-secret api_key=api-secret",
      '{"password":"pw secret with spaces","credential":"cred-secret"}',
      "https://example.test/?cookie=cookie-secret&credential=cred-secret",
    ];
    const kinds = ["prompt", "response", "source"] as const;
    for (const [index, value] of values.entries())
      expect(
        store.content("redaction", kinds[index]!, value, {
          enabled: true,
        }),
      ).toBe(true);
    const rows = database
      .prepare(
        "SELECT content FROM task_run_content WHERE run_id=(SELECT id FROM task_runs WHERE route_id='redaction')",
      )
      .all() as Array<{ content: string }>;
    const joined = rows.map((row) => row.content).join("\n");
    for (const secret of [
      "pw-secret",
      "tok-secret",
      "bearer-secret",
      "api-secret",
      "pw secret with spaces",
      "cookie-secret",
      "cred-secret",
    ])
      expect(joined).not.toContain(secret);
    database.close();
  });
  it("keeps process completion separate from verification and exposes only safe aggregates", () => {
    const { database, store } = taskStore({ storeResponses: true });
    store.createRun({
      routeId: "route-safe",
      origin: "native",
      taskFingerprint: store.fingerprint("task", "task"),
      workspaceFingerprint: store.fingerprint("workspace", "workspace"),
      selectedModel: "model-safe",
      effort: "high",
      harness: "codex",
      profile: "balanced",
      derivedFeatures: { taskType: "implementation", complexity: 0.7 },
      repoTags: ["typescript"],
      context: { estimatedTokens: 2000 },
      cache: { status: "unknown" },
    });
    store.recordAttempt("route-safe", {
      attemptOrder: 1,
      model: "model-safe",
      harness: "codex",
      effort: "high",
      outcome: "completed",
      retry: false,
      fallback: false,
      inputTokens: 10,
      outputTokens: 4,
      tokenBasis: "actual",
      latencyMs: 25,
      costUsd: 0.02,
      costBasis: "estimated",
      pricingProvenance: "local-config",
      partialWriteDetected: false,
      safeToFallback: true,
    });
    store.completeProcess("route-safe", "completed", {
      latencyMs: 25,
      finalModel: "model-safe",
    });
    expect(
      store.content("route-safe", "response", "token=private-secret-value", { enabled: true }),
    ).toBe(true);

    const receipt = store.receipt("route-safe");
    expect(receipt).toMatchObject({
      process: "completed",
      verification: "not-run",
      labelValue: "unknown",
      labelStrength: "operational",
      selectedModel: "model-safe",
      effort: "high",
      harness: "codex",
      inputTokens: 10,
      outputTokens: 4,
      tokenBasis: "actual",
      latencyMs: 25,
      costBasis: "estimated",
      retryCount: 0,
      fallbackCount: 0,
      context: { estimatedTokens: 2000 },
      cache: { status: "unknown" },
    });
    expect(receipt?.processCompletedAt).toBeTruthy();
    const serialized = JSON.stringify(receipt);
    for (const forbidden of [
      "private-secret-value",
      "provider_request_id",
      "childSessionId",
      "command",
      "externalId",
    ])
      expect(serialized).not.toContain(forbidden);
    database.close();
  });

  it("updates attempts idempotently and computes conservative aggregate bases", () => {
    const { database, store } = taskStore();
    store.createRun({
      routeId: "route-attempts",
      origin: "compatibility",
      taskFingerprint: store.fingerprint("task", "task"),
    });
    store.recordAttempt("route-attempts", {
      attemptOrder: 1,
      model: "first",
      outcome: "failed",
      retry: false,
      fallback: false,
      inputTokens: 2,
      outputTokens: 1,
      tokenBasis: "actual",
      latencyMs: 10,
      costUsd: 0.1,
      costBasis: "estimated",
      partialWriteDetected: false,
      safeToFallback: true,
    });
    store.recordAttempt("route-attempts", {
      attemptOrder: 2,
      model: "second",
      outcome: "completed",
      retry: true,
      fallback: true,
      tokenBasis: "unknown",
      latencyMs: 5,
      costBasis: "unknown",
      partialWriteDetected: false,
      safeToFallback: true,
    });
    expect(store.receipt("route-attempts")).toMatchObject({
      inputTokens: 2,
      outputTokens: 1,
      tokenBasis: "unknown",
      latencyMs: 15,
      costBasis: "unknown",
      retryCount: 1,
      fallbackCount: 1,
      attemptCount: 2,
    });

    store.recordAttempt("route-attempts", {
      attemptOrder: 2,
      model: "second",
      outcome: "completed",
      retry: true,
      fallback: true,
      inputTokens: 3,
      outputTokens: 4,
      tokenBasis: "actual",
      latencyMs: 6,
      costUsd: 0.2,
      costBasis: "estimated",
      partialWriteDetected: false,
      safeToFallback: true,
    });
    expect(store.receipt("route-attempts")).toMatchObject({
      inputTokens: 5,
      outputTokens: 5,
      tokenBasis: "actual",
      latencyMs: 16,
      costBasis: "estimated",
      attemptCount: 2,
    });
    expect(store.receipt("route-attempts")?.costUsd).toBeCloseTo(0.3);
    database.close();
  });
});

describe("task-run evidence semantics", () => {
  it("maps feedback dispositions without treating non-correctness abandonment as failure", () => {
    const { database, store } = taskStore();
    const create = (routeId: string) => {
      store.createRun({
        routeId,
        origin: "native",
        taskFingerprint: store.fingerprint(routeId, "task"),
      });
      store.completeProcess(routeId, "completed");
    };
    create("accepted");
    store.event("accepted", "feedback", {
      outcome: "success",
      reasonCategory: "unknown",
    });
    expect(store.receipt("accepted")).toMatchObject({
      disposition: "accepted",
      labelValue: "correct",
      labelStrength: "attested",
    });

    create("failed");
    store.event("failed", "feedback", {
      outcome: "failure",
      reasonCategory: "correctness",
    });
    expect(store.receipt("failed")).toMatchObject({
      labelValue: "incorrect",
      labelStrength: "attested",
    });

    create("corrected");
    store.event("corrected", "feedback", {
      outcome: "corrected",
      reasonCategory: "correctness",
    });
    expect(store.receipt("corrected")).toMatchObject({
      disposition: "corrected",
      labelValue: "incorrect",
      labelStrength: "attested",
    });

    create("reverted");
    store.event("reverted", "feedback", {
      outcome: "reverted",
      reasonCategory: "correctness",
    });
    expect(store.receipt("reverted")).toMatchObject({
      disposition: "reverted",
      labelValue: "incorrect",
      labelStrength: "attested",
    });

    create("abandoned-choice");
    store.event("abandoned-choice", "feedback", {
      outcome: "abandoned",
      reasonCategory: "user-choice",
    });
    expect(store.receipt("abandoned-choice")).toMatchObject({
      disposition: "abandoned",
      labelValue: "unknown",
      labelStrength: "operational",
    });

    create("abandoned-correctness");
    store.event("abandoned-correctness", "feedback", {
      outcome: "abandoned",
      reasonCategory: "instruction",
    });
    expect(store.receipt("abandoned-correctness")).toMatchObject({
      disposition: "abandoned",
      labelValue: "incorrect",
      labelStrength: "attested",
    });
    database.close();
  });

  it("retains verified strength for conflicting checks and ignores exact repeats", () => {
    const { database, store } = taskStore();
    store.createRun({
      routeId: "verified",
      origin: "evaluation",
      taskFingerprint: store.fingerprint("verified", "task"),
    });
    store.completeProcess("verified", "completed");
    store.verify("verified", {
      kind: "held-out-test",
      result: "passed",
      checkName: "hidden-suite",
      evidenceHash: "sha256:pass",
    });
    store.verify("verified", {
      kind: "held-out-test",
      result: "passed",
      checkName: "hidden-suite",
      evidenceHash: "sha256:pass",
    });
    expect(store.receipt("verified")).toMatchObject({
      verification: "passed",
      verificationCount: 1,
      labelValue: "correct",
      labelStrength: "verified",
    });

    store.verify("verified", {
      kind: "held-out-test",
      result: "failed",
      checkName: "hidden-suite",
      evidenceHash: "sha256:fail",
    });
    expect(store.receipt("verified")).toMatchObject({
      verification: "inconclusive",
      verificationCount: 2,
      labelValue: "mixed",
      labelStrength: "verified",
    });
    const stored = database
      .prepare("SELECT check_name_hmac FROM task_run_verifications")
      .pluck()
      .all() as string[];
    expect(stored).not.toContain("hidden-suite");

    store.createRun({
      routeId: "inconclusive-only",
      origin: "evaluation",
      taskFingerprint: store.fingerprint("inconclusive-only", "task"),
    });
    store.completeProcess("inconclusive-only", "completed");
    store.verify("inconclusive-only", {
      kind: "held-out-test",
      result: "inconclusive",
      checkName: "unavailable-suite",
    });
    expect(store.receipt("inconclusive-only")).toMatchObject({
      verification: "inconclusive",
      verificationCount: 1,
      labelValue: "unknown",
      labelStrength: "operational",
    });
    database.close();
  });
});

describe("task-run privacy controls", () => {
  it("uses configured opt-in content bounds and retention defaults", () => {
    const database = new Database(":memory:");
    migrate(database);
    const store = new TaskRunStore(database, "installation-salt", {
      storePrompts: true,
      contentMaxItemBytes: 4,
      contentMaxRunBytes: 4,
      contentMaxTotalBytes: 4,
      contentRetentionDays: 2,
    });
    store.createRun({
      routeId: "configured-content",
      origin: "evaluation",
      taskFingerprint: store.fingerprint("configured-content", "task"),
    });

    expect(
      store.content("configured-content", "prompt", "abcdef", {
        enabled: true,
        maxItemBytes: 100,
        maxRunBytes: 100,
        maxTotalBytes: 100,
        retentionDays: 100,
      }),
    ).toBe(true);
    expect(store.content("configured-content", "response", "disabled")).toBe(false);
    const row = database
      .prepare("SELECT content, stored_bytes, expires_at, created_at FROM task_run_content")
      .get() as {
      content: string;
      stored_bytes: number;
      expires_at: string;
      created_at: string;
    };
    expect(row.content).toBe("abcd");
    expect(row.stored_bytes).toBe(4);
    expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBe(2 * 86_400_000);
    database.close();
  });

  it("redacts secrets, truncates on UTF-8 boundaries, enforces caps, and prunes expiry", () => {
    const { database, store } = taskStore({
      storePrompts: true,
      storeResponses: true,
      storeSource: true,
      contentMaxItemBytes: 20,
      contentMaxRunBytes: 24,
      contentMaxTotalBytes: 24,
      contentRetentionDays: 1,
    });
    store.createRun({
      routeId: "content",
      origin: "evaluation",
      taskFingerprint: store.fingerprint("content", "task"),
    });
    expect(
      store.content("content", "prompt", "token=supersecretvalue 😀😀😀", {
        enabled: true,
        maxItemBytes: 20,
        maxRunBytes: 24,
        maxTotalBytes: 24,
        retentionDays: 1,
      }),
    ).toBe(true);
    const row = database
      .prepare("SELECT content,stored_bytes,original_hmac FROM task_run_content")
      .get() as { content: string; stored_bytes: number; original_hmac: string };
    expect(row.content).not.toContain("supersecretvalue");
    expect(row.stored_bytes).toBe(Buffer.byteLength(row.content, "utf8"));
    expect(row.stored_bytes).toBeLessThanOrEqual(20);
    expect(row.original_hmac).not.toContain("supersecretvalue");

    expect(
      store.content("content", "response", "1234567890", {
        enabled: true,
        maxItemBytes: 10,
        maxRunBytes: 24,
        maxTotalBytes: 24,
        retentionDays: 1,
      }),
    ).toBe(false);
    database.prepare("UPDATE task_run_content SET expires_at='2000-01-01T00:00:00.000Z'").run();
    expect(
      store.content("content", "source", "safe", {
        enabled: true,
        maxItemBytes: 10,
        maxRunBytes: 24,
        maxTotalBytes: 24,
        retentionDays: 1,
      }),
    ).toBe(true);
    expect(database.prepare("SELECT COUNT(*) FROM task_run_content").pluck().get()).toBe(1);
    database.close();
  });

  it("rejects invalid local embeddings and persists only explicit local values", () => {
    const { database, store } = taskStore({ storeEmbeddings: true });
    store.createRun({
      routeId: "embedding",
      origin: "evaluation",
      taskFingerprint: store.fingerprint("embedding", "task"),
    });
    expect(
      store.embedding(
        "embedding",
        {
          locallyGenerated: true,
          normalized: true,
          model: "local-model",
          dimensions: 2,
          values: [0.5, 0.5],
        },
        false,
      ),
    ).toBe(false);
    expect(() =>
      store.embedding(
        "embedding",
        {
          locallyGenerated: true,
          normalized: true,
          model: "local-model",
          dimensions: 2,
          values: [Number.NaN, 1],
        },
        true,
      ),
    ).toThrow();
    expect(
      store.embedding(
        "embedding",
        {
          locallyGenerated: true,
          normalized: true,
          model: "local-model",
          dimensions: 2,
          values: [0.5, 0.5],
        },
        true,
      ),
    ).toBe(true);
    expect(database.prepare("SELECT normalized FROM task_run_embeddings").pluck().get()).toBe(1);
    database.close();
  });

  it("does not let per-call flags widen disabled content or embedding settings", () => {
    const { database, store } = taskStore();
    store.createRun({
      routeId: "privacy-bypass",
      origin: "evaluation",
      taskFingerprint: store.fingerprint("privacy-bypass", "task"),
    });
    expect(store.content("privacy-bypass", "prompt", "must-not-persist", { enabled: true })).toBe(
      false,
    );
    expect(
      store.embedding(
        "privacy-bypass",
        {
          locallyGenerated: true,
          normalized: true,
          model: "local-model",
          dimensions: 1,
          values: [1],
        },
        true,
      ),
    ).toBe(false);
    expect(database.prepare("SELECT COUNT(*) FROM task_run_content").pluck().get()).toBe(0);
    expect(database.prepare("SELECT COUNT(*) FROM task_run_embeddings").pluck().get()).toBe(0);
    database.close();
  });
});

describe("legacy telemetry backfill", () => {
  it("maps process, attempts, costs, and feedback idempotently from a v5 database", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (5, '2025-01-01T00:00:00.000Z');
      CREATE TABLE route_decisions(
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL, logical_model TEXT NOT NULL,
        upstream_model TEXT NOT NULL, profile TEXT NOT NULL, task_type TEXT NOT NULL,
        features_json TEXT NOT NULL, fallback_chain_json TEXT NOT NULL,
        affinity_used INTEGER NOT NULL, created_at TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'legacy'
      );
      CREATE TABLE request_metrics(
        route_id TEXT PRIMARY KEY, status INTEGER NOT NULL, latency_ms REAL NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0, provider_request_id TEXT,
        created_at TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'success',
        final_model TEXT, fallback_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE provider_attempts(
        id INTEGER PRIMARY KEY AUTOINCREMENT, route_id TEXT NOT NULL,
        attempt_order INTEGER NOT NULL, model_id TEXT NOT NULL, outcome TEXT NOT NULL,
        error_class TEXT, status INTEGER, latency_ms REAL NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0, provider_request_id TEXT,
        bytes_emitted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        UNIQUE(route_id, attempt_order)
      );
      CREATE TABLE feedback_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, route_id TEXT NOT NULL, outcome TEXT NOT NULL,
        score REAL, tags_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE installation_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO route_decisions VALUES
        ('ok','req1','m1','u1','balanced','code','{"taskType":"code"}','[]',0,'2025-01-01T00:00:00.000Z','compatibility'),
        ('bad','req2','m2','u2','balanced','code','{"taskType":"code"}','[]',0,'2025-01-01T00:00:00.000Z','compatibility'),
        ('cancel','req3','m3','u3','balanced','code','{"taskType":"code"}','[]',0,'2025-01-01T00:00:00.000Z','compatibility');
      INSERT INTO request_metrics VALUES
        ('ok',200,20,5,2,0.03,NULL,'2025-01-01T00:01:00.000Z','success','m1',1),
        ('bad',500,8,0,0,0,NULL,'2025-01-01T00:01:00.000Z','failure','m2',0),
        ('cancel',499,4,0,0,0,NULL,'2025-01-01T00:01:00.000Z','canceled','m3',0);
      INSERT INTO provider_attempts(
        route_id,attempt_order,model_id,outcome,error_class,status,latency_ms,
        input_tokens,output_tokens,estimated_cost_usd,bytes_emitted,created_at
      ) VALUES
        ('ok',1,'m0','failure','timeout',504,10,0,0,0,0,'2025-01-01T00:00:30.000Z'),
        ('ok',2,'m1','success',NULL,200,10,5,2,0.03,0,'2025-01-01T00:01:00.000Z');
      INSERT INTO feedback_events(route_id,outcome,score,tags_json,created_at)
        VALUES ('ok','success',1,'["accepted"]','2025-01-01T00:02:00.000Z');
    `);
    migrate(database);
    const first = new TaskRunStore(database, "installation-salt");
    expect(first.receipt("ok")).toMatchObject({
      process: "completed",
      labelValue: "correct",
      labelStrength: "attested",
      attemptCount: 2,
      retryCount: 1,
      fallbackCount: 1,
    });
    expect(first.receipt("bad")).toMatchObject({
      process: "failed",
      tokenBasis: "unknown",
    });
    expect(first.receipt("cancel")).toMatchObject({ process: "canceled" });
    const counts = {
      attempts: database.prepare("SELECT COUNT(*) FROM task_run_attempts").pluck().get(),
      events: database.prepare("SELECT COUNT(*) FROM task_run_events").pluck().get(),
    };
    const reopened = new TaskRunStore(database, "installation-salt");
    expect(reopened.receipt("ok")?.taskFingerprint).toMatch(/^hmac-sha256-v1:/);
    expect(database.prepare("SELECT COUNT(*) FROM task_run_attempts").pluck().get()).toBe(
      counts.attempts,
    );
    expect(database.prepare("SELECT COUNT(*) FROM task_run_events").pluck().get()).toBe(
      counts.events,
    );
    database.close();
  });
});

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AutoObservedMetrics,
  FeedbackEvent,
  HarnessRouteRecord,
  NativeRouteHistoryFilters,
  NativeRouteJob,
  NativeRouteStats,
  RouteDecision,
  RouteStats,
} from "@model-router/contracts";
import {
  harnessRouteRecordSchema,
  nativeRouteHistoryFiltersSchema,
  nativeRouteJobSchema,
} from "@model-router/contracts";
import type { ObservedModelMetrics, RouterState } from "@model-router/router-core";
import Database from "better-sqlite3";
import { migrate } from "./migrations.js";

export interface RequestMetric {
  routeId: string;
  status: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  providerRequestId?: string;
  outcome?: "success" | "failure" | "canceled";
  finalModel?: string;
  fallbackCount?: number;
}

export interface ProviderAttempt extends RequestMetric {
  modelId: string;
  attemptOrder: number;
  errorClass?: string;
  bytesEmitted?: boolean;
}

interface HealthConfig {
  windowSize: number;
  minimumObservations: number;
  failureThreshold: number;
  cooldownSeconds: number;
}

export class TelemetryStore implements RouterState {
  readonly database: Database.Database;
  readonly #now: () => number;
  #health: HealthConfig = {
    windowSize: 20,
    minimumObservations: 5,
    failureThreshold: 0.6,
    cooldownSeconds: 30,
  };

  constructor(path: string, options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path);
    this.database.pragma("journal_mode = WAL");
    migrate(this.database);
  }

  close(): void {
    this.database.close();
  }

  sessionSalt(): string {
    const existing = this.database
      .prepare("SELECT value FROM installation_metadata WHERE key = 'session_salt'")
      .get() as { value: string } | undefined;
    if (existing) return existing.value;
    const value = randomBytes(32).toString("hex");
    this.database
      .prepare("INSERT INTO installation_metadata(key, value) VALUES ('session_salt', ?)")
      .run(value);
    return value;
  }

  configureHealth(value: Partial<HealthConfig>): void {
    this.#health = { ...this.#health, ...value };
  }

  isHealthy(modelId: string): boolean {
    const row = this.database
      .prepare("SELECT state, cooldown_until FROM model_health_windows WHERE model_id = ?")
      .get(modelId) as { state: string; cooldown_until: number | null } | undefined;
    if (!row || row.state !== "unhealthy") return true;
    if (row.cooldown_until && row.cooldown_until <= this.#now()) {
      this.database
        .prepare("UPDATE model_health_windows SET state='recovering', healthy=1 WHERE model_id=?")
        .run(modelId);
      return true;
    }
    return false;
  }

  setHealth(modelId: string, healthy: boolean, latencyMs = 500): void {
    const baseline = healthy
      ? (
          this.database
            .prepare("SELECT COALESCE(MAX(id), 0) id FROM provider_attempts WHERE model_id=?")
            .get(modelId) as { id: number }
        ).id
      : 0;
    this.database
      .prepare(`
        INSERT INTO model_health_windows(model_id, healthy, average_latency_ms, failures, attempts, updated_at)
        VALUES (?, ?, ?, ?, 1, ?)
        ON CONFLICT(model_id) DO UPDATE SET healthy=excluded.healthy,
          average_latency_ms=excluded.average_latency_ms,
          failures=model_health_windows.failures + CASE WHEN excluded.healthy = 0 THEN 1 ELSE 0 END,
          attempts=model_health_windows.attempts + 1,
          updated_at=excluded.updated_at
      `)
      .run(modelId, healthy ? 1 : 0, latencyMs, healthy ? 0 : 1, new Date().toISOString());
    this.database
      .prepare("UPDATE model_health_windows SET state=?, cooldown_until=? WHERE model_id=?")
      .run(
        healthy ? "healthy" : "unhealthy",
        healthy ? null : this.#now() + this.#health.cooldownSeconds * 1000,
        modelId,
      );
    if (healthy) {
      this.database
        .prepare(`UPDATE model_health_windows SET failures=0, attempts=0,
        window_start_attempt_id=? WHERE model_id=?`)
        .run(baseline, modelId);
    }
  }

  observeAttempt(modelId: string, healthy: boolean, latencyMs: number, errorClass?: string): void {
    const qualifyingFailures = [
      "timeout",
      "network",
      "rate_limit",
      "overloaded",
      "upstream_5xx",
      "auth",
      "model_not_found",
    ];
    if (!healthy && !qualifyingFailures.includes(errorClass ?? "")) return;
    if (healthy && errorClass && errorClass !== "unknown") return;
    const prior = this.database
      .prepare(`SELECT state, window_start_attempt_id FROM model_health_windows
      WHERE model_id=?`)
      .get(modelId) as { state: string; window_start_attempt_id: number } | undefined;
    const baseline = prior?.window_start_attempt_id ?? 0;
    const recent = this.database
      .prepare(`SELECT id, outcome, error_class, latency_ms FROM provider_attempts
      WHERE model_id=? AND id > ? AND (outcome='success' OR error_class IN
      ('timeout','network','rate_limit','overloaded','upstream_5xx','auth','model_not_found'))
      ORDER BY id DESC LIMIT ?`)
      .all(modelId, baseline, this.#health.windowSize) as Array<{
      id: number;
      outcome: string;
      error_class: string | null;
      latency_ms: number;
    }>;
    if (recent.length === 0) return;
    const immediate = errorClass === "auth" || errorClass === "model_not_found";
    const failures = recent.filter((item) => item.outcome !== "success").length;
    const failureRate = failures / recent.length;
    const recoveringFailure = prior?.state === "recovering" && !healthy;
    const recoveringSuccess = prior?.state === "recovering" && healthy;
    const open =
      !recoveringSuccess &&
      (immediate ||
        recoveringFailure ||
        (recent.length >= this.#health.minimumObservations &&
          failureRate >= this.#health.failureThreshold));
    const state = open
      ? "unhealthy"
      : recoveringSuccess || failureRate === 0
        ? "healthy"
        : recent.length < this.#health.minimumObservations
          ? "unknown"
          : "degraded";
    const newBaseline = recoveringSuccess ? (recent[0]?.id ?? baseline) : baseline;
    const persistedAttempts = recoveringSuccess ? 0 : recent.length;
    const persistedFailures = recoveringSuccess ? 0 : failures;
    const averageLatency = recent.reduce((sum, item) => sum + item.latency_ms, 0) / recent.length;
    this.database
      .prepare(`INSERT INTO model_health_windows(model_id, healthy, average_latency_ms, failures,
        attempts, updated_at, state, cooldown_until, window_start_attempt_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(model_id) DO UPDATE SET healthy=excluded.healthy,
        average_latency_ms=excluded.average_latency_ms, failures=excluded.failures,
        attempts=excluded.attempts, updated_at=excluded.updated_at, state=excluded.state,
        cooldown_until=excluded.cooldown_until, window_start_attempt_id=excluded.window_start_attempt_id`)
      .run(
        modelId,
        open ? 0 : 1,
        averageLatency,
        persistedFailures,
        persistedAttempts,
        new Date(this.#now()).toISOString(),
        state,
        open ? this.#now() + this.#health.cooldownSeconds * 1000 : null,
        newBaseline,
      );
  }

  healthStatus(modelId: string): Record<string, unknown> {
    const row = this.database
      .prepare(
        "SELECT state, average_latency_ms, failures, attempts, updated_at, cooldown_until FROM model_health_windows WHERE model_id=?",
      )
      .get(modelId) as Record<string, unknown> | undefined;
    if (!row)
      return {
        state: "unknown",
        lastObservation: null,
        recentLatencyMs: 500,
        recentFailureRate: 0,
        cooldownUntil: null,
      };
    const attempts = Number(row.attempts);
    return {
      state: row.state,
      lastObservation: row.updated_at,
      recentLatencyMs: Number(row.average_latency_ms),
      recentFailureRate: attempts > 0 ? Number(row.failures) / attempts : 0,
      cooldownUntil: row.cooldown_until,
    };
  }

  metricsFor(modelId: string, taskType: string): ObservedModelMetrics {
    const health = this.database
      .prepare(
        "SELECT average_latency_ms, failures, attempts FROM model_health_windows WHERE model_id = ?",
      )
      .get(modelId) as
      | { average_latency_ms: number; failures: number; attempts: number }
      | undefined;
    const feedback = this.database
      .prepare(`
        SELECT COALESCE(AVG(CASE WHEN f.score IS NOT NULL THEN 2 * f.score - 1
          ELSE CASE f.outcome WHEN 'success' THEN 1 WHEN 'failure' THEN -1
          WHEN 'corrected' THEN -0.5 ELSE -0.25 END END), 0) AS prior
        FROM feedback_events f JOIN route_decisions r ON r.id = f.route_id
        WHERE f.id IN (SELECT MAX(id) FROM feedback_events GROUP BY route_id)
          AND r.logical_model = ? AND r.task_type = ?
      `)
      .get(modelId, taskType) as { prior: number };
    return {
      averageLatencyMs: health?.average_latency_ms ?? 500,
      failureRate: health && health.attempts > 0 ? health.failures / health.attempts : 0,
      feedbackPrior: Number(feedback.prior) * 0.1,
    };
  }

  autoMetricsFor(modelId: string, taskType: string): AutoObservedMetrics {
    const attempts = this.database
      .prepare(`SELECT COUNT(*) samples,
        COALESCE(AVG(CASE WHEN a.outcome='success' THEN 1.0 ELSE 0.0 END), 0) success_rate,
        COALESCE(AVG(a.latency_ms), 500) average_latency_ms,
        MAX(a.created_at) last_observed_at
        FROM provider_attempts a JOIN route_decisions r ON r.id=a.route_id
        WHERE a.model_id=? AND r.task_type=? AND a.outcome IN ('success','failure')`)
      .get(modelId, taskType) as {
      samples: number;
      success_rate: number;
      average_latency_ms: number;
      last_observed_at: string | null;
    };
    const feedback = this.database
      .prepare(`SELECT COUNT(*) samples,
        COALESCE(AVG(CASE WHEN f.score IS NOT NULL THEN 2 * f.score - 1
          ELSE CASE f.outcome WHEN 'success' THEN 1 WHEN 'failure' THEN -1
          WHEN 'corrected' THEN -0.5 ELSE -0.25 END END), 0) prior,
        MAX(f.created_at) last_observed_at
        FROM feedback_events f JOIN route_decisions r ON r.id=f.route_id
        WHERE f.id IN (SELECT MAX(id) FROM feedback_events GROUP BY route_id)
          AND r.logical_model=? AND r.task_type=?`)
      .get(modelId, taskType) as {
      samples: number;
      prior: number;
      last_observed_at: string | null;
    };
    const latest = [attempts.last_observed_at, feedback.last_observed_at]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1);
    return {
      successRate: Number(attempts.success_rate),
      averageLatencyMs: Number(attempts.average_latency_ms),
      feedbackPrior: Number(feedback.prior),
      attemptSamples: Number(attempts.samples),
      feedbackSamples: Number(feedback.samples),
      lastObservedAt: latest,
    };
  }

  saveDecision(decision: RouteDecision): void {
    this.database.transaction(() => {
      this.database
        .prepare(`INSERT INTO route_decisions
          (id, request_id, logical_model, upstream_model, profile, task_type, features_json,
           fallback_chain_json, affinity_used, created_at, kind)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          decision.id,
          decision.requestId,
          decision.logicalModel,
          decision.upstreamModel,
          decision.profile,
          decision.features.taskType,
          JSON.stringify(decision.features),
          JSON.stringify(decision.fallbackChain),
          decision.affinityUsed ? 1 : 0,
          decision.createdAt,
          decision.kind ?? "compatibility",
        );
      const insert = this.database.prepare(`INSERT INTO route_candidates
        (route_id, model_id, eligible, exclusions_json, scores_json, rank_index)
        VALUES (?, ?, ?, ?, ?, ?)`);
      for (const [rankIndex, candidate] of decision.candidates.entries()) {
        insert.run(
          decision.id,
          candidate.modelId,
          candidate.eligible ? 1 : 0,
          JSON.stringify(candidate.exclusionReasons),
          JSON.stringify(candidate.scores),
          rankIndex,
        );
      }
    })();
  }

  getDecision(id: string): RouteDecision | undefined {
    const row = this.database.prepare("SELECT * FROM route_decisions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    const candidateRows = this.database
      .prepare("SELECT * FROM route_candidates WHERE route_id = ? ORDER BY rank_index, model_id")
      .all(id) as Record<string, unknown>[];
    return {
      id: String(row.id),
      requestId: String(row.request_id),
      logicalModel: String(row.logical_model),
      upstreamModel: String(row.upstream_model),
      profile: String(row.profile),
      features: JSON.parse(String(row.features_json)),
      candidates: candidateRows.map((candidate) => ({
        modelId: String(candidate.model_id),
        eligible: Boolean(candidate.eligible),
        exclusionReasons: JSON.parse(String(candidate.exclusions_json)),
        scores: JSON.parse(String(candidate.scores_json)),
      })),
      fallbackChain: JSON.parse(String(row.fallback_chain_json)),
      affinityUsed: Boolean(row.affinity_used),
      createdAt: String(row.created_at),
      kind: String(row.kind ?? "legacy") as RouteDecision["kind"],
    };
  }

  updateFallbackChain(routeId: string, chain: string[]): void {
    this.database
      .prepare("UPDATE route_decisions SET fallback_chain_json = ? WHERE id = ?")
      .run(JSON.stringify(chain), routeId);
  }

  updateDecisionModel(routeId: string, logicalModel: string, upstreamModel: string): void {
    this.database
      .prepare("UPDATE route_decisions SET logical_model = ?, upstream_model = ? WHERE id = ?")
      .run(logicalModel, upstreamModel, routeId);
  }

  recordAttempt(attempt: ProviderAttempt): void {
    this.database
      .prepare(`INSERT INTO provider_attempts
      (route_id, attempt_order, model_id, outcome, error_class, status, latency_ms, input_tokens,
       output_tokens, estimated_cost_usd, provider_request_id, bytes_emitted, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        attempt.routeId,
        attempt.attemptOrder,
        attempt.modelId,
        attempt.outcome ?? "failure",
        attempt.errorClass ?? null,
        attempt.status,
        attempt.latencyMs,
        attempt.inputTokens ?? 0,
        attempt.outputTokens ?? 0,
        attempt.estimatedCostUsd ?? 0,
        attempt.providerRequestId ?? null,
        attempt.bytesEmitted ? 1 : 0,
        new Date().toISOString(),
      );
  }

  recordMetric(metric: RequestMetric): void {
    this.database
      .prepare(`INSERT OR REPLACE INTO request_metrics
        (route_id, status, latency_ms, input_tokens, output_tokens, estimated_cost_usd,
         provider_request_id, created_at, outcome, final_model, fallback_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        metric.routeId,
        metric.status,
        metric.latencyMs,
        metric.inputTokens ?? 0,
        metric.outputTokens ?? 0,
        metric.estimatedCostUsd ?? 0,
        metric.providerRequestId ?? null,
        new Date().toISOString(),
        metric.outcome ?? (metric.status >= 200 && metric.status < 400 ? "success" : "failure"),
        metric.finalModel ?? null,
        metric.fallbackCount ?? 0,
      );
  }

  recordFeedback(event: FeedbackEvent): void {
    const exists = this.database
      .prepare("SELECT 1 FROM route_decisions WHERE id = ?")
      .get(event.routeId);
    if (!exists) throw new Error("route not found");
    this.database
      .prepare(
        "INSERT INTO feedback_events(route_id, outcome, score, tags_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        event.routeId,
        event.outcome,
        event.score ?? null,
        JSON.stringify(event.tags),
        new Date().toISOString(),
      );
  }

  getStats(filters: { since?: string; model?: string; task?: string } = {}): RouteStats {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filters.since) {
      where.push("r.created_at >= ?");
      args.push(filters.since);
    }
    if (filters.model) {
      where.push("r.logical_model = ?");
      args.push(filters.model);
    }
    if (filters.task) {
      where.push("r.task_type = ?");
      args.push(filters.task);
    }
    where.push("r.kind = 'compatibility'");
    const clause = `WHERE ${where.join(" AND ")}`;
    const aggregate = this.database
      .prepare(`SELECT COUNT(m.route_id) total,
        COALESCE(SUM(CASE WHEN m.outcome = 'success' THEN 1 ELSE 0 END), 0) successful,
        COALESCE(SUM(CASE WHEN m.outcome = 'failure' THEN 1 ELSE 0 END), 0) failed,
        COALESCE(SUM(CASE WHEN m.outcome = 'canceled' THEN 1 ELSE 0 END), 0) canceled,
        COALESCE(SUM(m.fallback_count), 0) fallbacks,
        COALESCE(SUM(m.estimated_cost_usd), 0) cost,
        COALESCE(AVG(m.latency_ms), 0) latency
        FROM route_decisions r LEFT JOIN request_metrics m ON m.route_id = r.id ${clause}`)
      .get(...args) as {
      total: number;
      successful: number;
      failed: number;
      canceled: number;
      fallbacks: number;
      cost: number;
      latency: number;
    };
    const attempts = this.database
      .prepare(
        `SELECT COUNT(*) count FROM provider_attempts a JOIN route_decisions r ON r.id=a.route_id ${clause}`,
      )
      .get(...args) as { count: number };
    const byModelRows = this.database
      .prepare(
        `SELECT r.logical_model key, COUNT(*) count FROM route_decisions r JOIN request_metrics m ON m.route_id=r.id ${clause} GROUP BY r.logical_model`,
      )
      .all(...args) as { key: string; count: number }[];
    const byTaskRows = this.database
      .prepare(
        `SELECT r.task_type key, COUNT(*) count FROM route_decisions r JOIN request_metrics m ON m.route_id=r.id ${clause} GROUP BY r.task_type`,
      )
      .all(...args) as { key: string; count: number }[];
    const byOutcomeRows = this.database
      .prepare(
        `SELECT m.outcome key, COUNT(*) count FROM request_metrics m JOIN route_decisions r ON r.id=m.route_id ${clause} GROUP BY m.outcome`,
      )
      .all(...args) as { key: string; count: number }[];
    return {
      totalRequests: aggregate.total,
      successfulRequests: aggregate.successful,
      failedRequests: aggregate.failed,
      canceledRequests: aggregate.canceled,
      totalAttempts: attempts.count,
      fallbackAttempts: aggregate.fallbacks,
      estimatedCostUsd: aggregate.cost,
      averageLatencyMs: aggregate.latency,
      byModel: Object.fromEntries(byModelRows.map((row) => [row.key, row.count])),
      byTask: Object.fromEntries(byTaskRows.map((row) => [row.key, row.count])),
      byOutcome: Object.fromEntries(byOutcomeRows.map((row) => [row.key, row.count])),
    };
  }

  saveNativeRoute(input: HarnessRouteRecord): HarnessRouteRecord {
    const record = sanitizeNativeRoute(input);
    this.database
      .prepare(`INSERT INTO native_routes (
        route_id, created_at, updated_at, harness, session_hash, task_id_hash, task_fingerprint,
        workspace_fingerprint, requirements_fingerprint, affinity_expires_at,
        selected_candidate, outcome, profile, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(route_id) DO UPDATE SET
        created_at=excluded.created_at, updated_at=excluded.updated_at, harness=excluded.harness,
        session_hash=excluded.session_hash, task_id_hash=excluded.task_id_hash,
        task_fingerprint=excluded.task_fingerprint,
        workspace_fingerprint=excluded.workspace_fingerprint,
        requirements_fingerprint=excluded.requirements_fingerprint,
        affinity_expires_at=excluded.affinity_expires_at,
        selected_candidate=excluded.selected_candidate, outcome=excluded.outcome,
        profile=excluded.profile, record_json=excluded.record_json
      WHERE excluded.updated_at >= native_routes.updated_at`)
      .run(
        record.routeId,
        record.createdAt,
        record.updatedAt,
        record.harness,
        record.sessionHash ?? null,
        record.taskIdHash ?? null,
        record.taskFingerprint,
        record.workspaceFingerprint,
        record.requirementsFingerprint ?? null,
        record.affinityExpiresAt ? Date.parse(record.affinityExpiresAt) : null,
        record.selectedCandidate ?? null,
        record.outcome,
        record.profile,
        JSON.stringify(record),
      );
    return record;
  }

  saveNativeRouteAndJob(route: HarnessRouteRecord, job: NativeRouteJob): NativeRouteJob {
    return this.database.transaction(() => {
      this.saveNativeRoute(route);
      return this.createNativeRouteJob(job);
    })();
  }

  createNativeRouteJob(input: NativeRouteJob): NativeRouteJob {
    const job = nativeRouteJobSchema.parse(input);
    const existing = this.getNativeRouteJobByIdempotencyHash(job.idempotencyKeyHash);
    if (existing) {
      if (existing.executionHash !== job.executionHash) {
        throw new Error("Idempotency key was already used for a different execution request");
      }
      return existing;
    }
    this.database
      .prepare(`INSERT INTO native_route_jobs (
        job_id, route_id, status, updated_at, idempotency_key_hash, execution_hash, permission,
        created_at, started_at, completed_at, progress_json, error_code, child_session_hash,
        cancel_requested
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        job.jobId,
        job.routeId,
        job.status,
        job.updatedAt,
        job.idempotencyKeyHash,
        job.executionHash,
        job.permission,
        job.createdAt,
        job.startedAt ?? null,
        job.completedAt ?? null,
        JSON.stringify(job.progress),
        job.errorCode ?? null,
        job.childSessionHash ?? null,
        job.cancelRequested ? 1 : 0,
      );
    return job;
  }

  getNativeRouteJob(jobId: string): NativeRouteJob | undefined {
    return this.#readNativeRouteJob("job_id = ?", jobId);
  }

  getNativeRouteJobByIdempotencyHash(hash: string): NativeRouteJob | undefined {
    return this.#readNativeRouteJob("idempotency_key_hash = ?", hash);
  }

  listNativeRouteJobs(
    input: { routeId?: string; status?: string; limit?: number } = {},
  ): NativeRouteJob[] {
    const where: string[] = ["idempotency_key_hash IS NOT NULL"];
    const args: unknown[] = [];
    if (input.routeId) {
      where.push("route_id = ?");
      args.push(input.routeId);
    }
    if (input.status) {
      where.push("status = ?");
      args.push(input.status);
    }
    const limit = Math.max(1, Math.min(1_000, input.limit ?? 50));
    const rows = this.database
      .prepare(`SELECT * FROM native_route_jobs WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC, job_id ASC LIMIT ?`)
      .all(...args, limit) as NativeRouteJobRow[];
    return rows.map(nativeRouteJobFromRow);
  }

  updateNativeRouteJob(job: NativeRouteJob): NativeRouteJob {
    const parsed = nativeRouteJobSchema.parse(job);
    const result = this.database
      .prepare(`UPDATE native_route_jobs SET
        status = ?, updated_at = ?, started_at = ?, completed_at = ?, progress_json = ?,
        error_code = ?, child_session_hash = ?, cancel_requested = ?
        WHERE job_id = ? AND execution_hash = ?`)
      .run(
        parsed.status,
        parsed.updatedAt,
        parsed.startedAt ?? null,
        parsed.completedAt ?? null,
        JSON.stringify(parsed.progress),
        parsed.errorCode ?? null,
        parsed.childSessionHash ?? null,
        parsed.cancelRequested ? 1 : 0,
        parsed.jobId,
        parsed.executionHash,
      );
    if (result.changes !== 1) throw new Error(`Unknown native route job: ${parsed.jobId}`);
    return parsed;
  }

  recoverNativeRouteJobs(now = new Date(this.#now()).toISOString()): number {
    const rows = this.database
      .prepare(
        "SELECT * FROM native_route_jobs WHERE status IN ('starting', 'running') AND idempotency_key_hash IS NOT NULL",
      )
      .all() as NativeRouteJobRow[];
    const update = this.database.transaction(() => {
      for (const row of rows) {
        const job = nativeRouteJobFromRow(row);
        this.updateNativeRouteJob({
          ...job,
          status: "orphaned",
          updatedAt: now,
          completedAt: now,
          progress: { ...job.progress, stage: "terminal", resultAvailable: false },
          errorCode: "process-restarted",
        });
      }
    });
    update();
    return rows.length;
  }

  #readNativeRouteJob(where: string, value: string): NativeRouteJob | undefined {
    const row = this.database
      .prepare(`SELECT * FROM native_route_jobs WHERE ${where}`)
      .get(value) as NativeRouteJobRow | undefined;
    if (!row || !row.idempotency_key_hash) return undefined;
    return nativeRouteJobFromRow(row);
  }

  importNativeRoutes(records: readonly unknown[], sourceKey?: string): number {
    const metadataKey = sourceKey ? `native_route_import:${sourceKey}` : undefined;
    if (
      metadataKey &&
      this.database.prepare("SELECT 1 FROM installation_metadata WHERE key = ?").get(metadataKey)
    ) {
      return 0;
    }
    const latest = new Map<string, HarnessRouteRecord>();
    for (const input of records) {
      const parsed = harnessRouteRecordSchema.safeParse(input);
      if (!parsed.success) continue;
      const current = latest.get(parsed.data.routeId);
      if (!current || parsed.data.updatedAt >= current.updatedAt) {
        latest.set(parsed.data.routeId, parsed.data);
      }
    }
    const before = this.database
      .prepare("SELECT COUNT(*) FROM native_routes")
      .pluck()
      .get() as number;
    this.database.transaction(() => {
      for (const record of latest.values()) this.saveNativeRoute(record);
      if (metadataKey) {
        this.database
          .prepare("INSERT INTO installation_metadata(key, value) VALUES (?, ?)")
          .run(metadataKey, new Date(this.#now()).toISOString());
      }
    })();
    const after = this.database
      .prepare("SELECT COUNT(*) FROM native_routes")
      .pluck()
      .get() as number;
    return after - before;
  }

  getNativeRoute(routeId: string): HarnessRouteRecord | undefined {
    const row = this.database
      .prepare("SELECT record_json FROM native_routes WHERE route_id = ?")
      .get(routeId) as { record_json: string } | undefined;
    if (!row) return undefined;
    return harnessRouteRecordSchema.parse(JSON.parse(row.record_json));
  }

  getAllNativeRoutes(): HarnessRouteRecord[] {
    const rows = this.database
      .prepare("SELECT record_json FROM native_routes ORDER BY updated_at ASC, route_id ASC")
      .all() as Array<{ record_json: string }>;
    return rows.map((row) => harnessRouteRecordSchema.parse(JSON.parse(row.record_json)));
  }

  getNativeRouteHistory(filters: NativeRouteHistoryFilters = {}): HarnessRouteRecord[] {
    const parsed = nativeRouteHistoryFiltersSchema.parse(filters);
    const where: string[] = [];
    const args: unknown[] = [];
    if (parsed.since) {
      where.push("updated_at >= ?");
      args.push(parsed.since);
    }
    if (parsed.harness) {
      where.push("harness = ?");
      args.push(parsed.harness);
    }
    if (parsed.outcome) {
      where.push("outcome = ?");
      args.push(parsed.outcome);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.database
      .prepare(`SELECT record_json FROM native_routes ${clause}
        ORDER BY updated_at DESC, route_id ASC LIMIT ?`)
      .all(...args, parsed.limit) as Array<{ record_json: string }>;
    return rows.map((row) => harnessRouteRecordSchema.parse(JSON.parse(row.record_json)));
  }

  getNativeRouteStats(filters: Omit<NativeRouteHistoryFilters, "limit"> = {}): NativeRouteStats {
    const parsed = nativeRouteHistoryFiltersSchema.parse({ ...filters, limit: 1_000 });
    const where: string[] = [];
    const args: unknown[] = [];
    if (parsed.since) {
      where.push("updated_at >= ?");
      args.push(parsed.since);
    }
    if (parsed.harness) {
      where.push("harness = ?");
      args.push(parsed.harness);
    }
    if (parsed.outcome) {
      where.push("outcome = ?");
      args.push(parsed.outcome);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const records = this.database
      .prepare(`SELECT harness, outcome, selected_candidate, record_json
        FROM native_routes ${clause}`)
      .all(...args) as Array<{
      harness: string;
      outcome: string;
      selected_candidate: string | null;
      record_json: string;
    }>;
    const byHarness: Record<string, number> = {};
    const byOutcome: Record<string, number> = {};
    const byCandidate: Record<string, number> = {};
    let totalAttempts = 0;
    let successfulAttempts = 0;
    let totalLatency = 0;
    for (const row of records) {
      byHarness[row.harness] = (byHarness[row.harness] ?? 0) + 1;
      byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1;
      if (row.selected_candidate) {
        byCandidate[row.selected_candidate] = (byCandidate[row.selected_candidate] ?? 0) + 1;
      }
      const record = harnessRouteRecordSchema.parse(JSON.parse(row.record_json));
      for (const attempt of record.attempts ?? []) {
        totalAttempts++;
        successfulAttempts += attempt.outcome === "success" ? 1 : 0;
        totalLatency += attempt.latencyMs;
      }
    }
    return {
      totalRoutes: records.length,
      activeRoutes: records.filter((row) => row.outcome === "planned" || row.outcome === "running")
        .length,
      totalAttempts,
      successfulAttempts,
      averageAttemptLatencyMs: totalAttempts ? totalLatency / totalAttempts : 0,
      byHarness,
      byOutcome,
      byCandidate,
    };
  }

  pruneNativeRoutes(input: { before: string; now?: number }): number {
    const before = Date.parse(input.before);
    if (!Number.isFinite(before)) throw new Error("Invalid native route retention cutoff");
    return this.database
      .prepare(`DELETE FROM native_routes
        WHERE updated_at < ?
          AND outcome NOT IN ('planned', 'running')
          AND (affinity_expires_at IS NULL OR affinity_expires_at <= ?)
          AND NOT EXISTS (
            SELECT 1 FROM native_route_jobs j WHERE j.route_id = native_routes.route_id
              AND j.status IN ('queued', 'starting', 'running')
          )`)
      .run(new Date(before).toISOString(), input.now ?? this.#now()).changes;
  }

  getAffinity(sessionHash: string): string | undefined {
    const row = this.database
      .prepare("SELECT model_id, expires_at FROM session_affinity WHERE session_hash = ?")
      .get(sessionHash) as { model_id: string; expires_at: number } | undefined;
    if (!row) return undefined;
    if (row.expires_at <= this.#now()) {
      this.database.prepare("DELETE FROM session_affinity WHERE session_hash = ?").run(sessionHash);
      return undefined;
    }
    return row.model_id;
  }

  setAffinity(sessionHash: string, modelId: string, expiresAt: number): void {
    this.database
      .prepare(
        "INSERT OR REPLACE INTO session_affinity(session_hash, model_id, expires_at) VALUES (?, ?, ?)",
      )
      .run(sessionHash, modelId, expiresAt);
    this.database.prepare("DELETE FROM session_affinity WHERE expires_at <= ?").run(this.#now());
  }
}

function sanitizeNativeRoute(input: unknown): HarnessRouteRecord {
  const parsed = harnessRouteRecordSchema.parse(input);
  if (!parsed.rerouteReason) return parsed;
  const rerouteReason = /^sha256:[a-f0-9]{64}$/.test(parsed.rerouteReason)
    ? parsed.rerouteReason
    : `sha256:${createHash("sha256").update(parsed.rerouteReason).digest("hex")}`;
  return { ...parsed, rerouteReason };
}

interface NativeRouteJobRow {
  job_id: string;
  route_id: string;
  status: string;
  updated_at: string;
  idempotency_key_hash: string | null;
  execution_hash: string | null;
  permission: string | null;
  created_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  progress_json: string | null;
  error_code: string | null;
  child_session_hash: string | null;
  cancel_requested: number;
}

function nativeRouteJobFromRow(row: NativeRouteJobRow): NativeRouteJob {
  return nativeRouteJobSchema.parse({
    jobId: row.job_id,
    routeId: row.route_id,
    status: row.status,
    idempotencyKeyHash: row.idempotency_key_hash,
    executionHash: row.execution_hash,
    permission: row.permission,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    progress: row.progress_json ? JSON.parse(row.progress_json) : undefined,
    errorCode: row.error_code ?? undefined,
    childSessionHash: row.child_session_hash ?? undefined,
    cancelRequested: row.cancel_requested === 1,
  });
}

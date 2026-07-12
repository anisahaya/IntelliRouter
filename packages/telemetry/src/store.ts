import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { FeedbackEvent, RouteDecision, RouteStats } from "@model-router/contracts";
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
}

export class TelemetryStore implements RouterState {
  readonly database: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path);
    this.database.pragma("journal_mode = WAL");
    migrate(this.database);
  }

  close(): void {
    this.database.close();
  }

  isHealthy(modelId: string): boolean {
    const row = this.database
      .prepare("SELECT healthy FROM model_health_windows WHERE model_id = ?")
      .get(modelId) as { healthy: number } | undefined;
    return row?.healthy !== 0;
  }

  setHealth(modelId: string, healthy: boolean, latencyMs = 500): void {
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
        SELECT COALESCE(AVG(CASE f.outcome WHEN 'success' THEN 1 WHEN 'failure' THEN -1
          WHEN 'corrected' THEN -0.5 ELSE -0.25 END), 0) AS prior
        FROM feedback_events f JOIN route_decisions r ON r.id = f.route_id
        WHERE r.logical_model = ? AND r.task_type = ?
      `)
      .get(modelId, taskType) as { prior: number };
    return {
      averageLatencyMs: health?.average_latency_ms ?? 500,
      failureRate: health && health.attempts > 0 ? health.failures / health.attempts : 0,
      feedbackPrior: Number(feedback.prior) * 0.1,
    };
  }

  saveDecision(decision: RouteDecision): void {
    this.database.transaction(() => {
      this.database
        .prepare(`INSERT INTO route_decisions
          (id, request_id, logical_model, upstream_model, profile, task_type, features_json,
           fallback_chain_json, affinity_used, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
        );
      const insert = this.database.prepare(`INSERT INTO route_candidates
        (route_id, model_id, eligible, exclusions_json, scores_json) VALUES (?, ?, ?, ?, ?)`);
      for (const candidate of decision.candidates) {
        insert.run(
          decision.id,
          candidate.modelId,
          candidate.eligible ? 1 : 0,
          JSON.stringify(candidate.exclusionReasons),
          JSON.stringify(candidate.scores),
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
      .prepare("SELECT * FROM route_candidates WHERE route_id = ? ORDER BY model_id")
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
    };
  }

  updateFallbackChain(routeId: string, chain: string[]): void {
    this.database
      .prepare("UPDATE route_decisions SET fallback_chain_json = ? WHERE id = ?")
      .run(JSON.stringify(chain), routeId);
  }

  recordMetric(metric: RequestMetric): void {
    this.database
      .prepare(`INSERT OR REPLACE INTO request_metrics
        (route_id, status, latency_ms, input_tokens, output_tokens, estimated_cost_usd,
         provider_request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        metric.routeId,
        metric.status,
        metric.latencyMs,
        metric.inputTokens ?? 0,
        metric.outputTokens ?? 0,
        metric.estimatedCostUsd ?? 0,
        metric.providerRequestId ?? null,
        new Date().toISOString(),
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
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const aggregate = this.database
      .prepare(`SELECT COUNT(*) total,
        COALESCE(SUM(CASE WHEN m.status BETWEEN 200 AND 399 THEN 1 ELSE 0 END), 0) successful,
        COALESCE(SUM(m.estimated_cost_usd), 0) cost,
        COALESCE(AVG(m.latency_ms), 0) latency
        FROM route_decisions r LEFT JOIN request_metrics m ON m.route_id = r.id ${clause}`)
      .get(...args) as { total: number; successful: number; cost: number; latency: number };
    const byModelRows = this.database
      .prepare(
        `SELECT r.logical_model key, COUNT(*) count FROM route_decisions r ${clause} GROUP BY r.logical_model`,
      )
      .all(...args) as { key: string; count: number }[];
    const byTaskRows = this.database
      .prepare(
        `SELECT r.task_type key, COUNT(*) count FROM route_decisions r ${clause} GROUP BY r.task_type`,
      )
      .all(...args) as { key: string; count: number }[];
    return {
      totalRequests: aggregate.total,
      successfulRequests: aggregate.successful,
      estimatedCostUsd: aggregate.cost,
      averageLatencyMs: aggregate.latency,
      byModel: Object.fromEntries(byModelRows.map((row) => [row.key, row.count])),
      byTask: Object.fromEntries(byTaskRows.map((row) => [row.key, row.count])),
    };
  }

  getAffinity(sessionHash: string): string | undefined {
    const row = this.database
      .prepare("SELECT model_id, expires_at FROM session_affinity WHERE session_hash = ?")
      .get(sessionHash) as { model_id: string; expires_at: number } | undefined;
    if (!row || row.expires_at <= Date.now()) return undefined;
    return row.model_id;
  }

  setAffinity(sessionHash: string, modelId: string, expiresAt: number): void {
    this.database
      .prepare(
        "INSERT OR REPLACE INTO session_affinity(session_hash, model_id, expires_at) VALUES (?, ?, ?)",
      )
      .run(sessionHash, modelId, expiresAt);
  }
}

import type Database from "better-sqlite3";

const migrations = [
  `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS route_decisions (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      logical_model TEXT NOT NULL,
      upstream_model TEXT NOT NULL,
      profile TEXT NOT NULL,
      task_type TEXT NOT NULL,
      features_json TEXT NOT NULL,
      fallback_chain_json TEXT NOT NULL,
      affinity_used INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS route_candidates (
      route_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      eligible INTEGER NOT NULL,
      exclusions_json TEXT NOT NULL,
      scores_json TEXT NOT NULL,
      PRIMARY KEY (route_id, model_id)
    );
    CREATE TABLE IF NOT EXISTS request_metrics (
      route_id TEXT PRIMARY KEY,
      status INTEGER NOT NULL,
      latency_ms REAL NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      provider_request_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS feedback_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      score REAL,
      tags_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_health_windows (
      model_id TEXT PRIMARY KEY,
      healthy INTEGER NOT NULL DEFAULT 1,
      average_latency_ms REAL NOT NULL DEFAULT 500,
      failures INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_affinity (
      session_hash TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `,
  `
    ALTER TABLE route_decisions ADD COLUMN kind TEXT NOT NULL DEFAULT 'legacy';
    ALTER TABLE request_metrics ADD COLUMN outcome TEXT NOT NULL DEFAULT 'success';
    ALTER TABLE request_metrics ADD COLUMN final_model TEXT;
    ALTER TABLE request_metrics ADD COLUMN fallback_count INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE provider_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id TEXT NOT NULL REFERENCES route_decisions(id) ON DELETE CASCADE,
      attempt_order INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      error_class TEXT,
      status INTEGER,
      latency_ms REAL NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      provider_request_id TEXT,
      bytes_emitted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(route_id, attempt_order)
    );
    CREATE TABLE installation_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX idx_route_decisions_created ON route_decisions(created_at);
    CREATE INDEX idx_route_decisions_model_task ON route_decisions(logical_model, task_type);
    CREATE INDEX idx_attempts_route ON provider_attempts(route_id, attempt_order);
    CREATE INDEX idx_attempts_model_created ON provider_attempts(model_id, created_at);
    CREATE INDEX idx_feedback_route_created ON feedback_events(route_id, created_at);
    CREATE INDEX idx_metrics_outcome_created ON request_metrics(outcome, created_at);
    CREATE INDEX idx_health_updated ON model_health_windows(updated_at);
    CREATE INDEX idx_affinity_expiry ON session_affinity(expires_at);
    UPDATE route_decisions SET kind = CASE WHEN id IN (SELECT route_id FROM request_metrics)
      THEN 'compatibility' ELSE 'legacy' END;
    UPDATE request_metrics SET
      outcome = CASE WHEN status BETWEEN 200 AND 399 THEN 'success' ELSE 'failure' END,
      final_model = (SELECT logical_model FROM route_decisions WHERE id = request_metrics.route_id),
      fallback_count = COALESCE((SELECT json_array_length(fallback_chain_json) FROM route_decisions
        WHERE id = request_metrics.route_id AND json_valid(fallback_chain_json)), 0);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_metrics_outcome_created ON request_metrics(outcome, created_at);
    CREATE INDEX IF NOT EXISTS idx_health_updated ON model_health_windows(updated_at);
    CREATE INDEX IF NOT EXISTS idx_affinity_expiry ON session_affinity(expires_at);
  `,
  `
    ALTER TABLE model_health_windows ADD COLUMN state TEXT NOT NULL DEFAULT 'unknown';
    ALTER TABLE model_health_windows ADD COLUMN cooldown_until INTEGER;
    CREATE INDEX IF NOT EXISTS idx_health_state_updated ON model_health_windows(state, updated_at);
  `,
  `
    ALTER TABLE model_health_windows ADD COLUMN window_start_attempt_id INTEGER NOT NULL DEFAULT 0;
  `,
  `
    ALTER TABLE route_candidates ADD COLUMN rank_index INTEGER;
    CREATE INDEX IF NOT EXISTS idx_route_candidates_rank ON route_candidates(route_id, rank_index);
  `,
  `
    CREATE TABLE native_routes (
      route_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      harness TEXT NOT NULL,
      session_hash TEXT,
      task_id_hash TEXT,
      task_fingerprint TEXT NOT NULL,
      workspace_fingerprint TEXT NOT NULL,
      requirements_fingerprint TEXT,
      affinity_expires_at INTEGER,
      selected_candidate TEXT,
      outcome TEXT NOT NULL,
      profile TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE TABLE native_route_jobs (
      job_id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL REFERENCES native_routes(route_id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_native_routes_updated ON native_routes(updated_at DESC);
    CREATE INDEX idx_native_routes_harness_updated ON native_routes(harness, updated_at DESC);
    CREATE INDEX idx_native_routes_outcome_updated ON native_routes(outcome, updated_at DESC);
    CREATE INDEX idx_native_routes_affinity ON native_routes(
      harness, task_id_hash, session_hash, task_fingerprint, workspace_fingerprint,
      requirements_fingerprint, affinity_expires_at
    );
    CREATE INDEX idx_native_route_jobs_route_status ON native_route_jobs(route_id, status);
  `,
  `
    ALTER TABLE native_route_jobs ADD COLUMN idempotency_key_hash TEXT;
    ALTER TABLE native_route_jobs ADD COLUMN execution_hash TEXT;
    ALTER TABLE native_route_jobs ADD COLUMN permission TEXT;
    ALTER TABLE native_route_jobs ADD COLUMN created_at TEXT;
    ALTER TABLE native_route_jobs ADD COLUMN started_at TEXT;
    ALTER TABLE native_route_jobs ADD COLUMN completed_at TEXT;
    ALTER TABLE native_route_jobs ADD COLUMN progress_json TEXT;
    ALTER TABLE native_route_jobs ADD COLUMN error_code TEXT;
    ALTER TABLE native_route_jobs ADD COLUMN child_session_hash TEXT;
    ALTER TABLE native_route_jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
    CREATE UNIQUE INDEX idx_native_route_jobs_idempotency
      ON native_route_jobs(idempotency_key_hash) WHERE idempotency_key_hash IS NOT NULL;
    CREATE INDEX idx_native_route_jobs_status_updated
      ON native_route_jobs(status, updated_at DESC);
  `,
];

export function migrate(database: Database.Database): void {
  database.pragma("foreign_keys = ON");
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const current = database
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get() as { version: number };
  migrations.forEach((sql, index) => {
    const version = index + 1;
    if (version <= current.version) return;
    database.transaction(() => {
      database.exec(sql);
      database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(version, new Date().toISOString());
    })();
  });
}

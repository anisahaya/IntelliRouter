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
    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY, route_id TEXT NOT NULL UNIQUE, origin TEXT NOT NULL,
      task_fingerprint TEXT NOT NULL, workspace_fingerprint TEXT, algorithm TEXT,
      derived_features_json TEXT NOT NULL DEFAULT '{}', repo_tags_json TEXT NOT NULL DEFAULT '[]',
      selected_model TEXT, effort TEXT, harness TEXT, profile TEXT, context_json TEXT NOT NULL DEFAULT '{}',
      process TEXT NOT NULL, verification TEXT NOT NULL, disposition TEXT NOT NULL,
      label_value TEXT NOT NULL, label_strength TEXT NOT NULL,
      partial_write_detected INTEGER NOT NULL DEFAULT 0, safe_to_fallback INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_run_attempts (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
      attempt_order INTEGER NOT NULL, model TEXT, outcome TEXT NOT NULL, retry INTEGER NOT NULL DEFAULT 0,
      fallback INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER, output_tokens INTEGER, token_basis TEXT NOT NULL DEFAULT 'unknown',
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, latency_ms REAL, cost_usd REAL, cost_basis TEXT NOT NULL DEFAULT 'unknown',
      pricing_provenance TEXT, error_class TEXT, partial_write_detected INTEGER NOT NULL DEFAULT 0, safe_to_fallback INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, UNIQUE(run_id, attempt_order)
    );
    CREATE TABLE IF NOT EXISTS task_run_verifications (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, result TEXT NOT NULL, check_name TEXT NOT NULL, latency_ms REAL, evidence_hash TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_run_events (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, UNIQUE(run_id,id)
    );
    CREATE TABLE IF NOT EXISTS task_run_content (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, content TEXT NOT NULL, original_hmac TEXT NOT NULL, created_at TEXT NOT NULL
    );
    ALTER TABLE task_run_content ADD COLUMN redaction_version TEXT NOT NULL DEFAULT 'v1';
    ALTER TABLE task_run_content ADD COLUMN expires_at TEXT;
    ALTER TABLE task_run_content ADD COLUMN stored_bytes INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS task_run_embeddings (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
      model TEXT NOT NULL, dimensions INTEGER NOT NULL CHECK(dimensions BETWEEN 1 AND 4096), values_blob BLOB NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dataset_imports (
      id TEXT PRIMARY KEY, manifest_json TEXT NOT NULL, external_id_hmac TEXT NOT NULL, label TEXT NOT NULL,
      strength TEXT NOT NULL, source TEXT, model_pair TEXT, created_at TEXT NOT NULL, UNIQUE(external_id_hmac)
    );
    CREATE INDEX IF NOT EXISTS idx_task_runs_route ON task_runs(route_id);
    CREATE INDEX IF NOT EXISTS idx_task_runs_created ON task_runs(created_at);
    CREATE INDEX IF NOT EXISTS idx_task_attempts_run ON task_run_attempts(run_id, attempt_order);
    CREATE INDEX IF NOT EXISTS idx_task_events_run ON task_run_events(run_id, created_at);
    INSERT OR IGNORE INTO task_runs (id, route_id, origin, task_fingerprint, process, verification, disposition, label_value, label_strength, created_at, updated_at)
      SELECT 'legacy-' || id, id, CASE WHEN kind='compatibility' THEN 'compatibility' ELSE 'imported' END,
        'legacy-sha256-v0:' || lower(hex(features_json)), CASE WHEN EXISTS (SELECT 1 FROM request_metrics m WHERE m.route_id=route_decisions.id) THEN 'completed' ELSE 'planned' END,
        'not-run', 'unknown', 'unknown', CASE WHEN EXISTS (SELECT 1 FROM request_metrics m WHERE m.route_id=route_decisions.id) THEN 'operational' ELSE 'none' END, created_at, created_at
      FROM route_decisions;
    INSERT OR IGNORE INTO task_run_attempts (id, run_id, attempt_order, model, outcome, input_tokens, output_tokens, token_basis, latency_ms, cost_usd, cost_basis, created_at)
      SELECT 'legacy-metric-' || m.route_id, 'legacy-' || m.route_id, 0, m.final_model,
        CASE WHEN m.status BETWEEN 200 AND 399 THEN 'completed' ELSE 'failed' END, m.input_tokens, m.output_tokens, 'actual', m.latency_ms, m.estimated_cost_usd, 'estimated', m.created_at
      FROM request_metrics m;
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

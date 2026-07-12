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
];

export function migrate(database: Database.Database): void {
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

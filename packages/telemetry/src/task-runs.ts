import { createHash, createHmac } from "node:crypto";
import {
  type LocalEmbedding,
  reduceEvidence,
  type SafeReceipt,
  type TaskRun,
  type TaskRunAttempt,
} from "@model-router/contracts";
import type Database from "better-sqlite3";
import { redactTokenText, redactValue } from "./redaction.js";

const now = () => new Date().toISOString();
const json = (v: unknown) => JSON.stringify(v ?? {});

export interface CreateTaskRunInput {
  id?: string;
  routeId: string;
  origin: TaskRun["origin"];
  taskFingerprint: string;
  workspaceFingerprint?: string;
  algorithm?: string;
  selectedModel?: string;
  effort?: string;
  harness?: string;
  profile?: string;
  derivedFeatures?: Record<string, unknown>;
  repoTags?: string[];
  context?: Record<string, unknown>;
}
export interface ContentPolicy {
  enabled?: boolean;
  maxItemBytes?: number;
  maxRunBytes?: number;
  maxTotalBytes?: number;
  retentionDays?: number;
}
export interface RoutingEvidenceQuery {
  taskFingerprint?: string;
  model?: string;
  harness?: string;
  limit?: number;
}
export interface RoutingEvidenceRecord {
  id: string;
  model: string;
  taskFingerprint: string;
  taskType?: string;
  scope?: string;
  complexity?: number;
  risk?: number;
  capabilities?: string[];
  repoTags?: string[];
  label: "correct" | "incorrect";
  labelStrength: "verified" | "comparative";
  origin: string;
  verification: string;
  process: string;
  createdAt: string;
  updatedAt: string;
  attempts: Array<{
    attemptOrder: number;
    model?: string;
    outcome?: string;
    retry: boolean;
    fallback: boolean;
    inputTokens?: number;
    outputTokens?: number;
    tokenBasis: "actual" | "estimated" | "unknown";
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
    costBasis: "actual" | "estimated" | "unknown";
    pricingProvenance?: string;
    partialWriteDetected: boolean;
    safeToFallback: boolean;
  }>;
}

export class TaskRunStore {
  readonly database: Database.Database;
  readonly salt: string;
  constructor(database: Database.Database, salt: string) {
    this.database = database;
    this.salt = salt;
  }
  hmac(value: string, domain = "id"): string {
    return createHmac("sha256", this.salt).update(`${domain}:`).update(value).digest("hex");
  }
  legacyFingerprint(value: string): string {
    return `${createHash("sha256").update(value).digest("hex")}:legacy-sha256-v0`;
  }
  createRun(input: CreateTaskRunInput): string {
    const id = input.id ?? this.hmac(input.routeId, "task-run");
    const t = now();
    this.database
      .prepare(
        `INSERT INTO task_runs (id,route_id,origin,task_fingerprint,workspace_fingerprint,algorithm,derived_features_json,repo_tags_json,selected_model,effort,harness,profile,context_json,process,verification,disposition,label_value,label_strength,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(route_id) DO UPDATE SET updated_at=excluded.updated_at`,
      )
      .run(
        id,
        input.routeId,
        input.origin,
        input.taskFingerprint,
        input.workspaceFingerprint ?? null,
        input.algorithm ?? null,
        json(input.derivedFeatures),
        json(input.repoTags ?? []),
        input.selectedModel ?? null,
        input.effort ?? null,
        input.harness ?? null,
        input.profile ?? null,
        json(input.context),
        "planned",
        "not-run",
        "unknown",
        "unknown",
        "none",
        t,
        t,
      );
    return id;
  }
  upsertRun(input: CreateTaskRunInput): string {
    return this.createRun(input);
  }
  completeProcess(
    routeId: string,
    process: TaskRun["process"],
    fields: { latencyMs?: number; partialWriteDetected?: boolean; safeToFallback?: boolean } = {},
  ): void {
    this.database
      .prepare(
        "UPDATE task_runs SET process=?, partial_write_detected=COALESCE(?,partial_write_detected), safe_to_fallback=COALESCE(?,safe_to_fallback), updated_at=? WHERE route_id=?",
      )
      .run(
        process,
        fields.partialWriteDetected == null ? null : fields.partialWriteDetected ? 1 : 0,
        fields.safeToFallback == null ? null : fields.safeToFallback ? 1 : 0,
        now(),
        routeId,
      );
  }
  recordAttempt(
    routeId: string,
    attempt: Omit<TaskRunAttempt, "id" | "runId" | "createdAt"> & { id?: string },
  ): void {
    const run = this.database.prepare("SELECT id FROM task_runs WHERE route_id=?").get(routeId) as
      | { id: string }
      | undefined;
    if (!run) throw new Error("task run not found");
    this.database
      .prepare(
        `INSERT INTO task_run_attempts (id,run_id,attempt_order,model,outcome,retry,fallback,input_tokens,output_tokens,token_basis,cache_read_tokens,cache_write_tokens,latency_ms,cost_usd,cost_basis,pricing_provenance,error_class,partial_write_detected,safe_to_fallback,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,attempt_order) DO UPDATE SET outcome=excluded.outcome, latency_ms=excluded.latency_ms`,
      )
      .run(
        attempt.id ?? this.hmac(`${routeId}:${attempt.attemptOrder}`, "attempt"),
        run.id,
        attempt.attemptOrder,
        attempt.model ?? null,
        attempt.outcome,
        attempt.retry ? 1 : 0,
        attempt.fallback ? 1 : 0,
        attempt.inputTokens ?? null,
        attempt.outputTokens ?? null,
        attempt.tokenBasis ?? "unknown",
        attempt.cacheReadTokens ?? null,
        attempt.cacheWriteTokens ?? null,
        attempt.latencyMs ?? null,
        attempt.costUsd ?? null,
        attempt.costBasis ?? "unknown",
        attempt.pricingProvenance ?? null,
        attempt.errorClass ?? null,
        attempt.partialWriteDetected ? 1 : 0,
        attempt.safeToFallback === false ? 0 : 1,
        now(),
      );
  }
  verify(
    routeId: string,
    verification: {
      kind: string;
      result: "not-run" | "passed" | "failed" | "inconclusive";
      checkName: string;
      latencyMs?: number;
      evidenceHash?: string;
    },
  ): void {
    const run = this.database
      .prepare("SELECT id,process,disposition FROM task_runs WHERE route_id=?")
      .get(routeId) as
      | { id: string; process: TaskRun["process"]; disposition: TaskRun["disposition"] }
      | undefined;
    if (!run) throw new Error("task run not found");
    this.database.transaction(() => {
      this.database
        .prepare(
          "INSERT INTO task_run_verifications(id,run_id,kind,result,check_name,latency_ms,evidence_hash,created_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(
          this.hmac(`${routeId}:${verification.kind}:${verification.checkName}`, "verification"),
          run.id,
          verification.kind,
          verification.result,
          verification.checkName,
          verification.latencyMs ?? null,
          verification.evidenceHash ?? null,
          now(),
        );
      const reduced = reduceEvidence({
        process: run.process,
        verification: verification.result,
        independentCheck: verification.result === "passed" || verification.result === "failed",
        disposition: run.disposition,
      });
      this.database
        .prepare(
          "UPDATE task_runs SET verification=?,label_value=?,label_strength=?,updated_at=? WHERE id=?",
        )
        .run(reduced.verification, reduced.labelValue, reduced.labelStrength, now(), run.id);
    })();
  }
  event(routeId: string, kind: string, payload: Record<string, unknown> = {}): void {
    const run = this.database.prepare("SELECT id FROM task_runs WHERE route_id=?").get(routeId) as
      | { id: string }
      | undefined;
    if (!run) throw new Error("task run not found");
    this.database
      .prepare(
        "INSERT OR IGNORE INTO task_run_events(id,run_id,kind,payload_json,created_at) VALUES (?,?,?,?,?)",
      )
      .run(
        this.hmac(`${routeId}:${kind}:${json(payload)}`, "event"),
        run.id,
        kind,
        json(payload),
        now(),
      );
  }
  content(routeId: string, kind: string, value: string, policy: ContentPolicy = {}): boolean {
    if (!policy.enabled) return false;
    const original = value;
    try {
      value = redactTokenText(String(redactValue(value)));
    } catch {
      return false;
    }
    const bytes = Buffer.byteLength(value);
    const max = policy.maxItemBytes ?? 65536;
    if (bytes > max) value = Buffer.from(value).subarray(0, max).toString("utf8");
    const run = this.database.prepare("SELECT id FROM task_runs WHERE route_id=?").get(routeId) as
      | { id: string }
      | undefined;
    if (!run) throw new Error("task run not found");
    return this.database.transaction(() => {
      this.database
        .prepare("DELETE FROM task_run_content WHERE expires_at IS NOT NULL AND expires_at <= ?")
        .run(now());
      const count = this.database
        .prepare("SELECT COALESCE(SUM(stored_bytes),0) n FROM task_run_content")
        .get() as { n: number };
      const runCount = this.database
        .prepare("SELECT COALESCE(SUM(stored_bytes),0) n FROM task_run_content WHERE run_id=?")
        .get(run.id) as { n: number };
      const storedBytes = Buffer.byteLength(value);
      if (
        storedBytes + count.n > (policy.maxTotalBytes ?? 50 * 1024 * 1024) ||
        storedBytes + runCount.n > (policy.maxRunBytes ?? 131072)
      )
        return false;
      this.database
        .prepare(
          "INSERT INTO task_run_content(id,run_id,kind,content,original_hmac,redaction_version,expires_at,stored_bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(
          this.hmac(`${routeId}:${kind}:${Date.now()}`, "content"),
          run.id,
          kind,
          value,
          this.hmac(original, "content-original"),
          "v1",
          new Date(Date.now() + (policy.retentionDays ?? 7) * 86400000).toISOString(),
          storedBytes,
          now(),
        );
      return true;
    })();
  }
  embedding(routeId: string, embedding: LocalEmbedding, enabled = false): boolean {
    if (
      !enabled ||
      !embedding.locallyGenerated ||
      embedding.values.length !== embedding.dimensions ||
      embedding.values.some((v) => !Number.isFinite(v))
    )
      return false;
    const run = this.database.prepare("SELECT id FROM task_runs WHERE route_id=?").get(routeId) as
      | { id: string }
      | undefined;
    if (!run) throw new Error("task run not found");
    const buf = Buffer.from(new Float32Array(embedding.values).buffer);
    this.database
      .prepare(
        "INSERT OR REPLACE INTO task_run_embeddings(id,run_id,model,dimensions,values_blob,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        this.hmac(`${routeId}:${embedding.model}`, "embedding"),
        run.id,
        embedding.model,
        embedding.dimensions,
        buf,
        now(),
      );
    return true;
  }
  receipt(routeId: string): SafeReceipt | undefined {
    const r = this.database.prepare("SELECT * FROM task_runs WHERE route_id=?").get(routeId) as
      | Record<string, unknown>
      | undefined;
    if (!r) return undefined;
    const a = this.database
      .prepare("SELECT COUNT(*) n FROM task_run_attempts WHERE run_id=?")
      .get(r.id) as { n: number };
    return {
      routeId: String(r.route_id),
      runId: String(r.id),
      origin: r.origin as SafeReceipt["origin"],
      process: r.process as SafeReceipt["process"],
      verification: r.verification as SafeReceipt["verification"],
      disposition: r.disposition as SafeReceipt["disposition"],
      labelValue: r.label_value as SafeReceipt["labelValue"],
      labelStrength: r.label_strength as SafeReceipt["labelStrength"],
      partialWriteDetected: Boolean(r.partial_write_detected),
      safeToFallback: Boolean(r.safe_to_fallback),
      attemptCount: a.n,
    };
  }
  /** Bounded read-only verified evidence query; never mutates telemetry state. */
  queryRoutingEvidence(query: RoutingEvidenceQuery = {}): RoutingEvidenceRecord[] {
    const clauses = [
      "t.label_value IN ('correct','incorrect')",
      "t.label_strength IN ('verified','comparative')",
      "t.verification IN ('passed','failed')",
      "t.process IN ('completed','failed')",
      "t.origin IN ('native','compatibility','evaluation')",
    ];
    const args: unknown[] = [];
    if (query.taskFingerprint) {
      clauses.push("t.task_fingerprint=?");
      args.push(query.taskFingerprint);
    }
    if (query.model) {
      clauses.push("t.selected_model=?");
      args.push(query.model);
    }
    if (query.harness) {
      clauses.push("t.harness=?");
      args.push(query.harness);
    }
    const limit = Math.max(1, Math.min(256, Math.floor(query.limit ?? 256)));
    const rows = this.database
      .prepare(
        `SELECT t.id,t.selected_model model,t.task_fingerprint,t.derived_features_json,t.repo_tags_json,t.label_value,t.label_strength,t.origin,t.verification,t.process,t.created_at,t.updated_at
         FROM task_runs t
         WHERE ${clauses.join(" AND ")}
         ORDER BY t.updated_at DESC,t.id ASC
         LIMIT ?`,
      )
      .all(...args, limit) as Array<Record<string, unknown>>;
    const attemptQuery = this.database.prepare(
      `SELECT attempt_order,model,outcome,retry,fallback,input_tokens,output_tokens,token_basis,
              cache_read_tokens,cache_write_tokens,cost_usd,cost_basis,pricing_provenance,
              partial_write_detected,safe_to_fallback
       FROM task_run_attempts
       WHERE run_id=?
       ORDER BY attempt_order ASC,id ASC`,
    );
    return rows.map((row) => {
      const features = parseObject(row.derived_features_json);
      const tags = parseStringArray(row.repo_tags_json);
      const attemptRows = attemptQuery.all(row.id) as Array<Record<string, unknown>>;
      return {
        id: String(row.id),
        model: String(row.model ?? ""),
        taskFingerprint: String(row.task_fingerprint),
        taskType: typeof features.taskType === "string" ? features.taskType : undefined,
        scope: typeof features.scope === "string" ? features.scope : undefined,
        complexity: typeof features.complexity === "number" ? features.complexity : undefined,
        risk: typeof features.risk === "number" ? features.risk : undefined,
        capabilities: Array.isArray(features.requiredCapabilities)
          ? features.requiredCapabilities.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
        repoTags: tags,
        label: row.label_value as "correct" | "incorrect",
        labelStrength: row.label_strength as "verified" | "comparative",
        origin: String(row.origin),
        verification: String(row.verification),
        process: String(row.process),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        attempts: attemptRows.map((attempt) => ({
          attemptOrder: Number(attempt.attempt_order),
          model: optionalString(attempt.model),
          outcome: optionalString(attempt.outcome),
          retry: Boolean(attempt.retry),
          fallback: Boolean(attempt.fallback),
          inputTokens: optionalNumber(attempt.input_tokens),
          outputTokens: optionalNumber(attempt.output_tokens),
          tokenBasis: measurementBasis(attempt.token_basis),
          cacheReadTokens: optionalNumber(attempt.cache_read_tokens),
          cacheWriteTokens: optionalNumber(attempt.cache_write_tokens),
          costUsd: optionalNumber(attempt.cost_usd),
          costBasis: measurementBasis(attempt.cost_basis),
          pricingProvenance: optionalString(attempt.pricing_provenance, 256),
          partialWriteDetected: Boolean(attempt.partial_write_detected),
          safeToFallback: Boolean(attempt.safe_to_fallback),
        })),
      };
    });
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseStringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown, maximum = Number.POSITIVE_INFINITY): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, maximum) : undefined;
}

function measurementBasis(value: unknown): "actual" | "estimated" | "unknown" {
  return value === "actual" || value === "estimated" ? value : "unknown";
}

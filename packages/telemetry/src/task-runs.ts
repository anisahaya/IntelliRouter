import { createHash, createHmac } from "node:crypto";
import {
  type LocalEmbedding,
  reduceEvidence,
  type SafeReceipt,
  type TaskRun,
  type TaskRunAttempt,
} from "@model-router/contracts";
import { redactTokenText, redactValue } from "./redaction.js";
import type Database from "better-sqlite3";

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
        independentCheck: verification.result === "passed",
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
    try { value = redactTokenText(String(redactValue(value))); } catch { return false; }
    const bytes = Buffer.byteLength(value);
    const max = policy.maxItemBytes ?? 65536;
    if (bytes > max) value = Buffer.from(value).subarray(0, max).toString("utf8");
    const run = this.database.prepare("SELECT id FROM task_runs WHERE route_id=?").get(routeId) as
      | { id: string }
      | undefined;
    if (!run) throw new Error("task run not found");
    return this.database.transaction(() => {
      this.database.prepare("DELETE FROM task_run_content WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now());
      const count = this.database.prepare("SELECT COALESCE(SUM(stored_bytes),0) n FROM task_run_content").get() as { n: number };
      const runCount = this.database.prepare("SELECT COALESCE(SUM(stored_bytes),0) n FROM task_run_content WHERE run_id=?").get(run.id) as { n: number };
      const storedBytes = Buffer.byteLength(value); if (storedBytes + count.n > (policy.maxTotalBytes ?? 50*1024*1024) || storedBytes + runCount.n > (policy.maxRunBytes ?? 131072)) return false;
      this.database.prepare("INSERT INTO task_run_content(id,run_id,kind,content,original_hmac,redaction_version,expires_at,stored_bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
        this.hmac(`${routeId}:${kind}:${Date.now()}`, "content"),
        run.id,
        kind,
        value,
        this.hmac(original, "content-original"), "v1", new Date(Date.now() + (policy.retentionDays ?? 7)*86400000).toISOString(), storedBytes,
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
}

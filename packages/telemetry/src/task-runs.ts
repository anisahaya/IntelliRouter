import { createHmac } from "node:crypto";
import {
  type DatasetManifest,
  type DatasetSeedRecord,
  datasetManifestSchema,
  datasetSeedRecordSchema,
  type EvidenceSignal,
  type HarnessRouteRecord,
  type LocalEmbedding,
  localEmbeddingSchema,
  reasonCategorySchema,
  reduceEvidence,
  type SafeReceipt,
  safeReceiptSchema,
  type TaskRun,
  type TaskRunAttempt,
  taskRunSchema,
  type VerificationKind,
  verificationKindSchema,
} from "@model-router/contracts";
import type Database from "better-sqlite3";
import { redactTokenText, redactValue } from "./redaction.js";

const TASK_RUN_SCHEMA_VERSION = 1;
const SAFE_RECEIPT_VERSION = 1;
const BACKFILL_MARKER = "task_runs_backfill_v2";
const NATIVE_IMPORT_MARKER = "native_jsonl_import_sha_v1";
const MAX_SEED_IMPORT_RECORDS = 10_000;
const MAX_SEED_IMPORT_INPUT_BYTES = 16 * 1024 * 1024;

const now = () => new Date().toISOString();

export interface CreateTaskRunInput {
  id?: string;
  routeId: string;
  origin: TaskRun["origin"];
  taskFingerprint: string;
  workspaceFingerprint?: string;
  algorithm?: TaskRun["algorithm"];
  selectedModel?: string;
  effort?: string;
  harness?: string;
  profile?: string;
  derivedFeatures?: Record<string, unknown>;
  repoTags?: string[];
  context?: Record<string, unknown>;
  cache?: Record<string, unknown>;
  sourceId?: string;
}

export interface CompleteProcessFields {
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  tokenBasis?: "actual" | "estimated" | "unknown";
  costUsd?: number;
  costBasis?: "actual" | "estimated" | "unknown";
  pricingProvenance?: string;
  retryCount?: number;
  fallbackCount?: number;
  finalModel?: string;
  context?: Record<string, unknown>;
  cache?: Record<string, unknown>;
  partialWriteDetected?: boolean;
  safeToFallback?: boolean;
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

export interface TaskRunPrivacyPolicy {
  storePrompts?: boolean;
  storeResponses?: boolean;
  storeSource?: boolean;
  storeEmbeddings?: boolean;
  contentMaxItemBytes?: number;
  contentMaxRunBytes?: number;
  contentMaxTotalBytes?: number;
  contentRetentionDays?: number;
}

export interface SeedImportResult {
  sourceId: string;
  imported: number;
}

function parseJSONRecord(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? "{}")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseJSONArray(value: unknown): unknown[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function measurementBasis(
  rows: Array<Record<string, unknown>>,
  basisKey: string,
  valueKeys: string[],
): "actual" | "estimated" | "unknown" {
  if (rows.length === 0) return "unknown";
  if (
    rows.some(
      (row) =>
        String(row[basisKey] ?? "unknown") === "unknown" ||
        valueKeys.every((key) => row[key] == null),
    )
  )
    return "unknown";
  return rows.some((row) => String(row[basisKey]) === "estimated") ? "estimated" : "actual";
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function sumPresent(rows: Array<Record<string, unknown>>, key: string): number | undefined {
  const values = rows.flatMap((row) => {
    const value = finiteNumber(row[key]);
    return value === undefined ? [] : [value];
  });
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function routeProcess(outcome: HarnessRouteRecord["outcome"]): TaskRun["process"] {
  switch (outcome) {
    case "planned":
      return "planned";
    case "running":
    case "fallback":
      return "running";
    case "success":
    case "corrected":
      return "completed";
    case "timed-out":
      return "timed-out";
    case "abandoned":
      return "canceled";
    case "failure":
      return "failed";
  }
}

export class TaskRunStore {
  readonly database: Database.Database;
  readonly salt: string;

  readonly privacy: Required<TaskRunPrivacyPolicy>;

  constructor(database: Database.Database, salt: string, privacy: TaskRunPrivacyPolicy = {}) {
    this.database = database;
    this.salt = salt;
    this.privacy = {
      storePrompts: privacy.storePrompts ?? false,
      storeResponses: privacy.storeResponses ?? false,
      storeSource: privacy.storeSource ?? false,
      storeEmbeddings: privacy.storeEmbeddings ?? false,
      contentMaxItemBytes: privacy.contentMaxItemBytes ?? 64 * 1024,
      contentMaxRunBytes: privacy.contentMaxRunBytes ?? 128 * 1024,
      contentMaxTotalBytes: privacy.contentMaxTotalBytes ?? 50 * 1024 * 1024,
      contentRetentionDays: privacy.contentRetentionDays ?? 7,
    };
    this.backfillLegacy();
  }

  configurePrivacy(privacy: TaskRunPrivacyPolicy): void {
    this.privacy.storePrompts = privacy.storePrompts ?? this.privacy.storePrompts;
    this.privacy.storeResponses = privacy.storeResponses ?? this.privacy.storeResponses;
    this.privacy.storeSource = privacy.storeSource ?? this.privacy.storeSource;
    this.privacy.storeEmbeddings = privacy.storeEmbeddings ?? this.privacy.storeEmbeddings;
    this.privacy.contentMaxItemBytes =
      privacy.contentMaxItemBytes ?? this.privacy.contentMaxItemBytes;
    this.privacy.contentMaxRunBytes = privacy.contentMaxRunBytes ?? this.privacy.contentMaxRunBytes;
    this.privacy.contentMaxTotalBytes =
      privacy.contentMaxTotalBytes ?? this.privacy.contentMaxTotalBytes;
    this.privacy.contentRetentionDays =
      privacy.contentRetentionDays ?? this.privacy.contentRetentionDays;
  }

  static canonical(value: unknown): string {
    return (
      JSON.stringify(value, (_, nested) =>
        nested && typeof nested === "object" && !Array.isArray(nested)
          ? Object.fromEntries(
              Object.entries(nested as Record<string, unknown>).sort(([left], [right]) =>
                left.localeCompare(right),
              ),
            )
          : nested,
      ) ?? "null"
    );
  }

  hmac(value: string, domain = "id"): string {
    return createHmac("sha256", this.salt).update(`${domain}\0`).update(value).digest("hex");
  }

  fingerprint(value: string, domain: string): string {
    return `hmac-sha256-v1:${this.hmac(value, domain)}`;
  }

  createRun(input: CreateTaskRunInput): string {
    const derivedFeatures = taskRunSchema.shape.derivedFeatures.parse(input.derivedFeatures ?? {});
    const repoTags = taskRunSchema.shape.repoTags.parse(input.repoTags ?? []);
    const context = taskRunSchema.shape.context.parse(input.context ?? {});
    const cache = taskRunSchema.shape.cache.parse(input.cache ?? {});
    const id = input.id ?? this.hmac(input.routeId, "task-run");
    const timestamp = now();
    this.database
      .prepare(
        `INSERT INTO task_runs (
          id, route_id, origin, schema_version, receipt_version, task_fingerprint,
          workspace_fingerprint, algorithm, derived_features_json, repo_tags_json,
          selected_model, effort, harness, profile, context_json, cache_json, process,
          verification, disposition, label_value, label_strength, source_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', 'not-run',
          'unknown', 'unknown', 'none', ?, ?, ?)
        ON CONFLICT(route_id) DO UPDATE SET
          origin=excluded.origin,
          task_fingerprint=excluded.task_fingerprint,
          workspace_fingerprint=excluded.workspace_fingerprint,
          algorithm=excluded.algorithm,
          derived_features_json=excluded.derived_features_json,
          repo_tags_json=excluded.repo_tags_json,
          selected_model=COALESCE(excluded.selected_model, task_runs.selected_model),
          effort=COALESCE(excluded.effort, task_runs.effort),
          harness=COALESCE(excluded.harness, task_runs.harness),
          profile=COALESCE(excluded.profile, task_runs.profile),
          context_json=excluded.context_json,
          cache_json=excluded.cache_json,
          source_id=COALESCE(excluded.source_id, task_runs.source_id),
          updated_at=excluded.updated_at`,
      )
      .run(
        id,
        input.routeId,
        input.origin,
        TASK_RUN_SCHEMA_VERSION,
        SAFE_RECEIPT_VERSION,
        input.taskFingerprint,
        input.workspaceFingerprint ?? null,
        input.algorithm ?? "hmac-sha256-v1",
        TaskRunStore.canonical(derivedFeatures),
        TaskRunStore.canonical(repoTags),
        input.selectedModel ?? null,
        input.effort ?? null,
        input.harness ?? null,
        input.profile ?? null,
        TaskRunStore.canonical(context),
        TaskRunStore.canonical(cache),
        input.sourceId ?? null,
        timestamp,
        timestamp,
      );
    return id;
  }

  completeProcess(
    routeId: string,
    process: TaskRun["process"],
    fields: CompleteProcessFields = {},
  ): void {
    const terminal = ["completed", "failed", "timed-out", "canceled"].includes(process);
    const context =
      fields.context === undefined
        ? undefined
        : taskRunSchema.shape.context.parse(fields.context ?? {});
    const cache =
      fields.cache === undefined ? undefined : taskRunSchema.shape.cache.parse(fields.cache ?? {});
    const result = this.database
      .prepare(
        `UPDATE task_runs SET
          process=?,
          selected_model=COALESCE(?, selected_model),
          context_json=COALESCE(?, context_json),
          cache_json=COALESCE(?, cache_json),
          input_tokens=COALESCE(?, input_tokens),
          output_tokens=COALESCE(?, output_tokens),
          cache_read_tokens=COALESCE(?, cache_read_tokens),
          cache_write_tokens=COALESCE(?, cache_write_tokens),
          token_basis=COALESCE(?, token_basis),
          latency_ms=COALESCE(?, latency_ms),
          cost_usd=COALESCE(?, cost_usd),
          cost_basis=COALESCE(?, cost_basis),
          pricing_provenance=COALESCE(?, pricing_provenance),
          retry_count=COALESCE(?, retry_count),
          fallback_count=COALESCE(?, fallback_count),
          process_completed_at=CASE WHEN ? THEN COALESCE(process_completed_at, ?) ELSE NULL END,
          partial_write_detected=COALESCE(?, partial_write_detected),
          safe_to_fallback=COALESCE(?, safe_to_fallback),
          updated_at=?
        WHERE route_id=?`,
      )
      .run(
        process,
        fields.finalModel ?? null,
        context === undefined ? null : TaskRunStore.canonical(context),
        cache === undefined ? null : TaskRunStore.canonical(cache),
        fields.inputTokens ?? null,
        fields.outputTokens ?? null,
        fields.cacheReadTokens ?? null,
        fields.cacheWriteTokens ?? null,
        fields.tokenBasis ?? null,
        fields.latencyMs ?? null,
        fields.costUsd ?? null,
        fields.costBasis ?? null,
        fields.pricingProvenance ?? null,
        fields.retryCount ?? null,
        fields.fallbackCount ?? null,
        terminal ? 1 : 0,
        now(),
        fields.partialWriteDetected == null ? null : fields.partialWriteDetected ? 1 : 0,
        fields.safeToFallback == null ? null : fields.safeToFallback ? 1 : 0,
        now(),
        routeId,
      );
    if (result.changes === 0) throw new Error("task run not found");
    const run = this.runId(routeId);
    if (run) this.recomputeEvidence(run);
  }

  recordAttempt(
    routeId: string,
    attempt: Omit<TaskRunAttempt, "id" | "runId" | "createdAt"> & {
      id?: string;
      createdAt?: string;
    },
  ): void {
    const runId = this.runId(routeId);
    if (!runId) throw new Error("task run not found");
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO task_run_attempts (
            id, run_id, attempt_order, model, harness, effort, outcome, retry, fallback,
            input_tokens, output_tokens, token_basis, cache_read_tokens, cache_write_tokens,
            latency_ms, cost_usd, cost_basis, pricing_provenance, error_class,
            partial_write_detected, safe_to_fallback, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id, attempt_order) DO UPDATE SET
            model=excluded.model,
            harness=excluded.harness,
            effort=excluded.effort,
            outcome=excluded.outcome,
            retry=excluded.retry,
            fallback=excluded.fallback,
            input_tokens=excluded.input_tokens,
            output_tokens=excluded.output_tokens,
            token_basis=excluded.token_basis,
            cache_read_tokens=excluded.cache_read_tokens,
            cache_write_tokens=excluded.cache_write_tokens,
            latency_ms=excluded.latency_ms,
            cost_usd=excluded.cost_usd,
            cost_basis=excluded.cost_basis,
            pricing_provenance=excluded.pricing_provenance,
            error_class=excluded.error_class,
            partial_write_detected=excluded.partial_write_detected,
            safe_to_fallback=excluded.safe_to_fallback,
            created_at=excluded.created_at`,
        )
        .run(
          attempt.id ?? this.hmac(`${routeId}:${attempt.attemptOrder}`, "attempt"),
          runId,
          attempt.attemptOrder,
          attempt.model ?? null,
          attempt.harness ?? null,
          attempt.effort ?? null,
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
          attempt.createdAt ?? now(),
        );
      this.aggregateAttempts(runId);
    })();
  }

  verify(
    routeId: string,
    verification: {
      kind: VerificationKind;
      result: "not-run" | "passed" | "failed" | "inconclusive";
      checkName: string;
      latencyMs?: number;
      evidenceHash?: string;
    },
  ): void {
    const runId = this.runId(routeId);
    if (!runId) throw new Error("task run not found");
    const kind = verificationKindSchema.parse(verification.kind);
    const checkName = verification.checkName.trim();
    if (checkName.length === 0 || checkName.length > 128)
      throw new Error("checkName must contain 1 to 128 characters");
    const evidenceHash = verification.evidenceHash?.slice(0, 256);
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT OR IGNORE INTO task_run_verifications (
            id, run_id, kind, result, check_name_hmac, latency_ms, evidence_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.hmac(
            `${routeId}:${kind}:${checkName}:${verification.result}:${evidenceHash ?? ""}`,
            "verification",
          ),
          runId,
          kind,
          verification.result,
          this.hmac(checkName, "check-name"),
          verification.latencyMs ?? null,
          evidenceHash ?? null,
          now(),
        );
      this.recomputeEvidence(runId);
    })();
  }

  event(routeId: string, kind: string, payload: Record<string, unknown> = {}): void {
    const runId = this.runId(routeId);
    if (!runId) throw new Error("task run not found");
    const safePayload = this.safeEventPayload(kind, payload);
    this.database.transaction(() => {
      this.database
        .prepare(
          "INSERT OR IGNORE INTO task_run_events(id,run_id,kind,payload_json,created_at) VALUES (?,?,?,?,?)",
        )
        .run(
          this.hmac(`${routeId}:${kind}:${TaskRunStore.canonical(safePayload)}`, "event"),
          runId,
          kind,
          TaskRunStore.canonical(safePayload),
          now(),
        );
      this.recomputeEvidence(runId);
    })();
  }

  content(
    routeId: string,
    kind: "prompt" | "response" | "source",
    value: string,
    policy: ContentPolicy = {},
  ): boolean {
    const kindEnabled =
      kind === "prompt"
        ? this.privacy.storePrompts
        : kind === "response"
          ? this.privacy.storeResponses
          : this.privacy.storeSource;
    if (!kindEnabled || policy.enabled === false) return false;
    const maxItemBytes = Math.min(
      policy.maxItemBytes ?? this.privacy.contentMaxItemBytes,
      this.privacy.contentMaxItemBytes,
    );
    const maxRunBytes = Math.min(
      policy.maxRunBytes ?? this.privacy.contentMaxRunBytes,
      this.privacy.contentMaxRunBytes,
    );
    const maxTotalBytes = Math.min(
      policy.maxTotalBytes ?? this.privacy.contentMaxTotalBytes,
      this.privacy.contentMaxTotalBytes,
    );
    const retentionDays = Math.min(
      policy.retentionDays ?? this.privacy.contentRetentionDays,
      this.privacy.contentRetentionDays,
    );
    if (
      !Number.isInteger(maxItemBytes) ||
      !Number.isInteger(maxRunBytes) ||
      !Number.isInteger(maxTotalBytes) ||
      !Number.isInteger(retentionDays) ||
      maxItemBytes <= 0 ||
      maxItemBytes > maxRunBytes ||
      maxRunBytes > maxTotalBytes ||
      retentionDays <= 0
    )
      throw new Error("invalid task-run content policy");
    const runId = this.runId(routeId);
    if (!runId) throw new Error("task run not found");
    const originalHmac = this.hmac(value, "content-original");
    let redacted: string;
    try {
      const valueRedacted = redactValue(value);
      if (typeof valueRedacted !== "string") return false;
      redacted = redactTokenText(valueRedacted);
    } catch {
      return false;
    }
    const bounded = truncateUtf8(redacted, maxItemBytes);
    const storedBytes = Buffer.byteLength(bounded, "utf8");
    const id = this.hmac(`${routeId}:${kind}:${originalHmac}`, "content");
    return this.database.transaction(() => {
      this.database.prepare("DELETE FROM task_run_content WHERE expires_at <= ?").run(now());
      if (this.database.prepare("SELECT 1 FROM task_run_content WHERE id=?").get(id)) return true;
      const total = this.database
        .prepare("SELECT COALESCE(SUM(stored_bytes),0) AS bytes FROM task_run_content")
        .get() as { bytes: number };
      const runTotal = this.database
        .prepare(
          "SELECT COALESCE(SUM(stored_bytes),0) AS bytes FROM task_run_content WHERE run_id=?",
        )
        .get(runId) as { bytes: number };
      if (total.bytes + storedBytes > maxTotalBytes || runTotal.bytes + storedBytes > maxRunBytes)
        return false;
      this.database
        .prepare(
          `INSERT INTO task_run_content (
            id, run_id, kind, content, original_hmac, redaction_version,
            expires_at, stored_bytes, created_at
          ) VALUES (?, ?, ?, ?, ?, 'v1', ?, ?, ?)`,
        )
        .run(
          id,
          runId,
          kind,
          bounded,
          originalHmac,
          new Date(Date.now() + retentionDays * 86_400_000).toISOString(),
          storedBytes,
          now(),
        );
      return true;
    })();
  }

  embedding(routeId: string, embeddingInput: LocalEmbedding, enabled?: boolean): boolean {
    if (!this.privacy.storeEmbeddings || enabled === false) return false;
    const embedding = localEmbeddingSchema.parse(embeddingInput);
    const runId = this.runId(routeId);
    if (!runId) throw new Error("task run not found");
    const values = Buffer.from(new Float32Array(embedding.values).buffer);
    this.database
      .prepare(
        `INSERT INTO task_run_embeddings (
          id, run_id, model, normalized, dimensions, values_blob, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, model) DO UPDATE SET
          normalized=excluded.normalized,
          dimensions=excluded.dimensions,
          values_blob=excluded.values_blob,
          created_at=excluded.created_at`,
      )
      .run(
        this.hmac(`${routeId}:${embedding.model}`, "embedding"),
        runId,
        embedding.model,
        embedding.normalized ? 1 : 0,
        embedding.dimensions,
        values,
        now(),
      );
    return true;
  }

  receipt(routeId: string): SafeReceipt | undefined {
    const row = this.database.prepare("SELECT * FROM task_runs WHERE route_id=?").get(routeId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    const attempts = this.database
      .prepare("SELECT COUNT(*) AS count FROM task_run_attempts WHERE run_id=?")
      .get(row.id) as { count: number };
    const receipt = {
      routeId: String(row.route_id),
      runId: String(row.id),
      origin: row.origin,
      schemaVersion: Number(row.schema_version),
      receiptVersion: Number(row.receipt_version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      processCompletedAt: row.process_completed_at ? String(row.process_completed_at) : undefined,
      taskFingerprint: String(row.task_fingerprint),
      workspaceFingerprint: row.workspace_fingerprint
        ? String(row.workspace_fingerprint)
        : undefined,
      algorithm: row.algorithm,
      derivedFeatures: taskRunSchema.shape.derivedFeatures.parse(
        parseJSONRecord(row.derived_features_json),
      ),
      repoTags: taskRunSchema.shape.repoTags.parse(parseJSONArray(row.repo_tags_json)),
      selectedModel: row.selected_model ? String(row.selected_model) : undefined,
      effort: row.effort ? String(row.effort) : undefined,
      harness: row.harness ? String(row.harness) : undefined,
      profile: row.profile ? String(row.profile) : undefined,
      context: taskRunSchema.shape.context.parse(parseJSONRecord(row.context_json)),
      cache: taskRunSchema.shape.cache.parse(parseJSONRecord(row.cache_json)),
      inputTokens: row.input_tokens == null ? undefined : Number(row.input_tokens),
      outputTokens: row.output_tokens == null ? undefined : Number(row.output_tokens),
      cacheReadTokens: row.cache_read_tokens == null ? undefined : Number(row.cache_read_tokens),
      cacheWriteTokens: row.cache_write_tokens == null ? undefined : Number(row.cache_write_tokens),
      tokenBasis: row.token_basis,
      latencyMs: row.latency_ms == null ? undefined : Number(row.latency_ms),
      costUsd: row.cost_usd == null ? undefined : Number(row.cost_usd),
      costBasis: row.cost_basis,
      pricingProvenance: row.pricing_provenance ? String(row.pricing_provenance) : undefined,
      retryCount: Number(row.retry_count),
      fallbackCount: Number(row.fallback_count),
      attemptCount: attempts.count,
      process: row.process,
      verification: row.verification,
      verificationCount: Number(row.verification_count),
      disposition: row.disposition,
      labelValue: row.label_value,
      labelStrength: row.label_strength,
      partialWriteDetected: Boolean(row.partial_write_detected),
      safeToFallback: Boolean(row.safe_to_fallback),
    };
    return safeReceiptSchema.parse(receipt);
  }

  async importSeedDataset(
    manifestInput: DatasetManifest,
    input: AsyncIterable<DatasetSeedRecord>,
  ): Promise<SeedImportResult> {
    const manifest = datasetManifestSchema.parse(manifestInput);
    const records: DatasetSeedRecord[] = [];
    let inputBytes = 0;
    for await (const candidate of input) {
      if (records.length >= MAX_SEED_IMPORT_RECORDS)
        throw new Error(`seed import exceeds ${MAX_SEED_IMPORT_RECORDS} records`);
      const record = datasetSeedRecordSchema.parse(candidate);
      inputBytes += Buffer.byteLength(record.input, "utf8");
      if (inputBytes > MAX_SEED_IMPORT_INPUT_BYTES)
        throw new Error(`seed import exceeds ${MAX_SEED_IMPORT_INPUT_BYTES} input bytes`);
      records.push(record);
    }
    const manifestCanonical = TaskRunStore.canonical(manifest);
    const sourceId = this.hmac(manifestCanonical, "dataset-source");
    const modelPair = TaskRunStore.canonical(manifest.modelPair);
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO dataset_imports (
            id, provenance, revision, license, canonical_uri, model_pair_json,
            label_semantics, manifest_hmac, record_count, imported_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
          ON CONFLICT(id) DO UPDATE SET imported_at=excluded.imported_at`,
        )
        .run(
          sourceId,
          manifest.provenance,
          manifest.revision,
          manifest.license,
          manifest.canonicalUri ?? null,
          modelPair,
          manifest.labelSemantics,
          this.hmac(manifestCanonical, "dataset-manifest"),
          now(),
        );
      for (const record of records) {
        const externalIdHmac = this.hmac(
          `${manifest.provenance}\0${manifest.revision}\0${modelPair}\0${record.externalId}`,
          "dataset-external-id",
        );
        const routeId = `import:${externalIdHmac}`;
        this.createRun({
          routeId,
          origin: "imported",
          taskFingerprint: this.fingerprint(record.input, "imported-task"),
          algorithm: "hmac-sha256-v1",
          selectedModel: undefined,
          derivedFeatures: {
            sourceScoped: true,
            labelSemantics: manifest.labelSemantics.slice(0, 512),
          },
          repoTags: [],
          sourceId,
        });
        const strength = record.label === "unknown" ? "none" : "attested";
        this.event(routeId, "imported-preference", {
          label: record.label,
          strength,
        });
        this.database
          .prepare(
            `INSERT OR IGNORE INTO dataset_import_records (
              import_id, external_id_hmac, route_id, label, strength, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(sourceId, externalIdHmac, routeId, record.label, strength, now());
      }
      this.database
        .prepare(
          `UPDATE dataset_imports SET record_count=(
            SELECT COUNT(*) FROM dataset_import_records WHERE import_id=?
          ) WHERE id=?`,
        )
        .run(sourceId, sourceId);
    })();
    const count = this.database
      .prepare("SELECT record_count AS count FROM dataset_imports WHERE id=?")
      .get(sourceId) as { count: number };
    return { sourceId, imported: count.count };
  }

  importLegacyNativeRoutes(records: HarnessRouteRecord[], sourceHash: string): number {
    const current = this.database
      .prepare("SELECT value FROM installation_metadata WHERE key=?")
      .get(NATIVE_IMPORT_MARKER) as { value: string } | undefined;
    if (current?.value === sourceHash) return 0;
    const latest = new Map<string, HarnessRouteRecord>();
    for (const record of records) latest.set(record.routeId, record);
    this.database.transaction(() => {
      for (const record of latest.values()) {
        const runId = this.hmac(record.routeId, "task-run");
        this.database
          .prepare(
            `INSERT OR IGNORE INTO task_runs (
              id, route_id, origin, schema_version, receipt_version, task_fingerprint,
              workspace_fingerprint, algorithm, derived_features_json, repo_tags_json,
              selected_model, effort, harness, profile, context_json, cache_json, process,
              verification, disposition, label_value, label_strength, partial_write_detected,
              safe_to_fallback, created_at, updated_at
            ) VALUES (?, ?, 'native', ?, ?, ?, ?, 'legacy-sha256-v0', ?, '[]', ?, ?, ?, ?, '{}',
              '{}', ?, 'not-run', 'unknown', 'unknown', 'none', ?, ?, ?, ?)`,
          )
          .run(
            runId,
            record.routeId,
            TASK_RUN_SCHEMA_VERSION,
            SAFE_RECEIPT_VERSION,
            `legacy-sha256-v0:${record.taskFingerprint}`,
            `legacy-sha256-v0:${record.workspaceFingerprint}`,
            TaskRunStore.canonical(record.featureSummary),
            record.selectedCandidate ?? null,
            record.reasoningEffort ?? null,
            record.harness,
            record.profile,
            routeProcess(record.outcome),
            record.partialWriteDetected ? 1 : 0,
            record.partialWriteDetected ? 0 : 1,
            record.createdAt,
            record.updatedAt,
          );
        this.database
          .prepare(
            `UPDATE task_runs SET
              process=?,
              selected_model=COALESCE(?, selected_model),
              effort=COALESCE(?, effort),
              harness=?,
              profile=?,
              partial_write_detected=?,
              safe_to_fallback=?,
              process_completed_at=CASE
                WHEN ? IN ('completed','failed','timed-out','canceled') THEN ?
                ELSE NULL
              END,
              updated_at=?
            WHERE route_id=?`,
          )
          .run(
            routeProcess(record.outcome),
            record.selectedCandidate ?? null,
            record.reasoningEffort ?? null,
            record.harness,
            record.profile,
            record.partialWriteDetected ? 1 : 0,
            record.partialWriteDetected ? 0 : 1,
            routeProcess(record.outcome),
            record.updatedAt,
            record.updatedAt,
            record.routeId,
          );
        if (record.outcome === "corrected" || record.outcome === "abandoned") {
          this.event(record.routeId, "feedback", {
            outcome: record.outcome,
            reasonCategory: "unknown",
          });
        } else {
          this.recomputeEvidence(runId);
        }
      }
      this.database
        .prepare("INSERT OR REPLACE INTO installation_metadata(key,value) VALUES (?,?)")
        .run(NATIVE_IMPORT_MARKER, sourceHash);
    })();
    return latest.size;
  }

  private runId(routeId: string): string | undefined {
    const row = this.database.prepare("SELECT id FROM task_runs WHERE route_id=?").get(routeId) as
      | { id: string }
      | undefined;
    return row?.id;
  }

  private safeEventPayload(
    kind: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    if (kind === "feedback") {
      const outcome = String(payload.outcome ?? "");
      if (!["success", "failure", "corrected", "abandoned", "reverted"].includes(outcome))
        throw new Error("invalid feedback outcome");
      const reasonCategory = reasonCategorySchema.parse(payload.reasonCategory ?? "unknown");
      const tags = taskRunSchema.shape.repoTags.parse(
        Array.isArray(payload.tags) ? payload.tags : [],
      );
      const score = payload.score == null ? undefined : Number(payload.score);
      if (score !== undefined && (!Number.isFinite(score) || score < 0 || score > 1))
        throw new Error("feedback score must be between 0 and 1");
      return { outcome, reasonCategory, tags, ...(score === undefined ? {} : { score }) };
    }
    if (kind === "imported-preference") {
      const label = String(payload.label ?? "unknown");
      if (!["unknown", "correct", "incorrect", "mixed"].includes(label))
        throw new Error("invalid imported label");
      return { label, strength: label === "unknown" ? "none" : "attested" };
    }
    if (kind === "comparison") {
      const label = String(payload.label ?? "unknown");
      if (!["correct", "incorrect", "mixed"].includes(label))
        throw new Error("invalid comparison label");
      return { label, strength: "comparative" };
    }
    return {};
  }

  private aggregateAttempts(runId: string): void {
    const rows = this.database
      .prepare("SELECT * FROM task_run_attempts WHERE run_id=? ORDER BY attempt_order")
      .all(runId) as Array<Record<string, unknown>>;
    const tokenBasis = measurementBasis(rows, "token_basis", [
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
    ]);
    const costBasis = measurementBasis(rows, "cost_basis", ["cost_usd"]);
    const pricing = [
      ...new Set(
        rows.flatMap((row) =>
          row.pricing_provenance == null ? [] : [String(row.pricing_provenance)],
        ),
      ),
    ];
    this.database
      .prepare(
        `UPDATE task_runs SET
          input_tokens=?,
          output_tokens=?,
          cache_read_tokens=?,
          cache_write_tokens=?,
          token_basis=?,
          latency_ms=?,
          cost_usd=?,
          cost_basis=?,
          pricing_provenance=?,
          retry_count=?,
          fallback_count=?,
          partial_write_detected=?,
          safe_to_fallback=?,
          updated_at=?
        WHERE id=?`,
      )
      .run(
        sumPresent(rows, "input_tokens") ?? null,
        sumPresent(rows, "output_tokens") ?? null,
        sumPresent(rows, "cache_read_tokens") ?? null,
        sumPresent(rows, "cache_write_tokens") ?? null,
        tokenBasis,
        sumPresent(rows, "latency_ms") ?? null,
        sumPresent(rows, "cost_usd") ?? null,
        costBasis,
        pricing.length === 1 ? pricing[0] : null,
        rows.filter((row) => Boolean(row.retry)).length,
        rows.filter((row) => Boolean(row.fallback)).length,
        rows.some((row) => Boolean(row.partial_write_detected)) ? 1 : 0,
        rows.every((row) => Boolean(row.safe_to_fallback)) ? 1 : 0,
        now(),
        runId,
      );
  }

  private recomputeEvidence(runId: string): void {
    const run = this.database
      .prepare("SELECT process,disposition FROM task_runs WHERE id=?")
      .get(runId) as
      | { process: TaskRun["process"]; disposition: TaskRun["disposition"] }
      | undefined;
    if (!run) return;
    const signals: EvidenceSignal[] = [];
    const verifications = this.database
      .prepare(
        "SELECT kind,result,created_at FROM task_run_verifications WHERE run_id=? ORDER BY created_at,id",
      )
      .all(runId) as Array<{ kind: VerificationKind; result: string; created_at: string }>;
    for (const verification of verifications) {
      const verified = verification.kind !== "human-review";
      if (verification.result === "inconclusive") {
        if (verified)
          signals.push({
            strength: "verified",
            verification: "inconclusive",
          });
        continue;
      }
      if (!["passed", "failed"].includes(verification.result)) continue;
      signals.push({
        polarity: verification.result === "passed" ? "correct" : "incorrect",
        strength: verified ? "verified" : "attested",
        verification: verified
          ? verification.result === "passed"
            ? "passed"
            : "failed"
          : undefined,
      });
    }
    let disposition = run.disposition;
    const events = this.database
      .prepare(
        "SELECT kind,payload_json,created_at FROM task_run_events WHERE run_id=? ORDER BY created_at,id",
      )
      .all(runId) as Array<{ kind: string; payload_json: string; created_at: string }>;
    for (const event of events) {
      const payload = parseJSONRecord(event.payload_json);
      if (event.kind === "feedback") {
        const outcome = String(payload.outcome ?? "");
        const reasonCategory = String(payload.reasonCategory ?? "unknown");
        if (outcome === "success") {
          disposition = "accepted";
          signals.push({ polarity: "correct", strength: "attested", disposition });
        } else if (outcome === "failure") {
          signals.push({ polarity: "incorrect", strength: "attested" });
        } else if (outcome === "corrected") {
          disposition = "corrected";
          signals.push({ polarity: "incorrect", strength: "attested", disposition });
        } else if (outcome === "reverted") {
          disposition = "reverted";
          signals.push({ polarity: "incorrect", strength: "attested", disposition });
        } else if (outcome === "abandoned") {
          disposition = "abandoned";
          if (["correctness", "instruction"].includes(reasonCategory))
            signals.push({ polarity: "incorrect", strength: "attested", disposition });
        }
      } else if (event.kind === "imported-preference") {
        const label = String(payload.label ?? "unknown");
        if (label === "correct" || label === "incorrect")
          signals.push({ polarity: label, strength: "attested" });
        else if (label === "mixed")
          signals.push(
            { polarity: "correct", strength: "attested" },
            { polarity: "incorrect", strength: "attested" },
          );
      } else if (event.kind === "comparison") {
        const label = String(payload.label ?? "unknown");
        if (label === "correct" || label === "incorrect")
          signals.push({ polarity: label, strength: "comparative" });
        else if (label === "mixed")
          signals.push(
            { polarity: "correct", strength: "comparative" },
            { polarity: "incorrect", strength: "comparative" },
          );
      }
    }
    const reduced = reduceEvidence({
      process: run.process,
      signals,
      fallbackDisposition: disposition,
    });
    this.database
      .prepare(
        `UPDATE task_runs SET
          verification=?,
          verification_count=?,
          disposition=?,
          label_value=?,
          label_strength=?,
          updated_at=?
        WHERE id=?`,
      )
      .run(
        reduced.verification,
        verifications.length,
        reduced.disposition,
        reduced.labelValue,
        reduced.labelStrength,
        now(),
        runId,
      );
  }

  private backfillLegacy(): void {
    const marker = this.database
      .prepare("SELECT value FROM installation_metadata WHERE key=?")
      .get(BACKFILL_MARKER) as { value: string } | undefined;
    if (marker) return;
    this.database.transaction(() => {
      const decisions = this.database.prepare("SELECT * FROM route_decisions").all() as Array<
        Record<string, unknown>
      >;
      for (const decision of decisions) {
        const features = parseJSONRecord(decision.features_json);
        this.database
          .prepare(
            `INSERT OR IGNORE INTO task_runs (
              id, route_id, origin, schema_version, receipt_version, task_fingerprint,
              algorithm, derived_features_json, repo_tags_json, context_json, cache_json,
              selected_model, profile, process, verification, disposition, label_value,
              label_strength, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'hmac-sha256-v1', ?, '[]', '{}', '{}', ?, ?, 'planned',
              'not-run', 'unknown', 'unknown', 'none', ?, ?)`,
          )
          .run(
            this.hmac(String(decision.id), "task-run"),
            decision.id,
            ["compatibility", "dry_run"].includes(String(decision.kind))
              ? "compatibility"
              : "imported",
            TASK_RUN_SCHEMA_VERSION,
            SAFE_RECEIPT_VERSION,
            this.fingerprint(TaskRunStore.canonical(features), "task-fingerprint"),
            TaskRunStore.canonical(features),
            decision.logical_model ?? null,
            decision.profile ?? null,
            decision.created_at,
            decision.created_at,
          );
      }
      const metrics = this.database.prepare("SELECT * FROM request_metrics").all() as Array<
        Record<string, unknown>
      >;
      for (const metric of metrics) {
        const outcome = String(metric.outcome ?? "");
        const status = Number(metric.status);
        const process: TaskRun["process"] =
          outcome === "canceled"
            ? "canceled"
            : outcome === "failure" || status >= 400
              ? "failed"
              : status >= 200 && status < 400
                ? "completed"
                : "failed";
        const inputTokens =
          Number(metric.input_tokens) > 0 ? Number(metric.input_tokens) : undefined;
        const outputTokens =
          Number(metric.output_tokens) > 0 ? Number(metric.output_tokens) : undefined;
        this.database
          .prepare(
            `UPDATE task_runs SET
              process=?,
              selected_model=COALESCE(?, selected_model),
              input_tokens=?,
              output_tokens=?,
              token_basis=?,
              latency_ms=?,
              cost_usd=?,
              cost_basis='estimated',
              fallback_count=?,
              process_completed_at=?,
              updated_at=?
            WHERE route_id=?`,
          )
          .run(
            process,
            metric.final_model ?? null,
            inputTokens ?? null,
            outputTokens ?? null,
            inputTokens !== undefined || outputTokens !== undefined ? "actual" : "unknown",
            metric.latency_ms,
            metric.estimated_cost_usd,
            metric.fallback_count ?? 0,
            metric.created_at,
            metric.created_at,
            metric.route_id,
          );
      }
      const attempts = this.database
        .prepare("SELECT * FROM provider_attempts ORDER BY route_id,attempt_order")
        .all() as Array<Record<string, unknown>>;
      const affectedRuns = new Set<string>();
      for (const attempt of attempts) {
        const runId = this.runId(String(attempt.route_id));
        if (!runId) continue;
        affectedRuns.add(runId);
        const inputTokens =
          Number(attempt.input_tokens) > 0 ? Number(attempt.input_tokens) : undefined;
        const outputTokens =
          Number(attempt.output_tokens) > 0 ? Number(attempt.output_tokens) : undefined;
        const order = Number(attempt.attempt_order);
        this.database
          .prepare(
            `INSERT INTO task_run_attempts (
              id, run_id, attempt_order, model, outcome, retry, fallback, input_tokens,
              output_tokens, token_basis, latency_ms, cost_usd, cost_basis, error_class,
              partial_write_detected, safe_to_fallback, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'estimated', ?, 0, ?, ?)
            ON CONFLICT(run_id, attempt_order) DO NOTHING`,
          )
          .run(
            this.hmac(`${attempt.route_id}:${order}`, "attempt"),
            runId,
            order,
            attempt.model_id,
            attempt.outcome === "success"
              ? "completed"
              : attempt.outcome === "canceled"
                ? "canceled"
                : "failed",
            order > 1 ? 1 : 0,
            order > 1 ? 1 : 0,
            inputTokens ?? null,
            outputTokens ?? null,
            inputTokens !== undefined || outputTokens !== undefined ? "actual" : "unknown",
            attempt.latency_ms,
            attempt.estimated_cost_usd,
            attempt.error_class ?? null,
            attempt.bytes_emitted ? 0 : 1,
            attempt.created_at,
          );
      }
      for (const runId of affectedRuns) this.aggregateAttempts(runId);
      const feedback = this.database
        .prepare("SELECT * FROM feedback_events ORDER BY id")
        .all() as Array<Record<string, unknown>>;
      for (const item of feedback) {
        const runId = this.runId(String(item.route_id));
        if (!runId) continue;
        const payload = this.safeEventPayload("feedback", {
          outcome: item.outcome,
          score: item.score,
          tags: parseJSONArray(item.tags_json),
          reasonCategory: "unknown",
        });
        this.database
          .prepare(
            "INSERT OR IGNORE INTO task_run_events(id,run_id,kind,payload_json,created_at) VALUES (?,?,?,?,?)",
          )
          .run(
            this.hmac(`legacy-feedback:${item.id}`, "event"),
            runId,
            "feedback",
            TaskRunStore.canonical(payload),
            item.created_at,
          );
      }
      for (const decision of decisions) {
        const runId = this.runId(String(decision.id));
        if (runId) this.recomputeEvidence(runId);
      }
      this.database
        .prepare("INSERT OR REPLACE INTO installation_metadata(key,value) VALUES (?,?)")
        .run(BACKFILL_MARKER, now());
    })();
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

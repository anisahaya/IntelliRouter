import { z } from "zod";

export const taskRunOriginSchema = z.enum(["compatibility", "native", "imported", "evaluation"]);
export const processStateSchema = z.enum([
  "planned",
  "running",
  "completed",
  "failed",
  "timed-out",
  "canceled",
]);
export const verificationStateSchema = z.enum(["not-run", "passed", "failed", "inconclusive"]);
export const dispositionSchema = z.enum([
  "unknown",
  "accepted",
  "corrected",
  "abandoned",
  "reverted",
]);
export const measurementBasisSchema = z.enum(["actual", "estimated", "unknown"]);
export const labelStrengthSchema = z.enum([
  "none",
  "operational",
  "attested",
  "verified",
  "comparative",
]);
export const labelValueSchema = z.enum(["unknown", "correct", "incorrect", "mixed"]);
export const verificationKindSchema = z.enum([
  "acceptance",
  "public-test",
  "held-out-test",
  "human-review",
]);
export type VerificationKind = z.infer<typeof verificationKindSchema>;
export const reasonCategorySchema = z.enum([
  "correctness",
  "instruction",
  "cost",
  "latency",
  "changed-scope",
  "user-choice",
  "unknown",
]);

const boundedRecordSchema = z
  .record(z.string().max(64), z.unknown())
  .refine(
    (value) =>
      Object.keys(value).length <= 64 &&
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= 16 * 1024,
    "record must contain at most 64 keys and 16 KiB of JSON",
  );
const repositoryTagSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: "repository tags cannot contain control characters",
  });

export const taskRunSchema = z.object({
  id: z.string().min(1).max(256),
  routeId: z.string().min(1).max(256),
  origin: taskRunOriginSchema,
  taskFingerprint: z.string().min(1).max(256),
  workspaceFingerprint: z.string().min(1).max(256).optional(),
  algorithm: z.enum(["hmac-sha256-v1", "legacy-sha256-v0"]),
  derivedFeatures: boundedRecordSchema.default({}),
  repoTags: z.array(repositoryTagSchema).max(16).default([]),
  selectedModel: z.string().max(256).optional(),
  effort: z.string().max(64).optional(),
  harness: z.string().max(64).optional(),
  profile: z.string().max(64).optional(),
  context: boundedRecordSchema.default({}),
  cache: boundedRecordSchema.default({}),
  process: processStateSchema,
  verification: verificationStateSchema,
  disposition: dispositionSchema,
  labelValue: labelValueSchema,
  labelStrength: labelStrengthSchema,
  partialWriteDetected: z.boolean().default(false),
  safeToFallback: z.boolean().default(true),
  schemaVersion: z.number().int().positive().default(1),
  receiptVersion: z.number().int().positive().default(1),
  processCompletedAt: z.string().optional(),
  verificationCount: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaskRun = z.infer<typeof taskRunSchema>;

const taskRunAttemptSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  attemptOrder: z.number().int().nonnegative(),
  model: z.string().optional(),
  harness: z.string().optional(),
  effort: z.string().optional(),
  outcome: processStateSchema,
  retry: z.boolean().default(false),
  fallback: z.boolean().default(false),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  tokenBasis: measurementBasisSchema.default("unknown"),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  latencyMs: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  costBasis: measurementBasisSchema.default("unknown"),
  pricingProvenance: z.string().optional(),
  errorClass: z.string().optional(),
  partialWriteDetected: z.boolean().default(false),
  safeToFallback: z.boolean().default(true),
  createdAt: z.string(),
});
export type TaskRunAttempt = z.infer<typeof taskRunAttemptSchema>;

const taskRunVerificationSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  kind: verificationKindSchema,
  result: verificationStateSchema,
  checkName: z.string().max(128),
  latencyMs: z.number().nonnegative().optional(),
  evidenceHash: z.string().optional(),
  createdAt: z.string(),
});
export type TaskRunVerification = z.infer<typeof taskRunVerificationSchema>;
const taskRunEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  kind: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
});
export type TaskRunEvent = z.infer<typeof taskRunEventSchema>;
export const safeReceiptSchema = z.object({
  routeId: z.string(),
  runId: z.string(),
  origin: taskRunOriginSchema,
  schemaVersion: z.number().int().positive(),
  receiptVersion: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  processCompletedAt: z.string().optional(),
  taskFingerprint: z.string(),
  workspaceFingerprint: z.string().optional(),
  algorithm: z.enum(["hmac-sha256-v1", "legacy-sha256-v0"]),
  derivedFeatures: boundedRecordSchema,
  repoTags: z.array(repositoryTagSchema).max(16),
  selectedModel: z.string().optional(),
  effort: z.string().optional(),
  harness: z.string().optional(),
  profile: z.string().optional(),
  context: boundedRecordSchema,
  cache: boundedRecordSchema,
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  tokenBasis: measurementBasisSchema,
  latencyMs: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  costBasis: measurementBasisSchema,
  pricingProvenance: z.string().optional(),
  retryCount: z.number().int().nonnegative(),
  fallbackCount: z.number().int().nonnegative(),
  attemptCount: z.number().int().nonnegative(),
  process: processStateSchema,
  verification: verificationStateSchema,
  verificationCount: z.number().int().nonnegative(),
  disposition: dispositionSchema,
  labelValue: labelValueSchema,
  labelStrength: labelStrengthSchema,
  partialWriteDetected: z.boolean(),
  safeToFallback: z.boolean(),
});
export type SafeReceipt = z.infer<typeof safeReceiptSchema>;

export const datasetManifestSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  provenance: z.string().min(1).max(256),
  revision: z.string().min(1).max(256),
  license: z.string().min(1).max(256),
  canonicalUri: z.string().url().max(2_048).optional(),
  modelPair: z.object({
    source: z.string().min(1).max(256),
    target: z.string().min(1).max(256),
  }),
  labelSemantics: z.string().min(1).max(1_024),
});
export type DatasetManifest = z.infer<typeof datasetManifestSchema>;
export const datasetSeedRecordSchema = z.object({
  externalId: z.string().min(1).max(256),
  input: z
    .string()
    .max(32_000)
    .refine((value) => new TextEncoder().encode(value).byteLength <= 32_000, {
      message: "dataset inputs cannot exceed 32,000 UTF-8 bytes",
    }),
  label: labelValueSchema,
  strength: labelStrengthSchema,
});
export type DatasetSeedRecord = z.infer<typeof datasetSeedRecordSchema>;
export const localEmbeddingSchema = z
  .object({
    locallyGenerated: z.literal(true),
    normalized: z.boolean(),
    model: z.string().min(1).max(256),
    dimensions: z.number().int().min(1).max(4096),
    values: z.array(z.number().finite()).max(4096),
  })
  .refine((value) => value.values.length === value.dimensions, {
    message: "embedding dimensions must equal the number of values",
  });
export type LocalEmbedding = z.infer<typeof localEmbeddingSchema>;

export interface EvidenceSignal {
  polarity?: "correct" | "incorrect";
  strength: z.infer<typeof labelStrengthSchema>;
  disposition?: z.infer<typeof dispositionSchema>;
  verification?: "passed" | "failed" | "inconclusive";
}

const evidenceRank: Record<z.infer<typeof labelStrengthSchema>, number> = {
  none: 0,
  operational: 1,
  attested: 2,
  verified: 3,
  comparative: 4,
};

export function reduceEvidence(input: {
  process: z.infer<typeof processStateSchema>;
  signals: EvidenceSignal[];
  fallbackDisposition?: z.infer<typeof dispositionSchema>;
}): Pick<TaskRun, "process" | "verification" | "disposition" | "labelValue" | "labelStrength"> {
  const maxRank = input.signals.reduce(
    (maximum, signal) => Math.max(maximum, evidenceRank[signal.strength]),
    0,
  );
  const strongest = input.signals.filter((signal) => evidenceRank[signal.strength] === maxRank);
  const correct = strongest.some((signal) => signal.polarity === "correct");
  const incorrect = strongest.some((signal) => signal.polarity === "incorrect");
  const independent = input.signals.filter((signal) => signal.verification);
  const verificationPassed = independent.some((signal) => signal.verification === "passed");
  const verificationFailed = independent.some((signal) => signal.verification === "failed");
  const verificationInconclusive = independent.some(
    (signal) => signal.verification === "inconclusive",
  );
  const verification = verificationPassed
    ? verificationFailed
      ? "inconclusive"
      : "passed"
    : verificationFailed
      ? "failed"
      : verificationInconclusive || (correct && incorrect)
        ? "inconclusive"
        : "not-run";
  const disposition =
    [...strongest].reverse().find((signal) => signal.disposition)?.disposition ??
    input.fallbackDisposition ??
    "unknown";
  if (correct || incorrect) {
    return {
      process: input.process,
      verification,
      disposition,
      labelValue: correct && incorrect ? "mixed" : correct ? "correct" : "incorrect",
      labelStrength: strongest[0]?.strength ?? "none",
    };
  }
  return {
    process: input.process,
    verification,
    disposition,
    labelValue: "unknown",
    labelStrength: input.process === "completed" ? "operational" : "none",
  };
}

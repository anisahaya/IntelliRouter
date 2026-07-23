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

export const taskRunSchema = z.object({
  id: z.string().min(1),
  routeId: z.string().min(1),
  origin: taskRunOriginSchema,
  taskFingerprint: z.string().min(1),
  workspaceFingerprint: z.string().min(1).optional(),
  algorithm: z.string().min(1).optional(),
  derivedFeatures: z.record(z.string(), z.unknown()).default({}),
  repoTags: z.array(z.string()).default([]),
  selectedModel: z.string().optional(),
  effort: z.string().optional(),
  harness: z.string().optional(),
  profile: z.string().optional(),
  context: z.record(z.string(), z.unknown()).default({}),
  process: processStateSchema,
  verification: verificationStateSchema,
  disposition: dispositionSchema,
  labelValue: labelValueSchema,
  labelStrength: labelStrengthSchema,
  partialWriteDetected: z.boolean().default(false),
  safeToFallback: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaskRun = z.infer<typeof taskRunSchema>;

export const taskRunAttemptSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  attemptOrder: z.number().int().nonnegative(),
  model: z.string().optional(),
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

export const taskRunVerificationSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  kind: z.string().min(1),
  result: verificationStateSchema,
  checkName: z.string().max(128),
  latencyMs: z.number().nonnegative().optional(),
  evidenceHash: z.string().optional(),
  createdAt: z.string(),
});
export type TaskRunVerification = z.infer<typeof taskRunVerificationSchema>;
export const taskRunEventSchema = z.object({
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
  process: processStateSchema,
  verification: verificationStateSchema,
  disposition: dispositionSchema,
  labelValue: labelValueSchema,
  labelStrength: labelStrengthSchema,
  partialWriteDetected: z.boolean(),
  safeToFallback: z.boolean(),
  latencyMs: z.number().nonnegative().optional(),
  attemptCount: z.number().int().nonnegative(),
});
export type SafeReceipt = z.infer<typeof safeReceiptSchema>;

export const datasetManifestSchema = z.object({
  provenance: z.string().min(1),
  revision: z.string().min(1),
  license: z.string().min(1),
  modelPair: z.object({ source: z.string().min(1), target: z.string().min(1) }),
  labelSemantics: z.string().min(1),
});
export type DatasetManifest = z.infer<typeof datasetManifestSchema>;
export const datasetSeedRecordSchema = z.object({
  externalId: z.string().min(1),
  input: z.string(),
  label: labelValueSchema,
  strength: labelStrengthSchema,
  source: z.string().optional(),
  modelPair: z.string().optional(),
});
export type DatasetSeedRecord = z.infer<typeof datasetSeedRecordSchema>;
export const localEmbeddingSchema = z.object({
  locallyGenerated: z.literal(true),
  model: z.string().min(1),
  dimensions: z.number().int().min(1).max(4096),
  values: z.array(z.number().finite()),
});
export type LocalEmbedding = z.infer<typeof localEmbeddingSchema>;

export function reduceEvidence(input: {
  process: z.infer<typeof processStateSchema>;
  verification?: z.infer<typeof verificationStateSchema>;
  origin?: z.infer<typeof taskRunOriginSchema>;
  disposition?: z.infer<typeof dispositionSchema>;
  explicitFeedback?: boolean;
  independentCheck?: boolean;
  sameHiddenCaseComparison?: boolean;
  conflict?: boolean;
}): Pick<TaskRun, "process" | "verification" | "disposition" | "labelValue" | "labelStrength"> {
  const verification = input.verification ?? "not-run";
  const failed = verification === "failed" || input.disposition === "reverted";
  const process = input.process;
  if (input.conflict)
    return {
      process,
      verification: "inconclusive",
      disposition: input.disposition ?? "unknown",
      labelValue: "mixed",
      labelStrength: "none",
    };
  if (failed)
    return {
      process,
      verification,
      disposition: input.disposition === "reverted" ? "reverted" : "unknown",
      labelValue: "incorrect",
      labelStrength: verification === "failed" && input.independentCheck ? "verified" : "none",
    };
  if (input.sameHiddenCaseComparison && verification === "passed")
    return {
      process,
      verification,
      disposition: input.disposition ?? "unknown",
      labelValue: "correct",
      labelStrength: "comparative",
    };
  if (input.independentCheck && verification === "passed")
    return {
      process,
      verification,
      disposition: input.disposition ?? "unknown",
      labelValue: "correct",
      labelStrength: "verified",
    };
  if (input.explicitFeedback)
    return {
      process,
      verification,
      disposition: input.disposition ?? "accepted",
      labelValue: "correct",
      labelStrength: "attested",
    };
  return {
    process,
    verification,
    disposition: input.disposition ?? "unknown",
    labelValue: "unknown",
    labelStrength: process === "completed" ? "operational" : "none",
  };
}

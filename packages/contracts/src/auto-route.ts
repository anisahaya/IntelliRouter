import { z } from "zod";

export const reasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const harnessIdSchema = z.enum(["codex", "opencode", "claude-code", "pi"]);
export type HarnessId = z.infer<typeof harnessIdSchema>;

export const routeOutcomeSchema = z.enum([
  "planned",
  "running",
  "success",
  "failure",
  "timed-out",
  "fallback",
  "corrected",
  "abandoned",
]);
export type RouteOutcome = z.infer<typeof routeOutcomeSchema>;

export const autoRouteProfileSchema = z.enum(["balanced", "quality", "economy", "speed"]);
export type AutoRouteProfile = z.infer<typeof autoRouteProfileSchema>;

export const repoSignalsSchema = z.object({
  rootName: z.string(),
  languages: z.array(z.object({ name: z.string(), count: z.number().int().nonnegative() })),
  fileCount: z.number().int().nonnegative(),
  testFileCount: z.number().int().nonnegative(),
  manifests: z.array(z.string()),
  changedFileCount: z.number().int().nonnegative(),
  diffInsertions: z.number().int().nonnegative(),
  diffDeletions: z.number().int().nonnegative(),
  hasTests: z.boolean(),
  monorepo: z.boolean(),
  dirty: z.boolean(),
  truncated: z.boolean().default(false),
  changedFiles: z.array(z.string()).max(128).default([]),
  topLevelDirectories: z.array(z.string()).max(64).default([]),
  dependencyNames: z.array(z.string()).max(128).default([]),
  packageCount: z.number().int().nonnegative().default(0),
  hasCi: z.boolean().default(false),
});
export type RepoSignals = z.infer<typeof repoSignalsSchema>;

export const autoTaskProfileSchema = z.object({
  taskType: z.enum([
    "implementation",
    "debug",
    "review",
    "research",
    "docs",
    "data",
    "visual",
    "general",
  ]),
  complexity: z.number().min(0).max(1),
  ambiguity: z.number().min(0).max(1),
  risk: z.number().min(0).max(1),
  mechanical: z.number().min(0).max(1),
  scope: z.enum(["single", "multi", "repo"]),
  toolsRequired: z.boolean(),
  visionRequired: z.boolean(),
  searchRequired: z.boolean(),
  editRequired: z.boolean(),
  estimatedContextTokens: z.number().int().nonnegative(),
  desiredEffort: reasoningEffortSchema,
  repoTags: z.array(z.string()).max(16).default([]),
});
export type AutoTaskProfile = z.infer<typeof autoTaskProfileSchema>;

export const autoCapabilitiesSchema = z.object({
  tools: z.boolean(),
  vision: z.boolean(),
  search: z.boolean(),
  edit: z.boolean(),
  maxContextTokens: z.number().int().positive(),
});
export type AutoCapabilities = z.infer<typeof autoCapabilitiesSchema>;

export const autoCandidateSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["codex-model", "harness-model", "user-agent"]),
  harness: harnessIdSchema.optional(),
  displayName: z.string().min(1),
  description: z.string().default(""),
  available: z.boolean(),
  capabilities: autoCapabilitiesSchema,
  strengths: z.array(z.string()).default([]),
  quality: z.number().min(0).max(1),
  speed: z.number().min(0).max(1),
  economy: z.number().min(0).max(1),
  expectedCost: z.number().nonnegative().optional(),
  costUnit: z.enum(["usd", "tokens"]).optional(),
  costBasis: z.enum(["observed", "estimated", "catalog", "unknown"]).optional(),
  costProvenance: z.string().min(1).max(256).optional(),
  supportedEfforts: z.array(reasoningEffortSchema).optional(),
});
export type AutoCandidate = z.infer<typeof autoCandidateSchema>;

export const autoRankedCandidateSchema = z.object({
  id: z.string(),
  kind: z.enum(["codex-model", "harness-model", "user-agent"]),
  displayName: z.string(),
  reasoningEffort: reasoningEffortSchema.optional(),
  scores: z.object({
    taskFit: z.number(),
    quality: z.number(),
    qualityHeuristic: z.number().min(0).max(1).optional(),
    speed: z.number(),
    economy: z.number(),
    specialization: z.number(),
    total: z.number(),
    qualityThreshold: z.number().min(0).max(1).optional(),
    estimatedVerifiedSuccess: z.number().min(0).max(1).optional(),
    conservativeSuccess: z.number().min(0).max(1).optional(),
    meetsQualityThreshold: z.boolean().optional(),
    evidence: z
      .object({
        rawCount: z.number().int().nonnegative(),
        neighborCount: z.number().int().nonnegative(),
        effectiveCount: z.number().nonnegative(),
        priorOnly: z.boolean(),
        calibrated: z.literal(false),
        strength: z.enum(["prior-only", "sparse", "moderate", "strong"]),
        priorAlpha: z.literal(2),
        priorBeta: z.literal(2),
        similarityRange: z.tuple([z.number(), z.number()]).optional(),
      })
      .optional(),
    expectedCost: z.number().nonnegative().optional(),
    expectedCostUnit: z.enum(["usd", "tokens"]).optional(),
    expectedCostBasis: z
      .enum(["observed", "estimated", "mixed", "unknown", "catalog-fallback"])
      .optional(),
    expectedCostComparable: z.boolean().optional(),
    expectedCostComponents: z
      .object({
        firstAttempt: z.number().nonnegative(),
        retries: z.number().nonnegative(),
        escalations: z.number().nonnegative(),
        cacheSwitch: z.number().nonnegative(),
        routingOverhead: z.number().nonnegative(),
        verification: z.number().nonnegative(),
      })
      .optional(),
    expectedCostComponentBasis: z
      .object({
        firstAttempt: z.enum(["observed", "estimated", "mixed", "unknown"]),
        retries: z.enum(["observed", "estimated", "mixed", "unknown"]),
        escalations: z.enum(["observed", "estimated", "mixed", "unknown"]),
        cacheSwitch: z.enum(["observed", "estimated", "mixed", "unknown"]),
        routingOverhead: z.enum(["observed", "estimated", "mixed", "unknown"]),
        verification: z.enum(["observed", "estimated", "mixed", "unknown"]),
      })
      .optional(),
    pricingProvenance: z.array(z.string().max(256)).max(32).optional(),
    cacheState: z.enum(["observed", "unknown"]).optional(),
    selectionReason: z.string().optional(),
  }),
});
export type AutoRankedCandidate = z.infer<typeof autoRankedCandidateSchema>;

export const autoRouteDecisionSchema = z.object({
  routeId: z.string().uuid().optional(),
  harness: harnessIdSchema.optional(),
  sessionId: z.string().optional(),
  taskFingerprint: z.string().optional(),
  affinityReused: z.boolean().default(false),
  status: routeOutcomeSchema.default("planned"),
  selected: z
    .object({
      id: z.string(),
      kind: z.enum(["codex-model", "harness-model", "user-agent"]),
      displayName: z.string(),
      reasoningEffort: reasoningEffortSchema.optional(),
      execution: z.enum(["codex-exec", "opencode-run", "claude-print", "native-agent"]),
    })
    .nullable(),
  profile: autoRouteProfileSchema,
  taskProfile: autoTaskProfileSchema,
  repoSignals: repoSignalsSchema,
  ranked: z.array(autoRankedCandidateSchema),
  excluded: z.array(z.object({ id: z.string(), reasons: z.array(z.string()) })),
  fallback: z.object({
    kind: z.literal("current-model"),
    model: z.string().optional(),
    harness: harnessIdSchema.optional(),
  }),
  context: z.object({ objectiveTruncated: z.boolean(), conversationTruncated: z.boolean() }),
  selectionRule: z.literal("min-expected-cost-subject-to-quality-floor-v1").optional(),
  coldStart: z.boolean().optional(),
  coldStartReason: z.string().optional(),
});
export type AutoRouteDecision = z.infer<typeof autoRouteDecisionSchema>;

export const harnessRouteRecordSchema = z.object({
  routeId: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  harness: harnessIdSchema,
  sessionHash: z.string().optional(),
  taskFingerprint: z.string(),
  workspaceFingerprint: z.string(),
  selectedCandidate: z.string().optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  fallbackModel: z.string().optional(),
  profile: autoRouteProfileSchema,
  outcome: routeOutcomeSchema,
  rerouteReason: z.string().max(512).optional(),
  featureSummary: z.object({
    taskType: z.string(),
    complexity: z.number(),
    ambiguity: z.number().optional(),
    risk: z.number(),
    mechanical: z.number().optional(),
    scope: z.string(),
    requiredCapabilities: z.array(z.string()),
    estimatedContextTokens: z.number().int().nonnegative().optional(),
    repoTags: z.array(z.string()).optional(),
  }),
  selectionSnapshot: z
    .object({
      selectionRule: z.literal("min-expected-cost-subject-to-quality-floor-v1"),
      coldStart: z.boolean(),
      coldStartReason: z.string().optional(),
      selected: autoRankedCandidateSchema.optional(),
    })
    .optional(),
  partialWriteDetected: z.boolean().default(false),
});
export type HarnessRouteRecord = z.infer<typeof harnessRouteRecordSchema>;

export const registeredAgentSchema = z.object({
  id: z.string().min(1).max(128),
  displayName: z.string().min(1).max(128),
  description: z.string().max(1_000).default(""),
  strengths: z.array(z.string().max(64)).max(32).default([]),
  available: z.boolean().default(true),
  capabilities: autoCapabilitiesSchema.default({
    tools: true,
    vision: false,
    search: false,
    edit: true,
    maxContextTokens: 100_000,
  }),
  quality: z.number().min(0).max(1).default(0.8),
  speed: z.number().min(0).max(1).default(0.7),
  economy: z.number().min(0).max(1).default(0.8),
});
export type RegisteredAgent = z.infer<typeof registeredAgentSchema>;

export const autoRouteRequirementsSchema = z.object({
  tools: z.boolean().default(true),
  vision: z.boolean().default(false),
  search: z.boolean().default(false),
  edit: z.boolean().default(false),
  minimumContextTokens: z.number().int().nonnegative().default(0),
});
export type AutoRouteRequirements = z.infer<typeof autoRouteRequirementsSchema>;

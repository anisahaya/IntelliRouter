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

export const nativeProfileNameSchema = z.string().min(1).max(64);
export type NativeProfileName = z.infer<typeof nativeProfileNameSchema>;

const boundedSelectorListSchema = z.array(z.string().min(1).max(256)).max(128).default([]);
const boundedScoreAdjustmentsSchema = z
  .record(z.string().min(1).max(256), z.number().min(0).max(0.5))
  .default({});

export const nativeCandidateMetadataOverrideSchema = z.object({
  available: z.boolean().optional(),
  capabilities: z
    .object({
      tools: z.boolean().optional(),
      vision: z.boolean().optional(),
      search: z.boolean().optional(),
      edit: z.boolean().optional(),
      maxContextTokens: z.number().int().min(1).max(2_000_000).optional(),
    })
    .optional(),
  quality: z.number().min(0).max(1).optional(),
  speed: z.number().min(0).max(1).optional(),
  economy: z.number().min(0).max(1).optional(),
  strengths: z.array(z.string().min(1).max(64)).max(32).optional(),
  supportedEfforts: z.array(reasoningEffortSchema).min(1).max(6).optional(),
});
export type NativeCandidateMetadataOverride = z.infer<typeof nativeCandidateMetadataOverrideSchema>;

export const nativeEffortPolicySchema = z.object({
  cap: reasoningEffortSchema.optional(),
  force: reasoningEffortSchema.optional(),
  candidates: z
    .record(
      z.string().min(1).max(256),
      z.object({ cap: reasoningEffortSchema.optional(), force: reasoningEffortSchema.optional() }),
    )
    .default({}),
});

export const nativeBudgetPolicySchema = z.object({
  windowHours: z
    .number()
    .positive()
    .max(24 * 365)
    .default(24),
  maxRoutes: z.number().int().positive().optional(),
  maxAttempts: z.number().int().positive().optional(),
  candidateMaxRoutes: z.record(z.string().min(1).max(256), z.number().int().positive()).default({}),
});
export type NativeBudgetPolicy = z.infer<typeof nativeBudgetPolicySchema>;

export const nativeRoutingPolicySchema = z
  .object({
    harnesses: z
      .object({
        allow: z.array(harnessIdSchema).max(4).default([]),
        deny: z.array(harnessIdSchema).max(4).default([]),
      })
      .prefault({}),
    candidates: z
      .object({
        allow: boundedSelectorListSchema,
        deny: boundedSelectorListSchema,
        prefer: boundedScoreAdjustmentsSchema,
        penalize: boundedScoreAdjustmentsSchema,
      })
      .prefault({}),
    effort: nativeEffortPolicySchema.prefault({}),
    aliases: z.record(z.string().min(1).max(128), z.string().min(1).max(256)).default({}),
    overrides: z
      .record(z.string().min(1).max(256), nativeCandidateMetadataOverrideSchema)
      .default({}),
    budget: nativeBudgetPolicySchema.optional(),
  })
  .superRefine((value, context) => {
    for (const [field, record] of [
      ["aliases", value.aliases],
      ["overrides", value.overrides],
      ["prefer", value.candidates.prefer],
      ["penalize", value.candidates.penalize],
      ["effort.candidates", value.effort.candidates],
      ["budget.candidateMaxRoutes", value.budget?.candidateMaxRoutes ?? {}],
    ] as const) {
      if (Object.keys(record).length > 128) {
        context.addIssue({
          code: "custom",
          message: `${field} may contain at most 128 entries`,
        });
      }
    }
  });
export type NativeRoutingPolicy = z.infer<typeof nativeRoutingPolicySchema>;

export const nativeRoutingConfigSchema = z
  .object({
    defaultProfile: nativeProfileNameSchema.default("balanced"),
    repositoryProfiles: z.record(z.string().min(1).max(128), nativeProfileNameSchema).default({}),
    profiles: z
      .record(
        nativeProfileNameSchema,
        z.object({
          extends: autoRouteProfileSchema.default("balanced"),
          policy: nativeRoutingPolicySchema.prefault({}),
        }),
      )
      .default({}),
  })
  .prefault({})
  .superRefine((value, context) => {
    const defined = (profile: string) =>
      autoRouteProfileSchema.safeParse(profile).success || profile in value.profiles;
    if (!defined(value.defaultProfile)) {
      context.addIssue({
        code: "custom",
        path: ["defaultProfile"],
        message: `native default profile is not defined: ${value.defaultProfile}`,
      });
    }
    for (const [repository, profile] of Object.entries(value.repositoryProfiles)) {
      if (!defined(profile)) {
        context.addIssue({
          code: "custom",
          path: ["repositoryProfiles", repository],
          message: `native repository profile is not defined: ${profile}`,
        });
      }
    }
  });
export type NativeRoutingConfig = z.infer<typeof nativeRoutingConfigSchema>;

export const nativeRouteOverrideSchema = z.object({
  candidate: z.string().min(1).max(256).optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
});
export type NativeRouteOverride = z.infer<typeof nativeRouteOverrideSchema>;

export const nativePolicyExplanationSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(512),
  candidateId: z.string().min(1).max(256).optional(),
});

export const nativePolicyDecisionSchema = z.object({
  profile: nativeProfileNameSchema,
  baseProfile: autoRouteProfileSchema,
  source: z.enum(["explicit", "repository", "default", "builtin"]),
  effective: nativeRoutingPolicySchema,
  applied: z.array(nativePolicyExplanationSchema).max(512),
  ignored: z.array(nativePolicyExplanationSchema).max(512),
});
export type NativePolicyDecision = z.infer<typeof nativePolicyDecisionSchema>;

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
  supportedEfforts: z.array(reasoningEffortSchema).optional(),
});
export type AutoCandidate = z.infer<typeof autoCandidateSchema>;

export const autoObservedMetricsSchema = z.object({
  successRate: z.number().min(0).max(1),
  averageLatencyMs: z.number().nonnegative(),
  feedbackPrior: z.number().min(-1).max(1),
  attemptSamples: z.number().int().nonnegative(),
  feedbackSamples: z.number().int().nonnegative(),
  lastObservedAt: z.string().datetime().optional(),
});
export type AutoObservedMetrics = z.infer<typeof autoObservedMetricsSchema>;

export const autoRankedCandidateSchema = z.object({
  id: z.string(),
  kind: z.enum(["codex-model", "harness-model", "user-agent"]),
  displayName: z.string(),
  reasoningEffort: reasoningEffortSchema.optional(),
  scores: z.object({
    taskFit: z.number(),
    quality: z.number(),
    speed: z.number(),
    economy: z.number(),
    specialization: z.number(),
    total: z.number(),
    observedAdjustment: z.number().optional(),
    observedSampleCount: z.number().int().nonnegative().optional(),
    policyAdjustment: z.number().min(-0.5).max(0.5).optional(),
  }),
});
export type AutoRankedCandidate = z.infer<typeof autoRankedCandidateSchema>;

export const autoRouteDecisionSchema = z.object({
  routeId: z.string().uuid().optional(),
  harness: harnessIdSchema.optional(),
  sessionId: z.string().optional(),
  taskFingerprint: z.string().optional(),
  affinityReused: z.boolean().default(false),
  confidence: z
    .object({
      score: z.number().min(0).max(1),
      level: z.enum(["low", "medium", "high"]),
      winnerMargin: z.number().nonnegative(),
      evidenceSources: z.array(z.enum(["catalog", "probe", "observations", "affinity"])),
      freshestEvidenceAt: z.string().datetime().optional(),
      sampleSize: z.number().int().nonnegative(),
      abstained: z.boolean(),
      reasons: z.array(z.string()),
    })
    .optional(),
  status: routeOutcomeSchema.default("planned"),
  selected: z
    .object({
      id: z.string(),
      kind: z.enum(["codex-model", "harness-model", "user-agent"]),
      displayName: z.string(),
      reasoningEffort: reasoningEffortSchema.optional(),
      execution: z.enum(["codex-exec", "opencode-run", "claude-print", "native-agent"]),
      executionHarness: harnessIdSchema.optional(),
      executionModel: z.string().optional(),
    })
    .nullable(),
  profile: nativeProfileNameSchema,
  policy: nativePolicyDecisionSchema.optional(),
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
});
export type AutoRouteDecision = z.infer<typeof autoRouteDecisionSchema>;

export const harnessAttemptRecordSchema = z.object({
  candidateId: z.string().min(1),
  attemptOrder: z.number().int().positive(),
  outcome: z.enum(["success", "failure", "timed-out", "canceled"]),
  latencyMs: z.number().nonnegative(),
  errorClass: z
    .enum([
      "timeout",
      "network",
      "rate_limit",
      "overloaded",
      "upstream_5xx",
      "auth",
      "model_not_found",
      "invalid_request",
      "client",
      "unknown",
    ])
    .optional(),
  observedAt: z.string().datetime(),
});
export type HarnessAttemptRecord = z.infer<typeof harnessAttemptRecordSchema>;

export const harnessFeedbackRecordSchema = z.object({
  outcome: z.enum(["success", "failure", "corrected", "abandoned"]),
  score: z.number().min(0).max(1).optional(),
  tags: z
    .array(z.enum(["correctness", "quality", "speed", "cost", "tool-use", "instruction-following"]))
    .max(16)
    .default([]),
  observedAt: z.string().datetime(),
});
export type HarnessFeedbackRecord = z.infer<typeof harnessFeedbackRecordSchema>;

export const harnessHealthWindowSchema = z.object({
  candidateId: z.string().min(1),
  state: z.enum(["unknown", "healthy", "degraded", "unhealthy", "recovering"]),
  attempts: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  averageLatencyMs: z.number().nonnegative(),
  updatedAt: z.string().datetime(),
  cooldownUntil: z.string().datetime().optional(),
});
export type HarnessHealthWindow = z.infer<typeof harnessHealthWindowSchema>;

export const harnessRouteRecordSchema = z.object({
  routeId: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  harness: harnessIdSchema,
  sessionHash: z.string().optional(),
  taskIdHash: z.string().optional(),
  taskFingerprint: z.string(),
  workspaceFingerprint: z.string(),
  requirementsFingerprint: z.string().optional(),
  affinityExpiresAt: z.string().datetime().optional(),
  confidence: autoRouteDecisionSchema.shape.confidence,
  selectedCandidate: z.string().optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  fallbackModel: z.string().optional(),
  profile: nativeProfileNameSchema,
  policy: nativePolicyDecisionSchema.optional(),
  outcome: routeOutcomeSchema,
  rerouteReason: z.string().max(512).optional(),
  featureSummary: z.object({
    taskType: z.string(),
    complexity: z.number(),
    risk: z.number(),
    scope: z.string(),
    requiredCapabilities: z.array(z.string()),
  }),
  candidateRankings: z
    .array(
      z.object({
        candidateId: z.string().min(1),
        rank: z.number().int().positive(),
        totalScore: z.number(),
        kind: z.enum(["codex-model", "harness-model", "user-agent"]).optional(),
        reasoningEffort: reasoningEffortSchema.optional(),
      }),
    )
    .optional(),
  attempts: z.array(harnessAttemptRecordSchema).optional(),
  feedback: z.array(harnessFeedbackRecordSchema).optional(),
  healthWindows: z.array(harnessHealthWindowSchema).optional(),
  partialWriteDetected: z.boolean().default(false),
});
export type HarnessRouteRecord = z.infer<typeof harnessRouteRecordSchema>;

export const nativeRouteHistoryFiltersSchema = z.object({
  since: z.string().datetime().optional(),
  harness: harnessIdSchema.optional(),
  outcome: routeOutcomeSchema.optional(),
  limit: z.number().int().positive().max(1_000).default(50),
});
export type NativeRouteHistoryFilters = z.input<typeof nativeRouteHistoryFiltersSchema>;

export const nativeRouteStatsSchema = z.object({
  totalRoutes: z.number().int().nonnegative(),
  activeRoutes: z.number().int().nonnegative(),
  totalAttempts: z.number().int().nonnegative(),
  successfulAttempts: z.number().int().nonnegative(),
  averageAttemptLatencyMs: z.number().nonnegative(),
  byHarness: z.record(z.string(), z.number().int().nonnegative()),
  byOutcome: z.record(z.string(), z.number().int().nonnegative()),
  byCandidate: z.record(z.string(), z.number().int().nonnegative()),
});
export type NativeRouteStats = z.infer<typeof nativeRouteStatsSchema>;

export const nativeRouteJobStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "succeeded",
  "failed",
  "timed-out",
  "canceled",
  "orphaned",
]);
export type NativeRouteJobStatus = z.infer<typeof nativeRouteJobStatusSchema>;

export const nativeRouteJobSchema = z.object({
  jobId: z.string().uuid(),
  routeId: z.string().uuid(),
  status: nativeRouteJobStatusSchema,
  idempotencyKeyHash: z.string(),
  executionHash: z.string(),
  permission: z.enum(["read-only", "workspace-write"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  progress: z.object({
    stage: z.enum(["queued", "starting", "executing", "cancel-requested", "terminal"]),
    attemptCount: z.number().int().nonnegative(),
    outcome: z.enum(["success", "failure", "timed-out", "canceled"]).optional(),
    partialWriteDetected: z.boolean().optional(),
    safeToFallback: z.boolean().optional(),
    resultAvailable: z.boolean().default(false),
  }),
  errorCode: z
    .enum(["execution-failed", "execution-timed-out", "canceled", "process-restarted"])
    .optional(),
  childSessionHash: z.string().optional(),
  cancelRequested: z.boolean().default(false),
});
export type NativeRouteJob = z.infer<typeof nativeRouteJobSchema>;

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

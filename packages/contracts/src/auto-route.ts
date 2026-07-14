import { z } from "zod";

export const reasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

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
  kind: z.enum(["codex-model", "user-agent"]),
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

export const autoRankedCandidateSchema = z.object({
  id: z.string(),
  kind: z.enum(["codex-model", "user-agent"]),
  displayName: z.string(),
  reasoningEffort: reasoningEffortSchema.optional(),
  scores: z.object({
    taskFit: z.number(),
    quality: z.number(),
    speed: z.number(),
    economy: z.number(),
    specialization: z.number(),
    total: z.number(),
  }),
});
export type AutoRankedCandidate = z.infer<typeof autoRankedCandidateSchema>;

export const autoRouteDecisionSchema = z.object({
  selected: z
    .object({
      id: z.string(),
      kind: z.enum(["codex-model", "user-agent"]),
      displayName: z.string(),
      reasoningEffort: reasoningEffortSchema.optional(),
      execution: z.enum(["codex-exec", "native-agent"]),
    })
    .nullable(),
  profile: autoRouteProfileSchema,
  taskProfile: autoTaskProfileSchema,
  repoSignals: repoSignalsSchema,
  ranked: z.array(autoRankedCandidateSchema),
  excluded: z.array(z.object({ id: z.string(), reasons: z.array(z.string()) })),
  fallback: z.object({ kind: z.literal("current-model"), model: z.string().optional() }),
  context: z.object({ objectiveTruncated: z.boolean(), conversationTruncated: z.boolean() }),
});
export type AutoRouteDecision = z.infer<typeof autoRouteDecisionSchema>;

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

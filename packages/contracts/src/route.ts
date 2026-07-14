import { z } from "zod";

export const taskFeaturesSchema = z.object({
  taskType: z.enum(["code", "debug", "review", "research", "general"]),
  hasCode: z.boolean(),
  agentic: z.boolean(),
  reasoningIntensity: z.enum(["low", "medium", "high"]),
  estimatedInputTokens: z.number().int().nonnegative(),
});
export type TaskFeatures = z.infer<typeof taskFeaturesSchema>;

export const routeCandidateSchema = z.object({
  modelId: z.string(),
  eligible: z.boolean(),
  exclusionReasons: z.array(z.string()),
  scores: z.object({
    quality: z.number(),
    cost: z.number(),
    latency: z.number(),
    feedback: z.number(),
    total: z.number(),
  }),
});
export type RouteCandidate = z.infer<typeof routeCandidateSchema>;

export const routeDecisionSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  logicalModel: z.string(),
  upstreamModel: z.string(),
  provider: z.string().optional(),
  protocol: z.string().optional(),
  profile: z.string(),
  features: taskFeaturesSchema,
  candidates: z.array(routeCandidateSchema),
  fallbackChain: z.array(z.string()),
  affinityUsed: z.boolean(),
  createdAt: z.string(),
  kind: z.enum(["compatibility", "dry_run", "legacy"]).optional(),
});
export type RouteDecision = z.infer<typeof routeDecisionSchema>;

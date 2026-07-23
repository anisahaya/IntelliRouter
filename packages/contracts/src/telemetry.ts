import { z } from "zod";

export const feedbackEventSchema = z.object({
  routeId: z.string().min(1),
  outcome: z.enum(["success", "failure", "corrected", "abandoned", "reverted"]),
  score: z.number().min(0).max(1).optional(),
  tags: z.array(z.string().max(64)).max(16).default([]),
  reasonCategory: z.string().max(64).optional(),
});
export type FeedbackEvent = z.infer<typeof feedbackEventSchema>;

export interface RouteStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  canceledRequests: number;
  totalAttempts: number;
  fallbackAttempts: number;
  estimatedCostUsd: number;
  averageLatencyMs: number;
  byModel: Record<string, number>;
  byTask: Record<string, number>;
  byOutcome: Record<string, number>;
}

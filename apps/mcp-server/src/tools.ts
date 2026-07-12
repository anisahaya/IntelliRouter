import { z } from "zod/v4";
import type { ProxyClient } from "./client.js";

export const routeTaskInput = {
  task: z.string().min(1).max(32_000),
  profile: z.enum(["economy", "balanced", "premium"]).default("balanced"),
  protocol: z
    .enum(["openai-chat", "openai-responses", "anthropic-messages"])
    .default("openai-chat"),
  session: z.string().max(512).optional(),
  toolsRequired: z.boolean().default(false),
  jsonRequired: z.boolean().default(false),
  visionRequired: z.boolean().default(false),
};

export const routeTaskOutput = {
  routeId: z.string(),
  selectedModel: z.string(),
  profile: z.string(),
  explanation: z.string(),
  candidates: z
    .array(z.object({ modelId: z.string(), eligible: z.boolean(), total: z.number() }))
    .max(32),
};

export const genericObjectOutput = { result: z.record(z.string(), z.unknown()) };

export function createToolHandlers(client: ProxyClient) {
  return {
    routeTask: async (input: {
      task: string;
      profile: string;
      protocol: "openai-chat" | "openai-responses" | "anthropic-messages";
      session?: string;
      toolsRequired: boolean;
      jsonRequired: boolean;
      visionRequired: boolean;
    }) => {
      const decision = await client.routeTask({
        task: input.task,
        profile: input.profile,
        protocol: input.protocol,
        session: input.session,
        requirements: {
          tools: input.toolsRequired,
          json: input.jsonRequired,
          vision: input.visionRequired,
        },
      });
      const candidates = Array.isArray(decision.candidates)
        ? decision.candidates.slice(0, 32).map((candidate) => {
            const item = candidate as Record<string, unknown>;
            const scores = (item.scores ?? {}) as Record<string, unknown>;
            return {
              modelId: String(item.modelId),
              eligible: Boolean(item.eligible),
              total: Number(scores.total ?? 0),
            };
          })
        : [];
      const winner = candidates.find((candidate) => candidate.modelId === decision.logicalModel);
      return {
        routeId: String(decision.id),
        selectedModel: String(decision.logicalModel),
        profile: String(decision.profile),
        explanation: winner
          ? `${winner.modelId} selected with deterministic score ${winner.total.toFixed(4)}`
          : `${String(decision.logicalModel)} selected`,
        candidates,
      };
    },
    explainRoute: async (routeId: string) => ({ result: await client.explainRoute(routeId) }),
    stats: async (filters: { since?: string; model?: string; task?: string }) => ({
      result: await client.stats(filters),
    }),
    feedback: async (input: {
      routeId: string;
      outcome: string;
      score?: number;
      tags: string[];
    }) => ({
      result: await client.feedback(input),
    }),
    models: async () => ({ result: await client.models() }),
    delegate: async (input: {
      prompt: string;
      profile?: string;
      model?: string;
      session?: string;
      maxOutputTokens: number;
    }) => ({ result: await client.delegate(input) }),
  };
}

export function success(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2).slice(0, 64_000) }],
    structuredContent: value,
  };
}

export function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: message.slice(0, 4_096) }],
    isError: true as const,
  };
}

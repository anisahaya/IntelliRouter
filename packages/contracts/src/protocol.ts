import { z } from "zod";

export const protocolSchema = z.enum(["openai-chat", "openai-responses", "anthropic-messages"]);
export type Protocol = z.infer<typeof protocolSchema>;

const baseNormalizedRequestSchema = z.object({
  stream: z.boolean(),
  summary: z.string(),
  toolsRequired: z.boolean(),
  jsonRequired: z.boolean(),
  visionRequired: z.boolean(),
  estimatedInputTokens: z.number().int().nonnegative(),
  minimumContextTokens: z.number().int().nonnegative(),
  pinnedModel: z.string().optional(),
  requestedProfile: z.string().optional(),
  passThroughBody: z.record(z.string(), z.unknown()),
});

export const normalizedRequestSchema = z.discriminatedUnion("protocol", [
  baseNormalizedRequestSchema.extend({
    protocol: z.literal("openai-chat"),
    metadata: z.object({ messageCount: z.number().int().nonnegative() }),
  }),
  baseNormalizedRequestSchema.extend({
    protocol: z.literal("openai-responses"),
    metadata: z.object({ inputKind: z.enum(["string", "array", "unknown"]) }),
  }),
  baseNormalizedRequestSchema.extend({
    protocol: z.literal("anthropic-messages"),
    metadata: z.object({ messageCount: z.number().int().nonnegative() }),
  }),
]);
export type NormalizedRequest = z.infer<typeof normalizedRequestSchema>;

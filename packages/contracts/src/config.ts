import { z } from "zod";
import { protocolSchema } from "./protocol.js";

export const capabilitySchema = z.object({
  protocols: z.array(protocolSchema).min(1),
  tools: z.boolean().default(false),
  json: z.boolean().default(false),
  vision: z.boolean().default(false),
  streaming: z.boolean().default(true),
  maxContextTokens: z.number().int().positive(),
});

export const modelDefinitionSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  provider: z.enum(["openai-compatible", "anthropic"]),
  upstreamModel: z.string().min(1),
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().min(1),
  cost: z
    .object({
      inputPerMillion: z.number().nonnegative().default(0),
      outputPerMillion: z.number().nonnegative().default(0),
    })
    .default({ inputPerMillion: 0, outputPerMillion: 0 }),
  capabilities: capabilitySchema,
  tags: z.array(z.string()).default([]),
  quality: z.number().min(0).max(1).default(0.5),
  timeoutMs: z.number().int().positive().default(60_000),
});
export type ModelDefinition = z.infer<typeof modelDefinitionSchema>;

export const weightsSchema = z
  .object({
    quality: z.number().min(0).max(1),
    cost: z.number().min(0).max(1),
    latency: z.number().min(0).max(1),
  })
  .refine((value) => Math.abs(value.quality + value.cost + value.latency - 1) <= 0.001, {
    message: "routing profile weights must sum to 1",
  });

export const routerConfigSchema = z
  .object({
    server: z
      .object({
        host: z.string().default("127.0.0.1"),
        port: z.number().int().min(1).max(65535).default(8856),
        authTokenEnv: z.string().optional(),
        databasePath: z.string().default("~/.model-router/router.db"),
        bodyLimitBytes: z
          .number()
          .int()
          .positive()
          .default(2 * 1024 * 1024),
      })
      .prefault({}),
    privacy: z
      .object({
        storePrompts: z.boolean().default(false),
        storeResponses: z.boolean().default(false),
        hashSessionIds: z.boolean().default(true),
      })
      .prefault({}),
    models: z.array(modelDefinitionSchema).min(1),
    routing: z
      .object({
        defaultProfile: z.string().default("balanced"),
        affinityTtlSeconds: z.number().int().positive().default(3600),
        fallbackOn: z
          .array(z.enum(["timeout", "rate_limit", "overloaded", "upstream_5xx"]))
          .default(["timeout", "rate_limit", "overloaded", "upstream_5xx"]),
        profiles: z.record(z.string(), z.object({ weights: weightsSchema })),
      })
      .refine((value) => value.defaultProfile in value.profiles, {
        message: "default routing profile is not defined",
      }),
  })
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const model of value.models) {
      if (ids.has(model.id)) {
        context.addIssue({
          code: "custom",
          path: ["models"],
          message: `duplicate model id: ${model.id}`,
        });
      }
      ids.add(model.id);
    }
    const loopback = ["127.0.0.1", "::1", "localhost"].includes(value.server.host);
    if (!loopback && !value.server.authTokenEnv) {
      context.addIssue({
        code: "custom",
        path: ["server", "authTokenEnv"],
        message: "non-loopback binding requires an auth token environment variable",
      });
    }
  });
export type RouterConfig = z.infer<typeof routerConfigSchema>;

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

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

const baseUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = (() => {
      try {
        return new URL(value);
      } catch {
        return null;
      }
    })();
    if (!url) return false;
    if (url.protocol === "http:") return loopbackHosts.has(url.hostname);
    return url.protocol === "https:";
  }, "baseUrl must use https://, or http:// only with a loopback host");

export const modelDefinitionSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  provider: z.enum(["openai-compatible", "anthropic"]),
  upstreamModel: z.string().min(1),
  baseUrl: baseUrlSchema,
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
        responseLimitBytes: z
          .number()
          .int()
          .positive()
          .default(16 * 1024 * 1024),
      })
      .prefault({}),
    privacy: z
      .object({
        storePrompts: z.boolean().default(false),
        storeResponses: z.boolean().default(false),
        storeSource: z.boolean().default(false),
        storeEmbeddings: z.boolean().default(false),
        contentMaxItemBytes: z.number().int().positive().default(65536),
        contentMaxRunBytes: z.number().int().positive().default(131072),
        contentMaxTotalBytes: z
          .number()
          .int()
          .positive()
          .default(50 * 1024 * 1024),
        contentRetentionDays: z.number().int().positive().default(7),
        hashSessionIds: z.boolean().default(true),
      })
      .prefault({}),
    models: z.array(modelDefinitionSchema).min(1),
    routing: z
      .object({
        defaultProfile: z.string().default("balanced"),
        affinityTtlSeconds: z.number().int().positive().default(3600),
        fallbackOn: z
          .array(z.enum(["timeout", "network", "rate_limit", "overloaded", "upstream_5xx"]))
          .default(["timeout", "network", "rate_limit", "overloaded", "upstream_5xx"]),
        health: z
          .object({
            windowSize: z.number().int().min(1).default(20),
            minimumObservations: z.number().int().min(1).default(5),
            failureThreshold: z.number().min(0).max(1).default(0.6),
            cooldownSeconds: z.number().int().positive().default(30),
          })
          .prefault({}),
        profiles: z.record(z.string(), z.object({ weights: weightsSchema })),
      })
      .refine((value) => value.defaultProfile in value.profiles, {
        message: "default routing profile is not defined",
      }),
  })
  .superRefine((value, context) => {
    const ids = new Set<string>();
    if (!value.privacy.hashSessionIds) {
      context.addIssue({
        code: "custom",
        path: ["privacy", "hashSessionIds"],
        message: "session hashing cannot be disabled",
      });
    }
    for (const model of value.models) {
      if (ids.has(model.id)) {
        context.addIssue({
          code: "custom",
          path: ["models"],
          message: `duplicate model id: ${model.id}`,
        });
      }
      ids.add(model.id);
      const validProtocols =
        model.provider === "anthropic"
          ? ["anthropic-messages"]
          : ["openai-chat", "openai-responses"];
      for (const protocol of model.capabilities.protocols) {
        if (!validProtocols.includes(protocol))
          context.addIssue({
            code: "custom",
            path: ["models", model.id, "capabilities", "protocols"],
            message: `provider ${model.provider} cannot serve ${protocol}`,
          });
      }
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

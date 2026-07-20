import {
  autoRouteRequirementsSchema,
  harnessIdSchema,
  nativeProfileNameSchema,
  nativeRouteJobStatusSchema,
  nativeRouteOverrideSchema,
  reasoningEffortSchema,
  registeredAgentSchema,
  repoSignalsSchema,
} from "@model-router/contracts";
import { z } from "zod/v4";
import { type AutoRouterOptions, autoRoute } from "./auto-router.js";
import type { ProxyClient } from "./client.js";
import { type CodexExecOptions, executeCodexTask } from "./codex-exec.js";
import { executeHarnessTask, type HarnessExecOptions } from "./harness-exec.js";
import { HarnessJobManager } from "./harness-jobs.js";
import { type HarnessRouterOptions, routeHarnessTask } from "./harness-router.js";
import { getRouteRecord, updateRouteOutcome } from "./route-state.js";

export const routeTaskInput = {
  task: z.string().min(1).max(32_000),
  profile: z.string().min(1).max(64).default("balanced"),
  protocol: z
    .enum(["openai-chat", "openai-responses", "anthropic-messages"])
    .default("openai-chat"),
  session: z.string().max(512).optional(),
  toolsRequired: z.boolean().default(false),
  jsonRequired: z.boolean().default(false),
  visionRequired: z.boolean().default(false),
  streamingRequired: z.boolean().default(false),
  minimumContextTokens: z.number().int().nonnegative().default(0),
  expectedOutputTokens: z.number().int().nonnegative().default(0),
};

export const routeTaskOutput = {
  routeId: z.string(),
  selectedModel: z.string(),
  profile: z.string(),
  explanation: z.string(),
  provider: z.string(),
  upstreamModel: z.string(),
  protocol: z.string(),
  candidates: z
    .array(
      z.object({
        modelId: z.string(),
        eligible: z.boolean(),
        exclusions: z.array(z.string()),
        scores: z.object({
          quality: z.number(),
          cost: z.number(),
          latency: z.number(),
          feedback: z.number(),
          total: z.number(),
        }),
      }),
    )
    .max(32),
};

export const genericObjectOutput = { result: z.record(z.string(), z.unknown()) };

export const autoRouteInput = {
  objective: z.string().min(1).max(32_000),
  conversationSummary: z.string().max(16_000).optional(),
  workspaceRoot: z.string().min(1).max(4_096),
  registeredAgents: z.array(registeredAgentSchema).max(32).default([]),
  profile: nativeProfileNameSchema.optional(),
  override: nativeRouteOverrideSchema.optional(),
  currentModel: z.string().min(1).max(128),
  requirements: autoRouteRequirementsSchema.default({
    tools: true,
    vision: false,
    search: false,
    edit: false,
    minimumContextTokens: 0,
  }),
};

export const delegateCodexTaskInput = {
  model: z.string().min(1).max(128),
  reasoningEffort: reasoningEffortSchema,
  objective: z.string().min(1).max(32_000),
  conversationSummary: z.string().max(16_000).optional(),
  acceptanceChecks: z.array(z.string().max(1_000)).max(32).default([]),
  searchRequired: z.boolean().default(false),
  visionRequired: z.boolean().default(false),
  imagePaths: z.array(z.string().min(1).max(4_096)).max(8).default([]),
  repoSignals: repoSignalsSchema,
  workspaceRoot: z.string().min(1).max(4_096),
  permission: z.enum(["read-only", "workspace-write"]).default("read-only"),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
};

export const routeHarnessTaskInput = {
  harness: z.union([harnessIdSchema, z.literal("auto")]),
  harnesses: z.array(harnessIdSchema).max(4).optional(),
  objective: z.string().min(1).max(32_000),
  conversationSummary: z.string().max(16_000).optional(),
  workspaceRoot: z.string().min(1).max(4_096),
  registeredAgents: z.array(registeredAgentSchema).max(32).default([]),
  profile: nativeProfileNameSchema.optional(),
  override: nativeRouteOverrideSchema.optional(),
  currentModel: z.string().min(1).max(256).optional(),
  sessionId: z.string().min(1).max(512).optional(),
  taskId: z.string().min(1).max(256).optional(),
  forceReroute: z.boolean().default(false),
  probe: z.boolean().default(false),
  requirements: autoRouteRequirementsSchema.default({
    tools: true,
    vision: false,
    search: false,
    edit: false,
    minimumContextTokens: 0,
  }),
};

export const delegateHarnessTaskInput = {
  routeId: z.string().uuid(),
  harness: harnessIdSchema,
  model: z.string().min(1).max(256),
  reasoningEffort: reasoningEffortSchema,
  objective: z.string().min(1).max(32_000),
  conversationSummary: z.string().max(16_000).optional(),
  acceptanceChecks: z.array(z.string().max(1_000)).max(32).default([]),
  searchRequired: z.boolean().default(false),
  visionRequired: z.boolean().default(false),
  imagePaths: z.array(z.string().min(1).max(4_096)).max(8).default([]),
  repoSignals: repoSignalsSchema,
  workspaceRoot: z.string().min(1).max(4_096),
  permission: z.enum(["read-only", "workspace-write"]).default("read-only"),
  allowWriteFallback: z.boolean().default(false),
  resumeSessionId: z.string().min(1).max(512).optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
};

const harnessJobExecutionInput = {
  objective: z.string().min(1).max(32_000),
  conversationSummary: z.string().max(16_000).optional(),
  acceptanceChecks: z.array(z.string().max(1_000)).max(32).default([]),
  workspaceRoot: z.string().min(1).max(4_096),
  permission: z.enum(["read-only", "workspace-write"]).default("read-only"),
  allowWriteFallback: z.boolean().default(false),
  searchRequired: z.boolean().optional(),
  visionRequired: z.boolean().optional(),
  imagePaths: z.array(z.string().min(1).max(4_096)).max(8).default([]),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  resumeSessionId: z.string().min(1).max(512).optional(),
};

export const startHarnessTaskInput = {
  routeId: z.string().uuid(),
  idempotencyKey: z.string().min(1).max(256),
  ...harnessJobExecutionInput,
};

export const routeAndStartHarnessTaskInput = {
  ...routeHarnessTaskInput,
  idempotencyKey: z.string().min(1).max(256),
  acceptanceChecks: z.array(z.string().max(1_000)).max(32).default([]),
  permission: z.enum(["read-only", "workspace-write"]).default("read-only"),
  allowWriteFallback: z.boolean().default(false),
  imagePaths: z.array(z.string().min(1).max(4_096)).max(8).default([]),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
};

export const resumeHarnessTaskInput = {
  jobId: z.string().uuid(),
  ...harnessJobExecutionInput,
};

export function createToolHandlers(
  client: ProxyClient,
  options: {
    autoRouter?: AutoRouterOptions;
    codexExec?: CodexExecOptions;
    harnessRouter?: HarnessRouterOptions;
    harnessExec?: HarnessExecOptions;
  } = {},
) {
  const jobs = new HarnessJobManager({ router: options.harnessRouter, exec: options.harnessExec });
  return {
    routeTask: async (input: {
      task: string;
      profile: string;
      protocol: "openai-chat" | "openai-responses" | "anthropic-messages";
      session?: string;
      toolsRequired: boolean;
      jsonRequired: boolean;
      visionRequired: boolean;
      streamingRequired?: boolean;
      minimumContextTokens?: number;
      expectedOutputTokens?: number;
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
          streaming: input.streamingRequired ?? false,
          minimumContextTokens:
            (input.minimumContextTokens ?? 0) + (input.expectedOutputTokens ?? 0),
        },
      });
      const candidates = Array.isArray(decision.candidates)
        ? decision.candidates.slice(0, 32).map((candidate) => {
            const item = candidate as Record<string, unknown>;
            const scores = (item.scores ?? {}) as Record<string, unknown>;
            return {
              modelId: String(item.modelId),
              eligible: Boolean(item.eligible),
              exclusions: Array.isArray(item.exclusionReasons)
                ? item.exclusionReasons.map(String)
                : [],
              scores: {
                quality: Number(scores.quality ?? 0),
                cost: Number(scores.cost ?? 0),
                latency: Number(scores.latency ?? 0),
                feedback: Number(scores.feedback ?? 0),
                total: Number(scores.total ?? 0),
              },
            };
          })
        : [];
      const winner = candidates.find((candidate) => candidate.modelId === decision.logicalModel);
      return {
        routeId: String(decision.id),
        selectedModel: String(decision.logicalModel),
        profile: String(decision.profile),
        explanation: winner
          ? `${winner.modelId} selected with deterministic score ${winner.scores.total.toFixed(4)}`
          : `${String(decision.logicalModel)} selected`,
        candidates,
        provider: String(decision.provider ?? "unknown"),
        upstreamModel: String(decision.upstreamModel),
        protocol: input.protocol,
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
      protocol?: "openai-chat" | "openai-responses" | "anthropic-messages";
    }) => ({ result: await client.delegate(input) }),
    autoRoute: async (input: Parameters<typeof autoRoute>[0]) => ({
      result: await autoRoute(input, options.autoRouter),
    }),
    delegateCodexTask: async (input: Parameters<typeof executeCodexTask>[0]) => ({
      result: await executeCodexTask(input, options.codexExec),
    }),
    routeHarnessTask: async (input: Parameters<typeof routeHarnessTask>[0]) => ({
      result: await routeHarnessTask(input, options.harnessRouter),
    }),
    delegateHarnessTask: async (input: Parameters<typeof executeHarnessTask>[0]) => ({
      result: await executeHarnessTask(input, options.harnessExec),
    }),
    routeAndStartHarnessTask: async (input: Parameters<typeof jobs.routeAndStart>[0]) => ({
      result: await jobs.routeAndStart(input),
    }),
    startHarnessTask: async (input: Parameters<typeof jobs.start>[0]) => ({
      result: await jobs.start(input),
    }),
    getHarnessTask: async (jobId: string) => ({ result: await jobs.get(jobId) }),
    cancelHarnessTask: async (jobId: string) => ({ result: await jobs.cancel(jobId) }),
    resumeHarnessTask: async (input: { jobId: string } & Parameters<typeof jobs.resume>[1]) => ({
      result: await jobs.resume(input.jobId, input),
    }),
    listHarnessTasks: async (input: {
      routeId?: string;
      status?: z.infer<typeof nativeRouteJobStatusSchema>;
      limit?: number;
    }) => ({ result: { jobs: await jobs.list(input) } }),
    explainHarnessRoute: async (routeId: string) => {
      const result = await getRouteRecord(routeId, options.harnessRouter?.state);
      if (!result) throw new Error(`Unknown harness route: ${routeId}`);
      return { result };
    },
    submitHarnessFeedback: async (input: {
      routeId: string;
      outcome: "success" | "failure" | "corrected" | "abandoned";
      reason?: string;
    }) => ({
      result: await updateRouteOutcome(
        input.routeId,
        input.outcome,
        { rerouteReason: input.reason },
        options.harnessRouter?.state,
      ),
    }),
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

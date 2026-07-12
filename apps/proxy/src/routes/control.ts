import { resolveApiKey } from "@model-router/config";
import type { NormalizedRequest, Protocol } from "@model-router/contracts";
import { feedbackEventSchema } from "@model-router/contracts";
import { adapterFor } from "@model-router/providers";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouterRuntime } from "../app.js";

const dryRunSchema = z.object({
  task: z.string().min(1).max(32_000),
  profile: z.string().optional(),
  protocol: z
    .enum(["openai-chat", "openai-responses", "anthropic-messages"])
    .default("openai-chat"),
  session: z.string().max(512).optional(),
  model: z.string().optional(),
  requirements: z
    .object({
      tools: z.boolean().default(false),
      json: z.boolean().default(false),
      vision: z.boolean().default(false),
      streaming: z.boolean().default(false),
      minimumContextTokens: z.number().int().nonnegative().default(0),
    })
    .prefault({}),
});

export function registerControl(app: FastifyInstance, runtime: RouterRuntime): void {
  app.post<{ Body: unknown }>("/router/route", async (request) => {
    const input = dryRunSchema.parse(request.body);
    const normalized = taskRequest(input.protocol, input.task, input.requirements);
    return runtime.engine.select(normalized, {
      requestId: request.id,
      profile: input.profile,
      pinnedModel: input.model,
      sessionId: input.session,
    });
  });

  app.get<{ Params: { routeId: string } }>("/router/routes/:routeId", async (request, reply) => {
    const decision = runtime.store.getDecision(request.params.routeId);
    if (!decision)
      return reply
        .code(404)
        .send({ error: { code: "not_found", message: "route not found", requestId: request.id } });
    return decision;
  });

  app.post<{ Body: unknown }>("/router/feedback", async (request, reply) => {
    const event = feedbackEventSchema.parse(request.body);
    runtime.store.recordFeedback(event);
    return reply.code(202).send({ accepted: true });
  });

  app.get<{ Querystring: { since?: string; model?: string; task?: string } }>(
    "/router/stats",
    async (request) => runtime.store.getStats(request.query),
  );

  app.get("/router/models", async () => ({
    profiles: Object.keys(runtime.config.routing.profiles),
    models: runtime.config.models.map((model) => ({
      id: model.id,
      provider: model.provider,
      enabled: model.enabled,
      capabilities: model.capabilities,
      tags: model.tags,
      healthy: runtime.store.isHealthy(model.id),
    })),
  }));

  app.post<{ Params: { id: string } }>("/router/models/:id/probe", async (request, reply) => {
    const model = runtime.config.models.find((item) => item.id === request.params.id);
    if (!model)
      return reply
        .code(404)
        .send({ error: { code: "not_found", message: "model not found", requestId: request.id } });
    const adapter = adapterFor(model);
    const protocol = model.capabilities.protocols[0] as Protocol;
    const probe = taskRequest(protocol, "health probe", { streaming: false });
    const prepared = adapter.prepareRequest(model, probe, resolveApiKey(model, runtime.env));
    const started = performance.now();
    try {
      const response = await adapter.send(
        prepared,
        AbortSignal.timeout(Math.min(model.timeoutMs, 10_000)),
      );
      const healthy =
        response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429);
      runtime.store.setHealth(model.id, healthy, performance.now() - started);
      await response.body?.cancel();
      return reply
        .code(healthy ? 200 : 503)
        .send({ model: model.id, healthy, status: response.status });
    } catch {
      runtime.store.setHealth(model.id, false, performance.now() - started);
      return reply.code(503).send({ model: model.id, healthy: false });
    }
  });
}

function taskRequest(
  protocol: Protocol,
  task: string,
  requirements: {
    tools?: boolean;
    json?: boolean;
    vision?: boolean;
    streaming?: boolean;
    minimumContextTokens?: number;
  },
): NormalizedRequest {
  const common = {
    stream: requirements.streaming ?? false,
    summary: task,
    toolsRequired: requirements.tools ?? false,
    jsonRequired: requirements.json ?? false,
    visionRequired: requirements.vision ?? false,
    estimatedInputTokens: Math.ceil(task.length / 4),
    minimumContextTokens: requirements.minimumContextTokens ?? 0,
    passThroughBody: { model: "auto" },
  };
  return protocol === "openai-responses"
    ? { ...common, protocol, metadata: { inputKind: "string" } }
    : { ...common, protocol, metadata: { messageCount: 1 } };
}

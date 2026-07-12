import type { OutgoingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import { resolveApiKey } from "@model-router/config";
import type { ModelDefinition, Protocol, RouteDecision } from "@model-router/contracts";
import { adapterFor, responseRequestId, UpstreamError } from "@model-router/providers";
import { canFallback } from "@model-router/router-core";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RouterRuntime } from "../app.js";
import { normalizeRequest } from "./normalize.js";

export async function handleCompatibility(
  protocol: Protocol,
  request: FastifyRequest<{ Body: Record<string, unknown> }>,
  reply: FastifyReply,
  runtime: RouterRuntime,
): Promise<unknown> {
  const normalized = normalizeRequest(protocol, request.body ?? {});
  const pinnedHeader = request.headers["x-router-model"];
  const sessionHeader = request.headers["x-router-session"];
  const profileHeader = request.headers["x-router-profile"];
  const excluded: string[] = [];
  const fallbackChain: string[] = [];
  let decision: RouteDecision | undefined;
  const started = performance.now();
  const clientController = new AbortController();
  request.raw.once("aborted", () => clientController.abort());
  reply.raw.once("close", () => clientController.abort());

  for (;;) {
    decision = runtime.engine.select(normalized, {
      requestId: request.id,
      pinnedModel: typeof pinnedHeader === "string" ? pinnedHeader : undefined,
      sessionId: typeof sessionHeader === "string" ? sessionHeader : undefined,
      profile: typeof profileHeader === "string" ? profileHeader : undefined,
      excludeModels: excluded,
    });
    decision.fallbackChain = [...fallbackChain];
    runtime.store.updateFallbackChain(decision.id, fallbackChain);
    const model = runtime.config.models.find(
      (item) => item.id === decision?.logicalModel,
    ) as ModelDefinition;
    const adapter = adapterFor(model);
    if (!adapter.supports(protocol))
      throw new Error(`provider ${model.provider} cannot serve ${protocol}`);
    const prepared = adapter.prepareRequest(model, normalized, resolveApiKey(model, runtime.env));
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), model.timeoutMs);
    const signal = AbortSignal.any([clientController.signal, timeoutController.signal]);
    let upstream: Response;
    try {
      upstream = await adapter.send(prepared, signal);
    } catch (error) {
      clearTimeout(timeout);
      const errorClass = adapter.classifyError(error);
      if (canFallback(errorClass, runtime.config.routing.fallbackOn, false)) {
        excluded.push(model.id);
        fallbackChain.push(model.id);
        continue;
      }
      throw error;
    }
    clearTimeout(timeout);
    if (!upstream.ok) {
      const errorClass = adapter.classifyError(undefined, upstream);
      const body = (await upstream.text()).slice(0, 16_384);
      if (canFallback(errorClass, runtime.config.routing.fallbackOn, false)) {
        excluded.push(model.id);
        fallbackChain.push(model.id);
        continue;
      }
      throw new UpstreamError(
        `upstream returned ${upstream.status}`,
        upstream.status,
        responseRequestId(upstream),
        body,
      );
    }

    const fallbackCount = fallbackChain.length;
    reply.header("x-router-request-id", request.id);
    reply.header("x-router-model", model.id);
    reply.header("x-router-route-id", decision.id);
    reply.header("x-router-profile", decision.profile);
    reply.header("x-router-fallback-count", String(fallbackCount));
    const contentType = upstream.headers.get("content-type") ?? "application/json";
    reply.header("content-type", contentType);
    const providerId = responseRequestId(upstream);
    if (providerId) reply.header("x-upstream-request-id", providerId);

    if (normalized.stream && upstream.body) {
      reply.hijack();
      reply.raw.writeHead(upstream.status, reply.getHeaders() as OutgoingHttpHeaders);
      const source = Readable.fromWeb(
        upstream.body as import("node:stream/web").ReadableStream<Uint8Array>,
      );
      reply.raw.once("close", () => source.destroy());
      source.on("error", () => reply.raw.destroy());
      source.on("end", () => {
        runtime.store.recordMetric({
          routeId: decision?.id ?? "unknown",
          status: upstream.status,
          latencyMs: performance.now() - started,
          providerRequestId: providerId,
        });
      });
      source.pipe(reply.raw);
      return reply;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const usage = extractUsage(buffer, contentType);
    runtime.store.recordMetric({
      routeId: decision.id,
      status: upstream.status,
      latencyMs: performance.now() - started,
      providerRequestId: providerId,
      ...usage,
      estimatedCostUsd:
        (usage.inputTokens * model.cost.inputPerMillion +
          usage.outputTokens * model.cost.outputPerMillion) /
        1_000_000,
    });
    return reply.code(upstream.status).send(buffer);
  }
}

function extractUsage(
  buffer: Buffer,
  contentType: string,
): { inputTokens: number; outputTokens: number } {
  if (!contentType.includes("json")) return { inputTokens: 0, outputTokens: 0 };
  try {
    const body = JSON.parse(buffer.toString("utf8")) as Record<string, unknown>;
    const usage = (body.usage ?? {}) as Record<string, unknown>;
    return {
      inputTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0),
      outputTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0),
    };
  } catch {
    return { inputTokens: 0, outputTokens: 0 };
  }
}

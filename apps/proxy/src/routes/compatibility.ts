import type { OutgoingHttpHeaders } from "node:http";
import { resolveApiKey } from "@model-router/config";
import type { ModelDefinition, Protocol, RouteDecision } from "@model-router/contracts";
import { adapterFor, responseRequestId, UpstreamError } from "@model-router/providers";
import { canFallback, type ErrorClass } from "@model-router/router-core";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RouterRuntime } from "../app.js";
import { normalizeRequest } from "./normalize.js";

const ERROR_PREVIEW_LIMIT = 16 * 1024;

export async function handleCompatibility(
  protocol: Protocol,
  request: FastifyRequest<{ Body: Record<string, unknown> }>,
  reply: FastifyReply,
  runtime: RouterRuntime,
): Promise<unknown> {
  const normalized = normalizeRequest(protocol, request.body ?? {});
  const pinnedHeader = stringHeader(request.headers["x-router-model"]);
  const sessionHeader = stringHeader(request.headers["x-router-session"]);
  const profileHeader = stringHeader(request.headers["x-router-profile"]);
  const excluded: string[] = [];
  const fallbackChain: string[] = [];
  const started = performance.now();
  const clientController = new AbortController();
  const abortClient = () => clientController.abort();
  request.raw.once("aborted", abortClient);
  reply.raw.once("close", abortClient);
  let rootDecision: RouteDecision | undefined;
  let attemptOrder = 0;
  let lastFailure:
    | { error: UpstreamError; modelId: string; status: number; providerId?: string }
    | undefined;
  const explicitlyPinned = Boolean(pinnedHeader || normalized.pinnedModel);

  try {
    for (;;) {
      let selection: RouteDecision;
      try {
        selection = runtime.engine.select(normalized, {
          requestId: request.id,
          pinnedModel: pinnedHeader,
          sessionId: sessionHeader,
          profile: profileHeader,
          excludeModels: excluded,
          persist: rootDecision === undefined,
        });
      } catch (error) {
        if (!lastFailure || !rootDecision) throw error;
        finishMetric(
          runtime,
          rootDecision.id,
          lastFailure.modelId,
          started,
          lastFailure.status,
          "failure",
          fallbackChain.length,
          lastFailure.providerId,
        );
        throw lastFailure.error;
      }
      rootDecision ??= selection;
      const routeId = rootDecision.id;
      const model = runtime.config.models.find(
        (item) => item.id === selection.logicalModel,
      ) as ModelDefinition;
      const adapter = adapterFor(model);
      if (!adapter.supports(protocol))
        throw new Error(`provider ${model.provider} cannot serve ${protocol}`);
      const prepared = adapter.prepareRequest(model, normalized, resolveApiKey(model, runtime.env));
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => timeoutController.abort(), model.timeoutMs);
      const signal = AbortSignal.any([clientController.signal, timeoutController.signal]);
      const attemptStarted = performance.now();
      attemptOrder += 1;
      let upstream: Response;

      try {
        upstream = await adapter.send(prepared, signal);
      } catch (error) {
        clearTimeout(timeout);
        if (clientController.signal.aborted) {
          recordFailedAttempt(
            runtime,
            routeId,
            model.id,
            attemptOrder,
            attemptStarted,
            "client",
            499,
          );
          finishMetric(runtime, routeId, model.id, started, 499, "canceled", fallbackChain.length);
          return reply;
        }
        const errorClass: ErrorClass = timeoutController.signal.aborted
          ? "timeout"
          : adapter.classifyError(error);
        recordFailedAttempt(
          runtime,
          routeId,
          model.id,
          attemptOrder,
          attemptStarted,
          errorClass,
          errorClass === "timeout" ? 504 : 502,
        );
        runtime.store.observeAttempt(
          model.id,
          false,
          performance.now() - attemptStarted,
          errorClass,
        );
        if (
          !explicitlyPinned &&
          canFallback(errorClass, runtime.config.routing.fallbackOn, false)
        ) {
          const status = errorClass === "timeout" ? 504 : 502;
          lastFailure = {
            error: new UpstreamError(
              errorClass === "timeout" ? "upstream timed out" : "upstream network failure",
              status,
            ),
            modelId: model.id,
            status,
          };
          excluded.push(model.id);
          fallbackChain.push(model.id);
          runtime.store.updateFallbackChain(routeId, fallbackChain);
          continue;
        }
        finishMetric(
          runtime,
          routeId,
          model.id,
          started,
          errorClass === "timeout" ? 504 : 502,
          "failure",
          fallbackChain.length,
        );
        throw new UpstreamError(
          errorClass === "timeout" ? "upstream timed out" : "upstream network failure",
          errorClass === "timeout" ? 504 : 502,
        );
      }

      const providerId = responseRequestId(upstream);
      if (!upstream.ok) {
        const errorClass = adapter.classifyError(undefined, upstream);
        let body: Buffer;
        try {
          body = await readBounded(upstream.body, ERROR_PREVIEW_LIMIT, signal, true);
        } catch {
          clearTimeout(timeout);
          const readErrorClass: ErrorClass = clientController.signal.aborted
            ? "client"
            : timeoutController.signal.aborted
              ? "timeout"
              : "network";
          const status =
            readErrorClass === "client" ? 499 : readErrorClass === "timeout" ? 504 : 502;
          recordFailedAttempt(
            runtime,
            routeId,
            model.id,
            attemptOrder,
            attemptStarted,
            readErrorClass,
            status,
            providerId,
          );
          if (readErrorClass !== "client")
            runtime.store.observeAttempt(
              model.id,
              false,
              performance.now() - attemptStarted,
              readErrorClass,
            );
          if (
            !explicitlyPinned &&
            canFallback(readErrorClass, runtime.config.routing.fallbackOn, false)
          ) {
            lastFailure = {
              error: new UpstreamError("upstream error body failed", status, providerId),
              modelId: model.id,
              status,
              providerId,
            };
            excluded.push(model.id);
            fallbackChain.push(model.id);
            runtime.store.updateFallbackChain(routeId, fallbackChain);
            continue;
          }
          finishMetric(
            runtime,
            routeId,
            model.id,
            started,
            status,
            readErrorClass === "client" ? "canceled" : "failure",
            fallbackChain.length,
            providerId,
          );
          if (readErrorClass === "client") return reply;
          throw new UpstreamError("upstream error body failed", status, providerId);
        }
        const safeBody = sanitizePreview(body.toString("utf8"), runtime);
        clearTimeout(timeout);
        recordFailedAttempt(
          runtime,
          routeId,
          model.id,
          attemptOrder,
          attemptStarted,
          errorClass,
          upstream.status,
          providerId,
        );
        runtime.store.observeAttempt(
          model.id,
          !providerFailure(errorClass),
          performance.now() - attemptStarted,
          errorClass,
        );
        if (
          !explicitlyPinned &&
          canFallback(errorClass, runtime.config.routing.fallbackOn, false)
        ) {
          lastFailure = {
            error: new UpstreamError(
              `upstream returned ${upstream.status}`,
              upstream.status,
              providerId,
              safeBody,
            ),
            modelId: model.id,
            status: upstream.status,
            providerId,
          };
          excluded.push(model.id);
          fallbackChain.push(model.id);
          runtime.store.updateFallbackChain(routeId, fallbackChain);
          continue;
        }
        finishMetric(
          runtime,
          routeId,
          model.id,
          started,
          upstream.status,
          "failure",
          fallbackChain.length,
          providerId,
        );
        throw new UpstreamError(
          `upstream returned ${upstream.status}`,
          upstream.status,
          providerId,
          safeBody,
        );
      }

      setResponseHeaders(
        reply,
        request.id,
        rootDecision,
        selection,
        model,
        upstream,
        fallbackChain.length,
      );
      if (normalized.stream) {
        try {
          return await streamResponse({
            upstream,
            signal,
            timeout,
            timeoutController,
            clientController,
            reply,
            runtime,
            routeId,
            model,
            attemptOrder,
            attemptStarted,
            started,
            fallbackCount: fallbackChain.length,
            providerId,
            sessionHeader,
          });
        } catch {
          clearTimeout(timeout);
          const errorClass: ErrorClass = clientController.signal.aborted
            ? "client"
            : timeoutController.signal.aborted
              ? "timeout"
              : "network";
          const status = errorClass === "client" ? 499 : errorClass === "timeout" ? 504 : 502;
          recordFailedAttempt(
            runtime,
            routeId,
            model.id,
            attemptOrder,
            attemptStarted,
            errorClass,
            status,
            providerId,
          );
          if (errorClass !== "client")
            runtime.store.observeAttempt(
              model.id,
              false,
              performance.now() - attemptStarted,
              errorClass,
            );
          if (
            !explicitlyPinned &&
            canFallback(errorClass, runtime.config.routing.fallbackOn, false)
          ) {
            lastFailure = {
              error: new UpstreamError(
                errorClass === "timeout" ? "upstream timed out" : "upstream stream failed",
                status,
                providerId,
              ),
              modelId: model.id,
              status,
              providerId,
            };
            excluded.push(model.id);
            fallbackChain.push(model.id);
            runtime.store.updateFallbackChain(routeId, fallbackChain);
            continue;
          }
          finishMetric(
            runtime,
            routeId,
            model.id,
            started,
            status,
            errorClass === "client" ? "canceled" : "failure",
            fallbackChain.length,
            providerId,
          );
          if (errorClass === "client") return reply;
          throw new UpstreamError(
            errorClass === "timeout" ? "upstream timed out" : "upstream stream failed",
            status,
            providerId,
          );
        }
      }

      let buffer: Buffer;
      try {
        buffer = await readBounded(upstream.body, runtime.config.server.responseLimitBytes, signal);
      } catch (error) {
        clearTimeout(timeout);
        const errorClass: ErrorClass = clientController.signal.aborted
          ? "client"
          : timeoutController.signal.aborted
            ? "timeout"
            : "network";
        const status =
          errorClass === "client"
            ? 499
            : errorClass === "timeout"
              ? 504
              : error instanceof ResponseTooLargeError
                ? 502
                : 502;
        recordFailedAttempt(
          runtime,
          routeId,
          model.id,
          attemptOrder,
          attemptStarted,
          errorClass,
          status,
          providerId,
        );
        if (errorClass !== "client")
          runtime.store.observeAttempt(
            model.id,
            false,
            performance.now() - attemptStarted,
            errorClass,
          );
        if (
          !explicitlyPinned &&
          !(error instanceof ResponseTooLargeError) &&
          canFallback(errorClass, runtime.config.routing.fallbackOn, false)
        ) {
          lastFailure = {
            error: new UpstreamError(
              errorClass === "timeout" ? "upstream timed out" : "upstream body failed",
              status,
              providerId,
            ),
            modelId: model.id,
            status,
            providerId,
          };
          excluded.push(model.id);
          fallbackChain.push(model.id);
          runtime.store.updateFallbackChain(routeId, fallbackChain);
          continue;
        }
        finishMetric(
          runtime,
          routeId,
          model.id,
          started,
          status,
          errorClass === "client" ? "canceled" : "failure",
          fallbackChain.length,
          providerId,
        );
        if (errorClass === "client") return reply;
        throw new UpstreamError(
          error instanceof ResponseTooLargeError
            ? "upstream response exceeded configured limit"
            : errorClass === "timeout"
              ? "upstream timed out"
              : "upstream body failed",
          status,
          providerId,
        );
      }
      clearTimeout(timeout);
      const contentType = upstream.headers.get("content-type") ?? "application/json";
      const usage = extractUsage(buffer, contentType);
      const cost = estimateCost(model, usage);
      runtime.store.recordAttempt({
        routeId,
        modelId: model.id,
        attemptOrder,
        outcome: "success",
        status: upstream.status,
        latencyMs: performance.now() - attemptStarted,
        providerRequestId: providerId,
        ...usage,
        estimatedCostUsd: cost,
      });
      runtime.store.observeAttempt(model.id, true, performance.now() - attemptStarted);
      runtime.store.updateDecisionModel(routeId, model.id, model.upstreamModel);
      runtime.engine.commitAffinity(sessionHeader, model.id);
      runtime.store.recordMetric({
        routeId,
        status: upstream.status,
        latencyMs: performance.now() - started,
        providerRequestId: providerId,
        ...usage,
        estimatedCostUsd: cost,
        outcome: "success",
        finalModel: model.id,
        fallbackCount: fallbackChain.length,
      });
      return reply.code(upstream.status).send(buffer);
    }
  } finally {
    request.raw.off("aborted", abortClient);
    reply.raw.off("close", abortClient);
  }
}

async function streamResponse(input: {
  upstream: Response;
  signal: AbortSignal;
  timeout: NodeJS.Timeout;
  timeoutController: AbortController;
  clientController: AbortController;
  reply: FastifyReply;
  runtime: RouterRuntime;
  routeId: string;
  model: ModelDefinition;
  attemptOrder: number;
  attemptStarted: number;
  started: number;
  fallbackCount: number;
  providerId?: string;
  sessionHeader?: string;
}): Promise<unknown> {
  const {
    upstream,
    signal,
    timeout,
    clientController,
    reply,
    runtime,
    routeId,
    model,
    attemptOrder,
    attemptStarted,
    started,
    fallbackCount,
    providerId,
    sessionHeader,
  } = input;
  const reader = upstream.body?.getReader();
  if (!reader) throw new UpstreamError("upstream stream was unavailable", 502, providerId);
  let bytesEmitted = false;
  let sample = "";
  let sampleBytes = 0;
  const decoder = new TextDecoder();
  try {
    const first = await reader.read();
    reply.hijack();
    reply.raw.writeHead(upstream.status, reply.getHeaders() as OutgoingHttpHeaders);
    if (!first.done && first.value) {
      bytesEmitted = true;
      const length = Math.min(first.value.byteLength, 256_000);
      sampleBytes += length;
      sample += decoder.decode(first.value.subarray(0, length), { stream: true });
      if (!reply.raw.write(first.value)) await waitForDrain(reply, signal);
    }
    sample += decoder.decode();
    while (!first.done) {
      const next = await reader.read();
      if (next.done) break;
      bytesEmitted = true;
      if (sampleBytes < 256_000) {
        const length = Math.min(next.value.byteLength, 256_000 - sampleBytes);
        sample += decoder.decode(next.value.subarray(0, length), { stream: true });
        sampleBytes += length;
      }
      if (!reply.raw.write(next.value)) await waitForDrain(reply, signal);
    }
    clearTimeout(timeout);
    reply.raw.end();
    const usage = extractStreamUsage(sample);
    const cost = estimateCost(model, usage);
    runtime.store.recordAttempt({
      routeId,
      modelId: model.id,
      attemptOrder,
      outcome: "success",
      status: upstream.status,
      latencyMs: performance.now() - attemptStarted,
      providerRequestId: providerId,
      bytesEmitted,
      ...usage,
      estimatedCostUsd: cost,
    });
    runtime.store.observeAttempt(model.id, true, performance.now() - attemptStarted);
    runtime.store.updateDecisionModel(routeId, model.id, model.upstreamModel);
    runtime.engine.commitAffinity(sessionHeader, model.id);
    runtime.store.recordMetric({
      routeId,
      status: upstream.status,
      latencyMs: performance.now() - started,
      providerRequestId: providerId,
      outcome: "success",
      finalModel: model.id,
      fallbackCount,
      ...usage,
      estimatedCostUsd: cost,
    });
    return reply;
  } catch (error) {
    if (!bytesEmitted && !reply.raw.headersSent) throw error;
    clearTimeout(timeout);
    const canceled = clientController.signal.aborted;
    const status = canceled ? 499 : input.timeoutController.signal.aborted ? 504 : 502;
    runtime.store.recordAttempt({
      routeId,
      modelId: model.id,
      attemptOrder,
      outcome: canceled ? "canceled" : "failure",
      errorClass: canceled ? "client" : status === 504 ? "timeout" : "network",
      status,
      latencyMs: performance.now() - attemptStarted,
      providerRequestId: providerId,
      bytesEmitted,
    });
    if (!canceled)
      runtime.store.observeAttempt(model.id, false, performance.now() - attemptStarted);
    finishMetric(
      runtime,
      routeId,
      model.id,
      started,
      status,
      canceled ? "canceled" : "failure",
      fallbackCount,
      providerId,
    );
    reply.raw.destroy();
    return reply;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  signal: AbortSignal,
  truncate = false,
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit - size;
      if (value.byteLength > remaining) {
        if (!truncate) throw new ResponseTooLargeError();
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

class ResponseTooLargeError extends Error {}

function setResponseHeaders(
  reply: FastifyReply,
  requestId: string,
  root: RouteDecision,
  selected: RouteDecision,
  model: ModelDefinition,
  upstream: Response,
  fallbackCount: number,
): void {
  reply.header("x-router-request-id", requestId);
  reply.header("x-router-model", model.id);
  reply.header("x-router-route-id", root.id);
  reply.header("x-router-profile", selected.profile);
  reply.header("x-router-fallback-count", String(fallbackCount));
  reply.header("content-type", upstream.headers.get("content-type") ?? "application/json");
  const providerId = responseRequestId(upstream);
  if (providerId) reply.header("x-upstream-request-id", providerId);
}

function recordFailedAttempt(
  runtime: RouterRuntime,
  routeId: string,
  modelId: string,
  attemptOrder: number,
  started: number,
  errorClass: string,
  status: number,
  providerRequestId?: string,
): void {
  runtime.store.recordAttempt({
    routeId,
    modelId,
    attemptOrder,
    outcome: errorClass === "client" ? "canceled" : "failure",
    errorClass,
    status,
    latencyMs: performance.now() - started,
    providerRequestId,
  });
}

function finishMetric(
  runtime: RouterRuntime,
  routeId: string,
  modelId: string,
  started: number,
  status: number,
  outcome: "success" | "failure" | "canceled",
  fallbackCount: number,
  providerRequestId?: string,
): void {
  runtime.store.updateDecisionModel(
    routeId,
    modelId,
    runtime.config.models.find((item) => item.id === modelId)?.upstreamModel ?? modelId,
  );
  runtime.store.recordMetric({
    routeId,
    status,
    latencyMs: performance.now() - started,
    outcome,
    finalModel: modelId,
    fallbackCount,
    providerRequestId,
  });
}

function providerFailure(errorClass: string): boolean {
  return [
    "timeout",
    "network",
    "rate_limit",
    "overloaded",
    "upstream_5xx",
    "auth",
    "model_not_found",
  ].includes(errorClass);
}

function stringHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function estimateCost(
  model: ModelDefinition,
  usage: { inputTokens: number; outputTokens: number },
): number {
  return (
    (usage.inputTokens * model.cost.inputPerMillion +
      usage.outputTokens * model.cost.outputPerMillion) /
    1_000_000
  );
}

function extractStreamUsage(text: string): { inputTokens: number; outputTokens: number } {
  let result = { inputTokens: 0, outputTokens: 0 };
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const usage = extractUsage(Buffer.from(data), "application/json");
      if (usage.inputTokens > 0) result.inputTokens = usage.inputTokens;
      if (usage.outputTokens > 0) result.outputTokens = usage.outputTokens;
    } catch {
      /* ignore malformed frames */
    }
  }
  return result;
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

function waitForDrain(reply: FastifyReply, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      reply.raw.off("drain", onDrain);
      reply.raw.off("close", onClose);
      reply.raw.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("client closed"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    reply.raw.once("drain", onDrain);
    reply.raw.once("close", onClose);
    reply.raw.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function sanitizePreview(value: string, runtime: RouterRuntime): string {
  let safe = value.replace(/\b(?:Bearer\s+)?(?:sk-|key-)[A-Za-z0-9._-]{8,}\b/gi, "[REDACTED]");
  const names = [
    ...runtime.config.models.map((model) => model.apiKeyEnv),
    runtime.config.server.authTokenEnv,
  ].filter(Boolean) as string[];
  for (const name of names) {
    const secret = runtime.env[name];
    if (secret) safe = safe.split(secret).join("[REDACTED]");
  }
  return safe;
}

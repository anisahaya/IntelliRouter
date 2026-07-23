import { resolveApiKey } from "@model-router/config";
import type { ModelDefinition, Protocol, RouteDecision } from "@model-router/contracts";
import { adapterFor, responseRequestId, UpstreamError } from "@model-router/providers";
import { canFallback, type ErrorClass } from "@model-router/router-core";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RouterRuntime } from "../app.js";
import {
  estimateCost,
  extractUsage,
  finishMetric,
  providerFailure,
  recordFailedAttempt,
} from "./compatibility-metrics.js";
import { streamResponse } from "./compatibility-stream.js";
import {
  ERROR_PREVIEW_LIMIT,
  ResponseTooLargeError,
  readBounded,
  sanitizePreview,
  setResponseHeaders,
  stringHeader,
} from "./compatibility-support.js";
import { normalizeRequest } from "./normalize.js";

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

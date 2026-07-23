import type { OutgoingHttpHeaders } from "node:http";
import type { ModelDefinition } from "@model-router/contracts";
import { UpstreamError } from "@model-router/providers";
import type { FastifyReply } from "fastify";
import type { RouterRuntime } from "../app.js";
import { estimateCost, extractStreamUsage, finishMetric } from "./compatibility-metrics.js";
import { ResponseTooLargeError } from "./compatibility-support.js";

export interface StreamResponseInput {
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
}

export async function streamResponse(input: StreamResponseInput): Promise<unknown> {
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
  let totalStreamed = 0;
  const streamLimit = runtime.config.server.responseLimitBytes;
  const decoder = new TextDecoder();
  try {
    const first = await reader.read();
    reply.hijack();
    reply.raw.writeHead(upstream.status, reply.getHeaders() as OutgoingHttpHeaders);
    if (!first.done && first.value) {
      bytesEmitted = true;
      totalStreamed += first.value.byteLength;
      if (totalStreamed > streamLimit) throw new ResponseTooLargeError();
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
      totalStreamed += next.value.byteLength;
      if (totalStreamed > streamLimit) throw new ResponseTooLargeError();
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

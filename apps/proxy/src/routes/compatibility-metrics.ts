import type { ModelDefinition } from "@model-router/contracts";
import { parseBoundedJSON } from "@model-router/telemetry";
import type { RouterRuntime } from "../app.js";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export function recordFailedAttempt(
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

export function finishMetric(
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

export function providerFailure(errorClass: string): boolean {
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

export function estimateCost(model: ModelDefinition, usage: TokenUsage): number {
  return (
    (usage.inputTokens * model.cost.inputPerMillion +
      usage.outputTokens * model.cost.outputPerMillion) /
    1_000_000
  );
}

export function extractStreamUsage(text: string): TokenUsage {
  const result = { inputTokens: 0, outputTokens: 0 };
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const usage = extractUsage(Buffer.from(data), "application/json");
      if (usage.inputTokens > 0) result.inputTokens = usage.inputTokens;
      if (usage.outputTokens > 0) result.outputTokens = usage.outputTokens;
    } catch {
      // Malformed stream frames do not carry usable accounting data.
    }
  }
  return result;
}

export function extractUsage(buffer: Buffer, contentType: string): TokenUsage {
  if (!contentType.includes("json")) return { inputTokens: 0, outputTokens: 0 };
  try {
    const body = parseBoundedJSON(buffer.toString("utf8"), 1024 * 1024) as Record<string, unknown>;
    const usage = (body.usage ?? {}) as Record<string, unknown>;
    return {
      inputTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0),
      outputTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0),
    };
  } catch {
    return { inputTokens: 0, outputTokens: 0 };
  }
}

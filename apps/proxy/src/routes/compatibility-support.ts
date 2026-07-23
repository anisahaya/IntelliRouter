import type { ModelDefinition, RouteDecision } from "@model-router/contracts";
import { responseRequestId } from "@model-router/providers";
import { parseBoundedJSON, redactValue } from "@model-router/telemetry";
import type { FastifyReply } from "fastify";
import type { RouterRuntime } from "../app.js";

export const ERROR_PREVIEW_LIMIT = 4 * 1024;

export class ResponseTooLargeError extends Error {}

export async function readBounded(
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
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          size += remaining;
        }
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

export function setResponseHeaders(
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

export function stringHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function sanitizePreview(value: string, runtime: RouterRuntime): string {
  const capped =
    value.length > ERROR_PREVIEW_LIMIT ? `${value.slice(0, ERROR_PREVIEW_LIMIT)}…` : value;
  let parsed: unknown;
  try {
    parsed = parseBoundedJSON(capped, ERROR_PREVIEW_LIMIT);
  } catch {
    parsed = capped;
  }
  const recursivelyRedacted = redactValue(parsed);
  let safe =
    typeof recursivelyRedacted === "string"
      ? recursivelyRedacted
      : (() => {
          try {
            return JSON.stringify(recursivelyRedacted);
          } catch {
            return String(recursivelyRedacted);
          }
        })();
  safe = safe.replace(/\b(?:Bearer\s+)?(?:sk-|key-)[A-Za-z0-9._-]{8,}\b/gi, "[REDACTED]");
  const names = [
    ...runtime.config.models.map((model) => model.apiKeyEnv),
    runtime.config.server.authTokenEnv,
  ].filter(Boolean) as string[];
  for (const name of names) {
    const secret = runtime.env[name];
    if (secret) safe = safe.split(secret).join("[REDACTED]");
  }
  return safe.slice(0, ERROR_PREVIEW_LIMIT);
}

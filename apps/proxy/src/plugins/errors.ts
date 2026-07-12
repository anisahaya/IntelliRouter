import { UpstreamError } from "@model-router/providers";
import { redactValue } from "@model-router/telemetry";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

export function installErrors(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error, headers: "[REDACTED]" }, "request failed");
    if (error instanceof UpstreamError) {
      return reply.code(error.status).send({
        error: {
          code: "upstream_error",
          message: error.message,
          requestId: request.id,
          upstreamRequestId: error.requestId,
          upstream: safeUpstreamError(error.responseBody),
        },
      });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "invalid_request",
          message: error.issues[0]?.message ?? "invalid request",
          requestId: request.id,
        },
      });
    }
    const message = error instanceof Error ? error.message : "internal router error";
    const explicitStatus = Number((error as { statusCode?: number }).statusCode);
    const status = Number.isInteger(explicitStatus)
      ? explicitStatus
      : /unknown|ineligible|eligible model|invalid|not found/.test(message)
        ? 400
        : 500;
    return reply.code(status).send({
      error: {
        code: status === 400 ? "routing_error" : "internal_error",
        message,
        requestId: request.id,
      },
    });
  });
}

function safeUpstreamError(body?: string): unknown {
  if (!body) return undefined;
  try {
    return redactValue(JSON.parse(body));
  } catch {
    return String(redactValue(body)).slice(0, 4_096);
  }
}

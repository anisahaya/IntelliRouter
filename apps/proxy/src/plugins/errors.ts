import { UpstreamError } from "@model-router/providers";
import { redactValue } from "@model-router/telemetry";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

const UPSTREAM_PREVIEW_LIMIT = 4_096;
const HOME_PREFIX =
  typeof process.env.HOME === "string" && process.env.HOME.length > 2 ? process.env.HOME : "";

export function installErrors(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    request.log.error(
      {
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorCode: error instanceof UpstreamError ? "upstream_error" : "request_error",
        status: error instanceof UpstreamError ? error.status : undefined,
      },
      "request failed",
    );
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
    const rawMessage = error instanceof Error ? error.message : "internal router error";
    const message = sanitizeClientMessage(rawMessage);
    const explicitStatus = Number((error as { statusCode?: number }).statusCode);
    const status = Number.isInteger(explicitStatus)
      ? explicitStatus
      : /unknown|ineligible|eligible model|invalid|not found/.test(message)
        ? 400
        : 500;
    return reply.code(status).send({
      error: {
        code: status === 400 ? "routing_error" : "internal_error",
        message: status === 400 ? message : "internal router error",
        requestId: request.id,
      },
    });
  });
}

function safeUpstreamError(body?: string): unknown {
  if (!body) return undefined;
  const truncated =
    body.length > UPSTREAM_PREVIEW_LIMIT ? `${body.slice(0, UPSTREAM_PREVIEW_LIMIT)}…` : body;
  try {
    return redactValue(JSON.parse(truncated));
  } catch {
    return sanitizeClientMessage(String(redactValue(truncated)));
  }
}

export function sanitizeClientMessage(message: string): string {
  let safe = message;
  if (HOME_PREFIX) safe = safe.split(HOME_PREFIX).join("~");
  safe = safe.replace(/\/[^\s"'<>]+\/[^\s"'<>]+/g, "<path>");
  return safe.slice(0, UPSTREAM_PREVIEW_LIMIT);
}

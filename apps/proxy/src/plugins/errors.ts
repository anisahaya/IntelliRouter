import { homedir } from "node:os";
import { UpstreamError } from "@model-router/providers";
import { redactTokenText, redactValue } from "@model-router/telemetry";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

const UPSTREAM_PREVIEW_LIMIT = 4_096;
const HOME_PREFIX = process.env.HOME ?? process.env.USERPROFILE ?? homedir();

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
    const parsed = redactValue(JSON.parse(truncated));
    return redactTokenLiterals(parsed);
  } catch {
    return sanitizeClientMessage(String(redactValue(truncated)));
  }
}

function redactTokenLiterals(value: unknown): unknown {
  if (typeof value === "string") return redactTokenText(value);
  if (Array.isArray(value)) return value.map(redactTokenLiterals);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactTokenLiterals(v)]),
    );
  }
  return value;
}

export function sanitizeClientMessage(message: string, homePrefix = HOME_PREFIX): string {
  let safe = message;
  safe = redactTokenText(safe);
  if (homePrefix.length > 2) safe = safe.split(homePrefix).join("~");
  safe = safe.replace(/\b[A-Za-z]:\\[^\s"'<>]+/g, "<path>");
  safe = safe.replace(/\/[^\s"'<>]+\/[^\s"'<>]+/g, "<path>");
  return safe.slice(0, UPSTREAM_PREVIEW_LIMIT);
}

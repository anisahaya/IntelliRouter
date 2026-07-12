import type { FastifyInstance } from "fastify";
import type { RouterRuntime } from "../app.js";
import { handleCompatibility } from "./compatibility.js";

export function registerAnthropicMessages(app: FastifyInstance, runtime: RouterRuntime): void {
  app.post<{ Body: Record<string, unknown> }>("/v1/messages", (request, reply) =>
    handleCompatibility("anthropic-messages", request, reply, runtime),
  );
}

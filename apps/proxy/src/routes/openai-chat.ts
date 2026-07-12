import type { FastifyInstance } from "fastify";
import type { RouterRuntime } from "../app.js";
import { handleCompatibility } from "./compatibility.js";

export function registerOpenAIChat(app: FastifyInstance, runtime: RouterRuntime): void {
  app.post<{ Body: Record<string, unknown> }>("/v1/chat/completions", (request, reply) =>
    handleCompatibility("openai-chat", request, reply, runtime),
  );
}

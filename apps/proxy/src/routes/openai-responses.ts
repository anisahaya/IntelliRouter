import type { FastifyInstance } from "fastify";
import type { RouterRuntime } from "../app.js";
import { handleCompatibility } from "./compatibility.js";

export function registerOpenAIResponses(app: FastifyInstance, runtime: RouterRuntime): void {
  app.post<{ Body: Record<string, unknown> }>("/v1/responses", (request, reply) =>
    handleCompatibility("openai-responses", request, reply, runtime),
  );
}

import type { FastifyInstance } from "fastify";
import type { RouterRuntime } from "../app.js";

export function registerModels(app: FastifyInstance, runtime: RouterRuntime): void {
  app.get("/v1/models", async () => ({
    object: "list",
    data: runtime.config.models
      .filter((model) => model.enabled)
      .map((model) => ({ id: model.id, object: "model", owned_by: "model-router" })),
  }));
}

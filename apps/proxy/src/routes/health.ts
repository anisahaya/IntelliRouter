import type { FastifyInstance } from "fastify";
import type { RouterRuntime } from "../app.js";

export function registerHealth(app: FastifyInstance, runtime: RouterRuntime): void {
  app.get("/healthz", async (_request, reply) => {
    try {
      runtime.store.database.prepare("SELECT 1").get();
      return { status: "ok", config: "loaded", database: "ready" };
    } catch {
      return reply
        .code(503)
        .send({ status: "unhealthy", config: "loaded", database: "unavailable" });
    }
  });
  app.get("/readyz", async (_request, reply) => {
    const eligible = runtime.config.models.some(
      (model) => model.enabled && runtime.store.isHealthy(model.id),
    );
    return reply
      .code(eligible ? 200 : 503)
      .send({ status: eligible ? "ready" : "not_ready", eligibleModels: eligible });
  });
}

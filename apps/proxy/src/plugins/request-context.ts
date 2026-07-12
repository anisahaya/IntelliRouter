import type { FastifyInstance } from "fastify";

export function installRequestContext(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-router-request-id", request.id);
    return payload;
  });
}

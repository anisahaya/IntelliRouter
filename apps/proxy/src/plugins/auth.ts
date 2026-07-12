import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

export function installAuth(app: FastifyInstance, expectedToken?: string): void {
  if (!expectedToken) return;
  app.addHook("onRequest", async (request, reply) => {
    const value = request.headers.authorization;
    const actual = value?.startsWith("Bearer ") ? value.slice(7) : "";
    const left = Buffer.from(actual);
    const right = Buffer.from(expectedToken);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      return reply.code(401).send({
        error: {
          code: "unauthorized",
          message: "missing or invalid router bearer token",
          requestId: request.id,
        },
      });
    }
  });
}

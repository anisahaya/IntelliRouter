import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type RouterConfig, routerConfigSchema } from "@model-router/contracts";
import { TelemetryStore } from "@model-router/telemetry";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

let upstream: Server;
let baseUrl: string;
let app: FastifyInstance;
const received: Record<string, unknown>[] = [];
let upstreamCanceled = false;

beforeAll(async () => {
  upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body =
      chunks.length > 0
        ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
        : {};
    received.push({ path: request.url, ...body });
    if (body.streamHold) {
      response.once("close", () => {
        upstreamCanceled = true;
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
      return;
    }
    if (body.streamFailure && body.model === "upstream-cheap") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
      response.destroy();
      return;
    }
    if (body.forceTimeout && body.model === "upstream-cheap") {
      setTimeout(() => {
        if (!response.destroyed) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: "late" }));
        }
      }, 100);
      return;
    }
    if (body.forceRateLimit && body.model === "upstream-cheap") {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "rate limited" } }));
      return;
    }
    if (body.forceClientError) {
      response.writeHead(400, {
        "content-type": "application/json",
        "x-request-id": "upstream-400",
      });
      response.end(JSON.stringify({ error: { message: "bad upstream request" } }));
      return;
    }
    if (body.forceFailure && body.model === "upstream-cheap") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "temporary" } }));
      return;
    }
    if (body.stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "stream-1" });
      if (request.url?.includes("messages")) {
        response.write(
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n',
        );
        response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      } else {
        response.write(
          `data: {"id":"chunk","model":"${body.model}","choices":[{"delta":{"content":"hello"}}]}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      }
      return;
    }
    response.writeHead(200, { "content-type": "application/json", "x-request-id": "mock-1" });
    if (request.url?.includes("messages")) {
      response.end(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: "hello" }],
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
      );
    } else if (request.url?.includes("responses")) {
      response.end(
        JSON.stringify({
          id: "resp_1",
          object: "response",
          model: body.model,
          output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }],
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
      );
    } else {
      response.end(
        JSON.stringify({
          id: "chat_1",
          object: "chat.completion",
          model: body.model,
          choices: [{ message: { role: "assistant", content: "hello" } }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    upstream.close((error) => (error ? reject(error) : resolve())),
  );
});

beforeEach(async () => {
  received.length = 0;
  upstreamCanceled = false;
  app = await buildApp({
    config: makeConfig(),
    store: new TelemetryStore(":memory:"),
    env: { MOCK_KEY: "mock-secret" },
    logger: false,
  });
});

afterEach(async () => {
  await app.close();
});

describe("compatibility proxy", () => {
  it("forwards OpenAI Chat and Responses without losing custom fields", async () => {
    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
        custom_field: "preserve",
      },
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.headers["x-router-model"]).toBe("cheap");
    expect(received[0]?.custom_field).toBe("preserve");
    const responses = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: { model: "router/balanced", input: "hello" },
    });
    expect(responses.statusCode).toBe(200);
    expect(responses.json().object).toBe("response");
  });

  it("forwards Anthropic Messages and both SSE protocols", async () => {
    const message = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: { model: "auto", max_tokens: 20, messages: [{ role: "user", content: "hello" }] },
    });
    expect(message.statusCode).toBe(200);
    expect(message.json().type).toBe("message");
    const openaiStream = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "auto", stream: true, messages: [{ role: "user", content: "hello" }] },
    });
    expect(openaiStream.body).toContain("data: [DONE]");
    expect(openaiStream.headers["x-router-request-id"]).toBeTruthy();
    const anthropicStream = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        model: "auto",
        stream: true,
        max_tokens: 20,
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(anthropicStream.body).toContain("event: message_stop");
  });

  it("filters tool/JSON requirements before score selection", async () => {
    const tool = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "call a tool" }],
        tools: [{ type: "function", function: { name: "x" } }],
      },
    });
    expect(tool.headers["x-router-model"]).toBe("premium");
    expect(received[0]?.tools).toEqual([{ type: "function", function: { name: "x" } }]);
    const json = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "json" }],
        response_format: { type: "json_schema" },
      },
    });
    expect(json.headers["x-router-model"]).toBe("premium");
  });

  it("falls back on transient pre-response failures and preserves non-transient IDs", async () => {
    const fallback = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        forceFailure: true,
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.headers["x-router-model"]).toBe("premium");
    expect(fallback.headers["x-router-fallback-count"]).toBe("1");
    const rateLimit = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        forceRateLimit: true,
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(rateLimit.headers["x-router-model"]).toBe("premium");
    const timeout = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        forceTimeout: true,
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(timeout.headers["x-router-model"]).toBe("premium");
    const bad = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-router-model": "premium" },
      payload: {
        model: "auto",
        forceClientError: true,
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.upstreamRequestId).toBe("upstream-400");
    expect(bad.json().error.upstream.error.message).toBe("bad upstream request");
  });

  it("does not retry after stream bytes begin and propagates client cancellation", async () => {
    await app
      .inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "auto",
          stream: true,
          streamFailure: true,
          messages: [{ role: "user", content: "hello" }],
        },
      })
      .catch(() => undefined);
    expect(received.filter((item) => item.streamFailure)).toHaveLength(1);
    expect(received.find((item) => item.streamFailure)?.model).toBe("upstream-cheap");

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    const clientAbort = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: clientAbort.signal,
      body: JSON.stringify({
        model: "auto",
        stream: true,
        streamHold: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const reader = response.body?.getReader();
    await reader?.read();
    clientAbort.abort();
    for (let index = 0; index < 20 && !upstreamCanceled; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(upstreamCanceled).toBe(true);
  });

  it("keeps sessions affine and exposes explanations, feedback, and aggregate stats", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-router-session": "opaque-session" },
      payload: { model: "router/balanced", messages: [{ role: "user", content: "hello" }] },
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-router-session": "opaque-session", "x-router-profile": "premium" },
      payload: { model: "auto", messages: [{ role: "user", content: "hard architecture" }] },
    });
    expect(second.headers["x-router-model"]).toBe(first.headers["x-router-model"]);
    const dry = await app.inject({
      method: "POST",
      url: "/router/route",
      payload: { task: "review code", profile: "balanced" },
    });
    const route = dry.json();
    const explanation = await app.inject({ method: "GET", url: `/router/routes/${route.id}` });
    expect(explanation.json().candidates.length).toBe(3);
    expect(explanation.body).not.toContain("mock-secret");
    expect(explanation.body).not.toContain("review code");
    const feedback = await app.inject({
      method: "POST",
      url: "/router/feedback",
      payload: { routeId: route.id, outcome: "success", tags: ["accepted"] },
    });
    expect(feedback.statusCode).toBe(202);
    const stats = await app.inject({ method: "GET", url: "/router/stats" });
    expect(stats.json().totalRequests).toBeGreaterThanOrEqual(2);
  });

  it("serves health/model surfaces and bounded malformed errors", async () => {
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/models" })).json().data).toHaveLength(3);
    const malformed = await app.inject({ method: "POST", url: "/router/route", payload: {} });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe("invalid_request");
    const oversized = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ model: "auto", input: "x".repeat(2_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.body.length).toBeLessThan(1_024);
  });

  it("covers control discovery, missing resources, protocol dry-runs, and probes", async () => {
    const models = await app.inject({ method: "GET", url: "/router/models" });
    expect(models.statusCode).toBe(200);
    expect(models.json().profiles).toContain("balanced");
    expect(models.json().models[0].health.state).toBe("unknown");

    const missingRoute = await app.inject({ method: "GET", url: "/router/routes/missing" });
    expect(missingRoute.statusCode).toBe(404);
    const missingModel = await app.inject({ method: "POST", url: "/router/models/missing/probe" });
    expect(missingModel.statusCode).toBe(404);

    const probe = await app.inject({ method: "POST", url: "/router/models/cheap/probe" });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toMatchObject({ model: "cheap", healthy: true, status: 200 });

    for (const protocol of ["openai-responses", "anthropic-messages"] as const) {
      const dry = await app.inject({
        method: "POST",
        url: "/router/route",
        payload: {
          task: "inspect a diagram",
          protocol,
          requirements: {
            vision: true,
            streaming: true,
            minimumContextTokens: 100,
          },
        },
      });
      expect(dry.statusCode).toBe(200);
      expect(dry.json().protocol).toBe(protocol);
    }
  });

  it("enforces configured bearer auth without echoing the token", async () => {
    await app.close();
    const config = makeConfig();
    config.server.authTokenEnv = "ROUTER_TOKEN";
    app = await buildApp({
      config,
      store: new TelemetryStore(":memory:"),
      env: { MOCK_KEY: "mock-secret", ROUTER_TOKEN: "router-secret" },
      logger: false,
    });
    const denied = await app.inject({ method: "GET", url: "/healthz" });
    expect(denied.statusCode).toBe(401);
    expect(denied.body).not.toContain("router-secret");
    const allowed = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { authorization: "Bearer router-secret" },
    });
    expect(allowed.statusCode).toBe(200);
  });
});

function makeConfig(): RouterConfig {
  return routerConfigSchema.parse({
    server: { databasePath: ":memory:" },
    models: [
      {
        id: "cheap",
        provider: "openai-compatible",
        upstreamModel: "upstream-cheap",
        baseUrl: `${baseUrl}/v1`,
        apiKeyEnv: "MOCK_KEY",
        timeoutMs: 30,
        quality: 0.8,
        cost: { inputPerMillion: 0.1, outputPerMillion: 0.2 },
        capabilities: {
          protocols: ["openai-chat", "openai-responses"],
          tools: false,
          json: false,
          vision: false,
          maxContextTokens: 64_000,
        },
      },
      {
        id: "premium",
        provider: "openai-compatible",
        upstreamModel: "upstream-premium",
        baseUrl: `${baseUrl}/v1`,
        apiKeyEnv: "MOCK_KEY",
        quality: 0.75,
        tags: ["reasoning"],
        cost: { inputPerMillion: 2, outputPerMillion: 8 },
        capabilities: {
          protocols: ["openai-chat", "openai-responses"],
          tools: true,
          json: true,
          vision: true,
          maxContextTokens: 200_000,
        },
      },
      {
        id: "anthropic",
        provider: "anthropic",
        upstreamModel: "upstream-anthropic",
        baseUrl,
        apiKeyEnv: "MOCK_KEY",
        quality: 0.8,
        capabilities: {
          protocols: ["anthropic-messages"],
          tools: true,
          json: true,
          vision: true,
          maxContextTokens: 200_000,
        },
      },
    ],
    routing: {
      defaultProfile: "balanced",
      affinityTtlSeconds: 3600,
      fallbackOn: ["timeout", "rate_limit", "overloaded", "upstream_5xx"],
      profiles: {
        balanced: { weights: { quality: 0.4, cost: 0.5, latency: 0.1 } },
        premium: { weights: { quality: 0.9, cost: 0.05, latency: 0.05 } },
      },
    },
  });
}

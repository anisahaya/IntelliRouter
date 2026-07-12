import { createServer } from "node:http";
import { buildApp } from "../dist/proxy/app.js";

export async function startHarness() {
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (body.stream) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "x-request-id": "mock-stream",
      });
      if (request.url.includes("messages")) {
        response.write(
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"mock"}}\n\n',
        );
        response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      } else {
        response.write('data: {"id":"chunk","choices":[{"delta":{"content":"mock"}}]}\n\n');
        response.end("data: [DONE]\n\n");
      }
      return;
    }
    response.writeHead(200, { "content-type": "application/json", "x-request-id": "mock-request" });
    if (request.url.includes("messages")) {
      response.end(
        JSON.stringify({
          id: "msg_mock",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "mock" }],
          model: body.model,
          usage: { input_tokens: 2, output_tokens: 1 },
        }),
      );
    } else if (request.url.includes("responses")) {
      response.end(
        JSON.stringify({
          id: "resp_mock",
          object: "response",
          output: [{ type: "message", content: [{ type: "output_text", text: "mock" }] }],
          model: body.model,
          usage: { input_tokens: 2, output_tokens: 1 },
        }),
      );
    } else {
      response.end(
        JSON.stringify({
          id: "chat_mock",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "mock" } }],
          model: body.model,
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        }),
      );
    }
  });
  await listen(upstream);
  const upstreamAddress = upstream.address();
  const upstreamUrl = `http://127.0.0.1:${upstreamAddress.port}`;
  const config = {
    server: { host: "127.0.0.1", port: 0, databasePath: ":memory:", bodyLimitBytes: 2_097_152 },
    privacy: { storePrompts: false, storeResponses: false, hashSessionIds: true },
    models: [
      model("mock-openai", "openai-compatible", "mock-openai-upstream", `${upstreamUrl}/v1`, [
        "openai-chat",
        "openai-responses",
      ]),
      model("mock-anthropic", "anthropic", "mock-anthropic-upstream", upstreamUrl, [
        "anthropic-messages",
      ]),
    ],
    routing: {
      defaultProfile: "balanced",
      affinityTtlSeconds: 3600,
      fallbackOn: ["timeout", "rate_limit", "overloaded", "upstream_5xx"],
      profiles: {
        economy: { weights: { quality: 0.2, cost: 0.55, latency: 0.25 } },
        balanced: { weights: { quality: 0.45, cost: 0.35, latency: 0.2 } },
        premium: { weights: { quality: 0.75, cost: 0.1, latency: 0.15 } },
      },
    },
  };
  const app = await buildApp({ config, env: { MOCK_API_KEY: "mock-only" }, logger: false });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await app.close();
      await new Promise((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function model(id, provider, upstreamModel, baseUrl, protocols) {
  return {
    id,
    enabled: true,
    provider,
    upstreamModel,
    baseUrl,
    apiKeyEnv: "MOCK_API_KEY",
    cost: { inputPerMillion: 0, outputPerMillion: 0 },
    capabilities: {
      protocols,
      tools: true,
      json: true,
      vision: true,
      streaming: true,
      maxContextTokens: 200_000,
    },
    tags: ["mock"],
    quality: 0.5,
    timeoutMs: 5_000,
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

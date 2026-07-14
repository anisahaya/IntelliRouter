import { describe, expect, it, vi } from "vitest";
import { ProxyClient } from "../src/client.js";

describe("ProxyClient", () => {
  it.each([
    [
      "openai-chat",
      "/v1/chat/completions",
      {
        choices: [
          {
            message: {
              content: [
                { type: "text", text: "a" },
                { type: "text", text: "b" },
              ],
            },
          },
        ],
        usage: {},
      },
      "ab",
    ],
    [
      "openai-responses",
      "/v1/responses",
      { output: [{ content: [{ type: "output_text", text: "answer" }] }], usage: {} },
      "answer",
    ],
    [
      "anthropic-messages",
      "/v1/messages",
      { content: [{ type: "text", text: "answer" }], usage: {} },
      "answer",
    ],
  ] as const)("delegates %s payloads", async (protocol, path, body, expected) => {
    const fetchImpl = vi.fn(
      async (url: string | URL | Request) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-router-model": "chosen",
            "x-router-route-id": "r1",
          },
        }),
    );
    const client = new ProxyClient({
      baseUrl: "http://router/",
      authToken: "token",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const result = await client.delegate({
      prompt: "do it",
      protocol,
      model: "chosen",
      maxOutputTokens: 20,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(path);
    expect(result.text).toBe(expected);
    expect(result.model).toBe("chosen");
  });

  it("bounds errors and supports control methods", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes("feedback")) return new Response("bad", { status: 500 });
      return new Response(JSON.stringify({ id: "r1" }), { status: 200 });
    });
    const client = new ProxyClient({
      baseUrl: "http://router",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await client.routeTask({ task: "x" });
    await client.explainRoute("r1");
    await client.stats({ model: "a" });
    await client.models();
    await expect(client.feedback({ routeId: "r1" })).rejects.toThrow("500");
  });
});

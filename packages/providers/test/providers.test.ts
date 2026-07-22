import type { ModelDefinition, NormalizedRequest } from "@model-router/contracts";
import { modelDefinitionSchema } from "@model-router/contracts";
import {
  AnthropicAdapter,
  assertSafeEgress,
  OpenAICompatibleAdapter,
} from "@model-router/providers";
import { describe, expect, it } from "vitest";

const model: ModelDefinition = modelDefinitionSchema.parse({
  id: "m",
  provider: "openai-compatible",
  upstreamModel: "upstream",
  baseUrl: "https://provider.test/v1",
  apiKeyEnv: "KEY",
  capabilities: { protocols: ["openai-chat"], maxContextTokens: 1000 },
});
const request: NormalizedRequest = {
  protocol: "openai-chat",
  stream: false,
  summary: "private prompt",
  toolsRequired: false,
  jsonRequired: false,
  visionRequired: false,
  estimatedInputTokens: 1,
  minimumContextTokens: 0,
  passThroughBody: {
    model: "auto",
    messages: [{ role: "user", content: "hello" }],
    custom: "keep",
  },
  metadata: { messageCount: 1 },
};

describe("provider adapters", () => {
  it("rejects private and unsupported egress targets", async () => {
    await expect(assertSafeEgress("https://10.0.0.1/v1")).rejects.toThrow();
    await expect(assertSafeEgress("ftp://example.test")).rejects.toThrow();
    await expect(assertSafeEgress("https://[fd00::1]/v1")).rejects.toThrow();
    await expect(assertSafeEgress("https://does-not-exist.invalid/v1")).rejects.toThrow();
  });
  it("preserves OpenAI payload fields while replacing only the model", () => {
    const prepared = new OpenAICompatibleAdapter().prepareRequest(model, request, "key");
    expect(prepared.url).toBe("https://provider.test/v1/chat/completions");
    expect(JSON.parse(String(prepared.init.body))).toEqual({
      model: "upstream",
      messages: [{ role: "user", content: "hello" }],
      custom: "keep",
    });
  });

  it("uses Anthropic headers without leaking them into the body", () => {
    const anthropicModel = {
      ...model,
      provider: "anthropic" as const,
      capabilities: { ...model.capabilities, protocols: ["anthropic-messages" as const] },
    };
    const anthropicRequest = {
      ...request,
      protocol: "anthropic-messages" as const,
      metadata: { messageCount: 1 },
    };
    const prepared = new AnthropicAdapter().prepareRequest(anthropicModel, anthropicRequest, "key");
    expect(new Headers(prepared.init.headers).get("x-api-key")).toBe("key");
    expect(String(prepared.init.body)).not.toContain("key");
  });

  it("classifies transport and provider failures without retrying client mistakes", () => {
    const adapter = new OpenAICompatibleAdapter();
    expect(adapter.supports("openai-chat")).toBe(true);
    expect(adapter.supports("anthropic-messages")).toBe(false);
    expect(adapter.classifyError(new DOMException("stopped", "AbortError"))).toBe("timeout");
    expect(adapter.classifyError(new TypeError("fetch failed"))).toBe("network");
    expect(adapter.classifyError(new Error("odd"))).toBe("unknown");
    for (const [status, classification] of [
      [429, "rate_limit"],
      [401, "auth"],
      [404, "model_not_found"],
      [529, "overloaded"],
      [503, "upstream_5xx"],
      [400, "client"],
      [200, "unknown"],
    ] as const) {
      expect(adapter.classifyError(undefined, new Response(null, { status }))).toBe(classification);
    }
    expect(adapter.stream(new Response(null))).toBeNull();
  });
});

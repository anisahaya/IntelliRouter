import type { ModelDefinition, NormalizedRequest } from "@model-router/contracts";
import { modelDefinitionSchema } from "@model-router/contracts";
import { AnthropicAdapter, OpenAICompatibleAdapter } from "@model-router/providers";
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
});

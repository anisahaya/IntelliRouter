import { describe, expect, it } from "vitest";
import { normalizeRequest } from "../src/routes/normalize.js";

describe("protocol normalization", () => {
  it("counts the full context while bounding only the feature summary", () => {
    const text = "x".repeat(40_000);
    const result = normalizeRequest("openai-chat", {
      messages: [{ role: "user", content: text }],
      max_completion_tokens: 500,
    });
    expect(result.summary).toHaveLength(8_000);
    expect(result.estimatedInputTokens).toBeGreaterThanOrEqual(10_000);
    expect(result.minimumContextTokens).toBe(result.estimatedInputTokens + 500);
  });

  it.each([
    [
      "openai-chat",
      { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] },
    ],
    [
      "openai-responses",
      { input: [{ role: "user", content: [{ type: "input_image", file_id: "f1" }] }] },
    ],
    [
      "anthropic-messages",
      { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64" } }] }] },
    ],
  ] as const)("detects %s images", (protocol, body) => {
    expect(normalizeRequest(protocol, body).visionRequired).toBe(true);
  });

  it.each([
    ["openai-chat", { messages: [], response_format: { type: "json_schema" } }],
    ["openai-responses", { input: "x", text: { format: { type: "json_schema" } } }],
    ["anthropic-messages", { messages: [], output_config: { format: { type: "json_schema" } } }],
  ] as const)("detects %s structured output", (protocol, body) => {
    expect(normalizeRequest(protocol, body).jsonRequired).toBe(true);
  });

  it("includes instructions and tools and rejects invalid token limits", () => {
    const result = normalizeRequest("openai-responses", {
      instructions: "system rule",
      input: "hello",
      tools: [{ type: "function", name: "lookup", description: "long tool description" }],
      max_output_tokens: 10,
    });
    expect(result.summary).toContain("system rule");
    expect(result.toolsRequired).toBe(true);
    expect(() => normalizeRequest("openai-chat", { messages: [], max_tokens: -1 })).toThrow();
    expect(() => normalizeRequest("openai-chat", { messages: [], max_tokens: "oops" })).toThrow();
  });

  it("does not infer capabilities from foreign protocol fields or nested tool schemas", () => {
    const chat = normalizeRequest("openai-chat", {
      messages: [{ role: "user", content: "hello" }],
      text: { format: { type: "json_schema" } },
      tools: [{ type: "function", function: { parameters: { type: "image" } } }],
    });
    expect(chat.jsonRequired).toBe(false);
    expect(chat.visionRequired).toBe(false);

    const anthropic = normalizeRequest("anthropic-messages", {
      messages: [{ role: "user", content: [{ type: "input_image", file_id: "foreign" }] }],
      response_format: { type: "json_object" },
    });
    expect(anthropic.jsonRequired).toBe(false);
    expect(anthropic.visionRequired).toBe(false);
  });
});

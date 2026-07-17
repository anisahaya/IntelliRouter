import { describe, expect, it } from "vitest";
import { parseJsonc } from "../src/setup.js";

describe("OpenCode setup config parsing", () => {
  it("accepts comments and trailing commas while preserving ordinary values", () => {
    expect(
      parseJsonc(`{
        // existing authentication and provider settings remain untouched
        "$schema": "https://opencode.ai/config.json",
        "provider": { "openai": { "options": { "label": "http://not-a-comment,}" } } },
      }`),
    ).toEqual({
      $schema: "https://opencode.ai/config.json",
      provider: { openai: { options: { label: "http://not-a-comment,}" } } },
    });
  });

  it("rejects malformed configuration instead of overwriting it", () => {
    expect(() => parseJsonc("{ invalid }")).toThrow();
  });
});

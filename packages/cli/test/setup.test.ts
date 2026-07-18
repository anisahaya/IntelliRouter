import { describe, expect, it } from "vitest";
import { claudeMcpAddArgs, parseJsonc } from "../src/setup.js";

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

describe("Claude Code setup", () => {
  it("registers the MCP at user scope without provider credentials", () => {
    expect(claudeMcpAddArgs("/package/dist/mcp-server/index.js", "/usr/bin/node")).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "model-router",
      "--",
      "/usr/bin/node",
      "/package/dist/mcp-server/index.js",
    ]);
  });
});

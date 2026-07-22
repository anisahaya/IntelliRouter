import { parseBoundedJSON, TOKEN_LITERAL } from "@model-router/telemetry";
import { describe, expect, it } from "vitest";

describe("parseBoundedJSON", () => {
  it("parses valid JSON within size and depth limits", () => {
    expect(parseBoundedJSON('{"a":1}', 1024)).toEqual({ a: 1 });
    expect(parseBoundedJSON("[1,2,3]", 1024)).toEqual([1, 2, 3]);
  });

  it("rejects inputs longer than maxLen", () => {
    const big = "x".repeat(2048);
    expect(() => parseBoundedJSON(`"${big}"`, 1024)).toThrow(/too_long/);
  });

  it("rejects deeply nested arrays beyond maxDepth", () => {
    let depth = 0;
    let s = "1";
    while (depth < 64) {
      s = `[${s}]`;
      depth++;
    }
    expect(() => parseBoundedJSON(s, 1 << 20)).toThrow(/too_deep/);
  });

  it("rejects deeply nested objects beyond maxDepth", () => {
    let depth = 0;
    let s = '"v"';
    while (depth < 64) {
      s = `{"k":${s}}`;
      depth++;
    }
    expect(() => parseBoundedJSON(s, 1 << 20)).toThrow(/too_deep/);
  });

  it("accepts nesting up to the default depth limit", () => {
    let depth = 0;
    let s = "1";
    while (depth < 16) {
      s = `[${s}]`;
      depth++;
    }
    expect(parseBoundedJSON(s, 1 << 20)).toEqual([[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseBoundedJSON("{not json", 1024)).toThrow();
  });
});

describe("TOKEN_LITERAL", () => {
  it("matches common token shapes", () => {
    expect(TOKEN_LITERAL.test("Bearer sk-abc1234567")).toBe(true);
    expect(TOKEN_LITERAL.test("key-abc12345678")).toBe(true);
    expect(TOKEN_LITERAL.test("ghp_abc1234567890defgh")).toBe(true);
    expect(TOKEN_LITERAL.test("xoxb-12345678901234")).toBe(true);
  });

  it("does not match ordinary prose", () => {
    expect(TOKEN_LITERAL.test("a normal sentence with words")).toBe(false);
    expect(TOKEN_LITERAL.test("the quick brown fox jumped")).toBe(false);
  });
});

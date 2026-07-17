import { describe, expect, it } from "vitest";
import { assertRootInvocation, boundedOutput, sanitizeText } from "../src/context-security.js";

describe("routed context security", () => {
  it("redacts common credentials before routing", () => {
    const value = sanitizeText(
      "Authorization: Bearer abcdefghijklmnop API_TOKEN=super-secret-value sk-abcdefghijklmnop",
      1_000,
      "prompt",
    );
    expect(value.redacted).toBe(true);
    expect(value.text).not.toContain("super-secret-value");
    expect(value.text).not.toContain("sk-abcdefghijklmnop");
  });

  it("bounds output and rejects nested routing", () => {
    expect(boundedOutput("x".repeat(20), 5)).toMatchObject({ text: "xxxxx", truncated: true });
    expect(() => assertRootInvocation({ MODEL_ROUTER_CHILD_DEPTH: "1" })).toThrow(
      "disabled inside a routed child",
    );
  });

  it("rejects NUL bytes", () => {
    expect(() => sanitizeText("bad\0value", 20, "prompt")).toThrow("NUL");
  });
});

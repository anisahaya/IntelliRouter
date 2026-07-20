import { routerConfigSchema } from "@model-router/contracts";
import { describe, expect, it } from "vitest";

const base = {
  models: [
    {
      id: "a",
      provider: "openai-compatible",
      upstreamModel: "a",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKeyEnv: "TEST_KEY",
      capabilities: { protocols: ["openai-chat"], maxContextTokens: 1000 },
    },
  ],
  routing: {
    defaultProfile: "balanced",
    profiles: { balanced: { weights: { quality: 0.4, cost: 0.4, latency: 0.2 } } },
  },
};

describe("router config", () => {
  it("applies safe localhost and privacy defaults", () => {
    const config = routerConfigSchema.parse(base);
    expect(config.server.host).toBe("127.0.0.1");
    expect(config.privacy.storePrompts).toBe(false);
    expect(config.nativeRouting).toEqual({
      defaultProfile: "balanced",
      repositoryProfiles: {},
      profiles: {},
    });
  });

  it("accepts additive native policies and rejects undefined profile selection", () => {
    const config = routerConfigSchema.parse({
      ...base,
      nativeRouting: {
        defaultProfile: "repo-safe",
        repositoryProfiles: { "my-repo": "quality" },
        profiles: {
          "repo-safe": {
            extends: "balanced",
            policy: {
              harnesses: { allow: ["codex", "opencode"] },
              candidates: { deny: ["retired"], prefer: { fast: 0.1 } },
              effort: { cap: "high" },
              aliases: { fast: "provider/fast" },
            },
          },
        },
      },
    });
    expect(config.nativeRouting?.profiles["repo-safe"]?.policy.effort.cap).toBe("high");
    expect(() =>
      routerConfigSchema.parse({
        ...base,
        nativeRouting: { defaultProfile: "missing", profiles: {} },
      }),
    ).toThrow(/native default profile is not defined/);
  });

  it("rejects duplicate model IDs", () => {
    expect(() =>
      routerConfigSchema.parse({ ...base, models: [...base.models, ...base.models] }),
    ).toThrow(/duplicate model id/);
  });

  it("rejects invalid weights and unauthenticated public binding", () => {
    expect(() =>
      routerConfigSchema.parse({
        ...base,
        server: { host: "0.0.0.0" },
        routing: {
          defaultProfile: "balanced",
          profiles: { balanced: { weights: { quality: 1, cost: 1, latency: 1 } } },
        },
      }),
    ).toThrow();
  });
});

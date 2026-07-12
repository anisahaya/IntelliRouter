import type { NormalizedRequest, RouterConfig } from "@model-router/contracts";
import { routerConfigSchema } from "@model-router/contracts";
import { AffinityCache, canFallback, RoutingEngine } from "@model-router/router-core";
import { describe, expect, it } from "vitest";

const config: RouterConfig = routerConfigSchema.parse({
  models: [
    {
      id: "cheap",
      provider: "openai-compatible",
      upstreamModel: "cheap",
      baseUrl: "http://localhost:1/v1",
      apiKeyEnv: "KEY",
      quality: 0.6,
      cost: { inputPerMillion: 0.1, outputPerMillion: 0.2 },
      capabilities: { protocols: ["openai-chat"], tools: false, maxContextTokens: 100_000 },
    },
    {
      id: "strong",
      provider: "openai-compatible",
      upstreamModel: "strong",
      baseUrl: "http://localhost:1/v1",
      apiKeyEnv: "KEY",
      quality: 0.9,
      tags: ["reasoning"],
      cost: { inputPerMillion: 4, outputPerMillion: 12 },
      capabilities: { protocols: ["openai-chat"], tools: true, maxContextTokens: 200_000 },
    },
  ],
  routing: {
    defaultProfile: "economy",
    affinityTtlSeconds: 10,
    profiles: {
      economy: { weights: { quality: 0.2, cost: 0.7, latency: 0.1 } },
      premium: { weights: { quality: 0.9, cost: 0.05, latency: 0.05 } },
    },
  },
});

const request: NormalizedRequest = {
  protocol: "openai-chat",
  stream: false,
  summary: "quick formatting task",
  toolsRequired: false,
  jsonRequired: false,
  visionRequired: false,
  estimatedInputTokens: 10,
  minimumContextTokens: 100,
  passThroughBody: {},
  metadata: { messageCount: 1 },
};

describe("routing", () => {
  it("filters hard capabilities before scoring", () => {
    const decision = new RoutingEngine(config).select({ ...request, toolsRequired: true });
    expect(decision.logicalModel).toBe("strong");
    expect(
      decision.candidates.find((item) => item.modelId === "cheap")?.exclusionReasons,
    ).toContain("tool use is unsupported");
  });

  it("is deterministic and honors profiles", () => {
    const engine = new RoutingEngine(config);
    expect(engine.select(request).logicalModel).toBe("cheap");
    expect(engine.select(request, { profile: "premium" }).logicalModel).toBe("strong");
  });

  it("keeps explicit sessions affine while eligible", () => {
    const engine = new RoutingEngine(config);
    const first = engine.select(request, { sessionId: "opaque" });
    const second = engine.select(request, { sessionId: "opaque", profile: "premium" });
    expect(second.logicalModel).toBe(first.logicalModel);
    expect(second.affinityUsed).toBe(true);
  });

  it("expires affinity and forbids fallback after bytes", () => {
    const cache = new AffinityCache();
    cache.set("s", "cheap", 1, 1000);
    expect(cache.get("s", 1500)).toBe("cheap");
    expect(cache.get("s", 2100)).toBeUndefined();
    expect(canFallback("rate_limit", ["rate_limit"], false)).toBe(true);
    expect(canFallback("rate_limit", ["rate_limit"], true)).toBe(false);
  });
});

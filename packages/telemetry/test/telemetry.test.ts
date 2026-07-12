import type { RouteDecision } from "@model-router/contracts";
import { redactValue, TelemetryStore } from "@model-router/telemetry";
import { describe, expect, it } from "vitest";

const decision: RouteDecision = {
  id: "r1",
  requestId: "req1",
  logicalModel: "cheap",
  upstreamModel: "upstream",
  profile: "balanced",
  features: {
    taskType: "code",
    hasCode: true,
    agentic: true,
    reasoningIntensity: "medium",
    estimatedInputTokens: 12,
  },
  candidates: [
    {
      modelId: "cheap",
      eligible: true,
      exclusionReasons: [],
      scores: { quality: 1, cost: 1, latency: 1, feedback: 0, total: 1 },
    },
  ],
  fallbackChain: [],
  affinityUsed: false,
  createdAt: new Date().toISOString(),
};

describe("telemetry", () => {
  it("redacts nested secrets and URL query secrets case-insensitively", () => {
    const result = redactValue({
      Authorization: "Bearer secret",
      nested: { apiKey: "secret" },
      url: "https://x.test?a=1&token=secret",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).toContain("%5BREDACTED%5D");
  });

  it("stores explanations, metrics and feedback without raw content", () => {
    const store = new TelemetryStore(":memory:");
    store.saveDecision(decision);
    store.recordMetric({ routeId: "r1", status: 200, latencyMs: 25, estimatedCostUsd: 0.01 });
    store.recordFeedback({ routeId: "r1", outcome: "success", tags: [] });
    expect(store.getDecision("r1")?.logicalModel).toBe("cheap");
    expect(store.getStats().successfulRequests).toBe(1);
    expect(store.metricsFor("cheap", "code").feedbackPrior).toBeGreaterThan(0);
    const schema = store.database.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all();
    expect(JSON.stringify(schema)).not.toMatch(/prompt|response_text|raw_content/i);
    store.close();
  });
});

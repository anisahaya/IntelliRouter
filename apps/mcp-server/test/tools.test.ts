import { describe, expect, it } from "vitest";
import type { ProxyClient } from "../src/client.js";
import { createToolHandlers } from "../src/tools.js";

class FakeClient {
  calls: string[] = [];
  async routeTask() {
    this.calls.push("route");
    return {
      id: "r1",
      logicalModel: "cheap",
      profile: "balanced",
      candidates: [{ modelId: "cheap", eligible: true, scores: { total: 0.75 } }],
    };
  }
  async explainRoute() {
    this.calls.push("explain");
    return { id: "r1" };
  }
  async stats() {
    this.calls.push("stats");
    return { totalRequests: 1 };
  }
  async feedback() {
    this.calls.push("feedback");
    return { accepted: true };
  }
  async models() {
    this.calls.push("models");
    return { models: [] };
  }
  async delegate() {
    this.calls.push("delegate");
    return { text: "done", model: "cheap" };
  }
}

describe("MCP tool handlers", () => {
  it("calls the proxy client for every tool instead of routing locally", async () => {
    const fake = new FakeClient();
    const handlers = createToolHandlers(fake as unknown as ProxyClient);
    expect(
      (
        await handlers.routeTask({
          task: "fix test",
          profile: "balanced",
          protocol: "openai-chat",
          toolsRequired: false,
          jsonRequired: false,
          visionRequired: false,
        })
      ).selectedModel,
    ).toBe("cheap");
    await handlers.explainRoute("r1");
    await handlers.stats({});
    await handlers.feedback({ routeId: "r1", outcome: "success", tags: [] });
    await handlers.models();
    await handlers.delegate({ prompt: "bounded", maxOutputTokens: 10 });
    expect(fake.calls).toEqual(["route", "explain", "stats", "feedback", "models", "delegate"]);
  });
});

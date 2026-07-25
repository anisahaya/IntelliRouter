import type { RoutingEvidence } from "@model-router/router-core";
import { describe, expect, it } from "vitest";
import { autoRoute } from "../src/auto-router.js";
import type { CodexCommandRunner } from "../src/codex-cli.js";
import type { RepoCommandRunner } from "../src/repo-signals.js";

const modelCatalog = {
  models: [
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      description: "frontier model for complex coding",
      visibility: "list",
      supported_in_api: true,
      priority: 1,
      supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }],
      input_modalities: ["text", "image"],
      context_window: 200_000,
      supports_search_tool: true,
    },
    {
      slug: "fast-model",
      display_name: "Fast",
      description: "fast efficient model for simple coding",
      visibility: "list",
      supported_in_api: true,
      priority: 20,
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
      input_modalities: ["text"],
      context_window: 100_000,
      supports_search_tool: false,
    },
  ],
};

const discoveryRunner: CodexCommandRunner = {
  async execFile() {
    return { stdout: JSON.stringify(modelCatalog) };
  },
};
const repoRunner: RepoCommandRunner = {
  async execFile(_file, args) {
    return { stdout: args[0] === "status" ? " M file.ts\n" : "2\t1\tfile.ts\n" };
  },
};

describe("auto route orchestration", () => {
  it("combines live models and registered agents while reserving the current model", async () => {
    const decision = await autoRoute(
      {
        objective: "Review a small TypeScript change for correctness",
        conversationSummary: "The change is isolated and has tests.",
        workspaceRoot: process.cwd(),
        registeredAgents: [
          {
            id: "security-agent",
            displayName: "Security Agent",
            description: "Reviews TypeScript changes",
            strengths: ["review", "typescript", "tests"],
            available: true,
            capabilities: {
              tools: true,
              vision: false,
              search: true,
              edit: true,
              maxContextTokens: 200_000,
            },
            quality: 1,
            speed: 0.7,
            economy: 0.8,
          },
        ],
        profile: "quality",
        currentModel: "5.6 Sol Medium",
        requirements: {
          tools: true,
          vision: false,
          search: true,
          edit: false,
          minimumContextTokens: 0,
        },
      },
      {
        discovery: { runner: discoveryRunner },
        repo: { runner: repoRunner },
        evidenceReader: {
          queryRoutingEvidence(query) {
            return query?.model === "security-agent"
              ? verifiedEvidence("security-agent", 8, 0.25)
              : [];
          },
        },
      },
    );
    expect(decision.selected).toMatchObject({
      id: "security-agent",
      execution: "native-agent",
    });
    expect(decision.excluded.find((item) => item.id === "gpt-5.6-sol")?.reasons[0]).toContain(
      "fallback",
    );
    expect(decision.repoSignals).toMatchObject({
      dirty: true,
      diffInsertions: 2,
      diffDeletions: 1,
    });
    expect(decision).toMatchObject({
      selectionRule: "min-expected-cost-subject-to-quality-floor-v1",
      coldStart: false,
    });
    expect(decision.ranked[0]?.scores).toMatchObject({
      qualityHeuristic: 1,
      meetsQualityThreshold: true,
      expectedCost: 0.25,
      expectedCostBasis: "observed",
      expectedCostComparable: true,
      evidence: {
        calibrated: false,
        strength: expect.any(String),
      },
      selectionReason: expect.stringContaining("lowest expected"),
    });
  });

  it("returns a null selection so the host uses its fallback when every candidate is ineligible", async () => {
    const decision = await autoRoute(
      {
        objective: "Inspect the image",
        workspaceRoot: process.cwd(),
        profile: "balanced",
        currentModel: "5.6 Sol Medium",
        requirements: {
          tools: true,
          vision: true,
          search: true,
          edit: false,
          minimumContextTokens: 0,
        },
      },
      { discovery: { runner: discoveryRunner }, repo: { runner: repoRunner } },
    );
    expect(decision.selected).toBeNull();
    expect(decision.fallback).toEqual({ kind: "current-model", model: "gpt-5.6-sol" });
  });

  it("refuses to route when the current model cannot be reserved as fallback", async () => {
    await expect(
      autoRoute(
        {
          objective: "Implement a fix",
          workspaceRoot: process.cwd(),
          currentModel: "unknown model",
          requirements: {
            tools: true,
            vision: false,
            search: false,
            edit: true,
            minimumContextTokens: 0,
          },
        },
        { discovery: { runner: discoveryRunner }, repo: { runner: repoRunner } },
      ),
    ).rejects.toThrow("does not match the live Codex catalog");
  });

  it("applies observable cache-switch cost when leaving the current session model", async () => {
    const agent = (id: string) => ({
      id,
      displayName: id,
      description: "TypeScript reviewer",
      strengths: ["review", "typescript"],
      available: true,
      capabilities: {
        tools: true,
        vision: false,
        search: false,
        edit: true,
        maxContextTokens: 100_000,
      },
      quality: 0.8,
      speed: 0.8,
      economy: 0.8,
    });
    const decision = await autoRoute(
      {
        objective: "Review a small TypeScript change",
        workspaceRoot: process.cwd(),
        registeredAgents: [agent("cache-hot"), agent("cache-cold")],
        profile: "balanced",
        currentModel: "5.6 Sol Medium",
        requirements: {
          tools: true,
          vision: false,
          search: false,
          edit: false,
          minimumContextTokens: 0,
        },
      },
      {
        discovery: { runner: discoveryRunner },
        repo: { runner: repoRunner },
        evidenceReader: {
          queryRoutingEvidence(query) {
            if (query?.model === "cache-hot") return tokenEvidence("cache-hot", 8, 0);
            if (query?.model === "cache-cold") return tokenEvidence("cache-cold", 8, 100);
            return [];
          },
        },
      },
    );
    expect(decision.selected?.id).toBe("cache-hot");
    expect(
      decision.ranked.find((item) => item.id === "cache-cold")?.scores.expectedCostComponents
        ?.cacheSwitch,
    ).toBeCloseTo(100);
    expect(decision.ranked.find((item) => item.id === "cache-hot")?.scores.cacheState).toBe(
      "observed",
    );
  });
});

function verifiedEvidence(model: string, count: number, costUsd: number): RoutingEvidence[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${model}-${index}`,
    model,
    taskFingerprint: `${model}-${index}`,
    taskType: "review",
    scope: "single",
    complexity: 0.4,
    risk: 0.1,
    capabilities: ["tools", "search"],
    repoTags: [],
    label: "correct",
    labelStrength: "verified",
    origin: "native",
    verification: "passed",
    process: "completed",
    createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    attempts: [
      {
        attemptOrder: 0,
        model,
        outcome: "completed",
        retry: false,
        fallback: false,
        inputTokens: 100,
        outputTokens: 20,
        tokenBasis: "actual",
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
        costUsd,
        costBasis: "actual",
        pricingProvenance: "observed-receipt",
        partialWriteDetected: false,
        safeToFallback: true,
      },
    ],
  }));
}

function tokenEvidence(model: string, count: number, cacheWriteTokens: number): RoutingEvidence[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${model}-token-${index}`,
    model,
    taskFingerprint: `${model}-token-${index}`,
    taskType: "review",
    scope: "single",
    complexity: 0.4,
    risk: 0.1,
    capabilities: ["tools"],
    repoTags: [],
    label: "correct",
    labelStrength: "verified",
    origin: "native",
    verification: "passed",
    process: "completed",
    createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    attempts: [
      {
        attemptOrder: 0,
        model,
        outcome: "completed",
        retry: false,
        fallback: false,
        inputTokens: 100,
        outputTokens: 20,
        tokenBasis: "actual",
        cacheReadTokens: 0,
        cacheWriteTokens,
        costBasis: "unknown",
        partialWriteDetected: false,
        safeToFallback: true,
      },
    ],
  }));
}

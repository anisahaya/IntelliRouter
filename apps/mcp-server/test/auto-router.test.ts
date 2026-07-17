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
        objective: "Review a complex repository-wide security architecture change",
        conversationSummary: "Authentication and production permissions are involved.",
        workspaceRoot: process.cwd(),
        registeredAgents: [
          {
            id: "security-agent",
            displayName: "Security Agent",
            description: "Reviews risky security architecture",
            strengths: ["review", "security", "architecture", "complex", "repository"],
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
      { discovery: { runner: discoveryRunner }, repo: { runner: repoRunner } },
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
});

import { buildAutoTaskProfile, scoreAutoCandidates } from "@model-router/router-core";
import { describe, expect, it } from "vitest";
import { type CodexCommandRunner, discoverCodexCandidates } from "../src/codex-cli.js";

function runnerWith(
  value: unknown,
  calls: Array<Record<string, unknown>> = [],
): CodexCommandRunner {
  return {
    async execFile(file, args, options) {
      calls.push({ file, args, options });
      return { stdout: typeof value === "string" ? value : JSON.stringify(value) };
    },
  };
}

describe("Codex model discovery", () => {
  it("uses the live CLI catalog and dynamically maps only visible executable models", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const candidates = await discoverCodexCandidates(
      runnerWith(
        {
          models: [
            {
              slug: "future-frontier",
              display_name: "Future Frontier",
              description: "Latest frontier model for complex research and coding",
              visibility: "list",
              supported_in_api: true,
              priority: 1,
              supported_reasoning_levels: [
                { effort: "low" },
                { effort: "high" },
                { effort: "ultra" },
              ],
              input_modalities: ["text", "image"],
              context_window: 123456,
              supports_search_tool: true,
            },
            {
              slug: "hidden-review",
              display_name: "Hidden",
              visibility: "hide",
              supported_in_api: true,
            },
            {
              slug: "not-executable",
              display_name: "Unavailable",
              visibility: "list",
              supported_in_api: false,
            },
          ],
        },
        calls,
      ),
      { CODEX_BIN: "/custom/codex", HOME: "/home/test", PATH: "/bin", API_KEY: "must-not-pass" },
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: "future-frontier",
      kind: "codex-model",
      available: true,
      supportedEfforts: ["low", "high", "ultra"],
      capabilities: { vision: true, search: true, maxContextTokens: 123456 },
    });
    expect(candidates[0]?.strengths).toContain("complex");
    expect(calls[0]).toMatchObject({ file: "/custom/codex", args: ["debug", "models"] });
    const options = calls[0]?.options as {
      shell: boolean;
      timeout: number;
      maxBuffer: number;
      env: Record<string, string>;
    };
    expect(options).toMatchObject({ shell: false, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    expect(options.env.API_KEY).toBeUndefined();
  });

  it("accepts a top-level catalog array and sorts deterministically", async () => {
    const model = (slug: string) => ({
      slug,
      display_name: slug,
      description: "Balanced everyday coding model",
      visibility: "list",
      supported_in_api: true,
      supported_reasoning_levels: [{ effort: "medium" }],
      input_modalities: ["text"],
      context_window: 1000,
    });
    const candidates = await discoverCodexCandidates(runnerWith([model("z"), model("a")]));
    expect(candidates.map((candidate) => candidate.id)).toEqual(["a", "z"]);
  });

  it("rejects malformed JSON, malformed catalogs, and empty visible catalogs", async () => {
    await expect(discoverCodexCandidates(runnerWith("not-json"))).rejects.toThrow(/invalid JSON/);
    await expect(discoverCodexCandidates(runnerWith({ nope: [] }))).rejects.toThrow(
      /invalid catalog/,
    );
    await expect(discoverCodexCandidates(runnerWith({ models: [] }))).rejects.toThrow(/no visible/);
  });

  it("calibrates the current catalog semantics without hardcoding its inventory", async () => {
    const model = (slug: string, description: string, priority: number) => ({
      slug,
      display_name: slug,
      description,
      visibility: "list",
      supported_in_api: true,
      priority,
      supported_reasoning_levels: [{ effort: "medium" }],
      input_modalities: ["text"],
      context_window: 100_000,
      supports_search_tool: true,
    });
    const candidates = await discoverCodexCandidates(
      runnerWith([
        model("sol-like", "Latest frontier agentic coding model.", 1),
        model("terra-like", "Balanced agentic coding model for everyday work.", 2),
        model("luna-like", "Fast and affordable agentic coding model.", 3),
        model("prior-frontier", "Frontier model for complex coding and research.", 7),
        model("prior-strong", "Strong model for everyday coding.", 16),
      ]),
    );
    const quality = Object.fromEntries(
      candidates.map((candidate) => [candidate.id, candidate.quality]),
    );
    expect(quality["sol-like"]).toBeGreaterThan(quality["prior-frontier"] ?? 0);
    expect(quality["prior-frontier"]).toBeGreaterThan(quality["terra-like"] ?? 0);
    expect(quality["terra-like"]).toBeGreaterThan(quality["prior-strong"] ?? 0);
    expect(quality["prior-strong"]).toBeGreaterThan(quality["luna-like"] ?? 0);
  });

  it("preserves intended Sol, Terra, and Luna routing semantics for the current catalog", async () => {
    const model = (slug: string, description: string, priority: number) => ({
      slug,
      display_name: slug,
      description,
      visibility: "list",
      supported_in_api: true,
      priority,
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "max" }],
      input_modalities: ["text"],
      context_window: 200_000,
      supports_search_tool: true,
    });
    const candidates = await discoverCodexCandidates(
      runnerWith([
        model("gpt-5.6-sol", "Latest frontier agentic coding model.", 1),
        model("gpt-5.6-terra", "Balanced agentic coding model for everyday work.", 2),
        model("gpt-5.6-luna", "Fast and affordable agentic coding model.", 3),
        model("gpt-5.5", "Frontier model for complex coding, research, and real-world work.", 7),
      ]),
    );
    const repoSignals = {
      rootName: "repo",
      languages: [{ name: "TypeScript", count: 50 }],
      fileCount: 80,
      testFileCount: 10,
      manifests: ["package.json", "pnpm-workspace.yaml"],
      changedFileCount: 0,
      diffInsertions: 0,
      diffDeletions: 0,
      hasTests: true,
      monorepo: true,
      dirty: false,
      truncated: false,
      changedFiles: [],
      topLevelDirectories: [],
      dependencyNames: [],
      packageCount: 2,
      hasCi: false,
    };
    const winner = (objective: string) => {
      const task = buildAutoTaskProfile({
        objective,
        repoSignals,
        requirements: {
          tools: true,
          vision: false,
          search: false,
          edit: true,
          minimumContextTokens: 0,
        },
      });
      return scoreAutoCandidates(candidates, task, "balanced", "gpt-5.5").ranked[0]?.id;
    };
    expect(winner("Architect a complex repository-wide security migration")).toBe("gpt-5.6-sol");
    expect(winner("Implement an everyday multi-file TypeScript feature and tests")).toBe(
      "gpt-5.6-terra",
    );
    expect(winner("Mechanically rename a small helper and format it")).toBe("gpt-5.6-luna");
  });
});

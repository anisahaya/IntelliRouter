import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClaudeCommandRunner } from "../src/claude-cli.js";
import type { CodexCommandRunner } from "../src/codex-cli.js";
import { executeHarnessTask } from "../src/harness-exec.js";
import { decodeNormalizedCandidateId, routeHarnessTask } from "../src/harness-router.js";
import type { OpenCodeCommandRunner } from "../src/opencode-cli.js";
import type { RepoCommandRunner } from "../src/repo-signals.js";
import { getRouteRecord } from "../src/route-state.js";

const repo: RepoCommandRunner = {
  async execFile(_file, args) {
    return { stdout: args[0] === "status" ? "" : "" };
  },
};

const codexCatalog = JSON.stringify([
  {
    slug: "gpt-test",
    display_name: "GPT Test",
    description: "balanced coding model",
    visibility: "list",
    supported_in_api: true,
    priority: 10,
    supported_reasoning_levels: [{ effort: "high" }],
    input_modalities: ["text"],
    context_window: 200000,
    supports_search_tool: true,
  },
]);

const opencodeCatalog = `openai/gpt-test
${JSON.stringify({
  id: "gpt-test",
  providerID: "openai",
  name: "GPT Test",
  family: "gpt-terra",
  status: "active",
  limit: { context: 200000 },
  capabilities: { toolcall: true, attachment: false, input: { image: false } },
  variants: { high: {} },
})}`;

describe("cross-harness meta-routing", () => {
  it("discovers native catalogs concurrently and returns collision-safe execution coordinates", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-router-meta-route-"));
    let active = 0;
    let maximumActive = 0;
    const delayed = async (stdout: string) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return { stdout };
    };
    const codex: CodexCommandRunner = {
      async execFile() {
        return delayed(codexCatalog);
      },
    };
    const opencode: OpenCodeCommandRunner = {
      async execFile() {
        return delayed(opencodeCatalog);
      },
    };
    const claude: ClaudeCommandRunner = {
      async execFile() {
        return delayed(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));
      },
    };
    const state = { path: join(root, "routes.jsonl") };
    const result = await routeHarnessTask(
      {
        harness: "auto",
        harnesses: ["pi"],
        objective: "Implement a repository feature with tests",
        workspaceRoot: process.cwd(),
        requirements: {
          tools: true,
          vision: false,
          search: false,
          edit: true,
          minimumContextTokens: 0,
        },
      },
      {
        codex: { runner: codex },
        opencode: { runner: opencode },
        claude: { runner: claude, availableModels: ["sonnet"] },
        repo: { runner: repo },
        state,
      },
    );

    expect(maximumActive).toBeGreaterThan(1);
    expect(result.ranked.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining(["codex:gpt-test", "opencode:openai/gpt-test", "claude-code:sonnet"]),
    );
    expect(result.excluded).toContainEqual({
      id: "pi:*",
      reasons: ["pi excluded: no native discovery or execution adapter"],
    });
    expect(result.selected).toMatchObject({
      id: expect.stringMatching(/^(codex|opencode|claude-code):/),
      executionHarness: result.harness,
      executionModel: expect.any(String),
    });
    expect(decodeNormalizedCandidateId(result.selected?.id ?? "")?.model).toBe(
      result.selected?.executionModel,
    );
    expect((await getRouteRecord(result.routeId ?? "", state))?.selectedCandidate).toBe(
      result.selected?.id,
    );
  });

  it("keeps healthy catalogs eligible when another configured harness discovery fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-router-meta-failure-"));
    const result = await routeHarnessTask(
      {
        harness: "auto",
        objective: "Review a repository",
        workspaceRoot: process.cwd(),
        requirements: {
          tools: true,
          vision: false,
          search: false,
          edit: false,
          minimumContextTokens: 0,
        },
      },
      {
        codex: {
          runner: {
            async execFile() {
              throw new Error("not signed in");
            },
          },
        },
        opencode: {
          runner: {
            async execFile() {
              return { stdout: opencodeCatalog };
            },
          },
        },
        claude: {
          runner: {
            async execFile() {
              throw new Error("not installed");
            },
          },
        },
        repo: { runner: repo },
        state: { path: join(root, "routes.jsonl") },
      },
    );
    expect(result.selected?.id).toBe("opencode:openai/gpt-test");
    expect(result.excluded).toEqual(
      expect.arrayContaining([
        { id: "codex:*", reasons: ["discovery failed: not signed in"] },
        { id: "claude-code:*", reasons: ["discovery failed: not installed"] },
      ]),
    );
  });

  it("applies namespaced candidate policy to only the matching harness catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-router-meta-policy-"));
    const result = await routeHarnessTask(
      {
        harness: "auto",
        objective: "Implement a repository feature",
        workspaceRoot: process.cwd(),
        requirements: {
          tools: true,
          vision: false,
          search: false,
          edit: true,
          minimumContextTokens: 0,
        },
      },
      {
        codex: {
          runner: {
            async execFile() {
              return { stdout: codexCatalog };
            },
          },
        },
        opencode: {
          runner: {
            async execFile() {
              return { stdout: opencodeCatalog };
            },
          },
        },
        claude: {
          runner: {
            async execFile() {
              return { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) };
            },
          },
          availableModels: ["sonnet"],
        },
        repo: { runner: repo },
        state: { path: join(root, "routes.jsonl") },
        policyConfig: policyConfig({ allow: ["codex:gpt-test"] }),
      },
    );
    expect(result.selected?.id).toBe("codex:gpt-test");
    expect(result.ranked.map((candidate) => candidate.id)).toEqual(["codex:gpt-test"]);
  });

  it("falls back across harness adapters only after a transient no-write failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-router-meta-fallback-"));
    const state = { path: join(root, "routes.jsonl") };
    const route = await metaRoute(state, repo);
    const calls: Array<{ harness: string; model: string; resumeSessionId?: string }> = [];
    const result = await executeHarnessTask(
      {
        routeId: route.routeId as string,
        harness: route.harness as "opencode",
        model: route.selected?.id as string,
        reasoningEffort: route.selected?.reasoningEffort ?? "high",
        objective: "Perform a read-only review",
        repoSignals: route.repoSignals,
        workspaceRoot: process.cwd(),
        permission: "read-only",
        resumeSessionId: "adapter-local-session",
      },
      {
        state,
        adapter: async (input) => {
          calls.push({
            harness: input.harness,
            model: input.model,
            resumeSessionId: input.resumeSessionId,
          });
          return calls.length === 1
            ? {
                output: "",
                stderr: "429 rate limit exceeded",
                exitCode: 1,
                timedOut: false,
                truncated: false,
                redacted: false,
              }
            : {
                output: "CROSS_HARNESS_PASS",
                stderr: "",
                exitCode: 0,
                timedOut: false,
                truncated: false,
                redacted: false,
              };
        },
      },
    );
    expect(result.outcome).toBe("success");
    expect(result.output).toBe("CROSS_HARNESS_PASS");
    expect(result.attemptChain).toHaveLength(2);
    expect(calls[0]?.harness).not.toBe(calls[1]?.harness);
    expect(calls[0]?.resumeSessionId).toBe("adapter-local-session");
    expect(calls[1]?.resumeSessionId).toBeUndefined();
    expect(result.attemptChain[1]).toMatchObject({
      executionHarness: calls[1]?.harness,
      executionModel: calls[1]?.model,
    });
  });

  it("stops cross-harness fallback when a failed write attempt changes the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-router-meta-partial-"));
    const state = { path: join(root, "routes.jsonl") };
    let dirty = false;
    const changingRepo: RepoCommandRunner = {
      async execFile(_file, args) {
        if (args[0] === "status") return { stdout: dirty ? " M changed.ts\n" : "" };
        return { stdout: dirty ? "1\t0\tchanged.ts\n" : "" };
      },
    };
    const route = await metaRoute(state, changingRepo);
    let calls = 0;
    const result = await executeHarnessTask(
      {
        routeId: route.routeId as string,
        harness: route.harness as "opencode",
        model: route.selected?.id as string,
        reasoningEffort: route.selected?.reasoningEffort ?? "high",
        objective: "Edit one file",
        repoSignals: route.repoSignals,
        workspaceRoot: process.cwd(),
        permission: "workspace-write",
        allowWriteFallback: true,
      },
      {
        state,
        repo: { runner: changingRepo },
        adapter: async () => {
          calls++;
          dirty = true;
          return {
            output: "",
            stderr: "429 after write",
            exitCode: 1,
            timedOut: false,
            truncated: false,
            redacted: false,
          };
        },
      },
    );
    expect(calls).toBe(1);
    expect(result).toMatchObject({
      outcome: "failure",
      partialWriteDetected: true,
      safeToFallback: false,
    });
  });
});

async function metaRoute(state: { path: string }, repoRunner: RepoCommandRunner) {
  return routeHarnessTask(
    {
      harness: "auto",
      objective: "Implement a repository feature with tests",
      workspaceRoot: process.cwd(),
      requirements: {
        tools: true,
        vision: false,
        search: false,
        edit: true,
        minimumContextTokens: 0,
      },
    },
    {
      codex: {
        runner: {
          async execFile() {
            return { stdout: codexCatalog };
          },
        },
      },
      opencode: {
        runner: {
          async execFile() {
            return { stdout: opencodeCatalog };
          },
        },
      },
      claude: {
        runner: {
          async execFile() {
            return { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) };
          },
        },
        availableModels: ["sonnet"],
      },
      repo: { runner: repoRunner },
      state,
      policyConfig: policyConfig({ prefer: { "openai/gpt-test": 0.5 } }),
    },
  );
}

function policyConfig(candidates: { allow?: string[]; prefer?: Record<string, number> }) {
  return {
    defaultProfile: "cross-test",
    repositoryProfiles: {},
    profiles: {
      "cross-test": {
        extends: "balanced" as const,
        policy: {
          harnesses: { allow: [], deny: [] },
          candidates: {
            allow: candidates.allow ?? [],
            deny: [],
            prefer: candidates.prefer ?? {},
            penalize: {},
          },
          effort: { candidates: {} },
          aliases: {},
          overrides: {},
        },
      },
    },
  };
}

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClaudeCommandRunner } from "../src/claude-cli.js";
import { routeHarnessTask } from "../src/harness-router.js";
import type { OpenCodeCommandRunner } from "../src/opencode-cli.js";
import type { RepoCommandRunner } from "../src/repo-signals.js";
import { getRouteRecord } from "../src/route-state.js";

const output = `openai/gpt-5.6-terra
{
  "id": "gpt-5.6-terra",
  "providerID": "openai",
  "name": "GPT-5.6 Terra",
  "family": "gpt-terra",
  "status": "active",
  "limit": { "context": 500000 },
  "capabilities": { "toolcall": true, "attachment": true, "input": { "image": true } },
  "variants": { "low": {}, "medium": {}, "high": {}, "xhigh": {}, "max": {} }
}`;

const discovery: OpenCodeCommandRunner = {
  async execFile() {
    return { stdout: output };
  },
};
const repo: RepoCommandRunner = {
  async execFile(_file, args) {
    return { stdout: args[0] === "status" ? " M src/index.ts\n" : "3\t1\tsrc/index.ts\n" };
  },
};

describe("harness-neutral routing", () => {
  it("routes OpenCode with native catalog auth and reuses task affinity", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-router-harness-route-"));
    const state = { path: join(root, "routes.jsonl"), env: { ...process.env, MODEL_ROUTER_DATA_DIR: root } };
    const input = {
      harness: "opencode" as const,
      objective: "Implement a multi-file TypeScript feature and tests",
      workspaceRoot: process.cwd(),
      sessionId: "session-one",
      profile: "balanced" as const,
      requirements: {
        tools: true,
        vision: false,
        search: false,
        edit: true,
        minimumContextTokens: 0,
      },
    };
    const first = await routeHarnessTask(input, {
      opencode: { runner: discovery },
      repo: { runner: repo },
      state,
    });
    expect(first).toMatchObject({
      harness: "opencode",
      affinityReused: false,
      selected: {
        id: "openai/gpt-5.6-terra",
        execution: "opencode-run",
      },
      fallback: { kind: "current-model", harness: "opencode" },
    });
    expect(first.repoSignals).toMatchObject({
      changedFiles: ["src/index.ts"],
      diffInsertions: 3,
      diffDeletions: 1,
    });
    expect((await getRouteRecord(first.routeId ?? "", state))?.outcome).toBe("planned");

    const second = await routeHarnessTask(input, {
      opencode: { runner: discovery },
      repo: { runner: repo },
      state,
    });
    expect(second.affinityReused).toBe(true);
    expect(second.selected?.id).toBe(first.selected?.id);
    expect(second.routeId).not.toBe(first.routeId);

    const changedRequirements = await routeHarnessTask(
      { ...input, requirements: { ...input.requirements, vision: true } },
      {
        opencode: { runner: discovery },
        repo: { runner: repo },
        state,
      },
    );
    expect(changedRequirements.affinityReused).toBe(false);
  });

  it("routes Claude Code through its signed-in model aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-router-claude-route-"));
    const claude: ClaudeCommandRunner = {
      async execFile() {
        return { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) };
      },
    };
    const result = await routeHarnessTask(
      {
        harness: "claude-code",
        objective: "Review a complex architecture",
        workspaceRoot: process.cwd(),
        profile: "quality",
        requirements: {
          tools: true,
          vision: false,
          search: false,
          edit: false,
          minimumContextTokens: 0,
        },
      },
      {
        claude: { runner: claude, availableModels: ["opus", "sonnet", "haiku"] },
        repo: { runner: repo },
        state: { path: join(root, "routes.jsonl"), env: { ...process.env, MODEL_ROUTER_DATA_DIR: root } },
      },
    );
    expect(result.selected).toMatchObject({
      id: "opus",
      execution: "claude-print",
    });
  });
});

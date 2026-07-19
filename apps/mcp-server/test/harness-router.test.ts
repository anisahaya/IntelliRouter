import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClaudeCommandRunner } from "../src/claude-cli.js";
import { routeHarnessTask } from "../src/harness-router.js";
import type { NativeProbeRunner } from "../src/native-probes.js";
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

const twoModelOutput = `${output}
openai/gpt-5.6-sol
{
  "id": "gpt-5.6-sol",
  "providerID": "openai",
  "name": "GPT-5.6 Sol",
  "family": "gpt-sol",
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
    const state = { path: join(root, "routes.jsonl") };
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
        state: { path: join(root, "routes.jsonl") },
      },
    );
    expect(result.selected).toMatchObject({
      id: "opus",
      execution: "claude-print",
    });
  });

  it("conservatively abstains to the current host when only catalog evidence is available", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-router-abstain-"));
    const result = await routeHarnessTask(
      {
        harness: "opencode",
        objective: "Review a complex repository architecture",
        workspaceRoot: process.cwd(),
        currentModel: "gpt-5.6-terra",
        requirements: {
          tools: true,
          vision: false,
          search: false,
          edit: false,
          minimumContextTokens: 0,
        },
      },
      {
        opencode: {
          runner: {
            async execFile() {
              return { stdout: twoModelOutput };
            },
          },
        },
        repo: { runner: repo },
        state: { path: join(root, "routes.jsonl") },
      },
    );
    expect(result.selected).toBeNull();
    expect(result.fallback.model).toBe("openai/gpt-5.6-terra");
    expect(result.confidence).toMatchObject({ level: "low", abstained: true });
    expect(result.confidence?.reasons.join(" ")).toContain("abstention threshold");
  });

  it("uses and caches opt-in native probe evidence without persisting prompt content", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-router-probe-"));
    const state = { path: join(root, "routes.jsonl") };
    let calls = 0;
    const runner: NativeProbeRunner = {
      async probe() {
        calls++;
      },
    };
    const input = {
      harness: "opencode" as const,
      objective: "Review a complex repository architecture",
      workspaceRoot: process.cwd(),
      currentModel: "gpt-5.6-terra",
      forceReroute: true,
      probe: true,
      requirements: {
        tools: true,
        vision: false,
        search: false,
        edit: false,
        minimumContextTokens: 0,
      },
    };
    const options = {
      opencode: {
        runner: {
          async execFile() {
            return { stdout: twoModelOutput };
          },
        },
      },
      repo: { runner: repo },
      state,
      probes: { runner, ttlMs: 60_000 },
    };
    const first = await routeHarnessTask(input, options);
    const second = await routeHarnessTask(input, options);
    expect(first.selected?.id).toBe("openai/gpt-5.6-sol");
    expect(first.confidence).toMatchObject({ level: "high", abstained: false });
    expect(first.confidence?.evidenceSources).toContain("probe");
    expect(second.selected?.id).toBe(first.selected?.id);
    expect(calls).toBe(1);
    const cache = await readFile(`${state.path}.probes`, "utf8");
    expect(cache).toContain('"outcome":"success"');
    expect(cache).not.toContain("Reply with exactly OK");
    expect(cache).not.toContain(input.objective);
  });

  it("persists only allowlisted probe failures and exposes the failure in exclusions", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-router-probe-auth-"));
    const state = { path: join(root, "routes.jsonl") };
    const result = await routeHarnessTask(
      {
        harness: "opencode",
        objective: "Review a complex repository architecture",
        workspaceRoot: process.cwd(),
        currentModel: "gpt-5.6-terra",
        probe: true,
        requirements: {
          tools: true,
          vision: false,
          search: false,
          edit: false,
          minimumContextTokens: 0,
        },
      },
      {
        opencode: {
          runner: {
            async execFile() {
              return { stdout: twoModelOutput };
            },
          },
        },
        repo: { runner: repo },
        state,
        probes: {
          runner: {
            async probe() {
              throw new Error("authentication required");
            },
          },
        },
      },
    );
    expect(result.selected).toBeNull();
    expect(result.excluded).toContainEqual({
      id: "openai/gpt-5.6-sol",
      reasons: ["unavailable", "native probe: auth"],
    });
    const cache = await readFile(`${state.path}.probes`, "utf8");
    expect(cache).toContain('"outcome":"auth"');
    expect(cache).not.toContain("authentication required");
  });
});

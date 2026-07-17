import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutoRouteDecision, RepoSignals } from "@model-router/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { extractClaudeOutput } from "../src/claude-exec.js";
import { executeHarnessTask } from "../src/harness-exec.js";
import { newRouteId, persistDecision, routeIdentity } from "../src/route-state.js";

let root = "";
let workspace = "";
let executable = "";

const signals: RepoSignals = {
  rootName: "workspace",
  languages: [{ name: "TypeScript", count: 1 }],
  fileCount: 1,
  testFileCount: 0,
  manifests: [],
  changedFileCount: 0,
  diffInsertions: 0,
  diffDeletions: 0,
  hasTests: false,
  monorepo: false,
  dirty: false,
  truncated: false,
  changedFiles: [],
  topLevelDirectories: [],
  dependencyNames: [],
  packageCount: 0,
  hasCi: false,
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "model-router-claude-exec-"));
  workspace = join(root, "workspace");
  executable = join(root, "fake-claude.mjs");
  await mkdir(workspace);
  await writeFile(
    executable,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "auth") process.stdout.write(JSON.stringify({loggedIn:true,authMethod:"claude.ai"}));
else process.stdout.write(JSON.stringify({result:"CLAUDE_NATIVE_PASS",session_id:"claude-child"}));
`,
    "utf8",
  );
  await chmod(executable, 0o755);
});

describe("Claude Code native execution", () => {
  it("extracts JSON output and runs an exact signed-in alias", async () => {
    expect(extractClaudeOutput('{"result":"ok","session_id":"s"}')).toEqual({
      output: "ok",
      sessionId: "s",
    });
    const state = { path: join(root, "routes.jsonl") };
    const routeId = await plannedRoute(state);
    const result = await executeHarnessTask(
      {
        routeId,
        harness: "claude-code",
        model: "sonnet",
        reasoningEffort: "high",
        objective: "Return the native smoke marker",
        repoSignals: signals,
        workspaceRoot: workspace,
        permission: "read-only",
      },
      {
        claude: { executable, trustedRoot: workspace, availableModels: ["sonnet"] },
        state,
        env: { ...process.env, MODEL_ROUTER_WORKSPACE_ROOT: workspace },
      },
    );
    expect(result).toMatchObject({
      outcome: "success",
      output: "CLAUDE_NATIVE_PASS",
      childSessionId: "claude-child",
      safeToFallback: true,
    });
  });

  it("preserves plain output and reports child launch failures", async () => {
    expect(extractClaudeOutput("plain output")).toEqual({ output: "plain output" });
    const state = { path: join(root, "failed-routes.jsonl") };
    const routeId = await plannedRoute(state);
    await expect(
      executeHarnessTask(
        {
          routeId,
          harness: "claude-code",
          model: "sonnet",
          reasoningEffort: "high",
          objective: "Fail before execution",
          repoSignals: signals,
          workspaceRoot: workspace,
          permission: "read-only",
        },
        {
          claude: {
            executable: join(root, "missing-claude"),
            trustedRoot: workspace,
            availableModels: ["sonnet"],
            runner: {
              async execFile() {
                return { stdout: JSON.stringify({ loggedIn: true }) };
              },
            },
          },
          state,
          env: { ...process.env, MODEL_ROUTER_WORKSPACE_ROOT: workspace },
        },
      ),
    ).resolves.toMatchObject({
      outcome: "failure",
      safeToFallback: true,
      stderr: expect.stringContaining("Unable to launch Claude Code child"),
    });
  });
});

async function plannedRoute(state: { path: string }): Promise<string> {
  const routeId = newRouteId();
  const decision = baseDecision(routeId);
  const identity = routeIdentity({
    harness: "claude-code",
    objective: "test",
    workspaceRoot: workspace,
  });
  await persistDecision(decision, identity, state);
  return routeId;
}

function baseDecision(routeId: string): AutoRouteDecision {
  return {
    routeId,
    harness: "claude-code",
    affinityReused: false,
    status: "planned",
    selected: {
      id: "sonnet",
      kind: "harness-model",
      displayName: "Sonnet",
      reasoningEffort: "high",
      execution: "claude-print",
    },
    profile: "balanced",
    taskProfile: {
      taskType: "review",
      complexity: 0.5,
      ambiguity: 0.2,
      risk: 0.2,
      mechanical: 0.2,
      scope: "single",
      toolsRequired: true,
      visionRequired: false,
      searchRequired: false,
      editRequired: false,
      estimatedContextTokens: 100,
      desiredEffort: "high",
      repoTags: [],
    },
    repoSignals: signals,
    ranked: [],
    excluded: [],
    fallback: { kind: "current-model", harness: "claude-code" },
    context: { objectiveTruncated: false, conversationTruncated: false },
  };
}

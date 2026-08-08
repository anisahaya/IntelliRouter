import { access, chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutoRouteDecision, RepoSignals } from "@model-router/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { executeHarnessTask } from "../src/harness-exec.js";
import { extractOpenCodeOutput } from "../src/opencode-exec.js";
import type { RepoCommandRunner } from "../src/repo-signals.js";
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
  root = await mkdtemp(join(tmpdir(), "model-router-opencode-exec-"));
  workspace = join(root, "workspace");
  executable = join(root, "fake-opencode.mjs");
  await mkdir(workspace);
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "models") {
  process.stdout.write('openai/test-model\\n' + JSON.stringify({id:"test-model",providerID:"openai",name:"Test Model",family:"test",status:"active",limit:{context:100000},capabilities:{toolcall:true,attachment:false,input:{image:false}},variants:{low:{},high:{}}}, null, 2));
} else if (args[0] === "run") {
  const prompt = args.at(-1) || "";
  if (prompt.includes("partial-write")) {
    writeFileSync("changed.ts", "partial");
    process.stderr.write("failed after write");
    process.exitCode = 1;
  } else {
    process.stdout.write(JSON.stringify({type:"text",sessionID:"session-child",sessionId:"ignored-session",part:{type:"text",text:"OPENCODE_"}}) + "\\n");
    process.stdout.write(JSON.stringify({type:"text",session_id:"later-session",part:{type:"text",text:"NATIVE_PASS"}}) + "\\n");
  }
}
`,
    "utf8",
  );
  await chmod(executable, 0o755);
});

describe("OpenCode native execution", () => {
  it("extracts text events and executes the exact routed model through the native CLI", async () => {
    expect(extractOpenCodeOutput('{"type":"text","part":{"type":"text","text":"a"}}\nnoise')).toBe(
      "a",
    );
    expect(extractOpenCodeOutput("raw fallback")).toBe("raw fallback");
    const state = {
      path: join(root, "success-routes.jsonl"),
      env: { ...process.env, MODEL_ROUTER_DATA_DIR: root },
    };
    const routeId = await plannedRoute(state);
    const result = await executeHarnessTask(
      {
        routeId,
        harness: "opencode",
        model: "openai/test-model",
        reasoningEffort: "high",
        objective: "Return the native smoke marker",
        repoSignals: signals,
        workspaceRoot: workspace,
        permission: "read-only",
      },
      {
        opencode: { executable, trustedRoot: workspace },
        state,
        env: { ...process.env, MODEL_ROUTER_WORKSPACE_ROOT: workspace },
      },
    );
    expect(result).toMatchObject({
      outcome: "success",
      output: "OPENCODE_NATIVE_PASS",
      childSessionId: "session-child",
      safeToFallback: true,
    });
  });

  it("detects partial writes after an unusable write-capable child result", async () => {
    const state = {
      path: join(root, "failure-routes.jsonl"),
      env: { ...process.env, MODEL_ROUTER_DATA_DIR: root },
    };
    const routeId = await plannedRoute(state);
    const repoRunner: RepoCommandRunner = {
      async execFile(_file, args) {
        let changed = false;
        try {
          await access(join(workspace, "changed.ts"));
          changed = true;
        } catch {
          changed = false;
        }
        if (args[0] === "status") return { stdout: changed ? "?? changed.ts\n" : "" };
        return { stdout: changed ? "1\t0\tchanged.ts\n" : "" };
      },
    };
    const result = await executeHarnessTask(
      {
        routeId,
        harness: "opencode",
        model: "openai/test-model",
        reasoningEffort: "high",
        objective: "partial-write",
        repoSignals: signals,
        workspaceRoot: workspace,
        permission: "workspace-write",
      },
      {
        opencode: { executable, trustedRoot: workspace },
        repo: { runner: repoRunner },
        state,
        env: { ...process.env, MODEL_ROUTER_WORKSPACE_ROOT: workspace },
      },
    );
    expect(result).toMatchObject({
      outcome: "failure",
      partialWriteDetected: true,
      safeToFallback: false,
    });
  });

  it("records adapter launch failures and permits fallback when no files changed", async () => {
    const state = {
      path: join(root, "launch-failure-routes.jsonl"),
      env: { ...process.env, MODEL_ROUTER_DATA_DIR: root },
    };
    const routeId = await plannedRoute(state);
    const result = await executeHarnessTask(
      {
        routeId,
        harness: "opencode",
        model: "openai/test-model",
        reasoningEffort: "high",
        objective: "Do not launch",
        repoSignals: signals,
        workspaceRoot: workspace,
        permission: "read-only",
      },
      {
        opencode: { executable: join(root, "missing-opencode"), trustedRoot: workspace },
        state,
      },
    );
    expect(result).toMatchObject({
      outcome: "failure",
      exitCode: null,
      partialWriteDetected: false,
      safeToFallback: true,
    });
    expect(result.stderr).toContain("ENOENT");
  });
});

async function plannedRoute(state: { path: string }): Promise<string> {
  const routeId = newRouteId();
  const decision: AutoRouteDecision = {
    routeId,
    harness: "opencode",
    affinityReused: false,
    status: "planned",
    selected: {
      id: "openai/test-model",
      kind: "harness-model",
      displayName: "Test Model",
      reasoningEffort: "high",
      execution: "opencode-run",
    },
    profile: "balanced",
    taskProfile: {
      taskType: "implementation",
      complexity: 0.5,
      ambiguity: 0.2,
      risk: 0.2,
      mechanical: 0.2,
      scope: "single",
      toolsRequired: true,
      visionRequired: false,
      searchRequired: false,
      editRequired: true,
      estimatedContextTokens: 100,
      desiredEffort: "high",
      repoTags: [],
    },
    repoSignals: signals,
    ranked: [],
    excluded: [],
    fallback: { kind: "current-model", harness: "opencode" },
    context: { objectiveTruncated: false, conversationTruncated: false },
  };
  const identity = routeIdentity({
    harness: "opencode",
    objective: "test",
    workspaceRoot: workspace,
  });
  await persistDecision(decision, identity, state);
  return routeId;
}

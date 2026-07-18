import { access, chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutoRankedCandidate, AutoRouteDecision, RepoSignals } from "@model-router/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { executeHarnessTask } from "../src/harness-exec.js";
import { extractOpenCodeOutput } from "../src/opencode-exec.js";
import type { RepoCommandRunner } from "../src/repo-signals.js";
import { getRouteRecord, newRouteId, persistDecision, routeIdentity } from "../src/route-state.js";

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
  const model = args[args.indexOf("--model") + 1];
  if (prompt.includes("partial-write")) {
    writeFileSync("changed.ts", "partial");
    process.stderr.write("429 rate limit after write");
    process.exitCode = 1;
  } else if (prompt.includes("fallback-transient") && model === "openai/test-model") {
    process.stderr.write("429 rate limit exceeded");
    process.exitCode = 1;
  } else {
    const text = prompt.includes("resume safely") && args.includes("--session") && args.includes("prior-session") ? "RESUME_PASS" : "OPENCODE_NATIVE_PASS";
    process.stdout.write(JSON.stringify({type:"text",sessionID:"session-child",part:{type:"text",text}}) + "\\n");
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
    const state = { path: join(root, "success-routes.jsonl") };
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
    const state = { path: join(root, "failure-routes.jsonl") };
    const routeId = await plannedRoute(state, [
      ranked("openai/test-model", "harness-model", 1),
      ranked("openai/backup-model", "harness-model", 0.8),
    ]);
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
        allowWriteFallback: true,
      },
      {
        opencode: {
          executable,
          trustedRoot: workspace,
          runner: {
            async execFile() {
              return { stdout: modelCatalog(["test-model", "backup-model"]) };
            },
          },
        },
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
    expect(result.attemptChain).toHaveLength(1);
  });

  it("records adapter launch failures and permits fallback when no files changed", async () => {
    const state = { path: join(root, "launch-failure-routes.jsonl") };
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

  it("falls through ranked native candidates on allowlisted transient failures", async () => {
    const state = { path: join(root, "fallback-routes.jsonl") };
    const routeId = await plannedRoute(state, [
      ranked("openai/test-model", "harness-model", 1),
      ranked("custom-agent", "user-agent", 0.9),
      ranked("openai/backup-model", "harness-model", 0.8),
    ]);
    const result = await executeHarnessTask(
      {
        routeId,
        harness: "opencode",
        model: "openai/test-model",
        reasoningEffort: "high",
        objective: "fallback-transient",
        repoSignals: signals,
        workspaceRoot: workspace,
        permission: "read-only",
      },
      {
        opencode: {
          executable,
          trustedRoot: workspace,
          runner: {
            async execFile() {
              return { stdout: modelCatalog(["test-model", "backup-model"]) };
            },
          },
        },
        state,
        env: { ...process.env, MODEL_ROUTER_WORKSPACE_ROOT: workspace },
      },
    );
    expect(result).toMatchObject({
      outcome: "success",
      model: "openai/backup-model",
      output: "OPENCODE_NATIVE_PASS",
    });
    expect(result.attemptChain).toMatchObject([
      {
        candidateId: "openai/test-model",
        outcome: "failure",
        errorClass: "rate_limit",
        errorDisposition: "transient",
      },
      { candidateId: "openai/backup-model", outcome: "success" },
    ]);
    const persisted = await getRouteRecord(routeId, state);
    expect(persisted?.attempts).toMatchObject([
      { candidateId: "openai/test-model", errorClass: "rate_limit" },
      { candidateId: "openai/backup-model", outcome: "success" },
    ]);
    expect(persisted?.healthWindows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateId: "openai/test-model",
          state: "unhealthy",
          cooldownUntil: expect.any(String),
        }),
      ]),
    );
  });

  it("passes an explicit supported OpenCode resume session", async () => {
    const state = { path: join(root, "resume-routes.jsonl") };
    const routeId = await plannedRoute(state);
    const result = await executeHarnessTask(
      {
        routeId,
        harness: "opencode",
        model: "openai/test-model",
        reasoningEffort: "high",
        objective: "resume safely",
        resumeSessionId: "prior-session",
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
    expect(result.childSessionId).toBe("session-child");
    expect(result.output).toBe("RESUME_PASS");
    expect(result.outcome).toBe("success");
  });
});

async function plannedRoute(
  state: { path: string },
  candidates: AutoRankedCandidate[] = [],
): Promise<string> {
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
    ranked: candidates,
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

function ranked(id: string, kind: AutoRankedCandidate["kind"], total: number): AutoRankedCandidate {
  return {
    id,
    kind,
    displayName: id,
    reasoningEffort: "high",
    scores: {
      taskFit: total,
      quality: total,
      speed: total,
      economy: total,
      specialization: 0,
      total,
    },
  };
}

function modelCatalog(ids: string[]): string {
  return ids
    .map(
      (id) =>
        `openai/${id}\n${JSON.stringify({ id, providerID: "openai", name: id, family: "test", status: "active", limit: { context: 100000 }, capabilities: { toolcall: true, attachment: false, input: { image: false } }, variants: { high: {} } }, null, 2)}`,
    )
    .join("\n");
}

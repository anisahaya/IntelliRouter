import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoSignals } from "@model-router/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeCodexTask } from "../src/codex-exec.js";

let fixtureRoot = "";
let workspace = "";
let fakeCodex = "";

const repoSignals: RepoSignals = {
  rootName: "workspace",
  languages: [{ name: "TypeScript", count: 3 }],
  fileCount: 5,
  testFileCount: 1,
  manifests: ["package.json"],
  changedFileCount: 0,
  diffInsertions: 0,
  diffDeletions: 0,
  hasTests: true,
  monorepo: false,
  dirty: false,
  truncated: false,
  changedFiles: [],
  topLevelDirectories: [],
  dependencyNames: [],
  packageCount: 1,
  hasCi: false,
};

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "model-router-exec-"));
  workspace = join(fixtureRoot, "workspace");
  fakeCodex = join(fixtureRoot, "fake-codex.mjs");
  await mkdir(workspace);
  await writeFile(join(workspace, "image.png"), "not-a-real-image", "utf8");
  const writerCode = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(
    join(workspace, "grandchild.txt"),
  )}, "escaped"), 1500)`;
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "debug" && args[1] === "models") {
  process.stdout.write(JSON.stringify([{slug:"gpt-test",display_name:"Test",description:"balanced coding",visibility:"list",supported_in_api:true,priority:1,supported_reasoning_levels:[{effort:"low"},{effort:"high"}],input_modalities:["text","image"],context_window:100000,supports_search_tool:true}]));
} else if (args.includes("exec")) {
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  if (prompt.includes("spawn-grandchild")) {
    const { spawn } = await import("node:child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(writerCode)}]);
    setInterval(() => {}, 1000);
  }
  process.stdout.write(JSON.stringify({args,depth:process.env.MODEL_ROUTER_CHILD_DEPTH,secret:process.env.TEST_SECRET ?? null,prompt}));
} else process.exitCode = 2;
`,
    "utf8",
  );
  await chmod(fakeCodex, 0o755);
});

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("guarded Codex child execution", () => {
  it("revalidates capabilities and launches a bounded non-recursive child", async () => {
    const result = await executeCodexTask(
      {
        model: "gpt-test",
        reasoningEffort: "high",
        objective: "Review this safely. API_TOKEN=do-not-forward-this",
        conversationSummary: "Prior Bearer abcdefghijklmnop",
        acceptanceChecks: ["Return evidence"],
        searchRequired: true,
        visionRequired: true,
        imagePaths: [join(workspace, "image.png")],
        repoSignals,
        workspaceRoot: workspace,
        permission: "read-only",
        timeoutMs: 5_000,
      },
      {
        executable: fakeCodex,
        env: { ...process.env, TEST_SECRET: "not-allowed" },
        trustedRoot: fixtureRoot,
      },
    );
    expect(result.exitCode).toBe(0);
    const child = JSON.parse(result.output) as {
      args: string[];
      depth: string;
      secret: string | null;
      prompt: string;
    };
    expect(child.args[0]).toBe("--search");
    expect(child.args).toContain("--ignore-user-config");
    expect(child.args).toContain("-i");
    expect(child.args).toContain("read-only");
    expect(child.depth).toBe("1");
    expect(child.secret).toBeNull();
    expect(child.prompt).toContain("Do not invoke model-router");
    expect(child.prompt).not.toContain("do-not-forward-this");
    expect(child.prompt).not.toContain("abcdefghijklmnop");
    expect(result.redacted).toBe(true);
  });

  it("rejects recursion, missing models, and unsupported efforts before execution", async () => {
    const base = {
      model: "gpt-test",
      reasoningEffort: "high" as const,
      objective: "Review",
      repoSignals,
      workspaceRoot: workspace,
      permission: "read-only" as const,
    };
    await expect(
      executeCodexTask(base, {
        executable: fakeCodex,
        env: { ...process.env, MODEL_ROUTER_CHILD_DEPTH: "1" },
        trustedRoot: fixtureRoot,
      }),
    ).rejects.toThrow("disabled inside a routed child");
    await expect(
      executeCodexTask(
        { ...base, model: "missing" },
        { executable: fakeCodex, trustedRoot: fixtureRoot },
      ),
    ).rejects.toThrow("no longer available");
    await expect(
      executeCodexTask(
        { ...base, reasoningEffort: "medium" },
        { executable: fakeCodex, trustedRoot: fixtureRoot },
      ),
    ).rejects.toThrow("no longer supported");
  });

  it("rejects workspace escape and terminates the routed process group on timeout", async () => {
    const base = {
      model: "gpt-test",
      reasoningEffort: "high" as const,
      objective: "spawn-grandchild",
      repoSignals,
      workspaceRoot: workspace,
      permission: "workspace-write" as const,
      timeoutMs: 1_000,
    };
    await expect(
      executeCodexTask(
        { ...base, workspaceRoot: tmpdir() },
        { executable: fakeCodex, trustedRoot: fixtureRoot },
      ),
    ).rejects.toThrow("outside the model router's trusted root");
    const result = await executeCodexTask(base, {
      executable: fakeCodex,
      trustedRoot: fixtureRoot,
    });
    expect(result.timedOut).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    await expect(access(join(workspace, "grandchild.txt"))).rejects.toThrow();
  });
});

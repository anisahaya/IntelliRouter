import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessJobManager } from "../src/harness-jobs.js";
import type { OpenCodeCommandRunner } from "../src/opencode-cli.js";
import { openNativeStore } from "../src/route-state.js";

const discovery: OpenCodeCommandRunner = {
  async execFile() {
    return {
      stdout: `openai/gpt-test
{"id":"gpt-test","providerID":"openai","name":"Test","family":"gpt","status":"active","limit":{"context":200000},"capabilities":{"toolcall":true,"attachment":false,"input":{"image":false}},"variants":{"medium":{}}}`,
    };
  },
};

const request = (idempotencyKey: string) => ({
  harness: "opencode" as const,
  objective: "Implement a durable background job without leaking its prompt",
  conversationSummary: "Private bounded context",
  workspaceRoot: process.cwd(),
  idempotencyKey,
  permission: "read-only" as const,
  requirements: {
    tools: true,
    vision: false,
    search: false,
    edit: false,
    minimumContextTokens: 0,
  },
});

describe("durable native harness jobs", () => {
  it("atomically routes, executes, deduplicates, and persists no raw task content", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-router-jobs-"));
    const databasePath = join(root, "state.db");
    const state = { databasePath, path: join(root, "legacy.jsonl") };
    const manager = new HarnessJobManager({
      router: { opencode: { runner: discovery }, state },
      exec: { state },
      execute: async (input) => ({
        routeId: input.routeId,
        harness: input.harness,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        output: "private adapter output",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        truncated: false,
        redacted: false,
        outcome: "success",
        partialWriteDetected: false,
        safeToFallback: true,
        childSessionId: "private-child-session",
        attemptChain: [
          {
            candidateId: input.model,
            reasoningEffort: input.reasoningEffort,
            attemptOrder: 1,
            outcome: "success",
            latencyMs: 1,
            partialWriteDetected: false,
          },
        ],
      }),
    });

    const started = await manager.routeAndStart(request("one-request"));
    const terminal = await waitForTerminal(manager, started.job.jobId);
    expect(terminal.job.status).toBe("succeeded");
    expect(terminal.result?.output).toBe("private adapter output");
    expect(terminal.job.childSessionHash).toMatch(/^sha256:/);
    expect(JSON.stringify(terminal.job)).not.toContain("private-child-session");

    await expect(
      manager.resume(started.job.jobId, {
        objective: request("x").objective,
        conversationSummary: "Private bounded context",
        workspaceRoot: process.cwd(),
        permission: "read-only",
        resumeSessionId: "wrong-child-session",
      }),
    ).rejects.toThrow("child-session hash");
    await manager.resume(started.job.jobId, {
      objective: request("x").objective,
      conversationSummary: "Private bounded context",
      workspaceRoot: process.cwd(),
      permission: "read-only",
      resumeSessionId: "private-child-session",
    });
    expect((await waitForTerminal(manager, started.job.jobId)).job.status).toBe("succeeded");

    const replay = await manager.routeAndStart(request("one-request"));
    expect(replay.job.jobId).toBe(started.job.jobId);
    expect(replay.job.routeId).toBe(started.job.routeId);
    await expect(
      manager.routeAndStart({ ...request("one-request"), objective: "Different task" }),
    ).rejects.toThrow("different execution request");

    const store = await openNativeStore(state);
    try {
      const persisted = JSON.stringify(store.getNativeRouteJob(started.job.jobId));
      const raw = store.database
        .prepare("SELECT progress_json FROM native_route_jobs WHERE job_id = ?")
        .pluck()
        .get(started.job.jobId) as string;
      expect(`${persisted}\n${raw}`).not.toContain(request("x").objective);
      expect(`${persisted}\n${raw}`).not.toContain("Private bounded context");
      expect(`${persisted}\n${raw}`).not.toContain(process.cwd());
      expect(`${persisted}\n${raw}`).not.toContain("private adapter output");
      expect(`${persisted}\n${raw}`).not.toContain("private-child-session");
      expect(store.getAllNativeRoutes()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("recovers interrupted jobs as terminal orphaned records", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-router-job-recovery-"));
    const databasePath = join(root, "state.db");
    const state = { databasePath, path: join(root, "legacy.jsonl") };
    const first = new HarnessJobManager({
      router: { opencode: { runner: discovery }, state },
      exec: { state },
      execute: async () => await new Promise(() => {}),
    });
    const started = await first.routeAndStart(request("interrupted"));
    await waitForStatus(first, started.job.jobId, "running");

    const restarted = new HarnessJobManager({
      router: { state },
      exec: { state },
    });
    expect(await restarted.recover()).toBe(1);
    const recovered = await restarted.get(started.job.jobId);
    expect(recovered.job).toMatchObject({
      status: "orphaned",
      errorCode: "process-restarted",
      progress: { stage: "terminal", resultAvailable: false },
    });
  });

  it("records cooperative cancellation without persisting adapter output", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-router-job-cancel-"));
    const databasePath = join(root, "state.db");
    const state = { databasePath, path: join(root, "legacy.jsonl") };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new HarnessJobManager({
      router: { opencode: { runner: discovery }, state },
      exec: { state },
      execute: async (input) => {
        await gate;
        return {
          routeId: input.routeId,
          harness: input.harness,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          output: "discarded after cancellation",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          truncated: false,
          redacted: false,
          outcome: "success",
          partialWriteDetected: false,
          safeToFallback: true,
          attemptChain: [],
        };
      },
    });
    const started = await manager.routeAndStart(request("cancel-me"));
    await waitForStatus(manager, started.job.jobId, "running");
    expect((await manager.cancel(started.job.jobId)).progress.stage).toBe("cancel-requested");
    release();
    const canceled = await waitForTerminal(manager, started.job.jobId);
    expect(canceled.job.status).toBe("canceled");
    expect(canceled.job.errorCode).toBe("canceled");
  });
});

async function waitForTerminal(manager: HarnessJobManager, jobId: string) {
  for (let index = 0; index < 100; index++) {
    const current = await manager.get(jobId);
    if (!["queued", "starting", "running"].includes(current.job.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("job did not reach a terminal state");
}

async function waitForStatus(manager: HarnessJobManager, jobId: string, status: string) {
  for (let index = 0; index < 100; index++) {
    const current = await manager.get(jobId);
    if (current.job.status === status) return current;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`job did not reach ${status}`);
}

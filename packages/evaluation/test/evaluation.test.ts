import { migrate, TaskRunStore } from "@model-router/telemetry";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  evaluateHistoricalCommit,
  type HistoricalSandbox,
  importSeedDataset,
  recordHistoricalEvaluation,
} from "../src/index.js";

describe("public seed import boundary", () => {
  it("caps imported evidence at attested and keeps raw inputs out of SQLite", async () => {
    const database = new Database(":memory:");
    migrate(database);
    const store = new TaskRunStore(database, "installation-salt");
    const result = await importSeedDataset(
      {
        manifest: {
          provenance: "routellm-example",
          revision: "revision-1",
          license: "Apache-2.0",
          modelPair: { source: "weak", target: "strong" },
          labelSemantics: "preferred only within this source model pair",
        },
        records: (async function* () {
          yield {
            externalId: "public-row-1",
            input: "private-looking source task",
            label: "correct" as const,
            strength: "comparative" as const,
          };
        })(),
      },
      store,
    );

    expect(result.imported).toBe(1);
    const imported = database.prepare("SELECT strength FROM dataset_import_records").get() as {
      strength: string;
    };
    expect(imported.strength).toBe("attested");
    expect(
      store.receipt(
        `import:${store.hmac(
          'routellm-example\0revision-1\0{"source":"weak","target":"strong"}\0public-row-1',
          "dataset-external-id",
        )}`,
      ),
    ).toMatchObject({
      origin: "imported",
      labelStrength: "attested",
    });
    const serialized = database
      .prepare("SELECT GROUP_CONCAT(COALESCE(sql,'')) AS value FROM sqlite_master")
      .get() as { value: string };
    expect(serialized.value).not.toContain("private-looking source task");
    expect(JSON.stringify(database.prepare("SELECT * FROM task_runs").all())).not.toContain(
      "private-looking source task",
    );
    database.close();
  });

  it("isolates external IDs by manifest and imports idempotently", async () => {
    const database = new Database(":memory:");
    migrate(database);
    const store = new TaskRunStore(database, "installation-salt");
    const source = (provenance: string) => ({
      manifest: {
        provenance,
        revision: "1",
        license: "MIT",
        modelPair: { source: "a", target: "b" },
        labelSemantics: "source preference",
      },
      records: (async function* () {
        yield {
          externalId: "same-id",
          input: "same task",
          label: "incorrect" as const,
          strength: "verified" as const,
        };
      })(),
    });
    await importSeedDataset(source("source-a"), store);
    await importSeedDataset(source("source-b"), store);
    await importSeedDataset(source("source-a"), store);

    expect(database.prepare("SELECT COUNT(*) FROM dataset_imports").pluck().get()).toBe(2);
    expect(database.prepare("SELECT COUNT(*) FROM dataset_import_records").pluck().get()).toBe(2);
    database.close();
  });

  it("bounds seed text by UTF-8 bytes before buffering or persistence", async () => {
    const database = new Database(":memory:");
    migrate(database);
    const store = new TaskRunStore(database, "installation-salt");
    await expect(
      importSeedDataset(
        {
          manifest: {
            provenance: "bounded-source",
            revision: "1",
            license: "MIT",
            modelPair: { source: "a", target: "b" },
            labelSemantics: "preference",
          },
          records: (async function* () {
            yield {
              externalId: "oversized-utf8",
              input: "😀".repeat(9_000),
              label: "correct" as const,
              strength: "attested" as const,
            };
          })(),
        },
        store,
      ),
    ).rejects.toThrow("32,000 UTF-8 bytes");
    expect(database.prepare("SELECT COUNT(*) FROM dataset_imports").pluck().get()).toBe(0);
    database.close();
  });
});

describe("historical commit evaluation boundary", () => {
  it("records only safe evaluation metadata and keeps completion separate from verification", () => {
    const database = new Database(":memory:");
    migrate(database);
    const store = new TaskRunStore(database, "installation-salt");
    const receipt = recordHistoricalEvaluation(store, {
      routeId: "123e4567-e89b-42d3-a456-426614174000",
      taskFingerprint: store.fingerprint("safe-derived-task", "task"),
      workspaceFingerprint: store.fingerprint("safe-workspace", "workspace"),
      selectedModel: "explicit/model",
      harness: "codex",
      checkName: "held-out-suite",
      result: {
        label: "incorrect",
        comparative: false,
        reason: "held-out checks failed",
        processCompleted: true,
        verification: "failed",
      },
    });

    expect(receipt).toMatchObject({
      origin: "evaluation",
      process: "completed",
      verification: "failed",
      labelValue: "incorrect",
      labelStrength: "verified",
      selectedModel: "explicit/model",
      harness: "codex",
    });
    expect(JSON.stringify(database.prepare("SELECT * FROM task_runs").all())).not.toContain(
      "held-out checks failed",
    );
    expect(() =>
      recordHistoricalEvaluation(store, {
        routeId: "raw objective",
        taskFingerprint: "fix the payment bug",
        checkName: "held-out-suite",
        evidenceHash: "raw held-out output",
        result: {
          label: "unknown",
          comparative: false,
          reason: "invalid",
          processCompleted: false,
          verification: "not-run",
        },
      }),
    ).toThrow("opaque versioned hashes");
    expect(database.prepare("SELECT COUNT(*) FROM task_runs").pluck().get()).toBe(1);
    database.close();
  });

  it("installs hidden tests only after candidate execution and observes candidate edits", async () => {
    const baseSha = "a".repeat(40);
    const targetSha = "b".repeat(40);
    const states = new Map<
      string,
      { solved: boolean; hiddenInstalled: boolean; cleaned: boolean }
    >();
    let baseCount = 0;
    const materialize = async (ref: string): Promise<HistoricalSandbox> => {
      const cwd = ref === targetSha ? "target" : baseCount++ === 0 ? "baseline" : "candidate";
      states.set(cwd, {
        solved: ref === targetSha,
        hiddenInstalled: false,
        cleaned: false,
      });
      return {
        cwd,
        changedPaths: async () =>
          cwd === "candidate" ? [{ path: "src/fix.ts", kind: "file" }] : [],
        installHeldOut: async () => {
          const state = states.get(cwd);
          if (state) state.hiddenInstalled = true;
        },
        cleanup: async () => {
          const state = states.get(cwd);
          if (state) state.cleaned = true;
        },
      };
    };

    const result = await evaluateHistoricalCommit({
      baseSha,
      targetSha,
      clean: true,
      allowedPaths: ["src"],
      objective: "fix the regression",
      heldOut: [["test-runner", "--held-out"]],
      sandboxFactory: { materialize },
      candidateExecutor: {
        execute: async (input) => {
          expect(input).not.toHaveProperty("targetSha");
          expect(input).not.toHaveProperty("heldOut");
          expect(states.get(input.cwd)?.hiddenInstalled).toBe(false);
          const state = states.get(input.cwd);
          if (state) state.solved = true;
          return { output: "candidate completed" };
        },
      },
      commandRunner: {
        run: async (_argv, { cwd }) => ({
          code: states.get(cwd)?.hiddenInstalled && states.get(cwd)?.solved ? 0 : 1,
          output: "",
        }),
      },
    });

    expect(result).toMatchObject({
      label: "correct",
      processCompleted: true,
      verification: "passed",
    });
    expect([...states.values()].every((state) => state.cleaned)).toBe(true);
  });

  it("rejects invalid baseline, target, path, and shell boundaries without running a candidate", async () => {
    let candidateCalls = 0;
    const sandbox = (cwd: string): HistoricalSandbox => ({
      cwd,
      changedPaths: async () => [{ path: "src/fix.ts", kind: "file" }],
      installHeldOut: async () => {},
      cleanup: async () => {},
    });
    const common = {
      baseSha: "a".repeat(40),
      targetSha: "b".repeat(40),
      clean: true,
      allowedPaths: ["src"],
      objective: "fix",
      heldOut: [["test-runner"]],
      candidateExecutor: {
        execute: async () => {
          candidateCalls++;
          return {};
        },
      },
      commandRunner: {
        run: async (_argv: string[], { cwd }: { cwd: string }) => ({
          code: cwd === "target" || candidateCalls > 0 ? 0 : 1,
          output: "",
        }),
      },
      sandboxFactory: {
        materialize: async (ref: string) => sandbox(ref === "b".repeat(40) ? "target" : "base"),
      },
    };

    expect(
      await evaluateHistoricalCommit({ ...common, allowedPaths: ["../secret"] }),
    ).toMatchObject({ label: "unknown", verification: "not-run" });
    for (const path of ["C:\\secret", "C:/secret", "\\\\server\\share", "/tmp/secret"]) {
      expect(await evaluateHistoricalCommit({ ...common, allowedPaths: [path] })).toMatchObject({
        label: "unknown",
        verification: "not-run",
      });
    }
    expect(
      await evaluateHistoricalCommit({ ...common, heldOut: [["bash", "-c", "test"]] }),
    ).toMatchObject({ label: "unknown", verification: "not-run" });
    expect(candidateCalls).toBe(0);

    const valid = await evaluateHistoricalCommit(common);
    expect(valid.label).toBe("correct");
    expect(candidateCalls).toBe(1);
  });

  it("rejects out-of-scope and symlink changes before installing hidden tests", async () => {
    const baseSha = "a".repeat(40);
    const targetSha = "b".repeat(40);
    let baseCount = 0;
    let hiddenInstalledOnCandidate = false;
    const result = await evaluateHistoricalCommit({
      baseSha,
      targetSha,
      clean: true,
      allowedPaths: ["src"],
      objective: "fix",
      heldOut: [["test-runner"]],
      candidateExecutor: {
        execute: async () => ({ output: "completed" }),
      },
      commandRunner: {
        run: async (_argv, { cwd }) => ({
          code: cwd === "baseline" ? 1 : 0,
          output: "",
        }),
      },
      sandboxFactory: {
        materialize: async (ref) => {
          const cwd = ref === targetSha ? "target" : baseCount++ === 0 ? "baseline" : "candidate";
          return {
            cwd,
            changedPaths: async () =>
              cwd === "candidate"
                ? [
                    { path: "src/fix.ts", kind: "file" as const },
                    { path: "test/config.ts", kind: "file" as const },
                    { path: "src/link", kind: "symlink" as const },
                  ]
                : [],
            installHeldOut: async () => {
              if (cwd === "candidate") hiddenInstalledOnCandidate = true;
            },
            cleanup: async () => {},
          };
        },
      },
    });

    expect(result).toMatchObject({
      label: "unknown",
      processCompleted: true,
      verification: "inconclusive",
    });
    expect(hiddenInstalledOnCandidate).toBe(false);
  });
});

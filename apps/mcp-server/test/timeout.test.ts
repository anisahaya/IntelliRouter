import { describe, expect, it } from "vitest";
import { resolveTaskTimeout } from "../src/timeout.js";

const repoSignals = { fileCount: 100 } as never;

describe("adaptive delegation timeouts", () => {
  it("uses the extended timeout for repository-scale read-only reviews", () => {
    expect(
      resolveTaskTimeout({
        objective: "Review the entire repository for regressions",
        repoSignals,
      }),
    ).toBe(300_000);
  });

  it("keeps small mechanical work at the default", () => {
    expect(
      resolveTaskTimeout({
        objective: "Make a small mechanical formatting change across the repository",
        repoSignals,
      }),
    ).toBe(120_000);
  });

  it("preserves explicit timeouts and caps them at six minutes", () => {
    expect(resolveTaskTimeout({ timeoutMs: 45_000, objective: "review repo" })).toBe(45_000);
    expect(resolveTaskTimeout({ timeoutMs: 900_000, objective: "review repo" })).toBe(600_000);
  });

  it("uses persisted route features through the shared harness path", () => {
    expect(
      resolveTaskTimeout({
        objective: "Investigate the codebase",
        repoSignals,
        featureSummary: { taskType: "debug", scope: "repo", complexity: 0.8, risk: 0.2 },
      }),
    ).toBe(300_000);
  });

  it("keeps repository-scale write work at the default", () => {
    expect(
      resolveTaskTimeout({
        objective: "Debug the entire repository",
        repoSignals,
        permission: "workspace-write",
      }),
    ).toBe(120_000);
  });
});

export interface CandidateExecutor {
  execute(input: {
    baseSha: string;
    objective: string;
    allowedPaths: string[];
  }): Promise<{ patch?: string; output?: string }>;
}
export interface CommandRunner {
  run(
    argv: string[],
    options: { cwd: string; timeoutMs: number; networkDisabled: true },
  ): Promise<{ code: number; output: string }>;
}
export interface SandboxFactory {
  create(): Promise<{ cwd: string; cleanup(): Promise<void> }>;
}
export interface HistoricalEvaluationInput {
  baseSha: string;
  targetSha: string;
  clean: boolean;
  allowedPaths: string[];
  objective: string;
  heldOut: string[][];
  candidateExecutor: CandidateExecutor;
  commandRunner: CommandRunner;
  sandboxFactory: SandboxFactory;
  timeoutMs?: number;
}
export async function evaluateHistoricalCommit(
  input: HistoricalEvaluationInput,
): Promise<{ label: "correct" | "incorrect" | "unknown"; comparative: boolean; reason: string }> {
  if (
    !/^[0-9a-f]{40}$/i.test(input.baseSha) ||
    !/^[0-9a-f]{40}$/i.test(input.targetSha) ||
    !input.clean ||
    input.allowedPaths.length === 0 ||
    input.heldOut.length === 0
  )
    return { label: "unknown", comparative: false, reason: "invalid evaluation boundary" };
  const sandbox = await input.sandboxFactory.create();
  try {
    const candidate = await input.candidateExecutor.execute({
      baseSha: input.baseSha,
      objective: input.objective,
      allowedPaths: input.allowedPaths,
    });
    if (candidate.output?.includes(input.targetSha))
      return { label: "unknown", comparative: false, reason: "candidate exposed target" };
    const results = [];
    for (const argv of input.heldOut) {
      if (
        !Array.isArray(argv) ||
        argv.some((a) => a.includes("&&") || a.includes(";") || a.includes("targetSha"))
      )
        return { label: "unknown", comparative: false, reason: "invalid command boundary" };
      results.push(
        await input.commandRunner.run(argv, {
          cwd: sandbox.cwd,
          timeoutMs: input.timeoutMs ?? 120000,
          networkDisabled: true,
        }),
      );
    }
    const pass = results.every((r) => r.code === 0);
    return {
      label: pass ? "correct" : "incorrect",
      comparative: false,
      reason: pass ? "held-out checks passed" : "held-out checks failed",
    };
  } finally {
    await sandbox.cleanup();
  }
}

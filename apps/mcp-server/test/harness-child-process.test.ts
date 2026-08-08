import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runHarnessChild } from "../src/harness-child-process.js";

describe("harness child process", () => {
  it("captures UTF-8 streams, transports stdin, redacts bounded output, and propagates sessions", async () => {
    const fake = childResult("raw output", "Bearer abcdefghijklmnop");
    const result = await runHarnessChild({
      child: fake.child,
      stdin: "prompt through stdin",
      timeoutMs: 5_000,
      timedOutCloseDelayMs: 0,
      inputRedacted: false,
      launchErrorPrefix: "Unable to launch test child",
      parseOutput: (stdout) => ({ output: `${stdout} parsed`, sessionId: "child-session" }),
      createResult: (input) => input,
    });

    expect(fake.stdin()).toBe("prompt through stdin");
    expect(result).toEqual({
      output: "raw output parsed",
      stderr: "Bearer [REDACTED]",
      sessionId: "child-session",
      exitCode: 0,
      timedOut: false,
      truncated: false,
      redacted: true,
    });
  });

  it("retains the current raw capture cap without marking discarded bytes truncated", async () => {
    const fake = childResult("a".repeat(64_001));
    const result = await runHarnessChild({
      child: fake.child,
      timeoutMs: 5_000,
      timedOutCloseDelayMs: 0,
      inputRedacted: false,
      launchErrorPrefix: "Unable to launch test child",
      parseOutput: (stdout) => ({ output: stdout }),
      createResult: (input) => input,
    });

    expect(result.output).toHaveLength(64_000);
    expect(result.truncated).toBe(false);
  });
});

function childResult(stdout: string, stderr = "") {
  let input = "";
  const stdin = new PassThrough();
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => {
    input += chunk;
  });
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout: stdoutStream,
    stderr: stderrStream,
    kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;
  stdin.on("end", () => {
    stdoutStream.end(stdout);
    stderrStream.end(stderr);
    process.nextTick(() => child.emit("close", 0));
  });
  return { child, stdin: () => input };
}

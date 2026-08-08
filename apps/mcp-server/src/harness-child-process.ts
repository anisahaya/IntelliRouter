import { type ChildProcessWithoutNullStreams, execFileSync } from "node:child_process";
import { boundedOutput } from "./context-security.js";

const MAX_CAPTURE_CHARS = 64_000;

export interface HarnessChildOutput {
  output: string;
  sessionId?: string;
}

export interface HarnessChildResultInput {
  output: string;
  stderr: string;
  sessionId?: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  redacted: boolean;
}

export interface RunHarnessChildOptions<TResult> {
  child: ChildProcessWithoutNullStreams;
  stdin?: string;
  timeoutMs: number;
  timedOutCloseDelayMs: number;
  inputRedacted: boolean;
  launchErrorPrefix: string;
  parseOutput: (stdout: string) => HarnessChildOutput;
  createResult: (input: HarnessChildResultInput) => TResult;
}

export function runHarnessChild<TResult>(
  options: RunHarnessChildOptions<TResult>,
): Promise<TResult> {
  const {
    child,
    stdin,
    timeoutMs,
    timedOutCloseDelayMs,
    inputRedacted,
    launchErrorPrefix,
    parseOutput,
    createResult,
  } = options;
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        terminateChild(child, "SIGTERM");
        setTimeout(() => terminateChild(child, "SIGKILL"), 2_000).unref();
      },
      Math.max(1_000, timeoutMs),
    );
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_CAPTURE_CHARS)
        stdout += chunk.slice(0, MAX_CAPTURE_CHARS - stdout.length);
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_CAPTURE_CHARS)
        stderr += chunk.slice(0, MAX_CAPTURE_CHARS - stderr.length);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${launchErrorPrefix}: ${error.message}`));
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const complete = () => {
        const parsed = parseOutput(stdout);
        const safeOut = boundedOutput(parsed.output, MAX_CAPTURE_CHARS);
        const safeErr = boundedOutput(stderr, 8_000);
        resolve(
          createResult({
            output: safeOut.text,
            stderr: safeErr.text,
            sessionId: parsed.sessionId,
            exitCode,
            timedOut,
            truncated: safeOut.truncated || safeErr.truncated,
            redacted: inputRedacted || safeOut.redacted || safeErr.redacted,
          }),
        );
      };
      if (timedOut && timedOutCloseDelayMs > 0) setTimeout(complete, timedOutCloseDelayMs);
      else complete();
    });
    if (stdin === undefined) child.stdin.end();
    else child.stdin.end(stdin);
  });
}

function terminateChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } catch {
      /* exited */
    }
    return;
  }
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between timeout and signal delivery.
    }
  }
  child.kill(signal);
}

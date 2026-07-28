import { spawn } from "cross-spawn";

interface CaptureOptions extends NonNullable<Parameters<typeof spawn>[2]> {
  maxBuffer?: number;
}

export function spawnCommand(
  file: string,
  args: string[],
  options: Parameters<typeof spawn>[2] = {},
): ReturnType<typeof spawn> {
  return spawn(file, args, { ...options, shell: false });
}
export function captureCommand(
  file: string,
  args: string[],
  options: CaptureOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const { maxBuffer = 1024 * 1024, ...spawnOptions } = options;
    const child = spawnCommand(file, args, {
      ...spawnOptions,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (target: "stdout" | "stderr", chunk: unknown) => {
      if (settled) return;
      const next = String(chunk);
      const size = Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(next);
      if (size > maxBuffer) {
        settled = true;
        child.kill();
        reject(new Error(`command output exceeded ${maxBuffer} bytes`));
        return;
      }
      if (target === "stdout") stdout += next;
      else stderr += next;
    };
    child.stdout?.on("data", (chunk) => {
      append("stdout", chunk);
    });
    child.stderr?.on("data", (chunk) => {
      append("stderr", chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `command exited ${code}`));
    });
  });
}

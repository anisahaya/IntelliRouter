import { spawn } from "cross-spawn";

export function commandCandidates(name: string, platform = process.platform): string[] {
  return platform === "win32" ? [name, `${name}.cmd`, `${name}.exe`] : [name];
}

export function taskkillArgs(pid: number): string[] {
  return ["/pid", String(pid), "/t", "/f"];
}

export function spawnCommand(
  name: string,
  args: string[],
  options: Parameters<typeof spawn>[2] = {},
) {
  return spawn(name, args, { ...options, shell: false });
}

export function runCommand(
  name: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(name, args, { stdio: ["ignore", "pipe", "pipe"], env: options.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const maxBuffer = options.maxBuffer ?? 1024 * 1024;
    const append = (target: "stdout" | "stderr", chunk: unknown) => {
      if (settled) return;
      const next = String(chunk);
      const size = Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(next);
      if (size > maxBuffer) {
        settled = true;
        child.kill();
        clearTimeout(timer);
        reject(new Error(`command output exceeded ${maxBuffer} bytes`));
        return;
      }
      if (target === "stdout") stdout += next;
      else stderr += next;
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("command timed out"));
    }, options.timeout ?? 10_000);
    child.stdout?.on("data", (chunk) => {
      append("stdout", chunk);
    });
    child.stderr?.on("data", (chunk) => {
      append("stderr", chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      code === 0 ? resolve(stdout) : reject(new Error(stderr || `command exited ${code}`));
    });
  });
}

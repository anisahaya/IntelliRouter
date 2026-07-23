import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensureSkill, type InstalledAssets } from "./setup-shared.js";

const execFileAsync = promisify(execFile);

export async function setupCodex(
  assets: InstalledAssets,
  force = false,
): Promise<Record<string, unknown>> {
  const existing = await codexMcpEntry();
  const skill = await ensureSkill(
    join(assets.skillDirectory, "intelligent-model-router"),
    join(homedir(), ".codex", "skills", "intelligent-model-router"),
    force,
    "Use the Codex plugin updater to replace it.",
  );
  if (existing && !force) {
    return {
      harness: "codex",
      configured: true,
      changed: false,
      message: "model-router already exists; pass --force to replace its command.",
      existing,
      skill,
    };
  }
  if (existing && force) await execFileAsync("codex", ["mcp", "remove", "model-router"]);
  await execFileAsync("codex", ["mcp", "add", "model-router", "--", process.execPath, assets.mcp]);
  return { harness: "codex", configured: true, changed: true, auth: "host-native", skill };
}

export async function setupClaude(
  assets: InstalledAssets,
  force = false,
): Promise<Record<string, unknown>> {
  const skill = await ensureSkill(
    join(assets.skillDirectory, "intelligent-model-router"),
    join(homedir(), ".claude", "skills", "intelligent-model-router"),
    force,
    "pass --force to replace it.",
  );
  const existing = await claudeMcpEntry();
  if (existing && !force) {
    return {
      harness: "claude-code",
      configured: true,
      changed: false,
      existing,
      skill,
      auth: "existing Claude Code sign-in",
    };
  }
  if (existing && force) {
    await execFileAsync("claude", ["mcp", "remove", "--scope", "user", "model-router"]);
  }
  await execFileAsync("claude", claudeMcpAddArgs(assets.mcp));
  return {
    harness: "claude-code",
    configured: true,
    changed: true,
    auth: "existing Claude Code sign-in",
    skill,
  };
}

export function claudeMcpAddArgs(mcpPath: string, nodePath = process.execPath): string[] {
  return ["mcp", "add", "--scope", "user", "model-router", "--", nodePath, mcpPath];
}

async function codexMcpEntry(): Promise<unknown | undefined> {
  try {
    const result = await execFileAsync("codex", ["mcp", "get", "model-router", "--json"], {
      timeout: 10_000,
    });
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

async function claudeMcpEntry(): Promise<string | undefined> {
  try {
    return (await execFileAsync("claude", ["mcp", "get", "model-router"], { timeout: 10_000 }))
      .stdout;
  } catch {
    return undefined;
  }
}

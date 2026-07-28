import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./command.js";
import { ensureSkill, type InstalledAssets } from "./setup-shared.js";

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
  if (existing && force) await runCommand("codex", ["mcp", "remove", "model-router"]);
  await runCommand("codex", ["mcp", "add", "model-router", "--", process.execPath, assets.mcp]);
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
    await runCommand("claude", ["mcp", "remove", "--scope", "user", "model-router"]);
  }
  await runCommand("claude", claudeMcpAddArgs(assets.mcp));
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
    const result = await runCommand("codex", ["mcp", "get", "model-router", "--json"], {
      timeout: 10_000,
    });
    return JSON.parse(result);
  } catch {
    return undefined;
  }
}

async function claudeMcpEntry(): Promise<string | undefined> {
  try {
    return await runCommand("claude", ["mcp", "get", "model-router"], { timeout: 10_000 });
  } catch {
    return undefined;
  }
}

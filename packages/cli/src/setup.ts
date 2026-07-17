import { execFile } from "node:child_process";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { HarnessId } from "@model-router/contracts";

const execFileAsync = promisify(execFile);

export async function setupHarness(
  harness: HarnessId | "all",
  options: { force?: boolean; configPath?: string } = {},
): Promise<Record<string, unknown>> {
  const assets = await installedAssets();
  const selected = harness === "all" ? (["codex", "opencode", "claude-code"] as const) : [harness];
  const results = [];
  for (const value of selected) {
    if (value === "codex") results.push(await setupCodex(assets, options.force));
    else if (value === "opencode") {
      results.push(await setupOpenCode(assets, options.configPath));
    } else if (value === "claude-code") results.push(await setupClaude(assets, options.force));
    else {
      results.push({
        harness: value,
        configured: false,
        nativeAdapter: false,
        message: "Use the compatibility gateway example for this harness.",
      });
    }
  }
  return { assets, results, restartRequired: true };
}

async function setupCodex(
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

async function ensureSkill(
  source: string,
  target: string,
  force: boolean,
  preservedMessage: string,
): Promise<Record<string, unknown>> {
  await mkdir(dirname(target), { recursive: true });
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) {
      const current = await readlink(target);
      if (current === source) return { configured: true, changed: false, path: target };
      if (force) {
        await unlink(target);
        await symlink(source, target, "junction");
        return { configured: true, changed: true, path: target };
      }
    }
    return {
      configured: true,
      changed: false,
      path: target,
      message: `An existing skill was preserved; ${preservedMessage}`,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await symlink(source, target, "junction");
  return { configured: true, changed: true, path: target };
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

async function setupOpenCode(
  assets: InstalledAssets,
  configOverride?: string,
): Promise<Record<string, unknown>> {
  const configPath = configOverride ?? (await openCodeConfigPath());
  await mkdir(dirname(configPath), { recursive: true });
  let source = '{"$schema":"https://opencode.ai/config.json"}\n';
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const config = parseJsonc(source) as Record<string, unknown>;
  const mcp = objectField(config, "mcp");
  mcp["model-router"] = {
    type: "local",
    command: [process.execPath, assets.mcp],
    enabled: true,
  };
  const skills = objectField(config, "skills");
  const paths = Array.isArray(skills.paths)
    ? skills.paths.filter((value): value is string => typeof value === "string")
    : [];
  skills.paths = [...new Set([...paths, assets.skillDirectory])];
  if (source.trim() && source !== '{"$schema":"https://opencode.ai/config.json"}\n') {
    await copyFile(configPath, `${configPath}.model-router.bak`);
  }
  const tempPath = `${configPath}.model-router.tmp`;
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, configPath);
  await execFileAsync("opencode", ["debug", "config"], {
    timeout: 15_000,
    env: { ...process.env, OPENCODE_CONFIG: configPath },
  });
  return {
    harness: "opencode",
    configured: true,
    changed: true,
    configPath,
    auth: "existing OpenCode provider credentials/OAuth",
  };
}

async function setupClaude(
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

async function claudeMcpEntry(): Promise<string | undefined> {
  try {
    return (await execFileAsync("claude", ["mcp", "get", "model-router"], { timeout: 10_000 }))
      .stdout;
  } catch {
    return undefined;
  }
}

export function claudeMcpAddArgs(mcpPath: string, nodePath = process.execPath): string[] {
  return ["mcp", "add", "--scope", "user", "model-router", "--", nodePath, mcpPath];
}

interface InstalledAssets {
  mcp: string;
  skillDirectory: string;
}

async function installedAssets(): Promise<InstalledAssets> {
  for (const relativeRoot of ["../../", "../../../"]) {
    const packageRoot = fileURLToPath(new URL(relativeRoot, import.meta.url));
    const mcp = join(packageRoot, "dist", "mcp-server", "index.js");
    const skillDirectory = join(packageRoot, "skills");
    try {
      await Promise.all([
        access(mcp),
        access(join(skillDirectory, "intelligent-model-router", "SKILL.md")),
      ]);
      return { mcp, skillDirectory };
    } catch {
      // Try the source-tree layout after the bundled package layout.
    }
  }
  throw new Error("Runnable assets are missing; run pnpm build or install the packaged release");
}

async function openCodeConfigPath(): Promise<string> {
  const base = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode");
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const path = join(base, name);
    try {
      await access(path);
      return path;
    } catch {
      // Try the next supported global filename.
    }
  }
  return join(base, "opencode.json");
}

function objectField(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = target[key];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const value: Record<string, unknown> = {};
  target[key] = value;
  return value;
}

export function parseJsonc(source: string): unknown {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && inString) {
      result += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      result += character;
      continue;
    }
    if (!inString && character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index++;
      result += "\n";
      continue;
    }
    if (!inString && character === "/" && next === "*") {
      index += 2;
      while (index < source.length - 1 && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") result += "\n";
        index++;
      }
      index++;
      continue;
    }
    result += character;
  }
  return JSON.parse(stripTrailingCommas(result));
}

function stripTrailingCommas(source: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index] ?? "";
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && inString) {
      result += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      result += character;
      continue;
    }
    if (!inString && character === ",") {
      let next = index + 1;
      while (/\s/.test(source[next] ?? "")) next++;
      if (source[next] === "}" || source[next] === "]") continue;
    }
    result += character;
  }
  return result;
}

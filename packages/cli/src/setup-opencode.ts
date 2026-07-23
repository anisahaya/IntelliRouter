import { execFile } from "node:child_process";
import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { InstalledAssets } from "./setup-shared.js";

const execFileAsync = promisify(execFile);

export async function setupOpenCode(
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

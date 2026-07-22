import { spawn } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SAFE_TMP = realpathSync(tmpdir());
const HOME = process.env.HOME && process.env.HOME.length > 0 ? process.env.HOME : homedir();
const CODEX_HOME =
  process.env.CODEX_HOME && process.env.CODEX_HOME.length > 0
    ? process.env.CODEX_HOME
    : join(HOME, ".codex");

function safeAncestor(candidate) {
  if (!candidate || candidate.length === 0) return SAFE_TMP;
  try {
    const resolved = realpathSync(resolve(SAFE_TMP, candidate));
    if (
      resolved === SAFE_TMP ||
      resolved.startsWith(`${SAFE_TMP}${process.platform === "win32" ? "\\" : "/"}`)
    )
      return resolved;
  } catch {
    return SAFE_TMP;
  }
  return SAFE_TMP;
}

const cacheRoot = safeAncestor(process.env.TMPDIR);
const UV_CACHE_DIR = join(cacheRoot, "model-router-uv-cache");
mkdirSync(UV_CACHE_DIR, { recursive: true });

const KIND = process.argv[2];
const ARGS = new Map([
  [
    "skill",
    [
      "--with",
      "pyyaml",
      "python",
      `${CODEX_HOME}/skills/.system/skill-creator/scripts/quick_validate.py`,
      "skills/intelligent-model-router",
    ],
  ],
  [
    "plugin",
    [
      "--with",
      "pyyaml",
      "python",
      `${CODEX_HOME}/skills/.system/plugin-creator/scripts/validate_plugin.py`,
      ".",
    ],
  ],
]);
const args = ARGS.get(KIND);
if (!args) {
  console.error(`validate: unknown kind "${KIND}". Usage: node scripts/validate.mjs skill|plugin`);
  process.exit(2);
}

const child = spawn("uv", ["run", ...args], {
  stdio: "inherit",
  env: { ...process.env, UV_CACHE_DIR },
  shell: process.platform === "win32",
});
child.once("error", (error) => {
  console.error(`validate: failed to spawn uv: ${error.message}`);
  process.exit(1);
});
child.once("exit", (code) => process.exit(code ?? 1));

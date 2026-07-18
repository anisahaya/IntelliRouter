import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { HarnessId } from "@model-router/contracts";
import { discoverClaudeModels } from "../../../apps/mcp-server/src/claude-cli.js";
import { discoverCodexModels } from "../../../apps/mcp-server/src/codex-cli.js";
import { discoverOpenCodeModels } from "../../../apps/mcp-server/src/opencode-cli.js";

const execFileAsync = promisify(execFile);

export async function nativeDoctor(harness: HarnessId | "all"): Promise<Record<string, unknown>> {
  const selected = harness === "all" ? (["codex", "opencode", "claude-code"] as const) : [harness];
  const checks = await Promise.all(selected.map((value) => checkHarness(value)));
  return {
    ready: checks.every((check) => check.ready),
    package: await packageCheck(),
    harnesses: checks,
  };
}

async function checkHarness(harness: HarnessId): Promise<Record<string, unknown>> {
  if (harness === "pi") {
    return {
      harness,
      ready: false,
      nativeAdapter: false,
      message: "Use the compatibility gateway until the native Pi adapter ships.",
    };
  }
  try {
    const executable =
      harness === "codex" ? "codex" : harness === "opencode" ? "opencode" : "claude";
    const version = (
      await execFileAsync(executable, ["--version"], { timeout: 10_000 })
    ).stdout.trim();
    const models = await discoverModels(harness);
    return {
      harness,
      ready: models.length > 0,
      nativeAdapter: true,
      executable,
      version,
      visibleModels: models.length,
      sampleModels: models.slice(0, 8).map((model) => ({
        id: model.id,
        efforts: model.supportedEfforts,
      })),
      auth: "host-native",
    };
  } catch (error) {
    return {
      harness,
      ready: false,
      nativeAdapter: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function discoverModels(harness: HarnessId) {
  if (harness === "codex") return discoverCodexModels();
  if (harness === "opencode") return discoverOpenCodeModels();
  return discoverClaudeModels();
}

async function packageCheck(): Promise<Record<string, unknown>> {
  for (const relativeRoot of ["../../", "../../../"]) {
    const root = fileURLToPath(new URL(relativeRoot, import.meta.url));
    const mcp = join(root, "dist", "mcp-server", "index.js");
    const skill = join(root, "skills", "intelligent-model-router", "SKILL.md");
    try {
      await Promise.all([access(mcp), access(skill)]);
      return { ready: true, mcp, skill };
    } catch {
      // Try the next supported layout.
    }
  }
  return {
    ready: false,
    message: "Build the package first (pnpm build) or install the published package.",
  };
}

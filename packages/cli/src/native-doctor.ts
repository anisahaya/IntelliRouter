import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessId } from "@model-router/contracts";
import { discoverClaudeModels } from "../../../apps/mcp-server/src/claude-cli.js";
import { discoverCodexModels } from "../../../apps/mcp-server/src/codex-cli.js";
import { discoverOpenCodeModels } from "../../../apps/mcp-server/src/opencode-cli.js";
import { commandCandidates, runCommand } from "./command.js";

export async function nativeDoctor(
  harness: HarnessId | "all",
  strict = false,
): Promise<Record<string, unknown>> {
  const selected = harness === "all" ? (["codex", "opencode", "claude-code"] as const) : [harness];
  const packageResult = await packageCheck();
  const checks = await Promise.all(selected.map((value) => checkHarness(value)));
  const usable = checks.filter((check) => check.ready).length;
  const ready = evaluateDoctorReadiness(
    harness,
    checks as Array<{ ready: boolean }>,
    Boolean(packageResult.ready),
    strict,
  );
  return {
    ready,
    strict,
    package: packageResult,
    summary:
      harness === "all"
        ? `core ${packageResult.ready ? "ready" : "not ready"}; ${usable}/${checks.length} harnesses usable`
        : checks[0]?.ready
          ? "selected harness usable"
          : "selected harness unavailable",
    harnesses: checks,
  };
}

export function evaluateDoctorReadiness(
  harness: HarnessId | "all",
  checks: Array<{ ready: boolean }>,
  packageReady: boolean,
  strict = false,
): boolean {
  if (!packageReady) return false;
  if (strict) return checks.length > 0 && checks.every((check) => check.ready);
  return harness === "all" ? checks.some((check) => check.ready) : checks[0]?.ready === true;
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
    const executableName =
      harness === "codex" ? "codex" : harness === "opencode" ? "opencode" : "claude";
    const candidates = commandCandidates(executableName);
    let executable = candidates[0];
    let stdout = "";
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        stdout = await runCommand(candidate, ["--version"]);
        executable = candidate;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!stdout) throw lastError instanceof Error ? lastError : new Error("executable not found");
    const version = stdout.trim();
    const models = await discoverModels(harness, executable);
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

function discoverModels(harness: HarnessId, executable?: string) {
  if (harness === "codex") return discoverCodexModels({ executable });
  if (harness === "opencode") return discoverOpenCodeModels({ executable });
  return discoverClaudeModels({ executable });
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

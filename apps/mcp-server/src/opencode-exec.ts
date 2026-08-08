import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ReasoningEffort, RepoSignals } from "@model-router/contracts";
import { parseBoundedJSON } from "@model-router/telemetry";
import { spawnCommand } from "./command.js";
import {
  assertRootInvocation,
  buildDelegatedPrompt,
  sanitizeAcceptanceChecks,
  sanitizeText,
} from "./context-security.js";
import { runHarnessChild } from "./harness-child-process.js";
import { discoverOpenCodeModels, type OpenCodeDiscoveryOptions } from "./opencode-cli.js";
import { resolveTaskTimeout } from "./timeout.js";
import {
  resolveTrustedFile,
  resolveTrustedWorkspace,
  revalidateTrustedWorkspace,
} from "./workspace-security.js";

const workspaceLocks = new Set<string>();

export interface OpenCodeTaskInput {
  model: string;
  reasoningEffort: ReasoningEffort;
  objective: string;
  conversationSummary?: string;
  acceptanceChecks?: string[];
  searchRequired?: boolean;
  visionRequired?: boolean;
  imagePaths?: string[];
  repoSignals: RepoSignals;
  workspaceRoot: string;
  permission: "read-only" | "workspace-write";
  timeoutMs?: number;
}

export interface OpenCodeTaskResult {
  harness: "opencode";
  model: string;
  reasoningEffort: ReasoningEffort;
  output: string;
  stderr: string;
  sessionId?: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  redacted: boolean;
}

export interface OpenCodeExecOptions extends OpenCodeDiscoveryOptions {
  spawnProcess?: typeof spawn;
  env?: NodeJS.ProcessEnv;
  trustedRoot?: string;
}

export async function executeOpenCodeTask(
  input: OpenCodeTaskInput,
  options: OpenCodeExecOptions = {},
): Promise<OpenCodeTaskResult> {
  const sourceEnv = options.env ?? process.env;
  assertRootInvocation(sourceEnv);
  const catalog = await discoverOpenCodeModels(options);
  const selected = catalog.find((candidate) => candidate.id === input.model);
  if (!selected) throw new Error("Selected OpenCode model is no longer available");
  if (!selected.supportedEfforts?.includes(input.reasoningEffort)) {
    throw new Error("Selected reasoning effort is no longer supported by this OpenCode model");
  }
  const workspaceRoot = await resolveTrustedWorkspace(input.workspaceRoot, options.trustedRoot);
  const imagePaths = await Promise.all(
    (input.imagePaths ?? []).map((path) =>
      resolveTrustedFile(path, trustedImageRoots(workspaceRoot, sourceEnv)),
    ),
  );
  if (input.searchRequired && !selected.capabilities.search) {
    throw new Error("Selected OpenCode model does not support web search tools");
  }
  if (input.visionRequired && imagePaths.length === 0) {
    throw new Error("Vision-required delegation must include at least one trusted image path");
  }
  if ((input.visionRequired || imagePaths.length > 0) && !selected.capabilities.vision) {
    throw new Error("Selected OpenCode model does not support image input");
  }
  if (input.permission === "workspace-write" && workspaceLocks.has(workspaceRoot)) {
    throw new Error("A routed write task is already running in this workspace");
  }

  const objective = sanitizeText(input.objective, 12_000, "objective");
  const conversation = sanitizeText(input.conversationSummary ?? "", 8_000, "conversation summary");
  const checks = sanitizeAcceptanceChecks(input.acceptanceChecks ?? []);
  const prompt = buildDelegatedPrompt({
    harness: "OpenCode",
    doNotInvoke:
      "Do not invoke model-router, load its skill, delegate, spawn subagents, or select another model.",
    permission: input.permission,
    objective: objective.text,
    conversationSummary: conversation.text,
    acceptanceChecks: checks.map((check) => check.text),
    repoSignals: input.repoSignals,
  });
  const executable = options.executable ?? sourceEnv.OPENCODE_BIN ?? "opencode";
  const args = [
    "run",
    "--pure",
    "--format",
    "json",
    "--model",
    input.model,
    "--variant",
    input.reasoningEffort,
    "--dir",
    workspaceRoot,
    ...imagePaths.flatMap((path) => ["--file", path]),
    prompt,
  ];
  const childEnv = childEnvironment(sourceEnv, input.permission, Boolean(input.searchRequired));
  const spawnProcess = (options.spawnProcess ?? spawnCommand) as typeof spawn;
  if (input.permission === "workspace-write") workspaceLocks.add(workspaceRoot);
  try {
    await revalidateTrustedWorkspace(workspaceRoot, options.trustedRoot);
    return await runHarnessChild({
      child: spawnProcess(executable, args, {
        cwd: workspaceRoot,
        env: childEnv,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      }),
      timeoutMs: resolveTaskTimeout(input),
      timedOutCloseDelayMs: 0,
      inputRedacted:
        objective.redacted || conversation.redacted || checks.some((check) => check.redacted),
      launchErrorPrefix: "Unable to launch OpenCode child",
      parseOutput: parseOpenCodeOutput,
      createResult: (result) => ({
        harness: "opencode",
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        ...result,
      }),
    });
  } finally {
    if (input.permission === "workspace-write") workspaceLocks.delete(workspaceRoot);
  }
}

function childEnvironment(
  source: NodeJS.ProcessEnv,
  permission: "read-only" | "workspace-write",
  searchRequired: boolean,
): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SHELL",
    "TERM",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
  ];
  const env: NodeJS.ProcessEnv = {
    MODEL_ROUTER_CHILD_DEPTH: "1",
    NO_COLOR: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(permissionConfig(permission, searchRequired)),
  };
  for (const key of allowed) if (source[key]) env[key] = source[key];
  return env;
}

function permissionConfig(
  permission: "read-only" | "workspace-write",
  searchRequired: boolean,
): Record<string, unknown> {
  const safeVerificationCommands = {
    "*": "deny",
    "git status": "allow",
    "git diff": "allow",
    "pnpm test": "allow",
    "pnpm run test": "allow",
    "npm test": "allow",
    "npm run test": "allow",
    "git status *": "deny",
    "git diff *": "deny",
    "pnpm test *": "deny",
    "pnpm run test *": "deny",
    "npm test *": "deny",
    "npm run test *": "deny",
    "* --*": "deny",
    "* * --*": "deny",
  };
  return {
    permission: {
      edit: permission === "workspace-write" ? "allow" : "deny",
      bash: permission === "workspace-write" ? safeVerificationCommands : "deny",
      task: "deny",
      external_directory: "deny",
      webfetch: searchRequired ? "allow" : "deny",
      websearch: searchRequired ? "allow" : "deny",
    },
  };
}

function trustedImageRoots(workspaceRoot: string, env: NodeJS.ProcessEnv): string[] {
  const roots = [workspaceRoot];
  if (env.HOME) roots.push(join(env.HOME, ".local", "share", "opencode"));
  return roots;
}

export function extractOpenCodeOutput(output: string): string {
  return parseOpenCodeOutput(output).output;
}

function parseOpenCodeOutput(output: string): { output: string; sessionId?: string } {
  const texts: string[] = [];
  let sessionId: string | undefined;
  for (const line of output.split("\n")) {
    try {
      const event = parseBoundedJSON(line, 32 * 1024) as Record<string, unknown>;
      const part = event.part as Record<string, unknown> | undefined;
      const text =
        typeof event.text === "string"
          ? event.text
          : part && typeof part.text === "string"
            ? part.text
            : undefined;
      if (text && (event.type === "text" || part?.type === "text")) texts.push(text);
      if (!sessionId) {
        for (const value of [event.sessionID, event.sessionId, event.session_id]) {
          if (typeof value === "string" && value.length > 0) {
            sessionId = value;
            break;
          }
        }
      }
    } catch {
      // Ignore non-event diagnostic lines.
    }
  }
  return { output: texts.length > 0 ? texts.join("") : output, sessionId };
}

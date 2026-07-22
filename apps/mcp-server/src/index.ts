import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import type { AutoRouterOptions } from "./auto-router.js";
import { ProxyClient } from "./client.js";
import type { CodexExecOptions } from "./codex-exec.js";
import type { HarnessExecOptions } from "./harness-exec.js";
import type { HarnessRouterOptions } from "./harness-router.js";
import {
  autoRouteInput,
  boundedString,
  boundedStringOptional,
  createToolHandlers,
  delegateCodexTaskInput,
  delegateHarnessTaskInput,
  failure,
  genericObjectOutput,
  readonlyHarnessTaskInput,
  routeHarnessTaskInput,
  routeTaskInput,
  routeTaskOutput,
  success,
} from "./tools.js";

export function createMcpServer(
  client = new ProxyClient(),
  options: {
    autoRouter?: AutoRouterOptions;
    codexExec?: CodexExecOptions;
    harnessRouter?: HarnessRouterOptions;
    harnessExec?: HarnessExecOptions;
  } = {},
): McpServer {
  const server = new McpServer({ name: "model-router", version: "0.1.0" });
  const handlers = createToolHandlers(client, options);
  server.registerTool(
    "route_task",
    {
      description:
        "Dry-run a bounded task through the local router and explain the deterministic model choice.",
      inputSchema: routeTaskInput,
      outputSchema: routeTaskOutput,
    },
    async (input) => {
      try {
        return success(await handlers.routeTask(input));
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    "explain_route",
    {
      description:
        "Retrieve a prior privacy-safe route decision and its candidate score breakdown.",
      inputSchema: { routeId: z.string().min(1) },
      outputSchema: genericObjectOutput,
    },
    async ({ routeId }) => {
      try {
        return success(await handlers.explainRoute(routeId));
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    "router_stats",
    {
      description:
        "Read aggregate local routing telemetry with optional time, model, and task filters.",
      inputSchema: {
        since: boundedStringOptional(1, 64),
        model: boundedStringOptional(1, 128),
        task: boundedStringOptional(1, 64),
      },
      outputSchema: genericObjectOutput,
    },
    async (input) => {
      try {
        return success(await handlers.stats(input));
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    "submit_route_feedback",
    {
      description: "Record an observable outcome for one prior route decision.",
      inputSchema: {
        routeId: boundedString(1, 256),
        outcome: z.enum(["success", "failure", "corrected", "abandoned"]),
        score: z.number().min(0).max(1).optional(),
        tags: z.array(boundedString(1, 64)).max(16).default([]),
      },
      outputSchema: genericObjectOutput,
    },
    async (input) => {
      try {
        return success(await handlers.feedback(input));
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    "list_router_models",
    {
      description: "List configured logical models, capabilities, health, and routing profiles.",
      inputSchema: {},
      outputSchema: genericObjectOutput,
    },
    async () => {
      try {
        return success(await handlers.models());
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    "delegate_task",
    {
      description:
        "Delegate one bounded prompt through the compatibility proxy with a strict output-token cap.",
      inputSchema: {
        prompt: boundedString(1, 32_000),
        profile: boundedStringOptional(1, 64),
        protocol: z
          .enum(["openai-chat", "openai-responses", "anthropic-messages"])
          .default("openai-chat"),
        model: boundedStringOptional(1, 128),
        session: boundedStringOptional(1, 512),
        maxOutputTokens: z.number().int().min(1).max(8_192).default(1_024),
      },
      outputSchema: genericObjectOutput,
    },
    async (input) => {
      try {
        return success(await handlers.delegate(input));
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    "route_harness_task",
    {
      description:
        "Discover signed-in Codex/OpenCode models or Claude Code aliases, combine bounded prompt/conversation/repository context, preserve task affinity, and return an inspectable native route.",
      inputSchema: routeHarnessTaskInput,
      outputSchema: genericObjectOutput,
    },
    async (input) => {
      try {
        return success(await handlers.routeHarnessTask(input));
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    "delegate_harness_task",
    {
      description:
        "Execute a prior native Codex, OpenCode, or Claude Code route with exact model/effort revalidation, recursion prevention, bounded context, workspace controls, and partial-write detection.",
      inputSchema: delegateHarnessTaskInput,
      outputSchema: genericObjectOutput,
    },
    async (input) => {
      try {
        return success(await handlers.delegateHarnessTask(input));
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    "explain_harness_route",
    {
      description:
        "Read the persisted privacy-safe decision, features, affinity, and outcome for a native harness route.",
      inputSchema: { routeId: z.string().uuid() },
      outputSchema: genericObjectOutput,
    },
    async ({ routeId }) => {
      try {
        return success(await handlers.explainHarnessRoute(routeId));
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    "submit_harness_feedback",
    {
      description: "Attach an observable outcome to a persisted native harness route.",
      inputSchema: {
        routeId: z.string().uuid(),
        outcome: z.enum(["success", "failure", "corrected", "abandoned"]),
        reason: boundedStringOptional(1, 512),
      },
      outputSchema: genericObjectOutput,
    },
    async (input) => {
      try {
        return success(await handlers.submitHarnessFeedback(input));
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    "auto_route",
    {
      description:
        "Select the best live Codex model or registered native user agent from a sanitized objective, bounded conversation summary, and repository metadata.",
      inputSchema: autoRouteInput,
      outputSchema: genericObjectOutput,
    },
    async (input) => {
      try {
        return success(await handlers.autoRoute(input));
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    "delegate_codex_task",
    {
      description:
        "Execute one bounded task with an exact live Codex model and reasoning effort selected by auto_route. Revalidates the catalog and prevents recursive routing.",
      inputSchema: delegateCodexTaskInput,
      outputSchema: genericObjectOutput,
    },
    async (input) => {
      try {
        return success(await handlers.delegateCodexTask(input));
      } catch (error) {
        return failure(error);
      }
    },
  );
  return server;
}

export async function main(): Promise<void> {
  await createMcpServer().connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

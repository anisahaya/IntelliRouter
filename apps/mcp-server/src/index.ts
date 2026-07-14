import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { ProxyClient } from "./client.js";
import {
  createToolHandlers,
  failure,
  genericObjectOutput,
  routeTaskInput,
  routeTaskOutput,
  success,
} from "./tools.js";

export function createMcpServer(client = new ProxyClient()): McpServer {
  const server = new McpServer({ name: "model-router", version: "0.1.0" });
  const handlers = createToolHandlers(client);
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
        since: z.string().optional(),
        model: z.string().optional(),
        task: z.string().optional(),
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
        routeId: z.string().min(1),
        outcome: z.enum(["success", "failure", "corrected", "abandoned"]),
        score: z.number().min(0).max(1).optional(),
        tags: z.array(z.string().max(64)).max(16).default([]),
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
        prompt: z.string().min(1).max(32_000),
        profile: z.string().min(1).max(64).optional(),
        protocol: z
          .enum(["openai-chat", "openai-responses", "anthropic-messages"])
          .default("openai-chat"),
        model: z.string().max(128).optional(),
        session: z.string().max(512).optional(),
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

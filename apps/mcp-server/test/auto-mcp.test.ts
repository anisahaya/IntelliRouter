import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProxyClient } from "../src/client.js";
import { createMcpServer } from "../src/index.js";

let fixtureRoot = "";
let workspace = "";
let fakeCodex = "";

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "model-router-mcp-"));
  workspace = join(fixtureRoot, "workspace");
  fakeCodex = join(fixtureRoot, "fake-codex.mjs");
  await mkdir(workspace);
  await writeFile(join(workspace, "package.json"), "{}", "utf8");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "debug") process.stdout.write(JSON.stringify({models:[
  {slug:"gpt-current",display_name:"Current Model",description:"balanced everyday coding",visibility:"list",supported_in_api:true,priority:2,supported_reasoning_levels:[{effort:"low"},{effort:"medium"}],input_modalities:["text"],context_window:100000,supports_search_tool:false},
  {slug:"gpt-frontier",display_name:"Frontier",description:"frontier model for complex coding",visibility:"list",supported_in_api:true,priority:1,supported_reasoning_levels:[{effort:"high"},{effort:"xhigh"}],input_modalities:["text"],context_window:200000,supports_search_tool:true}
]}));
else if (args.includes("exec")) { let prompt=""; for await (const chunk of process.stdin) prompt+=chunk; process.stdout.write("executed:"+args[args.indexOf("-m")+1]+":"+prompt.includes("Fix the auth architecture")); }
else process.exitCode=2;
`,
    "utf8",
  );
  await chmod(fakeCodex, 0o755);
});

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("auto routing over MCP", () => {
  it("routes and delegates through the two public tools end to end", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({} as ProxyClient, {
      autoRouter: {
        discovery: { executable: fakeCodex },
        trustedRoot: fixtureRoot,
      },
      codexExec: { executable: fakeCodex, trustedRoot: fixtureRoot },
      harnessRouter: {
        codex: { executable: fakeCodex },
        trustedRoot: fixtureRoot,
        state: { path: join(fixtureRoot, "harness-routes.jsonl") },
      },
      harnessExec: {
        codex: { executable: fakeCodex, trustedRoot: fixtureRoot },
        state: { path: join(fixtureRoot, "harness-routes.jsonl") },
      },
    });
    const client = new Client({ name: "auto-mcp-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "auto_route",
          "delegate_codex_task",
          "route_harness_task",
          "delegate_harness_task",
          "explain_harness_route",
          "submit_harness_feedback",
        ]),
      );
      const routed = await client.callTool({
        name: "auto_route",
        arguments: {
          objective: "Fix the auth architecture across multiple files",
          workspaceRoot: workspace,
          registeredAgents: [{ id: "luna-executor", displayName: "Luna Executor" }],
          profile: "quality",
          currentModel: "Current Model Medium",
          requirements: { tools: true, edit: true },
        },
      });
      expect(routed.isError).toBeUndefined();
      const decision = (routed.structuredContent as { result: Record<string, unknown> }).result as {
        selected: { id: string; reasoningEffort: "high" | "xhigh" };
        repoSignals: Record<string, unknown>;
        ranked: Array<{ id: string }>;
      };
      expect(decision.selected.id).toBe("gpt-frontier");
      expect(decision.ranked.map((candidate) => candidate.id)).toContain("luna-executor");

      const delegated = await client.callTool({
        name: "delegate_codex_task",
        arguments: {
          model: decision.selected.id,
          reasoningEffort: decision.selected.reasoningEffort,
          objective: "Fix the auth architecture across multiple files",
          repoSignals: decision.repoSignals,
          workspaceRoot: workspace,
          permission: "read-only",
        },
      });
      expect(delegated.isError).toBeUndefined();
      const execution = (delegated.structuredContent as { result: { output: string } }).result;
      expect(execution.output).toBe("executed:gpt-frontier:true");

      const harnessRouted = await client.callTool({
        name: "route_harness_task",
        arguments: {
          harness: "codex",
          objective: "Fix the auth architecture across multiple files",
          workspaceRoot: workspace,
          profile: "quality",
          currentModel: "Current Model Medium",
          sessionId: "mcp-session",
          requirements: { tools: true, edit: true },
        },
      });
      expect(harnessRouted.isError).toBeUndefined();
      const harnessDecision = (
        harnessRouted.structuredContent as { result: Record<string, unknown> }
      ).result as {
        routeId: string;
        selected: { id: string; reasoningEffort: "high" | "xhigh" };
        repoSignals: Record<string, unknown>;
      };
      expect(harnessDecision.selected.id).toBe("gpt-frontier");
      const harnessDelegated = await client.callTool({
        name: "delegate_harness_task",
        arguments: {
          routeId: harnessDecision.routeId,
          harness: "codex",
          model: harnessDecision.selected.id,
          reasoningEffort: harnessDecision.selected.reasoningEffort,
          objective: "Fix the auth architecture across multiple files",
          repoSignals: harnessDecision.repoSignals,
          workspaceRoot: workspace,
          permission: "read-only",
        },
      });
      expect(harnessDelegated.isError).toBeUndefined();
      expect(
        (
          harnessDelegated.structuredContent as {
            result: { output: string; outcome: string };
          }
        ).result,
      ).toMatchObject({ output: "executed:gpt-frontier:true", outcome: "success" });
      const explained = await client.callTool({
        name: "explain_harness_route",
        arguments: { routeId: harnessDecision.routeId },
      });
      expect(explained.isError).toBeUndefined();
      const feedback = await client.callTool({
        name: "submit_harness_feedback",
        arguments: { routeId: harnessDecision.routeId, outcome: "success" },
      });
      expect(feedback.isError).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startHarness } from "./test-harness.mjs";

const harness = await startHarness();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../dist/mcp-server/index.js", import.meta.url).pathname],
  env: { ...process.env, MODEL_ROUTER_BASE_URL: harness.baseUrl },
});
const client = new Client({ name: "model-router-smoke", version: "0.1.0" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 12);
  assert.ok(tools.tools.some((tool) => tool.name === "route_harness_task"));
  assert.ok(tools.tools.some((tool) => tool.name === "delegate_harness_task"));
  assert.ok(tools.tools.some((tool) => tool.name === "explain_harness_route"));
  assert.ok(tools.tools.some((tool) => tool.name === "submit_harness_feedback"));
  assert.ok(tools.tools.some((tool) => tool.name === "auto_route"));
  assert.ok(tools.tools.some((tool) => tool.name === "delegate_codex_task"));
  const route = await call("route_task", {
    task: "review this bounded function",
    profile: "balanced",
    protocol: "openai-chat",
    toolsRequired: false,
    jsonRequired: false,
    visionRequired: false,
  });
  const routeId = route.structuredContent.routeId;
  await call("explain_route", { routeId });
  await call("router_stats", {});
  await call("submit_route_feedback", { routeId, outcome: "success", tags: ["smoke"] });
  await call("list_router_models", {});
  const delegated = await call("delegate_task", {
    prompt: "Return the word mock",
    maxOutputTokens: 16,
  });
  assert.equal(delegated.structuredContent.result.text, "mock");
  assert.equal(delegated.structuredContent.result.fallbackCount, 0);
  process.stdout.write("mcp smoke: 12 tools registered and legacy proxy flow passed over stdio\n");
} finally {
  await client.close();
  await harness.close();
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, `${name} returned an MCP error`);
  return result;
}

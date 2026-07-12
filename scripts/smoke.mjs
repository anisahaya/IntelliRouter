import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startHarness } from "./test-harness.mjs";

const execFileAsync = promisify(execFile);
const harness = await startHarness();
try {
  const call = async (path, body, headers = {}) => {
    const response = await fetch(`${harness.baseUrl}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.ok(response.ok, `${path} returned ${response.status}`);
    return { response, body: await response.text() };
  };

  assert.equal((await call("/healthz")).response.status, 200);
  const chat = await call("/v1/chat/completions", {
    model: "auto",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(JSON.parse(chat.body).object, "chat.completion");
  const stream = await call("/v1/chat/completions", {
    model: "auto",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  });
  assert.match(stream.body, /\[DONE\]/);
  assert.equal(
    JSON.parse((await call("/v1/responses", { model: "auto", input: "hello" })).body).object,
    "response",
  );
  assert.equal(
    JSON.parse(
      (
        await call("/v1/messages", {
          model: "auto",
          max_tokens: 8,
          messages: [{ role: "user", content: "hello" }],
        })
      ).body,
    ).type,
    "message",
  );
  const route = JSON.parse(
    (await call("/router/route", { task: "review this code", profile: "balanced" })).body,
  );
  assert.equal(JSON.parse((await call(`/router/routes/${route.id}`)).body).id, route.id);
  assert.equal(
    JSON.parse(
      (await call("/router/feedback", { routeId: route.id, outcome: "success", tags: [] })).body,
    ).accepted,
    true,
  );
  assert.ok(JSON.parse((await call("/router/stats")).body).totalRequests >= 4);
  const cli = async (...args) => {
    const { stdout } = await execFileAsync(process.execPath, ["dist/cli/index.js", ...args], {
      env: { ...process.env, MODEL_ROUTER_BASE_URL: harness.baseUrl },
    });
    return JSON.parse(stdout);
  };
  const cliRoute = await cli("route", "--task", "bounded CLI smoke", "--profile", "balanced");
  assert.equal((await cli("explain", cliRoute.id)).id, cliRoute.id);
  assert.equal((await cli("feedback", cliRoute.id, "--outcome", "success")).accepted, true);
  assert.ok((await cli("stats")).totalRequests >= 5);
  process.stdout.write(
    "smoke: chat, streaming, responses, messages, routing, explanation, feedback, stats, CLI passed\n",
  );
} finally {
  await harness.close();
}

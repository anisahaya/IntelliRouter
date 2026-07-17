import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(new URL("../.codex-plugin/plugin.json", import.meta.url)),
);
const skill = await readFile(
  new URL("../skills/intelligent-model-router/SKILL.md", import.meta.url),
  "utf8",
);
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

assert.equal(
  Object.hasOwn(manifest, "mcpServers"),
  false,
  "marketplace plugin must not require the optional MCP backend",
);
assert.match(skill, /route_harness_task/);
assert.match(skill, /delegate_harness_task/);
assert.match(skill, /explain_harness_route/);
assert.match(skill, /submit_harness_feedback/);
assert.match(skill, /Codex-only workflow/i);
assert.match(skill, /MODEL_ROUTER_CHILD_DEPTH/);

const onboarding = readme.split(/^## Advanced self-hosting$/m)[0];
assert.doesNotMatch(onboarding, /router\.config|MODEL_ROUTER_CONFIG|PROVIDER_[A-Z_]*API_KEY/);
assert.match(onboarding, /retains the current host model as fallback/i);
assert.match(readme, /OpenCode continues using its existing OAuth\/subscription credentials/i);
assert.match(readme, /OpenCode Desktop is not a target surface/i);

process.stdout.write("product contract valid\n");

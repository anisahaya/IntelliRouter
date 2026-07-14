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
assert.match(skill, /list_router_models/);
assert.match(skill, /route_task` once for every protocol/i);
assert.match(skill, /select-catalog-route\.mjs/);
assert.match(skill, /delegate_task` with the winning `selectedModel` and its exact `protocol`/i);
assert.match(skill, /current Codex model only as the final fallback/i);

const onboarding = readme.split(/^## Advanced self-hosting$/m)[0];
assert.doesNotMatch(onboarding, /router\.config|MODEL_ROUTER_CONFIG|PROVIDER_[A-Z_]*API_KEY/);
assert.match(onboarding, /currently selected Codex model are fallback paths/i);

process.stdout.write("product contract valid\n");

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
assert.match(skill, /auto_route/);
assert.match(skill, /delegate_codex_task/);
assert.match(skill, /registered agents as one candidate set/i);
assert.match(skill, /current model is a fallback, not a ranked candidate/i);
assert.match(skill, /MODEL_ROUTER_CHILD_DEPTH/);

const onboarding = readme.split(/^## Advanced self-hosting$/m)[0];
assert.doesNotMatch(onboarding, /router\.config|MODEL_ROUTER_CONFIG|PROVIDER_[A-Z_]*API_KEY/);
assert.match(onboarding, /currently selected Codex model as the final fallback/i);

process.stdout.write("product contract valid\n");

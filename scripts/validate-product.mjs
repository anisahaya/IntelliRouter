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
assert.match(skill, /discover candidates on every invocation/i);
assert.match(skill, /host's native delegation|native delegation/i);
assert.match(skill, /delegate_task[^\n]+optional/i);
assert.match(skill, /do not call `route_task` in the normal native flow/i);

const onboarding = readme.split(/^## Advanced self-hosting$/m)[0];
assert.doesNotMatch(onboarding, /router\.config|MODEL_ROUTER_CONFIG|PROVIDER_[A-Z_]*API_KEY/);
assert.match(onboarding, /no proxy, YAML, provider keys, or separate server is required/i);

process.stdout.write("product contract valid\n");

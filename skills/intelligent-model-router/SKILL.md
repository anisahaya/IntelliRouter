---
name: intelligent-model-router
description: Choose and use the best native model or agent already exposed by the current coding host. Use when Codex should route a bounded task locally, preserve task affinity, or optionally delegate through a configured external model-router backend.
---

# Intelligent Model Router

Make routing decisions locally and let the current host execute through its native agents or models.

1. Discover candidates on every invocation. Inspect host-injected tools and capabilities, call a native enumeration tool when one is exposed, and include agent or model handles the user explicitly attached or named. Never assume a candidate exists, hardcode provider names, or discover candidates through the external proxy.
2. Include the current host as the fallback. Never require YAML, API keys, an MCP server, or a proxy. If a structured inventory is available, pass it to `node scripts/select-native-route.mjs` from this skill directory. Filter visible candidates by required capabilities, then choose the smallest capable option using task fit, expected quality, latency, and cost information that is actually available. State uncertainty instead of inventing metadata.
3. Keep one selected candidate for the task or session unless it becomes unavailable, ineligible, or fails. Avoid switching models per message.
4. Execute with the host's native delegation or model controls. Pass a bounded objective, only the needed repository context, expected output, and acceptance checks. Never send secrets, credentials, or unrelated source.
5. If no native alternative is visible, continue with the current host model. This is a valid local routing decision, not an error.
6. Treat `delegate_task` and all `model-router` MCP tools as optional advanced self-hosting capabilities. Use `delegate_task` only when it is actually exposed and connected, preferably when the user requests cross-provider delegation. Bound its prompt and output tokens. Do not call `route_task` in the normal native flow.
7. Record external route feedback only after an observable result such as passing tests, an accepted patch, a correction, or abandonment.

Read [references/native-routing.md](references/native-routing.md) when candidate choice or task affinity needs more detail.
Read [references/advanced-self-hosting.md](references/advanced-self-hosting.md) only when the user asks to configure or use the optional proxy, provider compatibility API, YAML configuration, telemetry, or MCP tools.

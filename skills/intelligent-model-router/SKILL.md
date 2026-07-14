---
name: intelligent-model-router
description: Choose and use the best model for a coding task across a configured model-router MCP catalog and host-native fallbacks. Use when Codex should compare available models, route a bounded task, preserve task affinity, or delegate through the selected provider.
---

# Intelligent Model Router

Prefer the configured model-router catalog for broad model selection. Fall back to host-native execution only when the catalog is unavailable or has no eligible model.

1. Determine the task's hard requirements: tools, structured output, vision, streaming, minimum context, expected output, and an opaque session ID when affinity is useful.
2. When `list_router_models`, `route_task`, and `delegate_task` are exposed, call `list_router_models` and treat its enabled, healthy models as the primary catalog. Never limit this path to the currently selected Codex model.
3. Call `route_task` once for every protocol represented by eligible catalog models, using the same task, profile, session, and requirements. Pass the results as `routes` to `node scripts/select-catalog-route.mjs` from this skill directory. Use its winner, which combines eligible candidates, keeps each model's highest score, and breaks exact ties by model ID. This cross-protocol comparison is required because the proxy does not translate protocols.
4. Call `delegate_task` with the winning `selectedModel` and its exact `protocol`. Send a bounded objective, only necessary context, acceptance checks, and an explicit output-token limit. Never send secrets, credentials, or unrelated source.
5. Keep the selected model for follow-ups in the same task. Re-route only when requirements change materially or the model becomes unavailable, ineligible, or fails.
6. If the MCP catalog or delegation tools are unavailable, discover host-native agents and model controls. Use `node scripts/select-native-route.mjs` from this skill directory when a structured native inventory exists, execute through native controls, and use the current Codex model only as the final fallback. Never invent candidates or capabilities.
7. Record route feedback only after an observable result such as passing tests, an accepted patch, a correction, or abandonment.

Read [references/native-routing.md](references/native-routing.md) when the MCP catalog is unavailable and native fallback needs more detail.
Read [references/advanced-self-hosting.md](references/advanced-self-hosting.md) when configuring the model catalog, provider compatibility API, YAML, telemetry, or MCP tools.

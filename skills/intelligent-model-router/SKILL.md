---
name: intelligent-model-router
description: Choose, compare, delegate to, or evaluate language models through a local intelligent model router. Use when Codex should route a bounded task, explain a prior model choice, inspect routing telemetry or model health, or submit observable outcome feedback.
---

# Intelligent Model Router

Use the plugin's `model-router` MCP tools as a thin client of the running local proxy.

1. Call `route_task` before delegation when the model choice is ambiguous.
2. Keep one explicit session on one model; prefer task/session affinity over per-message switching.
3. Call `delegate_task` only for a bounded subtask with an explicit expected output and output-token limit.
4. Submit feedback only when the outcome is observable, such as passing tests, an accepted patch, a correction, or abandonment.
5. Send only the repository context required for the bounded task. Never send secrets, credentials, or unrelated source.
6. If the router is unavailable, continue with the harness's current model and state that routing was skipped.

Read [references/harness-setup.md](references/harness-setup.md) only for installation or harness configuration work.
Read [references/routing-controls.md](references/routing-controls.md) only when choosing profiles, pinning a model, or controlling session/debug headers.

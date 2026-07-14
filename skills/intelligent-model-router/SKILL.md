---
name: intelligent-model-router
description: Automatically choose and use the best live Codex model or exposed user agent for a coding task using the prompt, bounded conversation context, and repository metadata. Use when Codex should act like an auto model mode, select reasoning effort, delegate a bounded task, or preserve task affinity.
---

# Intelligent Model Router

Route once at the start of a bounded task, then keep that choice while the task remains materially unchanged.

1. Refuse to route when `MODEL_ROUTER_CHILD_DEPTH` is `1` or greater. Complete the task directly instead.
2. Build a concise objective and conversation summary. Include only decisions, constraints, errors, and acceptance checks needed for this task. Never include system or developer instructions, tool transcripts, credentials, secrets, unrelated conversation, or unrelated source contents.
3. Identify hard requirements: repository edits, tools, vision, web search, and minimum context. Register only user agents actually exposed by the current host. Always send each exact ID and display name. Send advertised descriptions, strengths, capabilities, or priors when available; omit missing metadata so the server applies its conservative native-agent defaults. Never invent an agent, model, or capability.
4. When `auto_route` and `delegate_codex_task` are exposed, call `auto_route` with the objective, bounded summary, workspace root, registered agents, hard requirements, active profile, and the current model ID or visible UI label. The server resolves an unambiguous UI label, including a trailing effort label such as `5.6 Sol Medium`, against the live catalog. If the current label is unavailable or cannot be resolved, do not route; complete the task with the current model. Treat the live Codex catalog and registered agents as one candidate set. The current model is a fallback, not a ranked candidate.
5. Follow the returned execution mode exactly:
   - For `codex-exec`, call `delegate_codex_task` with the selected model, reasoning effort, objective, bounded summary, returned repository signals, acceptance checks, workspace root, hard search/vision requirements, trusted image paths when vision is required, and the minimum necessary permission. Use `read-only` unless the delegated worker must edit files.
   - For `native-agent`, invoke the exact selected agent through the host's native agent control. Pass the same bounded objective, summary, acceptance checks, workspace root, and required edit permission; tell it not to re-route or delegate. Wait for it and incorporate its result.
   - Treat a timed-out, nonzero-exit, or empty model result as unusable. Before falling back after any write-capable delegation, inspect the workspace for partial edits and verify or reconcile them; never start a second writer blindly. When `selected` is null, the selected route becomes unavailable, or delegation fails without a usable result, complete the task with the current model.
6. Do not re-route follow-up turns unless requirements materially change or the selected candidate becomes unavailable. Do not recursively invoke this skill from a routed child.
7. Verify the result in proportion to the task. Record feedback only after an observable outcome such as passing tests, an accepted patch, a correction, or abandonment.
8. The skill alone cannot expose execution tools. If the auto tools are unavailable, tell the user to build/connect this repository's MCP server or use the current model; do not imply auto execution occurred. Use the legacy configured-provider flow only when `list_router_models`, `route_task`, and `delegate_task` are exposed. Read [references/advanced-self-hosting.md](references/advanced-self-hosting.md) for setup and that flow.

Read [references/auto-routing.md](references/auto-routing.md) for input boundaries, candidate behavior, fallback semantics, and examples.
Read [references/native-routing.md](references/native-routing.md) only when the auto tools are unavailable and native fallback needs more detail.

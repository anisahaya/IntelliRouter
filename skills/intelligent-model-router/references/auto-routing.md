# Auto routing

## What it selects

`route_harness_task` discovers the signed-in Codex or OpenCode catalog at call time through the selected harness CLI. For Claude Code, whose CLI does not expose a machine-readable picker, it uses the documented rolling model aliases and filters them through `availableModels` in user settings when configured. All three paths retain the harness's subscription or OAuth authentication. The router also ranks user agents explicitly registered by the host for the current task. It never fabricates arbitrary model IDs.

Use `harness: "auto"` to compare all three native harnesses concurrently, or add `harnesses` to compare a bounded subset. Meta-route IDs are namespaced as `codex:<model>`, `opencode:<provider/model>`, and `claude-code:<alias>`; use the separately returned `executionHarness` and `executionModel` when inspecting the adapter decision. Pi remains an explicit exclusion because it has no native discovery/execution adapter. Registered host agents are not mixed into a cross-harness adapter ranking.

When known, the current host model is excluded from ranking and reserved as the final fallback. The tool accepts either its exact ID or an unambiguous visible label such as `5.6 Sol Medium`, resolves it against the current catalog, and uses the canonical ID. Omit it when the host does not expose an authoritative label; routing continues without fabricating a fallback identity. A model winner includes an exact supported reasoning effort. A user-agent winner must be invoked by the host because an MCP server cannot call native agent controls itself.

Register every actually exposed user agent with its exact ID and display name. Include advertised metadata when available. When the host exposes only a name, omit the missing fields: the server uses conservative native-agent defaults (tools and repository edits, no assumed vision or search, 100k context, neutral priors) rather than forcing the caller to invent capabilities.

## Context boundary

Send a short summary, not a transcript. Keep decisions, constraints, relevant failures, and acceptance checks. Omit system/developer instructions, raw tool output, secrets, credentials, unrelated messages, and unrelated source. The server redacts common credential shapes and truncates inputs again, but the caller should minimize context first.

Repository inspection is bounded and metadata-only: language/file counts, manifest and dependency names, test/CI presence, top-level topology, changed filenames, and aggregate Git diff counts. It ignores `.git`, dependency directories, build output, coverage, `.env*`, and symlinks. Apart from bounded dependency names in package manifests, source contents are not read for routing.

## Execution and fallback

Model execution re-reads the available candidates immediately before every launch and validates the exact model and effort. Codex uses an ephemeral `codex exec` child with its native sandbox. OpenCode uses `opencode run --pure` with its native signed-in provider, an injected least-privilege permission policy, and an exact `provider/model` plus variant. Claude Code uses `claude --print --safe-mode` with an exact alias and effort, no child MCP or skills, and a permission-specific built-in tool allowlist. All children expose an allowlisted environment and set `MODEL_ROUTER_CHILD_DEPTH=1`.

Use `read-only` for analysis, reviews, and research. Use `workspace-write` only when the worker must implement changes. The requested workspace must be inside the MCP process's configured trusted root, which defaults to its working directory; set `MODEL_ROUTER_WORKSPACE_ROOT` deliberately when those differ. Concurrent routed write tasks for the same canonical workspace are rejected.

Every route is persisted without raw prompt text, using hashes plus feature/outcome metadata. A stable harness session reuses the same eligible selection for the same task. On an allowlisted timeout, network/rate-limit/overload/upstream failure, or candidate-specific missing model, read-only execution tries the next persisted native ranking, including a different native harness when the route was created from multiple catalogs. It never substitutes a user agent, never treats an old ranking without an explicit native kind as eligible, revalidates every fallback against the selected adapter's live catalog, and leaves the current host as the final fallback when known. Authentication, invalid-request, client, and unknown failures stop the native chain.

The returned `attemptChain` exposes candidate, effort, latency, outcome, classified error, partial-write state, and child session ID. Persistence stores only privacy-safe attempt and health/cooldown metadata. Write fallback requires explicit `allowWriteFallback: true` and is forbidden after repository signals detect any write. OpenCode and Claude Code accept an optional `resumeSessionId` because their installed CLI help exposes supported session-resume flags; their child IDs are returned for later continuation. Codex continuation is deliberately disabled until its resume mode exposes the sandbox controls required by this adapter.

Optional `nativeRouting` policy configuration may choose repository profiles, narrow harnesses or
candidates, apply bounded preference/penalty weights, cap reasoning effort, define aliases, and
enforce locally measurable budgets. Hard live-catalog requirements always run first: policy and
per-call overrides cannot manufacture missing capabilities or bypass the reserved current-model
fallback. Decisions expose applied and ignored policy explanations for inspection.

## Example request

```text
Use $intelligent-model-router to inspect this repository, choose the best live model exposed by this harness, implement the failing authentication tests, and verify the fix.
```

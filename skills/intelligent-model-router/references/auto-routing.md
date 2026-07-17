# Auto routing

## What it selects

`route_harness_task` discovers the signed-in Codex or OpenCode catalog at call time through the selected harness CLI. It can therefore rank visible models added after this plugin was released while retaining the harness's subscription or OAuth authentication. It also ranks user agents explicitly registered by the host for the current task. It never fabricates unavailable choices.

When known, the current host model is excluded from ranking and reserved as the final fallback. The tool accepts either its exact ID or an unambiguous visible label such as `5.6 Sol Medium`, resolves it against the current catalog, and uses the canonical ID. Codex requires this label because it does not expose an authoritative current-model query to MCP; OpenCode may omit it. A model winner includes an exact supported reasoning effort. A user-agent winner must be invoked by the host because an MCP server cannot call native agent controls itself.

Register every actually exposed user agent with its exact ID and display name. Include advertised metadata when available. When the host exposes only a name, omit the missing fields: the server uses conservative native-agent defaults (tools and repository edits, no assumed vision or search, 100k context, neutral priors) rather than forcing the caller to invent capabilities.

## Context boundary

Send a short summary, not a transcript. Keep decisions, constraints, relevant failures, and acceptance checks. Omit system/developer instructions, raw tool output, secrets, credentials, unrelated messages, and unrelated source. The server redacts common credential shapes and truncates inputs again, but the caller should minimize context first.

Repository inspection is bounded and metadata-only: language/file counts, manifest and dependency names, test/CI presence, top-level topology, changed filenames, and aggregate Git diff counts. It ignores `.git`, dependency directories, build output, coverage, `.env*`, and symlinks. Apart from bounded dependency names in package manifests, source contents are not read for routing.

## Execution and fallback

Model execution re-reads the live catalog immediately before launch and validates the exact model and effort. Codex uses an ephemeral `codex exec` child with its native sandbox. OpenCode uses `opencode run --pure` with its native signed-in provider, an injected least-privilege permission policy, and an exact `provider/model` plus variant. Both expose an allowlisted environment and set `MODEL_ROUTER_CHILD_DEPTH=1`.

Use `read-only` for analysis, reviews, and research. Use `workspace-write` only when the worker must implement changes. The requested workspace must be inside the MCP process's configured trusted root, which defaults to its working directory; set `MODEL_ROUTER_WORKSPACE_ROOT` deliberately when those differ. Concurrent routed write tasks for the same canonical workspace are rejected.

Every route is persisted without raw prompt text, using hashes plus feature/outcome metadata. A stable harness session reuses the same eligible selection for the same task. Fall back to the current model when no eligible candidate remains, the selection disappears, execution cannot start, or the child returns an unusable result. After a write-capable failure, obey the reported partial-write safety state before starting any fallback writer. Never silently substitute a different routed model during execution.

## Example request

```text
Use $intelligent-model-router to inspect this repository, choose the best live model exposed by this harness, implement the failing authentication tests, and verify the fix.
```

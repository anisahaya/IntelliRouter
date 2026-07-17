# Auto routing

## What it selects

`auto_route` discovers the signed-in Codex model catalog at call time through the local Codex CLI. It can therefore rank visible models added after this plugin was released. It also ranks user agents explicitly registered by the host for the current task. It never fabricates unavailable choices.

The current host model is deliberately excluded from ranking and reserved as the final fallback. `auto_route` accepts either its exact slug or an unambiguous visible label such as `5.6 Sol Medium`, resolves it against the live catalog, and uses the canonical slug. Codex does not currently expose an authoritative current-model query to MCP, so this visible label must be available in host task context or stated once by the user; otherwise routing stops safely. A Codex-model winner includes an exact reasoning effort. A user-agent winner must be invoked by the host because an MCP server cannot call the host's native agent controls itself.

Register every actually exposed user agent with its exact ID and display name. Include advertised metadata when available. When the host exposes only a name, omit the missing fields: the server uses conservative native-agent defaults (tools and repository edits, no assumed vision or search, 100k context, neutral priors) rather than forcing the caller to invent capabilities.

## Context boundary

Send a short summary, not a transcript. Keep decisions, constraints, relevant failures, and acceptance checks. Omit system/developer instructions, raw tool output, secrets, credentials, unrelated messages, and unrelated source. The server redacts common credential shapes and truncates inputs again, but the caller should minimize context first.

Repository inspection is metadata-only: language/file counts, manifest names, test presence, and aggregate Git status/diff counts. It ignores `.git`, dependencies, build output, coverage, `.env*`, and symlinks. Source file contents are not read for routing.

## Execution and fallback

Model execution re-reads the live catalog immediately before launch, validates the exact model and effort, starts an ephemeral `codex exec` process without user configuration, passes the bounded prompt over stdin, and exposes only an allowlisted environment. Search-required tasks enable Codex web search. Vision-required tasks must supply at least one real image path under the workspace, `$CODEX_HOME/attachments`, or a user-configured `MODEL_ROUTER_IMAGE_ROOTS` entry. Routed children receive `MODEL_ROUTER_CHILD_DEPTH=1` and must not route or delegate again.

Use `read-only` for analysis, reviews, and research. Use `workspace-write` only when the worker must implement changes. The requested workspace must be inside the MCP process's configured trusted root, which defaults to its working directory; set `MODEL_ROUTER_WORKSPACE_ROOT` deliberately when those differ. Concurrent routed write tasks for the same canonical workspace are rejected.

Fall back to the current model when no eligible candidate remains, the live selection disappears, execution cannot start, or the child times out, exits nonzero, or returns no output. After a write-capable failure, inspect and reconcile partial workspace edits before starting any fallback writer. Never silently substitute a different routed model during execution.

## Example request

```text
Use $intelligent-model-router to inspect this repository, choose the best live Codex model or exposed user agent, implement the failing authentication tests, and verify the fix.
```

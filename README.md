# Intelligent Model Router

A Codex skill that acts like an auto-model mode. It uses the prompt, a bounded summary of the conversation, and privacy-safe repository metadata to rank every live model exposed by the signed-in Codex CLI alongside user agents exposed by the host. It selects both a candidate and reasoning effort, delegates the bounded task, and reserves the currently selected Codex model as the final fallback.

The plugin owns the workflow. The self-hosted backend supplies cross-provider discovery, deterministic scoring, delegation, fallback, and privacy-safe SQLite telemetry. YAML remains an advanced setup concern rather than something users provide per task.

## Why this exists

Coding work is a trajectory: tools, repository context, failures, follow-up turns, and task affinity matter. A static three-model list cannot represent what a signed-in Codex installation can actually run. The auto router reads the live catalog, filters hard requirements, scores task fit deterministically, and keeps the selected candidate for the task.

## Quick start

Install the plugin from your Codex marketplace, or load this checkout as a local plugin. Then ask:

```text
Use $intelligent-model-router to choose the best live Codex model or exposed user agent for this task, execute the bounded work, and verify it.
```

The skill supplies routing instructions; the local MCP supplies live discovery and execution. For the auto path, build this repository and connect its MCP in Codex. If you already installed the Intellirouter MCP, update that existing entry rather than creating or deleting a second one:

```bash
pnpm install
pnpm build
```

Set its command to `node`, its argument to the absolute `dist/mcp-server/index.js` path, and its working directory to the codebase it may inspect or edit. That working directory is the default trusted workspace root. If the server working directory must differ, set `MODEL_ROUTER_WORKSPACE_ROOT` explicitly to the allowed codebase. Restart the MCP after rebuilding. The optional legacy proxy environment variables are not required for `auto_route` or `delegate_codex_task`.

Codex does not currently expose an authoritative current-model query to MCP. The visible model label must therefore be present in task context (for example, `5.6 Sol Medium`) so the router can reserve it as fallback. If the host does not provide that label, include it in the request once; an absent or ambiguous label safely disables auto-routing instead of risking recursive selection of the host model.

When the local model-router MCP is connected, the skill calls `auto_route`. The server discovers the signed-in catalog with `codex debug models`, adds only the user agents the host actually exposes, derives task features from bounded context and repository metadata, and returns the winner plus reasoning effort. Codex-model winners run through a guarded `codex exec` child; user-agent winners run through native host delegation.

Your manually selected model—Sol Medium, for example—does not limit which live model can win. It orchestrates the skill and becomes the fallback when no eligible candidate remains or delegation fails.

## Hybrid routing

The normal product path is:

```text
bounded task context + repository metadata
                |
                v
plugin skill -> auto_route -> live Codex models + exposed user agents
                |                         |
                +-> codex-exec winner     +-> native-agent winner
                |
                +-> current model fallback
```

Required tools, vision, search, editing, and context size are hard filters. The selected profile then compares deterministic task fit, quality, speed, economy, and specialization. Exact ties break by candidate ID. The current model is excluded from ranking so it remains a genuine fallback.

Only the context needed for a bounded objective is delegated. The router never reads source contents to choose a model. It uses language/file counts, manifest names, test presence, and aggregate Git changes; ignores dependencies, build output, `.env*`, and symlinks; redacts common credential shapes; and caps all inputs and child outputs.

## Advanced self-hosting

The external proxy is required for broad cross-provider model choice. It remains optional only when host-native fallback routing is sufficient. It is not installed or started by the marketplace plugin.

Requirements for this advanced path: Node.js 22+, pnpm, a router YAML file, and provider credentials.

```bash
pnpm install
cp examples/router.config.example.yaml router.config.yaml
# Edit router.config.yaml, then export only the named secret variables.
export MODEL_ROUTER_CONFIG="$PWD/router.config.yaml"
export MODEL_ROUTER_AUTH_TOKEN=replace-with-a-local-token
export MODEL_ROUTER_BASE_URL=http://127.0.0.1:8856
export PROVIDER_A_API_KEY=replace-with-provider-key
export PROVIDER_B_API_KEY=replace-with-provider-key
pnpm build
node dist/cli/index.js doctor
node dist/cli/index.js serve
```

The default address is `http://127.0.0.1:8856`. Binding to a non-loopback host is rejected unless `server.authTokenEnv` is configured and populated. Keep populated configuration and environment files out of source control.

Full skill-side setup and controls are documented in [advanced-self-hosting.md](skills/intelligent-model-router/references/advanced-self-hosting.md). Harness examples are included for [Codex](examples/codex.config.toml), [Claude Code](examples/claude-code.md), [OpenCode](examples/opencode.json), and [Pi](examples/pi.md).

### MCP tools

The repository keeps `.mcp.json` as an opt-in development artifact for the built local server. It is intentionally not required by the plugin manifest. When connected, its eight tools include the primary `auto_route` and `delegate_codex_task` flow plus the six legacy self-hosting tools: `route_task`, `explain_route`, `router_stats`, `submit_route_feedback`, `list_router_models`, and `delegate_task`.

`auto_route` reads the live Codex catalog and scores it together with registered agents. `delegate_codex_task` revalidates the exact model, reasoning effort, search/vision capabilities, trusted image paths, and workspace containment before starting an ephemeral process group with user configuration disabled, an allowlisted environment, bounded stdin context, and a recursion guard. The six original tools remain available for advanced external-provider routing.

### API

Compatibility endpoints:

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `GET /v1/models`

Control endpoints:

- `GET /healthz` and `GET /readyz`
- `POST /router/route`
- `GET /router/routes/:routeId`
- `POST /router/feedback`
- `GET /router/stats` and `GET /router/models`
- `POST /router/models/:id/probe`

Use `model: "auto"`, `router/economy`, `router/balanced`, or `router/premium`. Headers `x-router-model`, `x-router-session`, and `x-router-profile` pin a model, enable affinity, or override the policy. Compatibility responses identify the request, route decision, model, profile, and fallback count.

A model `id` is the logical alias callers pin. `upstreamModel` is the provider's real model identifier, `provider` selects the wire adapter, and a routing profile is only a set of quality/cost/latency weights. Profiles are not models.

### Routing and fallback

The proxy normalizes enough metadata to detect required protocol, tools, JSON output, vision, streaming, and context size. Ineligible configured models are excluded before deterministic scoring. Explicit opaque sessions retain the selected model until affinity expires or it becomes ineligible or unhealthy.

Configured timeouts, network failures, rate limits, overloads, and upstream 5xx responses can fall back to the next candidate only before any response byte is emitted. Feedback is an explicit, inspectable prior; there is no opaque training in v0.1.

### Privacy and security

SQLite stores route features, approximate token counts, scores, aliases, latency, status, cost estimates, HMAC-hashed session IDs, provider attempts, and explicit feedback. Raw prompt/response storage and unhashed sessions are rejected because those modes are not safely implemented in v0.1. Logs redact authorization, API key, cookie, credential, token, password, and secret-shaped fields.

### CLI

```text
model-router serve [--config path]
model-router doctor [--config path] [--probe]
model-router route --task "..." [--profile balanced] [--protocol openai-chat] [--session id] [--model alias] [--tools] [--json] [--vision] [--streaming] [--minimum-context tokens]
model-router explain <route-id>
model-router stats [--since ISO_TIMESTAMP] [--model alias] [--task type]
model-router feedback <route-id> --outcome success [--score 1] [--tag accepted]
model-router config init [path]
```

### Supported v0.1 proxy subset

Chat Completions and Anthropic Messages preserve pass-through JSON bodies, tool definitions/calls, usage payloads, provider request IDs, and SSE bytes. Responses supports text/array inputs, tools, structured-output requirements, usage, and SSE pass-through. Provider-specific bidirectional WebSockets, uploaded file lifecycle APIs, background Responses jobs, hosted tools, and cross-protocol translation are not implemented. A model must advertise the incoming protocol; the router does not translate protocols.

Additional limitations: health uses persisted recent-attempt windows and circuit cooldowns; retries do not resume partial streams; cost data is config-supplied; and the Postman collection checks non-streaming protocol calls while `pnpm smoke` covers SSE.

## Architecture

```text
plugin skill -> auto_route -> live Codex catalog + registered user agents
     |              |                         |
     |              +-> delegate_codex_task   +-> native host delegation
     |
     +-> if unavailable: current Codex model fallback

legacy self-hosting -> configured providers + SQLite telemetry
```

## Verification

```bash
pnpm run verify
```

All integration checks use local mock providers and placeholder credentials.

Licensed under MIT.

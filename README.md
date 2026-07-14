# Intelligent Model Router

A skill that chooses the best model for a task across the providers configured in the model-router MCP catalog, then executes through that exact model. Host-native agents and the currently selected Codex model are fallback paths, not the primary candidate set.

The plugin owns the workflow. The self-hosted backend supplies cross-provider discovery, deterministic scoring, delegation, fallback, and privacy-safe SQLite telemetry. YAML remains an advanced setup concern rather than something users provide per task.

## Why this exists

Coding work is a trajectory: tools, repository context, failures, follow-up turns, and task affinity matter. The router filters hard requirements, compares configured models using inspectable quality, cost, latency, health, and feedback signals, and keeps the selected model for the task.

## Quick start

Install the plugin from your Codex marketplace, or load this checkout as a local plugin. Then ask:

```text
Use $intelligent-model-router to compare every configured model, choose the best one for this task, and execute through it.
```

When the model-router MCP is connected, the skill lists its catalog, evaluates every represented protocol, compares eligible candidate scores, and passes the winning logical model and protocol to `delegate_task`. Your manually selected Codex model orchestrates the workflow but does not restrict which configured backend model can win.

If the MCP catalog is unavailable or has no eligible model, the skill discovers host-native agents or model controls and finally falls back to the currently selected Codex model. The standalone selector in `skills/intelligent-model-router/scripts/select-native-route.mjs` makes that native fallback deterministic and testable.

## Hybrid routing

The normal product path is:

```text
plugin skill -> list configured models -> score every supported protocol -> delegate to winner
```

Required tools, modality, context, output, protocol, and health are hard filters. The configured profile then compares quality, cost, latency, failures, and observable feedback. Because the proxy does not translate protocols, the skill queries each represented protocol and chooses the highest eligible score across the combined results.

Only the context needed for a bounded objective is delegated. Credentials, secrets, and unrelated source must not be included. Native discovery is used only as the fallback path.

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

The repository keeps `.mcp.json` as an opt-in development artifact for the built external backend. It is intentionally not required by the plugin manifest. When connected, its six tools are `route_task`, `explain_route`, `router_stats`, `submit_route_feedback`, `list_router_models`, and `delegate_task`.

The primary catalog flow calls `list_router_models`, calls `route_task` for each represented protocol, and sends the winning model and protocol to `delegate_task` with an explicit output-token cap. If the backend is unavailable, the skill continues through the host-native fallback path.

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
plugin skill -> MCP model catalog -> cross-protocol scoring -> delegate_task -> selected provider model
     |
     +-> if unavailable: host-native agent/model -> current Codex model fallback

external proxy -> configured providers + SQLite telemetry
```

## Verification

```bash
pnpm run verify
```

All integration checks use local mock providers and placeholder credentials.

Licensed under MIT.

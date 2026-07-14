# Intelligent Model Router

A zero-config skill that chooses locally from the agents and models already available in your coding host, then lets the host execute natively. The plugin is the primary product; no proxy, YAML, provider keys, or separate server is required for ordinary use.

An optional self-hosted backend remains available for cross-provider compatibility APIs, configured deterministic routing, fallback, and privacy-safe SQLite telemetry.

## Why this exists

Coding work is a trajectory: tools, repository context, failures, follow-up turns, and task affinity matter. The skill routes at task boundaries using the capabilities the host actually exposes instead of treating every prompt as an isolated API request.

## Quick start

Install the plugin from your Codex marketplace, or load this checkout as a local plugin. Then ask:

```text
Use $intelligent-model-router to choose the best native agent or model for this task and execute it.
```

On every invocation, the skill inspects native agents, models, and selection controls exposed by the current host. It filters candidates by the task's hard requirements, makes the decision locally, and uses the host's native execution path. If no alternative is exposed, it continues on the current host model. It never invents unavailable candidates.

The selected candidate stays attached to the task unless it becomes unavailable, ineligible, or fails. The standalone selector in `skills/intelligent-model-router/scripts/select-native-route.mjs` makes structured inventory decisions deterministic and testable.

## Native routing

The normal product path is:

```text
plugin skill -> discover host-native candidates -> local decision -> native agent/model
```

Discovery happens at invocation time because available native agents and models can change between hosts and tasks. Required tools, modality, context, and output capabilities are hard filters. Task fit, visible quality information, latency, and cost guide the remaining local choice; missing metadata is treated as uncertainty, not fabricated.

Only the context needed for a bounded objective is delegated. Credentials, secrets, and unrelated source must not be included.

## Advanced self-hosting

The external proxy is an optional backend for users who want cross-provider delegation, OpenAI- or Anthropic-compatible endpoints, configured profiles, fallback, or telemetry. It is not installed or started by the marketplace plugin.

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

### Optional MCP tools

The repository keeps `.mcp.json` as an opt-in development artifact for the built external backend. It is intentionally not required by the plugin manifest. When connected, its six tools are `route_task`, `explain_route`, `router_stats`, `submit_route_feedback`, `list_router_models`, and `delegate_task`.

Native routing does not call `route_task`. `delegate_task` is an optional external cross-provider capability for a bounded prompt with an explicit output-token cap. If the backend is unavailable, the skill continues through the host-native path.

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
                              +-> host-native agent/model
plugin skill -> local choice -|
                              +-> optional delegate_task -> external proxy -> provider
                                                             |
                                                             +-> SQLite telemetry
```

## Verification

```bash
pnpm run verify
```

All integration checks use local mock providers and placeholder credentials.

Licensed under MIT.

# Intelligent Model Router

A local-first, open-source model router for coding agents. It exposes OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages compatibility endpoints, selects an eligible logical model for an entire task/session, and records privacy-safe outcome telemetry. MCP and the bundled Codex skill are clients of the proxy—not alternate routing engines.

## Why this exists

Most routers classify one isolated prompt as cheap or hard. Coding work is a trajectory: tools, repository context, failures, follow-up turns, and cache/session affinity matter. This router filters hard capabilities first, applies deterministic scoring second, and learns only through an explicit, inspectable feedback prior.

## Quick start

Requirements: Node.js 22+ and pnpm.

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

The default address is `http://127.0.0.1:8856`. Binding to a non-loopback host is rejected unless `server.authTokenEnv` is configured and populated.

## API

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

## Routing and fallback

The pipeline normalizes only enough metadata to detect required protocol, tools, JSON output, vision, streaming, and context size. Models that cannot satisfy requirements are excluded before scoring. Eligible models receive deterministic quality, cost, latency, failure, and task-feedback components; ties are broken by logical model ID.

Explicit opaque sessions retain the selected model until affinity expires or it becomes ineligible/unhealthy. Configured timeouts, rate limits, overloads, and upstream 5xx responses can fall back to the next candidate only before any response byte is emitted.

Feedback is a documented deterministic prior: `success` contributes `+1`, `failure` `-1`, `corrected` `-0.5`, and `abandoned` `-0.25`; the mean for a model/task pair is multiplied by `0.1` and bounded by the scorer. There is no opaque training in v0.1.

## Privacy and security

SQLite stores route features, approximate token counts, scores, aliases, latency, status, cost estimates, hashed session IDs, and explicit feedback. Raw prompts and responses are never stored in v0.1, even if the reserved privacy opt-in flags are set. Logs redact authorization, API key, cookie, credential, token, password, and secret-shaped fields. Never commit populated config files or `.env` files.

## MCP and Codex plugin

The plugin manifest is `.codex-plugin/plugin.json`; `.mcp.json` launches the built stdio server. Export `MODEL_ROUTER_BASE_URL` and optionally `MODEL_ROUTER_AUTH_TOKEN` before starting Codex. The six tools are `route_task`, `explain_route`, `router_stats`, `submit_route_feedback`, `list_router_models`, and `delegate_task`.

Harness setup is included for [Codex](examples/codex.config.toml), [Claude Code](examples/claude-code.md), [OpenCode](examples/opencode.json), and [Pi](examples/pi.md).

## CLI

```text
model-router serve [--config path]
model-router doctor [--config path] [--probe]
model-router route --task "..." [--profile balanced]
model-router explain <route-id>
model-router stats [--since ISO_TIMESTAMP]
model-router feedback <route-id> --outcome success
model-router config init [path]
```

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
pnpm postman
pnpm mcp:smoke
pnpm validate:skill
pnpm validate:plugin
```

All integration checks use local mock providers and placeholder credentials.

## Supported v0.1 subset

Chat Completions and Anthropic Messages preserve pass-through JSON bodies, tool definitions/calls, usage payloads, provider request IDs, and SSE bytes. Responses supports text/array inputs, tools, structured-output requirements, usage, and SSE pass-through. Provider-specific bidirectional WebSockets, uploaded file lifecycle APIs, background Responses jobs, hosted tools, and cross-protocol translation are not implemented. A model must advertise the incoming protocol; the router does not translate Chat Completions into Anthropic Messages or vice versa.

Additional limitations: health is process-local plus SQLite windows; retries do not resume partial streams; cost data is config-supplied; raw-content opt-in is reserved but intentionally inactive; and the Postman collection checks non-streaming protocol calls while `pnpm smoke` covers SSE.

## Architecture

```text
coding harness -> compatibility proxy -> capability filter -> deterministic router -> provider
                         |                         |
                         +-> control API -> SQLite telemetry
                                  ^
                                  |
                           MCP server + skill
```

Licensed under MIT.

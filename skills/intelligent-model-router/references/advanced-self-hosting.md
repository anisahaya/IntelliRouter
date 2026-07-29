# Advanced self-hosting

The optional compatibility proxy enables configured cross-provider routing, OpenAI- and Anthropic-compatible endpoints, fallback, and local SQLite telemetry. Native Codex, Claude Code, and OpenCode routing does not require it.

## Start the proxy

Requirements: Node.js 22+, pnpm, a router YAML file, and credentials for the providers in that file.

```bash
pnpm install
pnpm build
cp examples/router.config.example.yaml router.config.yaml
export MODEL_ROUTER_CONFIG="$PWD/router.config.yaml"
export MODEL_ROUTER_AUTH_TOKEN="$(openssl rand -hex 32)"
export MODEL_ROUTER_BASE_URL=http://127.0.0.1:8856
# Export only the provider credential variables named by router.config.yaml.
node dist/cli/index.js doctor
node dist/cli/index.js serve
```

Keep populated configuration and environment files out of source control. Binding outside loopback requires configured authentication.

## Compatibility API

Supported endpoints:

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `GET /v1/models`

Use `model: "auto"` or `router/<profile>`. `x-router-model`, `x-router-session`, and `x-router-profile` can pin a model, maintain affinity, or select a profile. Responses include route and fallback metadata in `x-router-*` headers.

The proxy preserves supported request bodies, tool definitions/calls, usage, provider request IDs, and SSE bytes. It does not translate protocols, resume partial streams, or support provider-specific WebSockets, file lifecycles, background Responses jobs, or hosted tools.

## Routing and safety

Models must advertise the incoming protocol and satisfy the request's tools, JSON, vision, streaming, and context requirements. Explicit sessions retain their model until it expires, becomes ineligible, or is unhealthy. Network and upstream failures can fall back only before response bytes are emitted.

SQLite records route features, scores, aliases, latency, status, cost estimates, HMAC-hashed sessions, attempts, and explicit feedback. Raw content capture is disabled by default; source and embeddings are opt-in and bounded. Logs redact common secret-shaped values.

Read [training data](../../../docs/training-data.md) for the opt-in task-run record and evaluation boundary, and [routing math](../../../docs/routing-math.md) for scoring and evidence limits.

## CLI

```text
intellirouter serve [--config path]
intellirouter doctor [--config path] [--probe]
intellirouter route --task "..." [--profile balanced] [--protocol openai-chat]
intellirouter explain <route-id>
intellirouter stats [--since ISO_TIMESTAMP] [--model alias] [--task type]
intellirouter feedback <route-id> --outcome success [--score 1] [--tag accepted]
intellirouter config init [path]
```

For native harness setup, return to the [README](../../../README.md#quick-start).

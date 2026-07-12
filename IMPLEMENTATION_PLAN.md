# Intelligent Model Router — Implementation Plan

Implementation target: `/Users/aniruddhsahay/Projects/General/model-router`

The planning workspace is not the project root. Create the complete repository at the implementation target above.

## 1. Product boundary

Build a local-first, open-source model router for coding harnesses. The runtime core is a compatibility proxy; MCP and skills are integrations, not the routing engine.

The first usable release must:

- accept OpenAI Chat Completions requests at `POST /v1/chat/completions`;
- accept OpenAI Responses requests at `POST /v1/responses` for the supported MVP subset;
- accept Anthropic Messages requests at `POST /v1/messages`;
- route a whole task/session to one eligible model by default;
- preserve streaming, tool calls, usage metadata, and provider errors;
- filter candidates by capabilities before scoring them;
- provide deterministic route explanations, feedback, telemetry, fallback, and session affinity;
- expose a separate MCP server that calls the proxy control API;
- ship a concise Codex skill inside a valid plugin scaffold;
- include harness onboarding examples for Codex, Claude Code, OpenCode, and Pi;
- run entirely locally except for calls made directly to configured model providers.

Non-goals for v0.1:

- training a learned router;
- silently switching models in the middle of an agent trajectory;
- implementing every field of every provider API;
- storing raw prompts/responses by default;
- operating a hosted multi-tenant SaaS.

## 2. Technology choices

- Runtime: Node.js 22 or newer, TypeScript, ESM.
- Package manager: pnpm workspaces.
- HTTP server: Fastify.
- HTTP client and streaming: Node `fetch`/Undici primitives.
- Validation and shared contracts: Zod.
- Persistence: SQLite through `better-sqlite3`.
- Logging: Pino with structured redaction.
- Configuration: YAML plus environment-variable secret references.
- CLI: Commander.
- MCP: `@modelcontextprotocol/sdk`, stdio transport first.
- Tests: Vitest, Fastify injection for API tests, mock upstream HTTP servers for streaming/provider tests.
- Formatting/linting: Biome.
- Build: TypeScript project references plus `tsup` for executable packages.
- API collection: committed Postman collection and environment with secret placeholders only.

Avoid provider SDKs in the proxy transport path unless a protocol cannot be implemented safely with `fetch`. Raw transport minimizes translation loss and makes streaming behavior explicit.

## 3. Repository scaffold

```text
model-router/
├── .codex-plugin/
│   └── plugin.json
├── .github/workflows/ci.yml
├── apps/
│   ├── proxy/
│   │   ├── src/
│   │   │   ├── app.ts
│   │   │   ├── server.ts
│   │   │   ├── routes/
│   │   │   │   ├── health.ts
│   │   │   │   ├── models.ts
│   │   │   │   ├── openai-chat.ts
│   │   │   │   ├── openai-responses.ts
│   │   │   │   ├── anthropic-messages.ts
│   │   │   │   └── control.ts
│   │   │   └── plugins/
│   │   │       ├── auth.ts
│   │   │       ├── errors.ts
│   │   │       └── request-context.ts
│   │   └── test/
│   └── mcp-server/
│       ├── src/index.ts
│       ├── src/client.ts
│       ├── src/tools.ts
│       └── test/
├── packages/
│   ├── contracts/
│   │   └── src/{config,protocol,route,telemetry}.ts
│   ├── config/
│   │   └── src/{load,env,defaults}.ts
│   ├── router-core/
│   │   ├── src/capabilities.ts
│   │   ├── src/features.ts
│   │   ├── src/policies.ts
│   │   ├── src/scorer.ts
│   │   ├── src/affinity.ts
│   │   ├── src/fallback.ts
│   │   ├── src/explain.ts
│   │   └── test/
│   ├── providers/
│   │   ├── src/base.ts
│   │   ├── src/openai-compatible.ts
│   │   ├── src/anthropic.ts
│   │   ├── src/registry.ts
│   │   ├── src/streaming.ts
│   │   └── test/
│   ├── telemetry/
│   │   ├── src/store.ts
│   │   ├── src/migrations.ts
│   │   ├── src/redaction.ts
│   │   └── test/
│   └── cli/
│       └── src/{index,serve,doctor,route,explain,stats,feedback}.ts
├── skills/
│   └── intelligent-model-router/
│       ├── SKILL.md
│       ├── agents/openai.yaml
│       └── references/
│           ├── harness-setup.md
│           └── routing-controls.md
├── scripts/
│   ├── smoke.mjs
│   └── generate-example-config.mjs
├── postman/
│   ├── model-router.postman_collection.json
│   └── local.postman_environment.json
├── examples/
│   ├── router.config.example.yaml
│   ├── codex.config.toml
│   ├── claude-code.md
│   ├── opencode.json
│   └── pi.md
├── .mcp.json
├── .env.example
├── biome.json
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── vitest.workspace.ts
├── LICENSE
└── README.md
```

The plugin manifest belongs at repository root because the repository itself is the distributable Codex plugin. Do not create a personal marketplace entry during initial implementation.

## 4. Runtime configuration

Example model configuration:

```yaml
server:
  host: 127.0.0.1
  port: 8856
  authTokenEnv: MODEL_ROUTER_AUTH_TOKEN
  databasePath: ~/.model-router/router.db

privacy:
  storePrompts: false
  storeResponses: false
  hashSessionIds: true

models:
  - id: cheap-code
    provider: openai-compatible
    upstreamModel: provider/model-a
    baseUrl: https://provider.example/v1
    apiKeyEnv: PROVIDER_A_API_KEY
    cost:
      inputPerMillion: 0.20
      outputPerMillion: 0.80
    capabilities:
      protocols: [openai-chat]
      tools: true
      json: true
      vision: false
      maxContextTokens: 128000
    tags: [cheap, fast, code]

  - id: premium-code
    provider: anthropic
    upstreamModel: provider-model-b
    baseUrl: https://api.anthropic.com
    apiKeyEnv: PROVIDER_B_API_KEY
    capabilities:
      protocols: [anthropic-messages]
      tools: true
      json: true
      vision: true
      maxContextTokens: 200000
    tags: [premium, reasoning, code]

routing:
  defaultProfile: balanced
  affinityTtlSeconds: 3600
  fallbackOn: [timeout, rate_limit, overloaded, upstream_5xx]
  profiles:
    economy:
      weights: {quality: 0.20, cost: 0.55, latency: 0.25}
    balanced:
      weights: {quality: 0.45, cost: 0.35, latency: 0.20}
    premium:
      weights: {quality: 0.75, cost: 0.10, latency: 0.15}
```

Configuration requirements:

- reject duplicate logical model IDs;
- reject weights that do not sum to approximately 1;
- reject missing environment variables at startup unless the model is disabled;
- never interpolate secrets into logs or route explanations;
- support `MODEL_ROUTER_CONFIG` as the configuration path override;
- support a `doctor` command that checks config, database access, and provider model reachability without printing keys.

## 5. Routing pipeline

Perform these stages in order:

1. Parse the incoming protocol and generate an internal `NormalizedRequest` without destructively rewriting the original body.
2. Extract hard requirements: protocol, tool use, JSON/structured output, vision, minimum context, streaming, and explicitly pinned model/profile.
3. Filter out ineligible or unhealthy candidates.
4. Resolve session affinity using an explicit `x-router-session` header, then protocol conversation identifiers when available. Do not derive affinity from raw prompt text.
5. Extract lightweight task features: code markers, task type, estimated input tokens, agentic/tool-loop signals, and requested reasoning intensity.
6. Score eligible candidates using deterministic policy weights, static quality priors, configured price, observed latency, recent failure rate, and feedback-adjusted task priors.
7. Choose a model and persist a `RouteDecision` with a complete score breakdown.
8. Forward the original request through the selected provider adapter, changing only fields required for upstream compatibility.
9. Stream chunks with backpressure and client-disconnect cancellation.
10. Record latency, status, usage, fallback chain, and privacy-safe task features.
11. On configured transient failures, select the next eligible candidate and retry only if it is safe to do so. Never retry after response bytes have been emitted.

Pinned routing controls:

- `model: "auto"` or `model: "router/balanced"` invokes routing;
- `model: "router/economy"` and `model: "router/premium"` choose a profile;
- `x-router-model: <logical-id>` pins a model;
- `x-router-session: <opaque-id>` enables task affinity;
- `x-router-debug: true` returns safe routing headers but never secrets or hidden prompt content.

## 6. Internal contracts

Define and test these core types:

- `Protocol = "openai-chat" | "openai-responses" | "anthropic-messages"`;
- `NormalizedRequest` with protocol, stream flag, messages/input summary, tool requirements, modality requirements, token estimate, and pass-through body;
- `ModelDefinition` with provider, upstream ID, capabilities, cost, tags, health configuration, and optional static quality priors;
- `RouteCandidate` with eligibility reasons and component scores;
- `RouteDecision` with request ID, logical model, upstream model, profile, features, candidate breakdown, fallback chain, and timestamps;
- `FeedbackEvent` with route ID, outcome (`success`, `failure`, `corrected`, `abandoned`), optional score, and privacy-safe tags;
- `ProviderAdapter` with `supports`, `prepareRequest`, `send`, `stream`, and `classifyError` methods.

Use discriminated unions for protocol-specific request and response metadata. Avoid one giant optional-field interface.

## 7. HTTP surface

Compatibility endpoints:

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `GET /v1/models`

Control endpoints:

- `GET /healthz`: process, config, and database status only;
- `GET /readyz`: includes whether at least one configured model is eligible;
- `POST /router/route`: dry-run selection without calling a model;
- `GET /router/routes/:routeId`: safe explanation and candidate scores;
- `POST /router/feedback`: attach an outcome to a route;
- `GET /router/stats`: counts, cost estimates, latency, success, and model/task distribution;
- `GET /router/models`: logical models, capabilities, health, and configured profiles;
- `POST /router/models/:id/probe`: explicit provider health probe.

Return a stable JSON error envelope for router errors. Preserve upstream status codes and request IDs where safe. Add `x-router-request-id`, `x-router-model`, `x-router-profile`, and `x-router-fallback-count` response headers.

## 8. Persistence and privacy

SQLite tables:

- `schema_migrations`;
- `route_decisions`;
- `route_candidates`;
- `request_metrics`;
- `feedback_events`;
- `model_health_windows`;
- `session_affinity`.

Default storage must contain no raw prompt or response text. Store feature flags, approximate token counts, salted hashes for optional session identifiers, and configured model aliases. Raw-content logging is an explicit opt-in with a startup warning.

Redact case-insensitively:

- authorization and proxy-authorization headers;
- `x-api-key` and provider-specific key headers;
- cookie/set-cookie;
- query parameters or JSON keys matching token, secret, password, key, credential, or authorization patterns.

## 9. MCP server

Implement only after the proxy acceptance suite passes. The MCP server is a thin client of the control API and must not duplicate routing logic.

Tools:

- `route_task`: dry-run a described task against a profile and return selected model plus explanation;
- `explain_route`: retrieve one prior route decision;
- `router_stats`: retrieve aggregate telemetry with optional time/model/task filters;
- `submit_route_feedback`: record an explicit outcome;
- `list_router_models`: list models, capabilities, health, and profiles;
- `delegate_task`: optionally call the compatibility proxy for a bounded prompt, with model/profile override and strict output limit.

Every tool needs Zod input/output schemas, bounded response sizes, useful MCP errors, and tests using an in-memory/fake proxy client.

Root `.mcp.json` should launch the built MCP executable and read `MODEL_ROUTER_BASE_URL` plus `MODEL_ROUTER_AUTH_TOKEN` from the environment. Do not embed secrets.

## 10. Codex plugin and skill

Create a valid `.codex-plugin/plugin.json` whose name matches the repository/plugin folder name. Include MCP metadata only when `.mcp.json` exists.

The skill name is `intelligent-model-router`. Its description should trigger when a user asks Codex to choose, compare, delegate to, or evaluate models through the local router.

Keep `SKILL.md` concise. It should instruct Codex to:

- use `route_task` before delegation when model choice is ambiguous;
- prefer task/session-level affinity over per-message switching;
- use `delegate_task` only for bounded subtasks with explicit expected output;
- submit feedback only when an outcome is observable;
- avoid sending secrets or unnecessary repository contents;
- fall back to the harness's current model if the router is unavailable;
- read `references/harness-setup.md` only for installation/configuration work;
- read `references/routing-controls.md` only for profile/header behavior.

Generate `skills/intelligent-model-router/agents/openai.yaml` from the finished skill and validate it with the skill-creator validator.

## 11. CLI

Expose a `model-router` binary:

- `model-router serve [--config path]`;
- `model-router doctor [--probe]`;
- `model-router route --task "..." [--profile balanced]`;
- `model-router explain <route-id>`;
- `model-router stats [--since 24h]`;
- `model-router feedback <route-id> --outcome success`;
- `model-router config init [path]`.

`serve` must handle SIGINT/SIGTERM, close the database, and drain active requests with a bounded timeout.

## 12. Test strategy

Unit tests:

- capability filtering;
- deterministic scoring and tie-breaking;
- session affinity and expiry;
- fallback eligibility and error classification;
- redaction;
- configuration validation;
- provider request preparation;
- route explanations.

Integration tests with mock upstreams:

- OpenAI non-streaming and SSE streaming;
- Anthropic non-streaming and SSE streaming;
- tool-call payload preservation;
- JSON/structured-output capability filtering;
- client cancellation propagation;
- timeout, rate-limit, and 5xx fallback before bytes are emitted;
- no retry after streaming has begun;
- upstream error/request-ID preservation;
- feedback and aggregate stats;
- MCP tools against an injected proxy server.

Security tests:

- secrets absent from logs, errors, database, explanations, and snapshots;
- localhost binding is the default;
- non-loopback binding requires an auth token;
- malformed/oversized bodies receive bounded errors;
- raw-content storage remains disabled by default.

End-to-end verification:

1. Run `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
2. Start mock providers and the built proxy.
3. Run `pnpm smoke` for Chat Completions, Responses, Messages, route dry-run, explanation, feedback, and stats.
4. Import/run the committed Postman collection against the local proxy, using mock credentials only.
5. Launch the MCP server over stdio and execute each tool through an MCP test client.
6. Validate the skill and plugin manifests with the official scaffold validators.
7. Inspect the final repository in Finder and confirm no secrets, databases, logs, build outputs, or dependency directories are staged as source.

## 13. Delivery phases and gates

### Phase 0 — Scaffold

- initialize pnpm workspace and TypeScript/Biome/Vitest configuration;
- create package boundaries and shared contracts;
- add example config, `.env.example`, license, README, and CI;
- gate: lint/typecheck/test/build commands exist and pass on an empty skeleton.

### Phase 1 — Compatibility proxy/API

- implement configuration, contracts, routing engine, provider adapters, persistence, CLI, compatibility endpoints, control endpoints, streaming, redaction, and mock providers;
- gate: all proxy unit/integration/security tests and CLI smoke tests pass;
- gate: Postman collection passes against local mock providers.

### Phase 2 — MCP integration

- implement the thin MCP client/server and root `.mcp.json`;
- gate: all MCP tools pass against an injected proxy and a running local proxy.

### Phase 3 — Skill/plugin/harness adapters

- scaffold/validate plugin manifest;
- initialize and write the skill plus focused references;
- add Codex, Claude Code, OpenCode, and Pi onboarding examples;
- gate: skill and plugin validators pass, and a fresh agent can follow the setup without undocumented steps.

### Phase 4 — Final hardening

- run full CI locally;
- run Postman and MCP end-to-end checks;
- review privacy defaults and secret redaction;
- document supported protocol subsets and known limitations honestly;
- gate: every acceptance criterion below has direct evidence.

## 14. Acceptance criteria

- A client can point an OpenAI-compatible base URL at the proxy and successfully receive non-streaming and streaming completions from a selected mock/provider model.
- An Anthropic Messages client receives valid non-streaming and streaming responses through the proxy.
- Required capabilities always filter models before cost/quality scoring.
- The same explicit session remains on the selected model until affinity expires or the model becomes ineligible/unhealthy.
- Route explanations show deterministic component scores and exclusions without secrets or raw content.
- Configured transient failures fall back only before output begins.
- Feedback affects stored task/model priors through a simple, documented deterministic update; it does not trigger opaque training.
- No raw prompts/responses are stored by default.
- MCP tools call the proxy rather than reimplementing router logic.
- The Codex skill is concise, validated, and packaged with the MCP server in a valid plugin.
- Codex, Claude Code, OpenCode, and Pi have concrete setup examples using the proxy or MCP where supported.
- The Postman collection covers health, models, dry-run route, all three compatibility endpoints, explanation, feedback, and stats.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm smoke`, plugin validation, and skill validation all pass.

## 15. Implementation constraints for the executor

- Implement Phase 1 completely before starting MCP or skill work.
- Keep routing logic in `packages/router-core`; neither HTTP routes nor MCP tools may duplicate it.
- Preserve provider payloads and streaming semantics; avoid lossy normalization.
- Do not add real API keys, provider credentials, raw prompts, or user-specific absolute paths.
- Do not use `rm -rf`.
- Use `apply_patch` for authored file changes.
- Preserve unrelated user files and inspect the worktree before every broad edit.
- If dependency installation is blocked by network policy, request escalation rather than replacing the chosen architecture with weaker local substitutes.
- Stop and report only for a genuinely material ambiguity; otherwise use the defaults in this plan.

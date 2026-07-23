# Intelligent Model Router

A cross-harness skill and local MCP that act like an auto-model mode. It uses the prompt, a bounded conversation summary, and privacy-safe repository metadata to rank models exposed by the signed-in Codex, OpenCode, or Claude Code CLI. It selects an exact model and reasoning effort, delegates through that same harness and subscription, persists task affinity, and retains the current host model as fallback.

The plugin owns the workflow. Native Codex, OpenCode, and Claude Code routing needs no separate provider key, YAML, or proxy. The separate self-hosted gateway remains available for Pi and cross-provider API compatibility.

## Why this exists

Coding work is a trajectory: tools, repository context, failures, follow-up turns, and task affinity matter. A static three-model list cannot represent what a signed-in Codex installation can actually run. The auto router reads the live catalog, filters hard requirements, scores task fit deterministically, and keeps the selected candidate for the task.

## Quick start

Install the package (or build this checkout), then configure every detected native harness:

```bash
npm install -g ./model-router-0.1.0.tgz
model-router setup --harness all
model-router doctor --harness all
```

During local development, run `pnpm build` and `node dist/cli/index.js setup --harness all`. Restart Codex, OpenCode, or Claude Code after setup, then ask:

```text
Use $intelligent-model-router to choose the best live model for this task, execute the bounded work, and verify it.
```

`setup` registers the bundled MCP and portable skill. It does not change the selected model, provider, or authentication. OpenCode and Claude Code continue using their existing OAuth/subscription credentials. The optional legacy proxy variables are not required for `route_harness_task` or `delegate_harness_task`.

By default, each MCP launch trusts the harness's active working directory. Set `MODEL_ROUTER_WORKSPACE_ROOT` only when the MCP process must start elsewhere and you deliberately want to pin a broader or different trusted root.

Codex does not currently expose an authoritative current-model query to MCP. The visible model label must therefore be present in task context (for example, `5.6 Sol Medium`) so the router can reserve it as fallback. If the host does not provide that label, include it in the request once; an absent or ambiguous label safely disables auto-routing instead of risking recursive selection of the host model.

When connected, the skill calls `route_harness_task`. The server discovers through `codex debug models`, `opencode models --verbose`, or the signed-in Claude Code model aliases allowed by settings. It derives task features from bounded context and repository metadata and returns the winner plus effort. Winners run through guarded `codex exec`, `opencode run`, or `claude --print` children. Existing Codex-only `auto_route` and `delegate_codex_task` tools remain during migration.

Claude Code does not expose a machine-readable live model picker. The native adapter therefore uses its documented rolling aliases (`opus`, `sonnet`, and `haiku`) and honors `availableModels` from user settings when present. Execution revalidates the alias through Claude Code itself; unavailable account entitlements fail safely back to the current host model.

## Harness status

| Priority | Harness | Native catalog | Native execution | Authentication | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | Codex app | Codex CLI | `codex exec` | Existing ChatGPT/Codex sign-in | Ready |
| 2 | Codex CLI | Codex CLI | `codex exec` | Existing ChatGPT/Codex sign-in | Ready |
| 3 | Claude Code CLI | Signed-in aliases and `availableModels` | `claude --print` | Existing Claude Code sign-in | Ready; live invocation still requires available usage |
| 4 | OpenCode CLI | OpenCode CLI | `opencode run` | Existing OpenCode OAuth/subscription | Ready |
| 5 | Pi CLI | Compatibility gateway | OpenAI-compatible | Provider/gateway credentials | Deferred; native adapter planned later |

OpenCode Desktop is not a target surface; OpenCode CLI is.

Your manually selected model—Sol Medium, for example—does not limit which live model can win. It orchestrates the skill and becomes the fallback when no eligible candidate remains or delegation fails.

## Hybrid routing

The normal product path is:

```text
bounded task context + repository metadata
                |
                v
portable skill -> route_harness_task -> signed-in harness models + exposed agents
                |                                      |
                +-> Codex/OpenCode/Claude child        +-> native-agent winner
                |
                +-> current model fallback
```

Required tools, vision, search, editing, policy, and context size remain hard filters. The
Balanced diagnostic profile is provisionally
`0.38 taskFit + 0.32 qualityHeuristic + 0.10 speed + 0.20 economy`. Selection is stricter than
that explanatory score: among routes whose cautious, non-calibrated estimate of verified success
clears the task-risk floor, the router chooses the lowest comparable expected completed-task cost.
The current model stays reserved as a genuine cold-start and safety fallback.

Completed-task cost can include observed attempts, retries, escalation, cache-write/switch cost,
routing overhead, and objective verification. Each component reports whether it is observed,
estimated, or unknown. The router never converts tokens to dollars without trusted pricing
provenance and never compares different cost units. See
[Routing math and safety](docs/routing-math.md) for the equations, evidence bounds, cold-start
behavior, and verify-then-escalate limits.

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

The primary tools are `route_harness_task`, `delegate_harness_task`, `explain_harness_route`, and `submit_harness_feedback`. The Codex-only pair and six legacy gateway tools remain for backward compatibility.

Routes contain a UUID, harness/session identity, selected candidate/effort, fallback, bounded feature summary, affinity state, and outcome. Raw prompts and conversations are not persisted. Delegation revalidates the catalog and route, prevents recursion, bounds context/output, contains process trees, locks writers, and reports whether a failed write left the workspace unsafe for automatic fallback.

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

Native delegation defaults to 120 seconds for small or mechanical work and 300 seconds for repository-scale read-only review, debugging, and general tasks; callers may set an explicit timeout up to 600 seconds. Configured timeouts, network failures, rate limits, overloads, and upstream 5xx responses can fall back to the next candidate only before any response byte is emitted. Feedback is an explicit, inspectable prior; there is no opaque training in v0.1.

### Privacy and security

SQLite stores route features, approximate token counts, scores, aliases, latency, status, cost estimates, HMAC-hashed session IDs, provider attempts, and explicit feedback. Raw content capture is disabled by default and only available through bounded, opt-in APIs; unhashed sessions remain rejected. Logs redact authorization, API key, cookie, credential, token, password, and secret-shaped fields.

Task-run records extend this telemetry with process/verification state and safe receipts. Source, raw content, and embeddings remain opt-in and bounded by privacy settings (`storeSource`, `storeEmbeddings`, and content byte/retention caps); no runtime capture occurs unless explicitly enabled.

### CLI

```text
model-router serve [--config path]
model-router doctor [--config path] [--probe]
model-router route --task "..." [--profile balanced] [--protocol openai-chat] [--session id] [--model alias] [--tools] [--json] [--vision] [--streaming] [--minimum-context tokens]
model-router explain <route-id>
model-router stats [--since ISO_TIMESTAMP] [--model alias] [--task type]
model-router feedback <route-id> --outcome success [--score 1] [--tag accepted]
model-router config init [path]
model-router setup --harness codex|opencode|claude-code|all [--force]
model-router doctor --harness codex|opencode|claude-code|all
model-router route-native --harness codex|opencode|claude-code --objective "..." [--current-model "..."]
model-router explain-native <route-id>
```

### Supported v0.1 proxy subset

Chat Completions and Anthropic Messages preserve pass-through JSON bodies, tool definitions/calls, usage payloads, provider request IDs, and SSE bytes. Responses supports text/array inputs, tools, structured-output requirements, usage, and SSE pass-through. Provider-specific bidirectional WebSockets, uploaded file lifecycle APIs, background Responses jobs, hosted tools, and cross-protocol translation are not implemented. A model must advertise the incoming protocol; the router does not translate protocols.

Additional limitations: health uses persisted recent-attempt windows and circuit cooldowns; retries do not resume partial streams; cost data is config-supplied; and the Postman collection checks non-streaming protocol calls while `pnpm smoke` covers SSE.

## Architecture

```text
portable skill -> route_harness_task -> Codex/OpenCode catalog or Claude aliases
     |                     |
     |                     +-> delegate_harness_task
     |
     +-> if unavailable: current Codex model fallback

legacy self-hosting -> configured providers + SQLite telemetry
```

## Verification

```bash
pnpm run verify
```

All integration checks use local mock providers and placeholder credentials.

Supply-chain checks run locally in CI: `pnpm audit --prod --audit-level=high`, the checked-in moderate-advisory policy, and `pnpm licenses list --prod --json` against the production license policy. The Postman smoke check is static as well as runtime: every request must use `{{baseUrl}}/explicit-path` or an explicit loopback URL, and collection scripts cannot make dynamic outbound requests.

Licensed under MIT.

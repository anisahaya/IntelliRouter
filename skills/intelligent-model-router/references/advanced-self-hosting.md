# Advanced self-hosting

The external compatibility proxy supplies the broad model catalog. When its MCP tools are connected, the skill compares configured models across providers and delegates through the winner. Without it, the skill can route only among models or agents the host exposes natively.

Use this setup for cross-provider selection, compatibility endpoints, deterministic configured scoring, fallback, or local SQLite telemetry. YAML remains an advanced administrator concern rather than part of each routing request.

## Start the backend

Requirements: Node.js 22+, pnpm, a router YAML file, and credentials for the providers configured in that file.

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

Keep populated configuration and environment files out of source control. Binding outside loopback requires an authentication token configuration.

Harness examples are available for [Codex](../../../examples/codex.config.toml), [Claude Code](../../../examples/claude-code.md), [OpenCode](../../../examples/opencode.json), and [Pi](../../../examples/pi.md).

## MCP model catalog

Build the project before launching `.mcp.json`, which points to `dist/mcp-server/index.js`. Set `MODEL_ROUTER_BASE_URL` and, when configured, `MODEL_ROUTER_AUTH_TOKEN` in the MCP server environment. These tools are available only when that server is connected:

- `route_task` asks the external configured router for a dry-run decision;
- `delegate_task` sends one bounded prompt through the external proxy;
- `explain_route`, `router_stats`, `submit_route_feedback`, and `list_router_models` inspect or update external backend state.

Call `list_router_models` first. Call `route_task` for every represented protocol with identical requirements, pass those results to `scripts/select-catalog-route.mjs`, and send its winning logical model and exact protocol to `delegate_task`. Do not rely on dry-run affinity alone.

`delegate_task` must receive an explicit bounded prompt and `maxOutputTokens`. Send only required context and never credentials or unrelated source. If the backend is unavailable, continue with host-native fallback routing.

## Compatibility controls

Compatibility requests accept `model: "auto"` or `model: "router/<profile>"`. They may also use `x-router-model`, `x-router-session`, `x-router-profile`, and `x-router-debug`. Use an opaque task or conversation identifier for session affinity; never derive it from prompt text.

Every compatibility response reports request, route, model, profile, and fallback metadata in `x-router-*` headers. Call `explain_route` for a returned route ID when the fallback chain needs inspection. Submit feedback only after an observable outcome.

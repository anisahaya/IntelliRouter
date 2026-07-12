# Harness setup

Build and start the proxy in terminal A before configuring a harness. Generate the token once, print/copy it, and keep that exact value for terminal B; do not regenerate it per process.

```bash
pnpm install
pnpm build
export MODEL_ROUTER_CONFIG=/absolute/path/to/router.config.yaml
export MODEL_ROUTER_AUTH_TOKEN="$(openssl rand -hex 32)"
printf 'Copy this token into terminal B: %s\n' "$MODEL_ROUTER_AUTH_TOKEN"
export MODEL_ROUTER_BASE_URL=http://127.0.0.1:8856
export PROVIDER_A_API_KEY=replace-with-provider-key
export PROVIDER_B_API_KEY=replace-with-provider-key
node dist/cli/index.js serve
```

The final command stays in the foreground. Leave terminal A running. In terminal B, export the same printed token (not a new token), export the base URL, and start Codex:

```bash
export MODEL_ROUTER_AUTH_TOKEN='<exact token printed by terminal A>'
export MODEL_ROUTER_BASE_URL=http://127.0.0.1:8856
codex
```

Copy `examples/router.config.example.yaml`, configure logical models, and keep every credential in its named environment variable. Do not commit the populated config or `.env` file.

- Codex: merge `examples/codex.config.toml` into user-level `~/.codex/config.toml`. Provider settings are intentionally user-level, not project-level.
- Claude Code: follow `examples/claude-code.md`.
- OpenCode: copy the provider from `examples/opencode.json` into the project or user config.
- Pi: follow `examples/pi.md` and add the shown provider to `~/.pi/agent/models.json`.

For Codex tool access during local development, add this to user-level `~/.codex/config.toml`, replacing the executable with the absolute repository path:

```toml
[mcp_servers.model_router]
command = "node"
args = ["/absolute/path/to/model-router/dist/mcp-server/index.js"]
env_vars = ["MODEL_ROUTER_BASE_URL", "MODEL_ROUTER_AUTH_TOKEN"]
required = true
```

Start a new Codex task after changing MCP or skill configuration. Verify the six tools under `/mcp`. `MODEL_ROUTER_BASE_URL` is the origin only (`http://127.0.0.1:8856`), without `/v1`.

To load the skill directly while developing without a marketplace, symlink `skills/intelligent-model-router` into `~/.agents/skills/intelligent-model-router`, then start a new Codex task. The repository is already a valid plugin bundle for marketplace packaging; it intentionally does not modify a personal marketplace during initial installation.

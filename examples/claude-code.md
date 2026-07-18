# Claude Code

Configure the native MCP and portable skill without changing Claude Code authentication or its selected model:

```bash
model-router setup --harness claude-code
model-router doctor --harness claude-code
```

Restart Claude Code, then ask:

```text
Use $intelligent-model-router to choose the best signed-in Claude Code model for this task, execute the bounded work, and verify it.
```

The router uses the documented `opus`, `sonnet`, and `haiku` aliases, filtered by `availableModels` in `~/.claude/settings.json` when configured. It executes the winner with exact `--model` and `--effort` flags through the existing Claude Code sign-in. No Anthropic API key or proxy is required.

For advanced cross-provider routing only, Claude Code can instead use the router's Anthropic-compatible Messages endpoint through gateway variables:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8856
export ANTHROPIC_AUTH_TOKEN="$MODEL_ROUTER_AUTH_TOKEN"
claude --model auto
```

The compatibility gateway forwards `/v1/messages` to an eligible configured Anthropic-protocol model and requires the separately configured proxy and provider credentials.

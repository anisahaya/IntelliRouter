# Claude Code

Claude Code can use the router's Anthropic-compatible Messages endpoint through its gateway variables:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8856
export ANTHROPIC_AUTH_TOKEN="$MODEL_ROUTER_AUTH_TOKEN"
claude --model auto
```

The router forwards `/v1/messages` to an eligible configured Anthropic-protocol model. Keep one Claude Code task on one explicit router session when the harness exposes a custom header; otherwise task-level selection still applies to each request.

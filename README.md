# Intelligent Model Router

Choose the best model available in your signed-in coding harness. The router uses a bounded task summary and privacy-safe repository metadata, then delegates to the selected model. Your current model remains the fallback.

Native routing works with existing Codex, Claude Code, and OpenCode sign-in. It needs no provider key, YAML, or proxy.

[npm package](https://www.npmjs.com/package/intellirouter) · [source](https://github.com/anisahaya/IntelliRouter) · [CI](https://github.com/anisahaya/IntelliRouter/actions/workflows/ci.yml) · [security policy](SECURITY.md)

## Quick start

```bash
npm install -g intellirouter
```

### Codex

```bash
intellirouter setup --harness codex
intellirouter doctor --harness codex
```

Restart Codex and ask:

```text
Use $intelligent-model-router to choose the best live model for this task, execute the bounded work, and verify it.
```

### Claude Code

```bash
intellirouter setup --harness claude-code
intellirouter doctor --harness claude-code
```

Restart Claude Code and use the same prompt. The router uses available signed-in Claude aliases; no Anthropic API key is required.

### OpenCode

```bash
intellirouter setup --harness opencode
intellirouter doctor --harness opencode
```

Restart OpenCode and use the same prompt. OpenCode Desktop is not a target surface; use OpenCode CLI.

`setup` registers the bundled MCP server and skill. It does not change your selected model, provider, or authentication.

## What it does

- Discovers models exposed by the active harness.
- Filters by required tools, vision, editing, policy, and context window.
- Selects deterministically, keeps task affinity, and falls back safely. See [Routing math and safety](docs/routing-math.md).
- Uses metadata only for repository signals: file and language counts, manifests, test presence, and aggregate Git changes. It does not read source code to select a model.

Codex needs the visible current-model label in task context to reserve it as the fallback. If it is unavailable or unclear, routing safely stops instead of selecting recursively.

## Advanced self-hosting

Use the optional compatibility proxy only for configured cross-provider routing, API compatibility, or local routing telemetry. See [Advanced self-hosting](skills/intelligent-model-router/references/advanced-self-hosting.md).

## Verification

```bash
pnpm run verify
```

Licensed under MIT.

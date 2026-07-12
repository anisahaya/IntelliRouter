# Routing controls

Use `model: "auto"` or `model: "router/balanced"` for normal routing. `router/economy` prioritizes cost and latency; `router/premium` prioritizes configured quality.

Compatibility requests accept:

- `x-router-model: <logical-id>` to pin a configured model;
- `x-router-session: <opaque-id>` to keep task-level affinity until expiry;
- `x-router-profile: economy|balanced|premium` to override the request profile;
- `x-router-debug: true` to request safe routing metadata where supported.

Every compatibility response returns `x-router-request-id`, `x-router-route-id`, `x-router-model`, `x-router-profile`, and `x-router-fallback-count`. A fallback occurs only for configured transient failures and only before response bytes are emitted.

Do not use affinity IDs derived from prompt text. Use an opaque task, thread, or conversation identifier that contains no secrets.

For an ambiguous bounded task, call `route_task` with:

```json
{
  "task": "Review only src/auth.ts and return prioritized correctness findings.",
  "profile": "balanced",
  "protocol": "openai-chat",
  "session": "opaque-task-id",
  "toolsRequired": false,
  "jsonRequired": false,
  "visionRequired": false
}
```

`route_task` requires `task` (1–32,000 characters). Optional fields are `profile` (`economy`, `balanced`, or `premium`; default `balanced`), `protocol` (`openai-chat`, `openai-responses`, or `anthropic-messages`; default `openai-chat`), `session` (up to 512 characters), and the `toolsRequired`, `jsonRequired`, and `visionRequired` booleans (all default `false`).

Then call `delegate_task` with an explicit bound:

```json
{
  "prompt": "Review only src/auth.ts. Return at most five findings with file/line, failure mechanism, and minimal fix. Do not edit files.",
  "profile": "balanced",
  "session": "opaque-task-id",
  "maxOutputTokens": 800
}
```

`delegate_task` requires `prompt` (1–32,000 characters). Optional fields are `profile`, `model` (a logical model ID; when both are present, `model` wins), `session`, and `maxOutputTokens` (integer 1–8,192; default 1,024).

Using the same session means the `route_task` dry run establishes affinity that `delegate_task` consumes. Delegation can choose a different model only when the affine model becomes unhealthy/ineligible or the delegation has different hard requirements.

The result contains the delegated text, selected model, request ID, route ID, fallback count, and usage. If `fallbackCount` is greater than zero, call `explain_route` with the returned route ID to inspect the stored fallback chain.

Call `submit_route_feedback` only after an observable result:

```json
{
  "routeId": "route-id-returned-by-delegate-task",
  "outcome": "success",
  "score": 1,
  "tags": ["tests-passed", "patch-accepted"]
}
```

`routeId` and `outcome` are required. Outcomes are `success`, `failure`, `corrected`, or `abandoned`. `score` is optional from 0 to 1. `tags` is optional, with at most 16 privacy-safe strings of up to 64 characters each.

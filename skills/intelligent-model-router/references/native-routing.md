# Native fallback routing

Use this path only when the configured model-router MCP catalog or `delegate_task` is unavailable, or when no configured model satisfies the task.

## Candidate discovery

Use only candidates visible in one of these places:

- native delegation or model-selection tools in the current tool registry;
- agents or models identified in the system context;
- agent handles or model choices the user explicitly supplied.

The current host model is the final fallback. An installed skill, provider mentioned in documentation, or model remembered from another environment is not evidence that a candidate is currently available.

## Local decision

First exclude candidates that cannot satisfy required tools, context, modality, structured output, or execution access. Compare the remaining candidates using only available evidence:

| Signal | Prefer |
| --- | --- |
| Task fit | specialization matching the bounded objective |
| Quality | demonstrated or host-described capability for the task |
| Latency | faster candidate when quality needs are met |
| Cost | lower-cost candidate when cost data is visible |

Do not fabricate scores or capabilities. When evidence is tied or sparse, keep the current host model.

When using `scripts/select-native-route.mjs`, pass only host-observed values. Missing quality, cost, or latency data receives a neutral internal default so absence is not treated as an advantage. The selector's numeric score is a deterministic comparison aid, not a claim about unobserved provider performance.

## Execution and affinity

Delegate one bounded objective with the minimum relevant context, a concrete deliverable, and acceptance checks. Reuse the same candidate for follow-ups in that task. Re-route only when requirements materially change or the candidate becomes unavailable, ineligible, or fails.

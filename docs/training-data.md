# Task-run training data

Task runs are additive records keyed by a domain-separated HMAC. A safe receipt exposes only route/run identifiers, process and verification state, disposition, label strength/value, fallback safety, partial-write state, latency, and attempt count. Provider/session identifiers, commands, paths, raw content, and external keys never appear in receipts.

Operational completion is not correctness. Explicit feedback is attested; independent checks are verified; identical held-out cases may be comparative. Failed verification and reverts override completion, while equal-strength conflicts are mixed/inconclusive. Imported evidence is scoped to its provenance and model pair and never becomes verified merely by import.

Prompt, response, source, and embeddings are disabled by default. Opt-in content is redacted, HMACed, truncated, and bounded (64 KiB/item, 128 KiB/run, 50 MiB total, seven-day retention). Embeddings require an injected local provider and finite Float32 values; no downloader or network path is provided.

Historical evaluation receives only a base snapshot and objective. Candidate execution uses argv arrays in a network-disabled sandbox; held-out checks run afterward. Target patches are scope/reference evidence, not candidate input. Invalid base/target or leakage cases produce no label. This infrastructure is not a learned router and does not claim nearest-neighbor suitability; RouteLLM (ICLR 2025) is an example of related research, not a result of this project.

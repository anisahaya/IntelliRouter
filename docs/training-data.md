# Task-run data and evaluation

This package records routing observations for offline analysis. It does not train a router, change
the deterministic scoring policy, generate embeddings, download datasets, or call a model.

## Record format

Migration 6 adds a canonical `task_runs` record for compatibility, native, imported, and evaluation
runs. Each run has:

- versioned HMAC task/workspace fingerprints, bounded derived features, and repository tags;
- selected model, reasoning effort, harness, profile, bounded context, and cache status;
- attempts with retry/fallback state, token/cache counts, latency, and cost;
- an `actual`, `estimated`, or `unknown` basis for token and cost measurements;
- separate process, verification, disposition, and evidence-label fields;
- correction, abandonment, revert, feedback, and verification evidence;
- partial-write and safe-fallback state.

The legacy compatibility tables and native `harness-routes.jsonl` remain intact. Compatibility
records dual-write into the new schema. Native JSONL is still the route-record authority and is
imported idempotently into the shared SQLite database by full-file hash. This is additive and
rollback-safe.

`completed` means the child process returned usable output. It never means the task was correct.
Independent verification is stored separately as `not-run`, `passed`, `failed`, or `inconclusive`.

## Evidence strength

Evidence is reduced by strength, not by last write:

| Strength | Meaning |
| --- | --- |
| `none` | No outcome evidence. |
| `operational` | Launch, exit, timeout, or usable-output evidence only. Never a correctness label. |
| `attested` | Explicit feedback, human review, or source-scoped imported preference. |
| `verified` | Independent acceptance, public, or held-out checks applied after the run. |
| `comparative` | Multiple candidates evaluated under the same hidden case and resource bounds. The schema supports this future evidence; the historical runner in this PR evaluates one candidate at a time. |

Opposing evidence at the highest strength becomes `mixed`/`inconclusive` while retaining that
strength. Failed held-out checks are `incorrect`/`verified`; process completion cannot override
them. Abandonment is a negative label only when its reason is correctness or instruction following.

## Privacy boundary

Safe route receipts expose only versioned fingerprints, bounded derived features/tags, selection
metadata, aggregate measurements with their basis, process/verification labels, and fallback
safety. Receipts exclude sessions, provider request IDs, child sessions, paths, commands, raw
outputs, content, dataset external IDs, and source text.

Prompt, response, source, and embedding persistence is disabled by default. Automatic runtime
capture is not implemented. The explicit task-run content API requires an enabled policy, redacts
before persistence, HMACs the original value, truncates on UTF-8 boundaries, enforces item/run/store
byte limits transactionally, and expires content after the configured retention window. SQLite
files remain mode `0600` inside a `0700` directory. Per-call options may disable capture or lower
the configured limits; they cannot enable a disabled kind or raise its byte or retention limits.

Embeddings are also sensitive and disabled by default. Callers may explicitly supply locally
generated values; stored values must declare `locallyGenerated: true`, match their bounded dimension
count, contain finite Float32-compatible values, and state whether they are normalized.
The repository ships no embedding model, downloader, subprocess launcher, or network provider.

## Public seed imports

The internal `@model-router/evaluation` workspace package accepts only caller-supplied local async iterables. A manifest must name
the provenance, revision, license, model pair, and exact label semantics. Manifest provenance is
authoritative; individual rows cannot override it. External IDs are HMACed with the manifest
provenance/revision/model pair, raw inputs are used only to derive an HMAC task fingerprint, and all
imported labels are capped at `attested`.
Imports are bounded to 10,000 records, 32,000 UTF-8 bytes per input, and 16 MiB of input text per
transaction.

[RouteLLM](https://github.com/lm-sys/RouteLLM) is one possible adapter target. Its preferences or
calibration results are source/model-pair evidence, not permanent truth and not assumed to transfer
to local traffic. This repository does not download RouteLLM or any other dataset.

## Historical-commit evaluation

The historical runner is an injected controller interface:

1. Validate full base/target SHAs, a clean source repository, relative allowed paths, argv-only
   checks, timeouts, output bounds, and a network-disabled sandbox contract.
2. Materialize a base snapshot without `.git` history, install held-out tests, and require at least
   one failure.
3. Materialize the target snapshot separately, install the same held-out tests, and require all
   checks to pass. Otherwise the case is invalid and produces no correctness label.
4. Materialize a fresh base snapshot for the candidate. The candidate receives only its working
   directory, objective, allowed paths, and resource bounds.
5. After candidate execution ends, install the hidden tests and run them through argv arrays.

The candidate never receives the target SHA, reference patch, commit message, hidden test paths, or
hidden commands. The target patch is reference/scope evidence, not the only acceptable solution.
Sandbox implementations must enforce history removal and network isolation; this PR deliberately
does not ship a live harness or provider executor. Controllers can pass the derived result to
`recordHistoricalEvaluation`; that boundary accepts only safe fingerprints, explicitly supplied
model metadata, and verification metadata—not objectives, patches, commands, outputs, or paths.

## Follow-up work

The schema is indexed by task fingerprint, model/harness, evidence, time, and embedding metadata so
later work can evaluate nearest-neighbor success estimates. A future PR must define leakage-safe
train/evaluation splits, calibration, minimum evidence strength, drift handling, and abstention
before any learned or retrieval-based signal can affect routing.

# Routing math and safety

IntelliRouter first removes candidates that cannot satisfy hard availability, capability, context,
policy, or current-model-reservation requirements. Cheapness never restores an excluded route.

## Diagnostic profile

The provisional Balanced diagnostic profile is:

```text
Diagnostic(c) =
  0.38 taskFit(c) +
  0.32 qualityHeuristic(c) +
  0.10 speed(c) +
  0.20 economy(c)
```

The weights total one. `qualityHeuristic` is catalog metadata, not a calibrated success
probability. When comparable completed-task costs exist, economy is inverse min-max normalized;
equal costs receive `0.5`. Otherwise catalog economy remains an explicitly labeled cold-start
fallback signal.

## Constrained selection

The normal rule is:

```text
choose arg min ExpectedCompletedTaskCost(c)
subject to ConservativeVerifiedSuccess(c) >= QualityThreshold(taskRisk)
```

The provisional low/medium/high thresholds are `0.60`, `0.75`, and `0.90`. Exact cost ties prefer
the stronger conservative success estimate, then the diagnostic score, then candidate ID.
Affinity can be reused only if the same route still clears the hard filters and quality floor.
If any quality-qualified candidate lacks the same comparable cost basis, the router abstains to the
current model instead of favoring the better-instrumented candidate.

Verified success uses at most 20 same-model neighbors with similarity at least `0.50`:

```text
similarity =
  0.30 taskType +
  0.15 scope +
  0.20 complexityProximity +
  0.15 riskProximity +
  0.10 capabilityJaccard +
  0.10 repoTagJaccard
```

Weights are `similarity²`. Repeated `(taskFingerprint, model)` evidence keeps the newest terminal
verified result. The estimator uses a Beta(2,2) policy prior and a deterministic sparse-evidence
margin. It reports its prior, neighbor count, effective weight, similarity range, and evidence
strength with `calibrated: false`. Operational, attested, mixed, unknown, and imported records do
not count. A prior-only estimate cannot clear the quality floor.

If no candidate qualifies, the current host model is the deterministic fallback. Harnesses without
a resolvable current model use the highest diagnostic candidate as a clearly labeled cold-start
fallback; this is not a probability-qualified winner.

## Expected completed-task cost

For comparable evidence:

```text
Ccomplete =
  Cfirst-attempt +
  Cretries +
  Cescalations +
  Ccache-switch +
  Crouting +
  Cverification
```

Observed provider cost is preferred. Estimated USD is accepted only with pricing provenance.
Otherwise actual/estimated token equivalents may be compared as tokens. USD and token units are
never mixed. Input/output tokens are charged once. When a session has a known cache-resident model,
historical cache-write tokens can supply a separate switching penalty for a different model; they
are not double-counted inside the attempt itself. Billed USD is never charged a second time.
Unknown cache, routing, or verification cost stays visibly unknown.

## Verify then escalate

An isolated cheap attempt can precede a frontier route only when objective verification exists:

```text
Cplan = Ccheap + Cverify + (1 - pCheap) * (Cfrontier + Cswitch + Crouting)
```

The plan must be cheaper than direct frontier execution, the frontier must clear the quality floor,
cost units must be comparable, and fallback must be safe. Workspace writes require a disposable
isolated workspace whose verified result is applied once. A partial write or
`safeToFallback: false` terminates escalation; IntelliRouter never silently starts a second writer.

## Limitations and evidence

- The Beta prior, similarity weights, thresholds, and sparse-evidence margin are provisional policy
  constants, not trained or calibrated probabilities.
- No model prices or training outcomes are bundled. Cost quality depends on observed receipts or
  caller-supplied pricing provenance.
- This change provides deterministic unit and integration scenarios. It does not claim a live-model
  benchmark or production calibration study.

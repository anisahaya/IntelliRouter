import type {
  AutoCandidate,
  AutoObservedMetrics,
  AutoRouteDecision,
  AutoRouteProfile,
  AutoTaskProfile,
  HarnessId,
  NativePolicyDecision,
  NativeRouteOverride,
  NativeRoutingConfig,
  NativeRoutingPolicy,
  ReasoningEffort,
} from "@model-router/contracts";
import {
  autoRouteProfileSchema,
  nativeRoutingConfigSchema,
  nativeRoutingPolicySchema,
} from "@model-router/contracts";
import { scoreAutoCandidates } from "@model-router/router-core";

const effortOrder: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

export interface NativePolicyUsage {
  routes: number;
  attempts: number;
  candidateRoutes: Record<string, number>;
}

export interface ResolvedNativePolicy {
  decision: NativePolicyDecision;
  aliases: Readonly<Record<string, string>>;
}

export function resolveNativePolicy(input: {
  config?: NativeRoutingConfig;
  repository: string;
  requestedProfile?: string;
}): ResolvedNativePolicy {
  const config = nativeRoutingConfigSchema.parse(input.config ?? {});
  const repositoryProfile = config.repositoryProfiles[input.repository];
  const profile = input.requestedProfile ?? repositoryProfile ?? config.defaultProfile;
  const source: NativePolicyDecision["source"] = input.requestedProfile
    ? "explicit"
    : repositoryProfile
      ? "repository"
      : config.defaultProfile !== "balanced" || config.profiles[config.defaultProfile]
        ? "default"
        : "builtin";
  const builtin = autoRouteProfileSchema.safeParse(profile);
  const configured = config.profiles[profile];
  if (!builtin.success && !configured)
    throw new Error(`Unknown native routing profile: ${profile}`);
  const baseProfile: AutoRouteProfile = configured?.extends ?? builtin.data ?? "balanced";
  const effective = nativeRoutingPolicySchema.parse(configured?.policy ?? {});
  return {
    aliases: effective.aliases,
    decision: {
      profile,
      baseProfile,
      source,
      effective,
      applied: [
        {
          code: "profile-selected",
          message: `${source} native profile ${profile} extends ${baseProfile}`,
        },
      ],
      ignored: [],
    },
  };
}

export function applyNativeMetadata(
  candidates: AutoCandidate[],
  resolved: ResolvedNativePolicy,
): {
  candidates: AutoCandidate[];
  applied: NativePolicyDecision["applied"];
  ignored: NativePolicyDecision["ignored"];
} {
  const applied: NativePolicyDecision["applied"] = [];
  const ignored: NativePolicyDecision["ignored"] = [];
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  for (const selector of Object.keys(resolved.decision.effective.overrides).sort()) {
    const id = resolveSelector(selector, resolved.aliases);
    const candidate = byId.get(id);
    if (!candidate) {
      ignored.push({
        code: "metadata-override-unmatched",
        message: "metadata override matched no live candidate",
      });
      continue;
    }
    const override = resolved.decision.effective.overrides[selector];
    if (!override) continue;
    const unsafe: string[] = [];
    const available = safeBoolean(candidate.available, override.available, "availability", unsafe);
    const capabilities = {
      tools: safeBoolean(
        candidate.capabilities.tools,
        override.capabilities?.tools,
        "tools",
        unsafe,
      ),
      vision: safeBoolean(
        candidate.capabilities.vision,
        override.capabilities?.vision,
        "vision",
        unsafe,
      ),
      search: safeBoolean(
        candidate.capabilities.search,
        override.capabilities?.search,
        "search",
        unsafe,
      ),
      edit: safeBoolean(candidate.capabilities.edit, override.capabilities?.edit, "edit", unsafe),
      maxContextTokens:
        override.capabilities?.maxContextTokens === undefined
          ? candidate.capabilities.maxContextTokens
          : Math.min(
              candidate.capabilities.maxContextTokens,
              override.capabilities.maxContextTokens,
            ),
    };
    if (
      override.capabilities?.maxContextTokens !== undefined &&
      override.capabilities.maxContextTokens > candidate.capabilities.maxContextTokens
    ) {
      unsafe.push("context window");
    }
    const supportedEfforts = override.supportedEfforts
      ? (candidate.supportedEfforts ?? []).filter((effort) =>
          override.supportedEfforts?.includes(effort),
        )
      : candidate.supportedEfforts;
    byId.set(id, {
      ...candidate,
      available,
      ...(override.quality === undefined ? {} : { quality: override.quality }),
      ...(override.speed === undefined ? {} : { speed: override.speed }),
      ...(override.economy === undefined ? {} : { economy: override.economy }),
      ...(override.strengths === undefined ? {} : { strengths: override.strengths }),
      ...(supportedEfforts === undefined
        ? {}
        : { supportedEfforts: [...new Set(supportedEfforts)] }),
      capabilities,
    });
    applied.push({
      code: "metadata-override-applied",
      message: "bounded candidate metadata override applied before safety filtering",
      candidateId: id,
    });
    if (unsafe.length > 0) {
      ignored.push({
        code: "metadata-override-unsafe",
        message: `metadata override cannot elevate live ${unsafe.join(", ")}`,
        candidateId: id,
      });
    }
  }
  return {
    candidates: candidates.map((candidate) => byId.get(candidate.id) ?? candidate),
    applied,
    ignored,
  };
}

function safeBoolean(
  live: boolean,
  requested: boolean | undefined,
  name: string,
  unsafe: string[],
): boolean {
  if (requested === undefined) return live;
  if (!live && requested) {
    unsafe.push(name);
    return false;
  }
  return requested;
}

export function scoreWithNativePolicy(input: {
  candidates: AutoCandidate[];
  task: AutoTaskProfile;
  currentModel?: string;
  observations?: Readonly<Record<string, AutoObservedMetrics>>;
  harness?: HarnessId;
  resolved: ResolvedNativePolicy;
  metadataApplied?: NativePolicyDecision["applied"];
  metadataIgnored?: NativePolicyDecision["ignored"];
  override?: NativeRouteOverride;
  usage?: NativePolicyUsage;
}): {
  ranked: AutoRouteDecision["ranked"];
  excluded: AutoRouteDecision["excluded"];
  policy: NativePolicyDecision;
} {
  const policy = structuredClone(input.resolved.decision);
  policy.applied.push(...(input.metadataApplied ?? []));
  policy.ignored.push(...(input.metadataIgnored ?? []));
  const scored = scoreAutoCandidates(
    input.candidates,
    input.task,
    policy.baseProfile,
    input.currentModel,
    input.observations,
  );
  const excluded = [...scored.excluded];
  let ranked = [...scored.ranked];
  const effective = policy.effective;
  const aliases = input.resolved.aliases;
  const liveIds = new Set(input.candidates.map((candidate) => candidate.id));
  for (const [kind, selectors] of [
    ["allow", effective.candidates.allow],
    ["deny", effective.candidates.deny],
    ["prefer", Object.keys(effective.candidates.prefer)],
    ["penalize", Object.keys(effective.candidates.penalize)],
    ["effort", Object.keys(effective.effort.candidates)],
    ["candidate-budget", Object.keys(effective.budget?.candidateMaxRoutes ?? {})],
  ] as const) {
    for (const selector of selectors) {
      if (!liveIds.has(resolveSelector(selector, aliases))) {
        policy.ignored.push({
          code: `${kind}-selector-unmatched`,
          message: `${kind} policy selector matched no live candidate`,
        });
      }
    }
  }

  const harnessDenied =
    input.harness &&
    (effective.harnesses.deny.includes(input.harness) ||
      (effective.harnesses.allow.length > 0 && !effective.harnesses.allow.includes(input.harness)));
  if (harnessDenied) {
    for (const candidate of ranked) {
      excluded.push({ id: candidate.id, reasons: ["denied by native harness policy"] });
    }
    ranked = [];
    policy.applied.push({
      code: "harness-denied",
      message: `native policy denied ${input.harness}`,
    });
  }

  const allow = new Set(effective.candidates.allow.map((value) => resolveSelector(value, aliases)));
  const deny = new Set(effective.candidates.deny.map((value) => resolveSelector(value, aliases)));
  if (allow.size > 0 || deny.size > 0) {
    ranked = ranked.filter((candidate) => {
      const denied = deny.has(candidate.id);
      const notAllowed = allow.size > 0 && !allow.has(candidate.id);
      if (!denied && !notAllowed) return true;
      excluded.push({
        id: candidate.id,
        reasons: [
          denied ? "denied by native candidate policy" : "not allowed by native candidate policy",
        ],
      });
      policy.applied.push({
        code: denied ? "candidate-denied" : "candidate-not-allowed",
        message: denied ? "candidate deny rule applied" : "candidate omitted by allow rule",
        candidateId: candidate.id,
      });
      return false;
    });
  }

  ranked = applyBudget(ranked, excluded, policy, input.usage, aliases);

  const candidateById = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  ranked = ranked.flatMap((candidate) => {
    const metadata = candidateById.get(candidate.id);
    if (!metadata || candidate.kind === "user-agent") return [candidate];
    const effort = resolveEffort(
      candidate.id,
      candidate.reasoningEffort,
      metadata.supportedEfforts ?? [],
      {
        policy: effective,
        aliases,
        requested: input.override?.reasoningEffort,
        applied: policy.applied,
        ignored: policy.ignored,
      },
    );
    if (!effort) {
      excluded.push({
        id: candidate.id,
        reasons: ["native effort cap leaves no supported effort"],
      });
      policy.applied.push({
        code: "effort-cap-excluded",
        message: "candidate has no supported effort at or below the configured cap",
        candidateId: candidate.id,
      });
      return [];
    }
    return [{ ...candidate, reasoningEffort: effort }];
  });

  ranked = ranked.map((candidate) => {
    const preferred = selectorAdjustment(effective.candidates.prefer, candidate.id, aliases);
    const penalized = selectorAdjustment(effective.candidates.penalize, candidate.id, aliases);
    const adjustment = clampAdjustment(preferred - penalized);
    if (preferred > 0) {
      policy.applied.push({
        code: "candidate-preferred",
        message: `candidate preference added ${preferred.toFixed(3)} to its score`,
        candidateId: candidate.id,
      });
    }
    if (penalized > 0) {
      policy.applied.push({
        code: "candidate-penalized",
        message: `candidate penalty subtracted ${penalized.toFixed(3)} from its score`,
        candidateId: candidate.id,
      });
    }
    return adjustment === 0
      ? candidate
      : {
          ...candidate,
          scores: {
            ...candidate.scores,
            policyAdjustment: adjustment,
            total: clampScore(candidate.scores.total + adjustment),
          },
        };
  });
  ranked.sort(
    (left, right) => right.scores.total - left.scores.total || left.id.localeCompare(right.id),
  );

  const requestedCandidate = input.override?.candidate
    ? resolveSelector(input.override.candidate, aliases)
    : undefined;
  if (requestedCandidate) {
    const index = ranked.findIndex((candidate) => candidate.id === requestedCandidate);
    if (index >= 0) {
      const [selected] = ranked.splice(index, 1);
      if (selected) ranked.unshift(selected);
      policy.applied.push({
        code: "request-candidate-selected",
        message: "eligible explicit candidate override applied",
        candidateId: requestedCandidate,
      });
    } else {
      const hard = scored.excluded.some((candidate) => candidate.id === requestedCandidate);
      const denied = excluded.some(
        (candidate) =>
          candidate.id === requestedCandidate &&
          candidate.reasons.some(
            (reason) => reason.includes("policy") || reason.includes("budget"),
          ),
      );
      policy.ignored.push({
        code: hard
          ? "request-candidate-unsafe"
          : denied
            ? "request-candidate-denied"
            : "request-candidate-unmatched",
        message: hard
          ? "explicit candidate override cannot bypass availability, capability, context, effort, or fallback safety"
          : denied
            ? "explicit candidate override cannot bypass deny or budget policy"
            : "explicit candidate override matched no eligible live candidate",
        candidateId: requestedCandidate,
      });
    }
  }

  excluded.sort((left, right) => left.id.localeCompare(right.id));
  return { ranked, excluded, policy };
}

function applyBudget(
  ranked: AutoRouteDecision["ranked"],
  excluded: AutoRouteDecision["excluded"],
  policy: NativePolicyDecision,
  usage: NativePolicyUsage | undefined,
  aliases: Readonly<Record<string, string>>,
): AutoRouteDecision["ranked"] {
  const budget = policy.effective.budget;
  if (!budget) return ranked;
  if (!usage) {
    policy.ignored.push({
      code: "budget-unmeasurable",
      message: "native usage budget was ignored because local usage state was unavailable",
    });
    return ranked;
  }
  const exhausted =
    (budget.maxRoutes !== undefined && usage.routes >= budget.maxRoutes) ||
    (budget.maxAttempts !== undefined && usage.attempts >= budget.maxAttempts);
  if (exhausted) {
    for (const candidate of ranked) {
      excluded.push({ id: candidate.id, reasons: ["native usage budget exhausted"] });
    }
    policy.applied.push({
      code: "budget-exhausted",
      message: "locally measured native route or attempt budget is exhausted",
    });
    return [];
  }
  const candidateLimits = new Map(
    Object.entries(budget.candidateMaxRoutes).map(([selector, limit]) => [
      resolveSelector(selector, aliases),
      limit,
    ]),
  );
  return ranked.filter((candidate) => {
    const limit = candidateLimits.get(candidate.id);
    if (limit === undefined || (usage.candidateRoutes[candidate.id] ?? 0) < limit) return true;
    excluded.push({ id: candidate.id, reasons: ["native candidate usage budget exhausted"] });
    policy.applied.push({
      code: "candidate-budget-exhausted",
      message: "locally measured candidate route budget is exhausted",
      candidateId: candidate.id,
    });
    return false;
  });
}

function resolveEffort(
  candidateId: string,
  scoredEffort: ReasoningEffort | undefined,
  supported: ReasoningEffort[],
  input: {
    policy: NativeRoutingPolicy;
    aliases: Readonly<Record<string, string>>;
    requested?: ReasoningEffort;
    applied: NativePolicyDecision["applied"];
    ignored: NativePolicyDecision["ignored"];
  },
): ReasoningEffort | undefined {
  const candidatePolicy = Object.entries(input.policy.effort.candidates)
    .filter(([selector]) => resolveSelector(selector, input.aliases) === candidateId)
    .sort(([left], [right]) => left.localeCompare(right))
    .at(-1)?.[1];
  const cap = candidatePolicy?.cap ?? input.policy.effort.cap;
  const allowed = supported.filter(
    (effort) => !cap || effortOrder.indexOf(effort) <= effortOrder.indexOf(cap),
  );
  if (allowed.length === 0) return undefined;
  const configuredForce = candidatePolicy?.force ?? input.policy.effort.force;
  const requested = input.requested;
  for (const [source, effort] of [
    ["request", requested],
    ["policy", configuredForce],
  ] as const) {
    if (!effort) continue;
    if (allowed.includes(effort)) {
      input.applied.push({
        code: `${source}-effort-forced`,
        message: `${source} reasoning effort ${effort} applied within supported policy cap`,
        candidateId,
      });
      return effort;
    }
    input.ignored.push({
      code: `${source}-effort-unsafe`,
      message: `${source} reasoning effort was unsupported or above the configured cap`,
      candidateId,
    });
  }
  if (scoredEffort && allowed.includes(scoredEffort)) return scoredEffort;
  const target = effortOrder.indexOf(scoredEffort ?? "medium");
  return allowed.reduce((best, effort) => {
    const distance = Math.abs(effortOrder.indexOf(effort) - target);
    const bestDistance = Math.abs(effortOrder.indexOf(best) - target);
    return distance < bestDistance ||
      (distance === bestDistance && effortOrder.indexOf(effort) < effortOrder.indexOf(best))
      ? effort
      : best;
  }, allowed[0] as ReasoningEffort);
}

function selectorAdjustment(
  adjustments: Record<string, number>,
  candidateId: string,
  aliases: Readonly<Record<string, string>>,
): number {
  return Object.entries(adjustments).reduce(
    (total, [selector, value]) =>
      resolveSelector(selector, aliases) === candidateId ? total + value : total,
    0,
  );
}

export function resolveNativeCandidateId(
  value: string,
  aliases: Readonly<Record<string, string>>,
): string {
  let current = value;
  const seen = new Set<string>();
  while (aliases[current] && !seen.has(current)) {
    seen.add(current);
    current = aliases[current] as string;
  }
  return current;
}

const resolveSelector = resolveNativeCandidateId;

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(6))));
}

function clampAdjustment(value: number): number {
  return Math.max(-0.5, Math.min(0.5, Number(value.toFixed(6))));
}

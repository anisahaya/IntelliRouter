import { loadConfig } from "@model-router/config";
import type {
  AutoCandidate,
  AutoObservedMetrics,
  AutoRouteDecision,
  AutoRouteRequirements,
  HarnessId,
  NativeRouteOverride,
  NativeRoutingConfig,
  RegisteredAgent,
} from "@model-router/contracts";
import { buildAutoTaskProfile } from "@model-router/router-core";
import { type ClaudeDiscoveryOptions, discoverClaudeModels } from "./claude-cli.js";
import { type CodexDiscoveryOptions, discoverCodexModels } from "./codex-cli.js";
import { assertRootInvocation, sanitizeText } from "./context-security.js";
import {
  decodeNormalizedCandidateId,
  nativeHarnesses,
  normalizedCandidateId,
} from "./harness-candidate.js";

export { decodeNormalizedCandidateId, normalizedCandidateId } from "./harness-candidate.js";

import {
  applyNativeMetadata,
  resolveNativeCandidateId,
  resolveNativePolicy,
  scoreWithNativePolicy,
} from "./native-policy.js";
import {
  collectNativeProbeEvidence,
  type NativeProbeEvidence,
  type NativeProbeOptions,
} from "./native-probes.js";
import { discoverOpenCodeModels, type OpenCodeDiscoveryOptions } from "./opencode-cli.js";
import { collectRepoSignals, type RepoSignalOptions } from "./repo-signals.js";
import {
  affinityDecision,
  findAffinity,
  nativePolicyUsage,
  newRouteId,
  observedMetrics,
  persistDecision,
  type RouteStateOptions,
  routeIdentity,
} from "./route-state.js";
import { resolveTrustedWorkspace } from "./workspace-security.js";

export interface HarnessRouteInput {
  harness: HarnessId | "auto";
  harnesses?: HarnessId[];
  objective: string;
  conversationSummary?: string;
  workspaceRoot: string;
  registeredAgents?: RegisteredAgent[];
  profile?: string;
  override?: NativeRouteOverride;
  currentModel?: string;
  sessionId?: string;
  taskId?: string;
  forceReroute?: boolean;
  probe?: boolean;
  requirements: AutoRouteRequirements;
}

export interface HarnessRouterOptions {
  codex?: CodexDiscoveryOptions;
  opencode?: OpenCodeDiscoveryOptions;
  claude?: ClaudeDiscoveryOptions;
  repo?: RepoSignalOptions;
  state?: RouteStateOptions;
  probes?: NativeProbeOptions;
  env?: NodeJS.ProcessEnv;
  trustedRoot?: string;
  policyConfig?: NativeRoutingConfig;
  policyConfigPath?: string;
  persist?: (
    decision: AutoRouteDecision,
    identity: ReturnType<typeof routeIdentity>,
    options: RouteStateOptions,
  ) => Promise<void>;
}

export async function routeHarnessTask(
  input: HarnessRouteInput,
  options: HarnessRouterOptions = {},
): Promise<AutoRouteDecision> {
  if (input.harness === "auto" || input.harnesses?.length) {
    return routeAcrossHarnesses(input, options);
  }
  return routeSingleHarnessTask(input as HarnessRouteInput & { harness: HarnessId }, options);
}

async function routeSingleHarnessTask(
  input: HarnessRouteInput & { harness: HarnessId },
  options: HarnessRouterOptions = {},
): Promise<AutoRouteDecision> {
  const env = options.env ?? process.env;
  assertRootInvocation(env);
  const workspaceRoot = await resolveTrustedWorkspace(input.workspaceRoot, options.trustedRoot);
  const objective = sanitizeText(input.objective, 12_000, "objective");
  const conversation = sanitizeText(input.conversationSummary ?? "", 8_000, "conversation summary");
  const [repoSignals, harnessCandidates] = await Promise.all([
    collectRepoSignals(workspaceRoot, options.repo),
    discoverHarnessCandidates(input.harness, options, env),
  ]);
  const taskProfile = buildAutoTaskProfile({
    objective: objective.text,
    conversationSummary: conversation.text,
    repoSignals,
    requirements: input.requirements,
  });
  const policyConfig = await readPolicyConfig(options);
  const resolvedPolicy = resolveNativePolicy({
    config: policyConfig,
    repository: repoSignals.rootName,
    requestedProfile: input.profile,
  });
  const discoveredCandidates = [
    ...harnessCandidates,
    ...(input.registeredAgents ?? []).map(agentCandidate),
  ];
  const metadata = applyNativeMetadata(discoveredCandidates, resolvedPolicy);
  let candidates = metadata.candidates;
  const fallbackModel = resolveCurrentModel(
    input.currentModel
      ? resolveNativeCandidateId(input.currentModel, resolvedPolicy.aliases)
      : undefined,
    candidates.filter((candidate) => candidate.kind !== "user-agent"),
  );
  if (input.harness === "codex" && input.currentModel && !fallbackModel) {
    throw new Error("current model does not match the live Codex catalog");
  }
  const profile = resolvedPolicy.decision.profile;
  const stateOptions = { ...options.state, env };
  const [observations, usage] = await Promise.all([
    observedMetrics(
      input.harness,
      candidates.map((candidate) => candidate.id),
      stateOptions,
    ),
    resolvedPolicy.decision.effective.budget
      ? nativePolicyUsage(
          {
            harness: input.harness,
            profile,
            since: new Date(
              Date.now() - resolvedPolicy.decision.effective.budget.windowHours * 60 * 60 * 1_000,
            ).toISOString(),
          },
          stateOptions,
        )
      : undefined,
  ]);
  const preliminary = scoreWithNativePolicy({
    candidates,
    task: taskProfile,
    currentModel: fallbackModel,
    observations,
    harness: input.harness,
    resolved: resolvedPolicy,
    override: input.override,
    usage,
  });
  const catalogObservedAt = new Date().toISOString();
  const probeOptions = {
    ...options.probes,
    enabled: input.probe === true && options.probes?.enabled !== false,
    path: options.probes?.path ?? probeStatePath(options.state, env),
  };
  const probeEvidence = await collectNativeProbeEvidence(
    input.harness,
    candidates.filter(
      (candidate) =>
        candidate.kind !== "user-agent" &&
        preliminary.ranked.slice(0, 2).some((ranked) => ranked.id === candidate.id),
    ),
    catalogObservedAt,
    env,
    probeOptions,
  );
  candidates = candidates.map((candidate) =>
    probeEvidence[candidate.id]?.outcome && probeEvidence[candidate.id]?.outcome !== "success"
      ? { ...candidate, available: false }
      : candidate,
  );
  const scored = scoreWithNativePolicy({
    candidates,
    task: taskProfile,
    currentModel: fallbackModel,
    observations,
    harness: input.harness,
    resolved: resolvedPolicy,
    metadataApplied: metadata.applied,
    metadataIgnored: metadata.ignored,
    override: input.override,
    usage,
  });
  const ranked = scored.ranked;
  const excluded = scored.excluded.map((candidate) => {
    const failure = probeEvidence[candidate.id]?.outcome;
    return failure && failure !== "success"
      ? { ...candidate, reasons: [...candidate.reasons, `native probe: ${failure}`] }
      : candidate;
  });
  const confidenceRanked = ranked[0]
    ? [
        ranked[0],
        ...scoreWithNativePolicy({
          candidates,
          task: taskProfile,
          observations,
          harness: input.harness,
          resolved: resolvedPolicy,
          override: input.override,
          usage,
        }).ranked.filter((candidate) => candidate.id !== ranked[0]?.id),
      ]
    : ranked;
  const identity = routeIdentity({
    harness: input.harness,
    sessionId: input.sessionId,
    taskId: input.taskId,
    objective: objective.text,
    workspaceRoot,
    requirements: input.requirements,
  });
  const execution = executionFor(input.harness);
  if (!input.forceReroute) {
    const affinity = await findAffinity(input.harness, identity, {
      ...options.state,
      env,
    });
    if (affinity) {
      const affinityPolicy = structuredClone(scored.policy);
      if (
        input.override?.candidate &&
        resolveNativeCandidateId(input.override.candidate, resolvedPolicy.aliases) !==
          affinity.selectedCandidate
      ) {
        affinityPolicy.applied = affinityPolicy.applied.filter(
          (item) => item.code !== "request-candidate-selected",
        );
        affinityPolicy.ignored.push({
          code: "request-candidate-affinity",
          message: "explicit candidate override was ignored to preserve compatible task affinity",
        });
      }
      const reused = affinityDecision({
        record: affinity,
        candidates: ranked,
        taskProfile,
        repoSignals,
        profile,
        policy: affinityPolicy,
        context: {
          objectiveTruncated: objective.truncated,
          conversationTruncated: conversation.truncated,
        },
        fallbackModel,
        execution,
      });
      if (reused) {
        reused.confidence = affinityConfidence(reused.ranked);
        reused.sessionId = input.sessionId;
        await persistRouteDecision(reused, identity, options, env);
        return reused;
      }
    }
  }
  const winner = ranked[0];
  const confidence = routeConfidence(
    confidenceRanked,
    observations,
    probeEvidence,
    catalogObservedAt,
    Boolean(fallbackModel),
  );
  const decision: AutoRouteDecision = {
    routeId: newRouteId(),
    harness: input.harness,
    sessionId: input.sessionId,
    taskFingerprint: identity.taskFingerprint,
    affinityReused: false,
    confidence,
    status: "planned",
    selected:
      winner && !confidence.abstained
        ? {
            id: winner.id,
            kind: winner.kind,
            displayName: winner.displayName,
            reasoningEffort: winner.reasoningEffort,
            execution: winner.kind === "user-agent" ? "native-agent" : execution,
          }
        : null,
    profile,
    policy: scored.policy,
    taskProfile,
    repoSignals,
    ranked,
    excluded,
    fallback: { kind: "current-model", model: fallbackModel, harness: input.harness },
    context: {
      objectiveTruncated: objective.truncated,
      conversationTruncated: conversation.truncated,
    },
  };
  await persistRouteDecision(decision, identity, options, env);
  return decision;
}

async function routeAcrossHarnesses(
  input: HarnessRouteInput,
  options: HarnessRouterOptions,
): Promise<AutoRouteDecision> {
  const metaPolicyConfig = await readPolicyConfig(options);
  const requested = [
    ...(input.harness === "auto" ? nativeHarnesses : [input.harness]),
    ...(input.harnesses ?? []),
  ];
  const harnesses = [...new Set(requested)];
  const routable = harnesses.filter(
    (harness): harness is Exclude<HarnessId, "pi"> => harness !== "pi",
  );
  if (routable.length === 0) {
    throw new Error(
      "pi is excluded from native meta-routing because it has no native discovery or execution adapter",
    );
  }
  const results = await Promise.allSettled(
    routable.map(async (harness) => ({
      harness,
      decision: await routeSingleHarnessTask(
        {
          ...input,
          harness,
          harnesses: undefined,
          registeredAgents: [],
          currentModel: currentModelForHarness(input.currentModel, harness),
        },
        {
          ...options,
          policyConfig: policyConfigForHarness(metaPolicyConfig, harness),
          policyConfigPath: undefined,
          persist: async () => undefined,
        },
      ),
    })),
  );
  const successful = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  if (successful.length === 0) {
    const reasons = results.map((result, index) =>
      result.status === "rejected"
        ? `${routable[index]}: ${safeDiscoveryError(result.reason)}`
        : `${routable[index]}: no eligible candidates`,
    );
    throw new Error(`No native harness could be discovered (${reasons.join("; ")})`);
  }

  const ranked = successful
    .flatMap(({ harness, decision }) =>
      decision.ranked.map((candidate) => ({
        ...candidate,
        id: normalizedCandidateId(harness, candidate.id),
      })),
    )
    .sort(
      (left, right) => right.scores.total - left.scores.total || left.id.localeCompare(right.id),
    );
  const winner = ranked[0];
  if (!winner) throw new Error("No eligible candidate remained after cross-harness policy checks");
  const decoded = decodeNormalizedCandidateId(winner.id);
  const source = successful.find(({ harness }) => harness === decoded?.harness);
  if (!decoded || !source)
    throw new Error("Selected meta-route candidate has no execution adapter");
  const sourceSelected = source.decision.ranked.find((candidate) => candidate.id === decoded.model);
  const objective = sanitizeText(input.objective, 12_000, "objective");
  const workspaceRoot = await resolveTrustedWorkspace(input.workspaceRoot, options.trustedRoot);
  const identity = routeIdentity({
    harness: decoded.harness,
    sessionId: input.sessionId,
    taskId: input.taskId,
    objective: objective.text,
    workspaceRoot,
    requirements: input.requirements,
  });
  const excluded = [
    ...successful.flatMap(({ harness, decision }) =>
      decision.excluded.map((candidate) => ({
        ...candidate,
        id: normalizedCandidateId(harness, candidate.id),
      })),
    ),
    ...results.flatMap((result, index) =>
      result.status === "rejected"
        ? [
            {
              id: `${routable[index]}:*`,
              reasons: [`discovery failed: ${safeDiscoveryError(result.reason)}`],
            },
          ]
        : [],
    ),
    ...(harnesses.includes("pi")
      ? [{ id: "pi:*", reasons: ["pi excluded: no native discovery or execution adapter"] }]
      : []),
  ];
  const confidence = metaConfidence(
    ranked,
    successful.map(({ decision }) => decision),
  );
  const decision: AutoRouteDecision = {
    ...source.decision,
    routeId: newRouteId(),
    harness: decoded.harness,
    taskFingerprint: identity.taskFingerprint,
    affinityReused: source.decision.affinityReused,
    confidence,
    selected: {
      id: winner.id,
      kind: winner.kind,
      displayName: winner.displayName,
      reasoningEffort: sourceSelected?.reasoningEffort ?? winner.reasoningEffort,
      execution: executionFor(decoded.harness),
      executionHarness: decoded.harness,
      executionModel: decoded.model,
    },
    ranked,
    excluded,
    fallback: {
      kind: "current-model",
      model: source.decision.fallback.model
        ? normalizedCandidateId(decoded.harness, source.decision.fallback.model)
        : undefined,
      harness: decoded.harness,
    },
  };
  decision.policy = structuredClone(decision.policy);
  decision.policy?.applied.push({
    code: "cross-harness-route",
    message: `ranked ${successful.length} live native harness catalogs concurrently`,
  });
  if (input.registeredAgents?.length) {
    decision.policy?.ignored.push({
      code: "cross-harness-agents-excluded",
      message: "registered host agents are excluded from cross-harness adapter routing",
    });
  }
  await persistRouteDecision(decision, identity, options, options.env ?? process.env);
  return decision;
}

function policyConfigForHarness(
  config: NativeRoutingConfig | undefined,
  harness: Exclude<HarnessId, "pi">,
): NativeRoutingConfig | undefined {
  if (!config) return undefined;
  const mapped = structuredClone(config);
  for (const profile of Object.values(mapped.profiles)) {
    const policy = profile.policy;
    const aliases = policy.aliases;
    const mapSelector = (selector: string) => selectorForHarness(selector, aliases, harness);
    const originalAllow = policy.candidates.allow;
    policy.candidates.allow = originalAllow.flatMap((selector) => {
      const mappedSelector = mapSelector(selector);
      return mappedSelector ? [mappedSelector] : [];
    });
    policy.candidates.deny = policy.candidates.deny.flatMap((selector) => {
      const mappedSelector = mapSelector(selector);
      return mappedSelector ? [mappedSelector] : [];
    });
    if (originalAllow.length > 0 && policy.candidates.allow.length === 0) {
      policy.harnesses.deny = [...new Set([...policy.harnesses.deny, harness])];
    }
    policy.candidates.prefer = mapSelectorRecord(policy.candidates.prefer, mapSelector);
    policy.candidates.penalize = mapSelectorRecord(policy.candidates.penalize, mapSelector);
    policy.overrides = mapSelectorRecord(policy.overrides, mapSelector);
    policy.effort.candidates = mapSelectorRecord(policy.effort.candidates, mapSelector);
    if (policy.budget) {
      policy.budget.candidateMaxRoutes = mapSelectorRecord(
        policy.budget.candidateMaxRoutes,
        mapSelector,
      );
    }
    policy.aliases = Object.fromEntries(
      Object.entries(aliases).flatMap(([alias, target]) => {
        const mappedTarget = selectorForHarness(target, aliases, harness);
        return mappedTarget ? [[alias, mappedTarget]] : [];
      }),
    );
  }
  return mapped;
}

function selectorForHarness(
  selector: string,
  aliases: Readonly<Record<string, string>>,
  harness: Exclude<HarnessId, "pi">,
): string | undefined {
  const target = aliases[selector] ?? selector;
  const decoded = decodeNormalizedCandidateId(target);
  if (!decoded) return selector;
  return decoded.harness === harness ? decoded.model : undefined;
}

function mapSelectorRecord<T>(
  record: Record<string, T>,
  mapSelector: (selector: string) => string | undefined,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).flatMap(([selector, value]) => {
      const mapped = mapSelector(selector);
      return mapped ? [[mapped, value]] : [];
    }),
  );
}

function currentModelForHarness(value: string | undefined, harness: HarnessId): string | undefined {
  if (!value) return undefined;
  const decoded = decodeNormalizedCandidateId(value);
  if (decoded) return decoded.harness === harness ? decoded.model : undefined;
  return undefined;
}

function safeDiscoveryError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeText(message.replace(/[\r\n]+/g, " "), 256, "discovery error").text;
}

function metaConfidence(
  ranked: AutoRouteDecision["ranked"],
  decisions: AutoRouteDecision[],
): NonNullable<AutoRouteDecision["confidence"]> {
  const margin = Math.max(0, (ranked[0]?.scores.total ?? 0) - (ranked[1]?.scores.total ?? 0));
  const sources = [
    ...new Set(decisions.flatMap((decision) => decision.confidence?.evidenceSources ?? [])),
  ];
  const sampleSize = decisions.reduce(
    (total, decision) => total + (decision.confidence?.sampleSize ?? 0),
    0,
  );
  const score = Math.min(
    1,
    Number((0.2 + Math.min(0.4, margin * 2.5) + (sources.includes("probe") ? 0.4 : 0)).toFixed(6)),
  );
  return {
    score,
    level: score >= 0.55 ? "high" : score >= 0.3 ? "medium" : "low",
    winnerMargin: Number(margin.toFixed(6)),
    evidenceSources: sources.length ? sources : ["catalog"],
    freshestEvidenceAt: decisions
      .flatMap((decision) => decision.confidence?.freshestEvidenceAt ?? [])
      .sort()
      .at(-1),
    sampleSize,
    abstained: false,
    reasons: [
      `cross-harness winner margin ${margin.toFixed(3)}`,
      `${decisions.length} live harness catalogs`,
    ],
  };
}

async function persistRouteDecision(
  decision: AutoRouteDecision,
  identity: ReturnType<typeof routeIdentity>,
  options: HarnessRouterOptions,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const state = { ...options.state, env };
  if (options.persist) await options.persist(decision, identity, state);
  else await persistDecision(decision, identity, state);
}

async function readPolicyConfig(
  options: HarnessRouterOptions,
): Promise<NativeRoutingConfig | undefined> {
  if (options.policyConfig) return options.policyConfig;
  if (!options.policyConfigPath) return undefined;
  try {
    return (await loadConfig(options.policyConfigPath, { validateEnv: false, env: options.env }))
      .nativeRouting;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function routeConfidence(
  ranked: AutoRouteDecision["ranked"],
  observations: Readonly<Record<string, AutoObservedMetrics>>,
  probes: Readonly<Record<string, NativeProbeEvidence>>,
  catalogObservedAt: string,
  canAbstain: boolean,
): NonNullable<AutoRouteDecision["confidence"]> {
  const winner = ranked[0];
  const margin = winner
    ? Math.max(0, winner.scores.total - (ranked[1]?.scores.total ?? winner.scores.total - 0.2))
    : 0;
  const observed = winner ? observations[winner.id] : undefined;
  const probe = winner ? probes[winner.id] : undefined;
  const sampleSize = observed ? observed.attemptSamples + observed.feedbackSamples : 0;
  const evidenceSources: NonNullable<AutoRouteDecision["confidence"]>["evidenceSources"] = [
    "catalog",
  ];
  let score = 0.15 + Math.min(0.3, margin * 2.5);
  const reasons = [`winner margin ${margin.toFixed(3)}`, "fresh native catalog"];
  let freshestEvidenceAt = catalogObservedAt;
  if (sampleSize > 0) {
    evidenceSources.push("observations");
    score += Math.min(0.25, sampleSize / 48);
    reasons.push(`${sampleSize} observed outcome sample${sampleSize === 1 ? "" : "s"}`);
    if (observed?.lastObservedAt && observed.lastObservedAt > freshestEvidenceAt)
      freshestEvidenceAt = observed.lastObservedAt;
  }
  if (probe?.outcome === "success") {
    evidenceSources.push("probe");
    score += 0.4;
    freshestEvidenceAt = probe.probedAt;
    reasons.push(`native probe succeeded in ${probe.latencyMs}ms`);
  }
  score = Math.min(1, Number(score.toFixed(6)));
  const abstained = canAbstain && (!winner || score < 0.3);
  if (abstained) reasons.push("evidence below 0.30 abstention threshold; using current host");
  return {
    score,
    level: score >= 0.55 ? "high" : score >= 0.3 ? "medium" : "low",
    winnerMargin: Number(margin.toFixed(6)),
    evidenceSources,
    freshestEvidenceAt,
    sampleSize,
    abstained,
    reasons,
  };
}

function affinityConfidence(
  ranked: AutoRouteDecision["ranked"],
): NonNullable<AutoRouteDecision["confidence"]> {
  const margin = Math.max(
    0,
    (ranked[0]?.scores.total ?? 0) - (ranked[1]?.scores.total ?? ranked[0]?.scores.total ?? 0),
  );
  return {
    score: 1,
    level: "high",
    winnerMargin: margin,
    evidenceSources: ["affinity"],
    sampleSize: 1,
    abstained: false,
    reasons: ["compatible unexpired task affinity"],
  };
}

function probeStatePath(
  state: RouteStateOptions | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (state?.path) return `${state.path}.probes`;
  if (env.MODEL_ROUTER_STATE_PATH) return `${env.MODEL_ROUTER_STATE_PATH}.probes`;
  return env.HOME ? `${env.HOME}/.model-router/native-probes.jsonl` : undefined;
}

async function discoverHarnessCandidates(
  harness: HarnessId,
  options: HarnessRouterOptions,
  env: NodeJS.ProcessEnv,
): Promise<AutoCandidate[]> {
  if (harness === "codex") {
    return discoverCodexModels({ ...options.codex, env });
  }
  if (harness === "opencode") {
    return discoverOpenCodeModels({ ...options.opencode, env });
  }
  if (harness === "claude-code") {
    return discoverClaudeModels({ ...options.claude, env });
  }
  throw new Error(
    "pi native catalog discovery is not available yet; use the compatibility gateway adapter",
  );
}

function executionFor(harness: HarnessId): "codex-exec" | "opencode-run" | "claude-print" {
  if (harness === "codex") return "codex-exec";
  if (harness === "opencode") return "opencode-run";
  if (harness === "claude-code") return "claude-print";
  throw new Error("No native execution adapter for pi");
}

function resolveCurrentModel(
  value: string | undefined,
  models: AutoCandidate[],
): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeModelLabel(value).replace(/(?:low|medium|high|xhigh|max|ultra)$/, "");
  return models.find((model) =>
    [model.id, model.displayName].some((label) => {
      const candidate = normalizeModelLabel(label);
      return (
        candidate === normalized ||
        (normalized.length >= 4 &&
          (candidate.endsWith(normalized) || normalized.endsWith(candidate)))
      );
    }),
  )?.id;
}

function normalizeModelLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function agentCandidate(agent: RegisteredAgent): AutoCandidate {
  return {
    id: agent.id,
    kind: "user-agent",
    displayName: agent.displayName,
    description: agent.description,
    available: agent.available,
    capabilities: agent.capabilities,
    strengths: agent.strengths,
    quality: agent.quality,
    speed: agent.speed,
    economy: agent.economy,
  };
}

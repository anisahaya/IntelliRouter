import type {
  AutoCandidate,
  AutoObservedMetrics,
  AutoRouteDecision,
  AutoRouteProfile,
  AutoRouteRequirements,
  HarnessId,
  RegisteredAgent,
} from "@model-router/contracts";
import { buildAutoTaskProfile, scoreAutoCandidates } from "@model-router/router-core";
import { type ClaudeDiscoveryOptions, discoverClaudeModels } from "./claude-cli.js";
import { type CodexDiscoveryOptions, discoverCodexModels } from "./codex-cli.js";
import { assertRootInvocation, sanitizeText } from "./context-security.js";
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
  newRouteId,
  observedMetrics,
  persistDecision,
  type RouteStateOptions,
  routeIdentity,
} from "./route-state.js";
import { resolveTrustedWorkspace } from "./workspace-security.js";

export interface HarnessRouteInput {
  harness: HarnessId;
  objective: string;
  conversationSummary?: string;
  workspaceRoot: string;
  registeredAgents?: RegisteredAgent[];
  profile?: AutoRouteProfile;
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
}

export async function routeHarnessTask(
  input: HarnessRouteInput,
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
  let candidates = [...harnessCandidates, ...(input.registeredAgents ?? []).map(agentCandidate)];
  const fallbackModel = resolveCurrentModel(input.currentModel, harnessCandidates);
  if (input.harness === "codex" && !fallbackModel) {
    throw new Error("current model does not match the live Codex catalog");
  }
  const profile = input.profile ?? "balanced";
  const stateOptions = { ...options.state, env };
  const observations = await observedMetrics(
    input.harness,
    candidates.map((candidate) => candidate.id),
    stateOptions,
  );
  const preliminary = scoreAutoCandidates(
    candidates,
    taskProfile,
    profile,
    fallbackModel,
    observations,
  );
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
  const scored = scoreAutoCandidates(candidates, taskProfile, profile, fallbackModel, observations);
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
        ...scoreAutoCandidates(
          candidates,
          taskProfile,
          profile,
          undefined,
          observations,
        ).ranked.filter((candidate) => candidate.id !== ranked[0]?.id),
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
      const reused = affinityDecision({
        record: affinity,
        candidates: ranked,
        taskProfile,
        repoSignals,
        profile,
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
        await persistDecision(reused, identity, { ...options.state, env });
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
  await persistDecision(decision, identity, { ...options.state, env });
  return decision;
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

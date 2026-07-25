import type {
  AutoCandidate,
  AutoRouteDecision,
  AutoRouteProfile,
  AutoRouteRequirements,
  HarnessId,
  RegisteredAgent,
} from "@model-router/contracts";
import {
  buildAutoTaskProfile,
  type RoutingEvidenceReader,
  scoreAutoCandidates,
} from "@model-router/router-core";
import { type ClaudeDiscoveryOptions, discoverClaudeModels } from "./claude-cli.js";
import { type CodexDiscoveryOptions, discoverCodexModels } from "./codex-cli.js";
import { assertRootInvocation, sanitizeText } from "./context-security.js";
import { discoverOpenCodeModels, type OpenCodeDiscoveryOptions } from "./opencode-cli.js";
import { collectRepoSignals, type RepoSignalOptions } from "./repo-signals.js";
import {
  affinityDecision,
  findAffinity,
  newRouteId,
  persistDecision,
  type RouteStateOptions,
  routeIdentity,
} from "./route-state.js";
import { cacheSwitchContexts, readRoutingEvidence } from "./routing-evidence.js";
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
  forceReroute?: boolean;
  requirements: AutoRouteRequirements;
}

export interface HarnessRouterOptions {
  codex?: CodexDiscoveryOptions;
  opencode?: OpenCodeDiscoveryOptions;
  claude?: ClaudeDiscoveryOptions;
  repo?: RepoSignalOptions;
  state?: RouteStateOptions;
  env?: NodeJS.ProcessEnv;
  trustedRoot?: string;
  evidenceReader?: RoutingEvidenceReader;
}

export async function routeHarnessTask(
  input: HarnessRouteInput,
  options: HarnessRouterOptions = {},
): Promise<AutoRouteDecision> {
  const env = options.state?.env ?? options.env ?? process.env;
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
  const candidates = [...harnessCandidates, ...(input.registeredAgents ?? []).map(agentCandidate)];
  const fallbackModel = resolveCurrentModel(input.currentModel, harnessCandidates);
  if (input.harness === "codex" && !fallbackModel) {
    throw new Error("current model does not match the live Codex catalog");
  }
  const profile = input.profile ?? "balanced";
  const identity = routeIdentity({
    harness: input.harness,
    sessionId: input.sessionId,
    objective: objective.text,
    workspaceRoot,
    requirements: input.requirements,
  });
  const execution = executionFor(input.harness);
  const affinity = input.forceReroute
    ? undefined
    : await findAffinity(input.harness, identity, {
        ...options.state,
        env,
      });
  const evidenceReader = options.evidenceReader ?? options.state?.telemetryStore?.taskRuns;
  const evidence = readRoutingEvidence(
    evidenceReader as RoutingEvidenceReader | undefined,
    candidates,
    input.harness,
  );
  const cacheCosts = cacheSwitchContexts(
    taskProfile,
    candidates,
    evidence,
    affinity?.selectedCandidate ?? fallbackModel,
  );
  const { ranked, excluded, selected, coldStart, coldStartReason } = scoreAutoCandidates(
    candidates,
    taskProfile,
    profile,
    fallbackModel,
    evidence,
    cacheCosts,
  );
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
      reused.sessionId = input.sessionId;
      await persistDecision(reused, identity, { ...options.state, env });
      return reused;
    }
  }
  const winner = selected;
  const decision: AutoRouteDecision = {
    routeId: newRouteId(),
    harness: input.harness,
    sessionId: input.sessionId,
    taskFingerprint: identity.taskFingerprint,
    affinityReused: false,
    status: "planned",
    selected: winner
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
    selectionRule: "min-expected-cost-subject-to-quality-floor-v1",
    coldStart,
    coldStartReason,
  };
  await persistDecision(decision, identity, { ...options.state, env });
  return decision;
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

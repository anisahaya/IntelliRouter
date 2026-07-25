import type {
  AutoCandidate,
  AutoRouteDecision,
  AutoRouteProfile,
  AutoRouteRequirements,
  RegisteredAgent,
} from "@model-router/contracts";
import {
  buildAutoTaskProfile,
  type RoutingEvidenceReader,
  scoreAutoCandidates,
} from "@model-router/router-core";
import { type CodexDiscoveryOptions, discoverCodexModels } from "./codex-cli.js";
import { assertRootInvocation, sanitizeText } from "./context-security.js";
import { collectRepoSignals, type RepoSignalOptions } from "./repo-signals.js";
import { cacheSwitchContexts, readRoutingEvidence } from "./routing-evidence.js";
import { resolveTrustedWorkspace } from "./workspace-security.js";

export interface AutoRouteInput {
  objective: string;
  conversationSummary?: string;
  workspaceRoot: string;
  registeredAgents?: RegisteredAgent[];
  profile?: AutoRouteProfile;
  currentModel: string;
  requirements: AutoRouteRequirements;
}

export interface AutoRouterOptions {
  discovery?: CodexDiscoveryOptions;
  repo?: RepoSignalOptions;
  env?: NodeJS.ProcessEnv;
  trustedRoot?: string;
  evidenceReader?: RoutingEvidenceReader;
}

export async function autoRoute(
  input: AutoRouteInput,
  options: AutoRouterOptions = {},
): Promise<AutoRouteDecision> {
  assertRootInvocation(options.env ?? process.env);
  const workspaceRoot = await resolveTrustedWorkspace(input.workspaceRoot, options.trustedRoot);
  const objective = sanitizeText(input.objective, 12_000, "objective");
  const conversation = sanitizeText(input.conversationSummary ?? "", 8_000, "conversation summary");
  const [repoSignals, models] = await Promise.all([
    collectRepoSignals(workspaceRoot, options.repo),
    discoverCodexModels({ ...options.discovery, env: options.env ?? options.discovery?.env }),
  ]);
  const requirements = { ...input.requirements };
  const taskProfile = buildAutoTaskProfile({
    objective: objective.text,
    conversationSummary: conversation.text,
    repoSignals,
    requirements,
  });
  const agents = (input.registeredAgents ?? []).map(agentCandidate);
  const profile = input.profile ?? "balanced";
  const currentModel = resolveCurrentModel(input.currentModel, models);
  if (!currentModel) throw new Error("current model does not match the live Codex catalog");
  const evidence = readRoutingEvidence(options.evidenceReader, [...models, ...agents]);
  const cacheCosts = cacheSwitchContexts(
    taskProfile,
    [...models, ...agents],
    evidence,
    currentModel,
  );
  const { ranked, excluded, selected, coldStart, coldStartReason } = scoreAutoCandidates(
    [...models, ...agents],
    taskProfile,
    profile,
    currentModel,
    evidence,
    cacheCosts,
  );
  const winner = selected;
  return {
    affinityReused: false,
    status: "planned",
    selected: winner
      ? {
          id: winner.id,
          kind: winner.kind,
          displayName: winner.displayName,
          reasoningEffort: winner.reasoningEffort,
          execution: winner.kind === "codex-model" ? "codex-exec" : "native-agent",
        }
      : null,
    profile,
    taskProfile,
    repoSignals,
    ranked,
    excluded,
    fallback: { kind: "current-model", model: currentModel },
    context: {
      objectiveTruncated: objective.truncated,
      conversationTruncated: conversation.truncated,
    },
    selectionRule: "min-expected-cost-subject-to-quality-floor-v1",
    coldStart,
    coldStartReason,
  };
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

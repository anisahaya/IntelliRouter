import { loadConfig } from "@model-router/config";
import type {
  AutoCandidate,
  AutoRouteDecision,
  AutoRouteRequirements,
  NativeRouteOverride,
  NativeRoutingConfig,
  RegisteredAgent,
} from "@model-router/contracts";
import { buildAutoTaskProfile } from "@model-router/router-core";
import { type CodexDiscoveryOptions, discoverCodexModels } from "./codex-cli.js";
import { assertRootInvocation, sanitizeText } from "./context-security.js";
import {
  applyNativeMetadata,
  resolveNativeCandidateId,
  resolveNativePolicy,
  scoreWithNativePolicy,
} from "./native-policy.js";
import { collectRepoSignals, type RepoSignalOptions } from "./repo-signals.js";
import { resolveTrustedWorkspace } from "./workspace-security.js";

export interface AutoRouteInput {
  objective: string;
  conversationSummary?: string;
  workspaceRoot: string;
  registeredAgents?: RegisteredAgent[];
  profile?: string;
  override?: NativeRouteOverride;
  currentModel: string;
  requirements: AutoRouteRequirements;
}

export interface AutoRouterOptions {
  discovery?: CodexDiscoveryOptions;
  repo?: RepoSignalOptions;
  env?: NodeJS.ProcessEnv;
  trustedRoot?: string;
  policyConfig?: NativeRoutingConfig;
  policyConfigPath?: string;
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
  const policyConfig = await readPolicyConfig(options);
  const resolvedPolicy = resolveNativePolicy({
    config: policyConfig,
    repository: repoSignals.rootName,
    requestedProfile: input.profile,
  });
  const metadata = applyNativeMetadata(
    [...models, ...(input.registeredAgents ?? []).map(agentCandidate)],
    resolvedPolicy,
  );
  const profile = resolvedPolicy.decision.profile;
  const currentModel = resolveCurrentModel(
    resolveNativeCandidateId(input.currentModel, resolvedPolicy.aliases),
    metadata.candidates.filter((candidate) => candidate.kind === "codex-model"),
  );
  if (!currentModel) throw new Error("current model does not match the live Codex catalog");
  const { ranked, excluded, policy } = scoreWithNativePolicy({
    candidates: metadata.candidates,
    task: taskProfile,
    currentModel,
    harness: "codex",
    resolved: resolvedPolicy,
    metadataApplied: metadata.applied,
    metadataIgnored: metadata.ignored,
    override: input.override,
  });
  const winner = ranked[0];
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
    policy,
    taskProfile,
    repoSignals,
    ranked,
    excluded,
    fallback: { kind: "current-model", model: currentModel },
    context: {
      objectiveTruncated: objective.truncated,
      conversationTruncated: conversation.truncated,
    },
  };
}

async function readPolicyConfig(
  options: AutoRouterOptions,
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

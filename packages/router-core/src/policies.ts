import { createHash, randomUUID } from "node:crypto";
import type {
  ModelDefinition,
  NormalizedRequest,
  RouteCandidate,
  RouteDecision,
  RouterConfig,
} from "@model-router/contracts";
import { AffinityCache } from "./affinity.js";
import { capabilityExclusions } from "./capabilities.js";
import { extractFeatures } from "./features.js";
import { type ObservedModelMetrics, scoreCandidate } from "./scorer.js";

export interface RouterState {
  isHealthy(modelId: string): boolean;
  metricsFor(modelId: string, taskType: string): ObservedModelMetrics;
  saveDecision(decision: RouteDecision): void;
  getAffinity?(sessionHash: string): string | undefined;
  setAffinity?(sessionHash: string, modelId: string, expiresAt: number): void;
}

const defaultState: RouterState = {
  isHealthy: () => true,
  metricsFor: () => ({ averageLatencyMs: 500, failureRate: 0, feedbackPrior: 0 }),
  saveDecision: () => undefined,
};

export interface RouteOptions {
  requestId?: string;
  profile?: string;
  pinnedModel?: string;
  sessionId?: string;
  excludeModels?: string[];
}

export class RoutingEngine {
  readonly #affinity = new AffinityCache();

  constructor(
    readonly config: RouterConfig,
    readonly state: RouterState = defaultState,
    readonly sessionSalt: string = randomUUID(),
  ) {}

  select(request: NormalizedRequest, options: RouteOptions = {}): RouteDecision {
    const requestId = options.requestId ?? randomUUID();
    const profile =
      options.profile ?? request.requestedProfile ?? this.config.routing.defaultProfile;
    const profileConfig = this.config.routing.profiles[profile];
    if (!profileConfig) throw new Error(`unknown routing profile: ${profile}`);
    const features = extractFeatures(request);
    const excluded = new Set(options.excludeModels ?? []);
    const candidates = this.config.models.map((model) => {
      const reasons = capabilityExclusions(model, request, this.state.isHealthy(model.id));
      if (excluded.has(model.id)) reasons.push("excluded after an earlier attempt");
      return scoreCandidate(
        model,
        profileConfig.weights,
        features,
        reasons,
        this.state.metricsFor(model.id, features.taskType),
      );
    });

    const explicitModel = options.pinnedModel ?? request.pinnedModel;
    let chosen: ModelDefinition | undefined;
    let affinityUsed = false;
    if (explicitModel && explicitModel !== "auto") {
      const candidate = candidates.find((item) => item.modelId === explicitModel);
      if (!candidate) throw new Error(`unknown pinned model: ${explicitModel}`);
      if (!candidate.eligible)
        throw new Error(`pinned model is ineligible: ${candidate.exclusionReasons.join(", ")}`);
      chosen = this.config.models.find((model) => model.id === explicitModel);
    }

    const sessionHash = options.sessionId ? this.hashSession(options.sessionId) : undefined;
    if (!chosen && sessionHash) {
      const affinityModel =
        this.state.getAffinity?.(sessionHash) ?? this.#affinity.get(sessionHash);
      const candidate = candidates.find((item) => item.modelId === affinityModel && item.eligible);
      if (candidate) {
        chosen = this.config.models.find((model) => model.id === affinityModel);
        affinityUsed = true;
      }
    }

    if (!chosen) {
      const ranked = candidates
        .filter((candidate) => candidate.eligible)
        .sort(
          (left, right) =>
            right.scores.total - left.scores.total || left.modelId.localeCompare(right.modelId),
        );
      const winner = ranked[0];
      if (!winner) throw new Error("no eligible model for this request");
      chosen = this.config.models.find((model) => model.id === winner.modelId);
    }
    if (!chosen) throw new Error("selected model is not configured");

    const decision: RouteDecision = {
      id: randomUUID(),
      requestId,
      logicalModel: chosen.id,
      upstreamModel: chosen.upstreamModel,
      profile,
      features,
      candidates,
      fallbackChain: [],
      affinityUsed,
      createdAt: new Date().toISOString(),
    };
    this.state.saveDecision(decision);
    if (sessionHash) {
      this.#affinity.set(sessionHash, chosen.id, this.config.routing.affinityTtlSeconds);
      this.state.setAffinity?.(
        sessionHash,
        chosen.id,
        Date.now() + this.config.routing.affinityTtlSeconds * 1000,
      );
    }
    return decision;
  }

  private hashSession(value: string): string {
    return createHash("sha256").update(this.sessionSalt).update(value).digest("hex");
  }
}

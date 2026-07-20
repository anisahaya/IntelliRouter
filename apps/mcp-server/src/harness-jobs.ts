import { createHash, randomUUID } from "node:crypto";
import type {
  AutoRouteDecision,
  HarnessRouteRecord,
  NativeRouteJob,
  NativeRouteJobStatus,
} from "@model-router/contracts";
import type { HarnessExecOptions, HarnessTaskInput, HarnessTaskResult } from "./harness-exec.js";
import { executeHarnessTask } from "./harness-exec.js";
import type { HarnessRouteInput, HarnessRouterOptions } from "./harness-router.js";
import { routeHarnessTask } from "./harness-router.js";
import { collectRepoSignals } from "./repo-signals.js";
import {
  getRouteRecord,
  openNativeStore,
  persistDecisionAndJob,
  type RouteStateOptions,
} from "./route-state.js";

export interface HarnessJobRequest {
  routeId: string;
  idempotencyKey: string;
  objective: string;
  conversationSummary?: string;
  acceptanceChecks?: string[];
  workspaceRoot: string;
  permission: "read-only" | "workspace-write";
  allowWriteFallback?: boolean;
  searchRequired?: boolean;
  visionRequired?: boolean;
  imagePaths?: string[];
  timeoutMs?: number;
  resumeSessionId?: string;
}

export interface RouteAndStartHarnessJobRequest extends Omit<HarnessRouteInput, "objective"> {
  objective: string;
  idempotencyKey: string;
  acceptanceChecks?: string[];
  permission: "read-only" | "workspace-write";
  allowWriteFallback?: boolean;
  imagePaths?: string[];
  timeoutMs?: number;
}

export interface HarnessJobView {
  job: NativeRouteJob;
  result?: HarnessTaskResult;
}

export interface HarnessJobManagerOptions {
  router?: HarnessRouterOptions;
  exec?: HarnessExecOptions;
  execute?: typeof executeHarnessTask;
  route?: typeof routeHarnessTask;
  now?: () => number;
}

const activeStatuses = new Set<NativeRouteJobStatus>(["queued", "starting", "running"]);

export class HarnessJobManager {
  readonly #options: HarnessJobManagerOptions;
  readonly #results = new Map<string, HarnessTaskResult>();
  readonly #envelopes = new Map<string, HarnessTaskInput>();
  #recovered = false;

  constructor(options: HarnessJobManagerOptions = {}) {
    this.#options = options;
  }

  async recover(): Promise<number> {
    if (this.#recovered) return 0;
    const store = await openNativeStore(this.#state());
    try {
      const recovered = store.recoverNativeRouteJobs(this.#isoNow());
      this.#recovered = true;
      return recovered;
    } finally {
      store.close();
    }
  }

  async routeAndStart(input: RouteAndStartHarnessJobRequest): Promise<{
    route: AutoRouteDecision | HarnessRouteRecord;
    job: NativeRouteJob;
  }> {
    await this.recover();
    const replay = await this.#byIdempotency(input.idempotencyKey);
    if (replay) {
      const route = await getRouteRecord(replay.routeId, this.#state());
      if (!route) throw new Error("Idempotent job references an expired route");
      if (replay.executionHash !== executionRequestHash({ ...input, harness: route.harness }))
        throw idempotencyConflict();
      return { route, job: replay };
    }

    let persistedJob: NativeRouteJob | undefined;
    const route = await (this.#options.route ?? routeHarnessTask)(input, {
      ...this.#options.router,
      persist: async (decision, identity, state) => {
        const requestHash = executionRequestHash({ ...input, harness: decision.harness });
        let job = newJob(decision.routeId as string, input, requestHash, this.#isoNow());
        if (!decision.selected) {
          job = {
            ...job,
            status: "failed",
            completedAt: job.createdAt,
            errorCode: "execution-failed",
            progress: {
              stage: "terminal",
              attemptCount: 0,
              outcome: "failure",
              resultAvailable: false,
            },
          };
        }
        persistedJob = (await persistDecisionAndJob(decision, identity, job, state)).job;
      },
    });
    if (!persistedJob) throw new Error("Atomic route-and-job persistence did not complete");
    if (!route.selected) return { route, job: persistedJob };
    const envelope = envelopeFromDecision(route, input);
    this.#envelopes.set(persistedJob.jobId, envelope);
    this.#launch(persistedJob.jobId);
    return { route, job: persistedJob };
  }

  async start(input: HarnessJobRequest): Promise<NativeRouteJob> {
    await this.recover();
    const route = await getRouteRecord(input.routeId, this.#state());
    if (!route) throw new Error("Unknown or expired harness route");
    if (!route.selectedCandidate || !route.reasoningEffort)
      throw new Error("The persisted route abstained and cannot be started");
    if (digest(input.workspaceRoot).slice(7) !== route.workspaceFingerprint)
      throw new Error("Workspace does not match the persisted route");
    const effective = {
      ...input,
      harness: route.harness,
      searchRequired: route.featureSummary.requiredCapabilities.includes("search"),
      visionRequired: route.featureSummary.requiredCapabilities.includes("vision"),
    };
    const hash = executionRequestHash(effective);
    const existing = await this.#byIdempotency(input.idempotencyKey);
    if (existing) {
      if (existing.executionHash !== hash) throw idempotencyConflict();
      if (input.resumeSessionId && existing.childSessionHash !== digest(input.resumeSessionId))
        throw idempotencyConflict();
      return existing;
    }
    const repoSignals = await collectRepoSignals(input.workspaceRoot, this.#options.exec?.repo);
    const envelope: HarnessTaskInput = {
      ...effective,
      harness: route.harness,
      model: route.selectedCandidate,
      reasoningEffort: route.reasoningEffort,
      repoSignals,
    };
    const job = newJob(input.routeId, input, hash, this.#isoNow());
    const store = await openNativeStore(this.#state());
    let persisted: NativeRouteJob;
    try {
      persisted = store.createNativeRouteJob(job);
    } finally {
      store.close();
    }
    this.#envelopes.set(persisted.jobId, envelope);
    this.#launch(persisted.jobId);
    return persisted;
  }

  async get(jobId: string): Promise<HarnessJobView> {
    await this.recover();
    const job = await this.#get(jobId);
    return {
      job: {
        ...job,
        progress: { ...job.progress, resultAvailable: this.#results.has(jobId) },
      },
      result: this.#results.get(jobId),
    };
  }

  async list(
    input: { routeId?: string; status?: NativeRouteJobStatus; limit?: number } = {},
  ): Promise<NativeRouteJob[]> {
    await this.recover();
    const store = await openNativeStore(this.#state());
    try {
      return store.listNativeRouteJobs(input).map((job) => ({
        ...job,
        progress: { ...job.progress, resultAvailable: this.#results.has(job.jobId) },
      }));
    } finally {
      store.close();
    }
  }

  async cancel(jobId: string): Promise<NativeRouteJob> {
    await this.recover();
    const job = await this.#get(jobId);
    if (!activeStatuses.has(job.status)) return job;
    const now = this.#isoNow();
    const queued = job.status === "queued";
    return this.#update({
      ...job,
      status: queued ? "canceled" : job.status,
      updatedAt: now,
      completedAt: queued ? now : job.completedAt,
      cancelRequested: true,
      errorCode: queued ? "canceled" : job.errorCode,
      progress: {
        ...job.progress,
        stage: queued ? "terminal" : "cancel-requested",
        outcome: queued ? "canceled" : job.progress.outcome,
      },
    });
  }

  async resume(
    jobId: string,
    input: Omit<HarnessJobRequest, "routeId" | "idempotencyKey">,
  ): Promise<NativeRouteJob> {
    await this.recover();
    const job = await this.#get(jobId);
    if (activeStatuses.has(job.status)) throw new Error("Active jobs cannot be resumed");
    const route = await getRouteRecord(job.routeId, this.#state());
    if (!route?.selectedCandidate || !route.reasoningEffort)
      throw new Error("The persisted route is no longer executable");
    const replay = {
      ...input,
      routeId: job.routeId,
      harness: route.harness,
      idempotencyKey: "resume",
      searchRequired: route.featureSummary.requiredCapabilities.includes("search"),
      visionRequired: route.featureSummary.requiredCapabilities.includes("vision"),
    };
    if (executionRequestHash(replay) !== job.executionHash)
      throw new Error("Resume request does not match the immutable execution envelope");
    if (job.childSessionHash) {
      if (!input.resumeSessionId || digest(input.resumeSessionId) !== job.childSessionHash)
        throw new Error("Resume session does not match the persisted child-session hash");
    }
    if (digest(input.workspaceRoot).slice(7) !== route.workspaceFingerprint)
      throw new Error("Workspace does not match the persisted route");
    const repoSignals = await collectRepoSignals(input.workspaceRoot, this.#options.exec?.repo);
    this.#envelopes.set(jobId, {
      ...replay,
      routeId: job.routeId,
      harness: route.harness,
      model: route.selectedCandidate,
      reasoningEffort: route.reasoningEffort,
      repoSignals,
    });
    const reset = await this.#update({
      ...job,
      status: "queued",
      updatedAt: this.#isoNow(),
      startedAt: undefined,
      completedAt: undefined,
      errorCode: undefined,
      cancelRequested: false,
      progress: {
        stage: "queued",
        attemptCount: job.progress.attemptCount,
        resultAvailable: false,
      },
    });
    this.#results.delete(jobId);
    this.#launch(jobId);
    return reset;
  }

  #launch(jobId: string): void {
    queueMicrotask(() => void this.#run(jobId));
  }

  async #run(jobId: string): Promise<void> {
    const envelope = this.#envelopes.get(jobId);
    if (!envelope) return;
    let job = await this.#get(jobId);
    if (job.cancelRequested || job.status !== "queued") return;
    const startedAt = this.#isoNow();
    job = await this.#update({
      ...job,
      status: "starting",
      startedAt,
      updatedAt: startedAt,
      progress: { ...job.progress, stage: "starting" },
    });
    if ((await this.#get(jobId)).cancelRequested) return void (await this.#finishCanceled(job));
    job = await this.#update({
      ...job,
      status: "running",
      updatedAt: this.#isoNow(),
      progress: { ...job.progress, stage: "executing" },
    });
    try {
      const result = await (this.#options.execute ?? executeHarnessTask)(
        envelope,
        this.#options.exec,
      );
      const current = await this.#get(jobId);
      if (current.cancelRequested) return void (await this.#finishCanceled(current));
      this.#results.set(jobId, result);
      const status =
        result.outcome === "success"
          ? "succeeded"
          : result.outcome === "failure"
            ? "failed"
            : result.outcome;
      await this.#update({
        ...current,
        status,
        updatedAt: this.#isoNow(),
        completedAt: this.#isoNow(),
        childSessionHash: result.childSessionId ? digest(result.childSessionId) : undefined,
        errorCode:
          result.outcome === "timed-out"
            ? "execution-timed-out"
            : result.outcome === "failure"
              ? "execution-failed"
              : undefined,
        progress: {
          stage: "terminal",
          attemptCount: current.progress.attemptCount + result.attemptChain.length,
          outcome: result.outcome,
          partialWriteDetected: result.partialWriteDetected,
          safeToFallback: result.safeToFallback,
          resultAvailable: false,
        },
      });
    } catch {
      const current = await this.#get(jobId);
      await this.#update({
        ...current,
        status: "failed",
        updatedAt: this.#isoNow(),
        completedAt: this.#isoNow(),
        errorCode: "execution-failed",
        progress: {
          stage: "terminal",
          attemptCount: current.progress.attemptCount + 1,
          outcome: "failure",
          resultAvailable: false,
        },
      });
    } finally {
      this.#envelopes.delete(jobId);
    }
  }

  async #finishCanceled(job: NativeRouteJob): Promise<NativeRouteJob> {
    const now = this.#isoNow();
    return this.#update({
      ...job,
      status: "canceled",
      updatedAt: now,
      completedAt: now,
      errorCode: "canceled",
      progress: { ...job.progress, stage: "terminal", outcome: "canceled" },
    });
  }

  async #get(jobId: string): Promise<NativeRouteJob> {
    const store = await openNativeStore(this.#state());
    try {
      const job = store.getNativeRouteJob(jobId);
      if (!job) throw new Error(`Unknown native route job: ${jobId}`);
      return job;
    } finally {
      store.close();
    }
  }

  async #byIdempotency(key: string): Promise<NativeRouteJob | undefined> {
    const store = await openNativeStore(this.#state());
    try {
      return store.getNativeRouteJobByIdempotencyHash(digest(key));
    } finally {
      store.close();
    }
  }

  async #update(job: NativeRouteJob): Promise<NativeRouteJob> {
    const store = await openNativeStore(this.#state());
    try {
      return store.updateNativeRouteJob(job);
    } finally {
      store.close();
    }
  }

  #state(): RouteStateOptions {
    const state = { ...this.#options.router?.state, ...this.#options.exec?.state };
    return {
      ...state,
      env: this.#options.exec?.env ?? this.#options.router?.env ?? state.env,
    };
  }

  #isoNow(): string {
    return new Date(this.#options.now?.() ?? Date.now()).toISOString();
  }
}

function newJob(
  routeId: string,
  input: {
    idempotencyKey: string;
    permission: "read-only" | "workspace-write";
    resumeSessionId?: string;
  },
  executionHash: string,
  now: string,
): NativeRouteJob {
  return {
    jobId: randomUUID(),
    routeId,
    status: "queued",
    idempotencyKeyHash: digest(input.idempotencyKey),
    executionHash,
    permission: input.permission,
    createdAt: now,
    updatedAt: now,
    progress: { stage: "queued", attemptCount: 0, resultAvailable: false },
    childSessionHash: input.resumeSessionId ? digest(input.resumeSessionId) : undefined,
    cancelRequested: false,
  };
}

function envelopeFromDecision(
  decision: Awaited<ReturnType<typeof routeHarnessTask>>,
  input: RouteAndStartHarnessJobRequest,
): HarnessTaskInput {
  if (!decision.selected) throw new Error("The route abstained and cannot be executed");
  return {
    routeId: decision.routeId as string,
    harness: decision.harness as HarnessTaskInput["harness"],
    model: decision.selected.id,
    reasoningEffort: decision.selected.reasoningEffort ?? "medium",
    objective: input.objective,
    conversationSummary: input.conversationSummary,
    acceptanceChecks: input.acceptanceChecks,
    searchRequired: input.requirements.search,
    visionRequired: input.requirements.vision,
    imagePaths: input.imagePaths,
    repoSignals: decision.repoSignals,
    workspaceRoot: input.workspaceRoot,
    permission: input.permission,
    allowWriteFallback: input.allowWriteFallback,
    timeoutMs: input.timeoutMs,
  };
}

function executionRequestHash(input: {
  routeId?: string;
  harness?: string;
  objective: string;
  conversationSummary?: string;
  acceptanceChecks?: string[];
  workspaceRoot: string;
  permission: string;
  allowWriteFallback?: boolean;
  searchRequired?: boolean;
  visionRequired?: boolean;
  imagePaths?: string[];
  timeoutMs?: number;
  requirements?: { search?: boolean; vision?: boolean };
}): string {
  return digest(
    JSON.stringify({
      objective: input.objective,
      harness: input.harness,
      conversationSummary: input.conversationSummary ?? "",
      acceptanceChecks: input.acceptanceChecks ?? [],
      workspaceRoot: input.workspaceRoot,
      permission: input.permission,
      allowWriteFallback: input.allowWriteFallback === true,
      searchRequired: input.searchRequired ?? input.requirements?.search ?? false,
      visionRequired: input.visionRequired ?? input.requirements?.vision ?? false,
      imagePaths: input.imagePaths ?? [],
      timeoutMs: input.timeoutMs,
    }),
  );
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function idempotencyConflict(): Error {
  return new Error("Idempotency key was already used for a different execution request");
}

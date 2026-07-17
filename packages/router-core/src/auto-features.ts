import type {
  AutoRouteRequirements,
  AutoTaskProfile,
  ReasoningEffort,
  RepoSignals,
} from "@model-router/contracts";

export interface AutoFeatureInput {
  objective: string;
  conversationSummary?: string;
  repoSignals: RepoSignals;
  requirements: AutoRouteRequirements;
}

export function buildAutoTaskProfile(input: AutoFeatureInput): AutoTaskProfile {
  const objective = input.objective.toLowerCase();
  const summary = (input.conversationSummary ?? "").toLowerCase();
  const weighted = `${objective} ${objective} ${summary}`;
  const taskType = classifyTask(weighted);
  const mechanical = clamp(
    0.15 +
      matches(weighted, /\b(rename|format|extract|convert|classify|sort|copy|boilerplate)\b/g) *
        0.16 +
      matches(weighted, /\b(simple|small|straightforward|repetitive|mechanical)\b/g) * 0.14,
  );
  const scope = inferScope(weighted, input.repoSignals);
  const ambiguity = clamp(
    0.15 +
      matches(
        weighted,
        /\b(architect|design|explore|open[- ]ended|unsure|investigate|tradeoff)\b/g,
      ) *
        0.14 +
      (input.objective.length < 80 ? 0.12 : 0) -
      matches(weighted, /\b(exact|specific|acceptance|must|only)\b/g) * 0.05,
  );
  const risk = clamp(
    0.1 +
      matches(
        weighted,
        /\b(auth|security|permission|migration|database|payment|production|privacy|secret|credential|breaking)\b/g,
      ) *
        0.16,
  );
  const scopeBoost = scope === "repo" ? 0.28 : scope === "multi" ? 0.14 : 0;
  const complexity = clamp(
    0.24 +
      scopeBoost +
      (input.repoSignals.monorepo ? 0.05 : 0) +
      ambiguity * 0.24 +
      risk * 0.2 +
      matches(
        weighted,
        /\b(complex|deep|hard|architecture|concurrent|distributed|performance)\b/g,
      ) *
        0.1 -
      mechanical * 0.18,
  );
  const visionRequired =
    input.requirements.vision || /\b(image|screenshot|visual|diagram|photo)\b/.test(weighted);
  const searchRequired =
    input.requirements.search ||
    /\b(latest|current|web|internet|research|documentation)\b/.test(weighted);
  const editRequired =
    input.requirements.edit ||
    /\b(implement|edit|change|fix|build|create|write|refactor)\b/.test(objective);
  const toolsRequired =
    input.requirements.tools ||
    editRequired ||
    /\b(run|test|inspect|repository|codebase|git)\b/.test(weighted);
  const estimatedContextTokens = Math.max(
    input.requirements.minimumContextTokens,
    Math.ceil((input.objective.length + (input.conversationSummary?.length ?? 0)) / 4) +
      Math.min(32_000, input.repoSignals.fileCount * 12),
  );
  const desiredEffort = effortFor(complexity, ambiguity, risk, mechanical);
  const repoTags = [
    ...input.repoSignals.languages.map((language) => language.name.toLowerCase()),
    ...input.repoSignals.manifests.map((manifest) => manifest.toLowerCase()),
    ...(input.repoSignals.monorepo ? ["monorepo"] : []),
    ...(input.repoSignals.hasTests ? ["tests"] : []),
  ].slice(0, 16);

  return {
    taskType,
    complexity,
    ambiguity,
    risk,
    mechanical,
    scope,
    toolsRequired,
    visionRequired,
    searchRequired,
    editRequired,
    estimatedContextTokens,
    desiredEffort,
    repoTags,
  };
}

function classifyTask(text: string): AutoTaskProfile["taskType"] {
  if (/\b(image|screenshot|visual|diagram|photo)\b/.test(text)) return "visual";
  if (/\b(debug|bug|error|failing|failure|stack trace|regression)\b/.test(text)) return "debug";
  if (/\b(review|audit|critique|findings|vulnerability)\b/.test(text)) return "review";
  if (/\b(research|compare|investigate|latest|current|evaluate)\b/.test(text)) return "research";
  if (/\b(document|readme|guide|docs|copywriting)\b/.test(text)) return "docs";
  if (/\b(csv|spreadsheet|dataset|classify|extract|transform data)\b/.test(text)) return "data";
  if (/\b(implement|build|create|refactor|edit|change|feature|code)\b/.test(text))
    return "implementation";
  return "general";
}

function inferScope(text: string, repo: RepoSignals): AutoTaskProfile["scope"] {
  if (/\b(entire|whole|repository|codebase|architecture|monorepo)\b/.test(text)) return "repo";
  if (/\b(multiple|multi[- ]file|across|several)\b/.test(text)) return "multi";
  return "single";
}

function effortFor(
  complexity: number,
  ambiguity: number,
  risk: number,
  mechanical: number,
): ReasoningEffort {
  const demand = clamp(complexity * 0.5 + ambiguity * 0.25 + risk * 0.35 - mechanical * 0.18);
  if (demand >= 0.96) return "ultra";
  if (demand >= 0.86) return "max";
  if (demand >= 0.68) return "xhigh";
  if (demand >= 0.48) return "high";
  if (demand >= 0.25) return "medium";
  return "low";
}

function matches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

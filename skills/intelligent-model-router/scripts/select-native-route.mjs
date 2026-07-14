import { pathToFileURL } from "node:url";

const PROFILE_WEIGHTS = {
  balanced: { quality: 0.5, cost: 0.25, latency: 0.25 },
  economy: { quality: 0.25, cost: 0.5, latency: 0.25 },
  premium: { quality: 0.7, cost: 0.15, latency: 0.15 },
  fast: { quality: 0.25, cost: 0.15, latency: 0.6 },
};

/**
 * Select a host-native candidate from an inventory discovered by the caller.
 * This function never discovers or invokes models itself.
 *
 * @param {Record<string, any>} input
 */
export function selectNativeRoute(input) {
  const task = typeof input?.task === "string" ? input.task : "";
  const profile = input?.profile ?? "balanced";
  const weights = PROFILE_WEIGHTS[profile];
  if (!weights) throw new Error(`unknown profile: ${profile}`);
  if (!Array.isArray(input?.candidates) || input.candidates.length === 0) {
    throw new Error("candidates must contain the current host and any discovered native options");
  }

  const requirements = normalizeRequirements(input.requirements);
  const seen = new Set();
  const evaluated = input.candidates.map((candidate) => {
    if (!candidate || typeof candidate.id !== "string" || candidate.id.length === 0) {
      throw new Error("every candidate must have a non-empty id");
    }
    if (seen.has(candidate.id)) throw new Error(`duplicate candidate id: ${candidate.id}`);
    seen.add(candidate.id);
    const exclusions = [];
    if (candidate.available === false) exclusions.push("unavailable");
    for (const requirement of requirements) {
      if (!hasCapability(candidate.capabilities, requirement)) {
        exclusions.push(`missing capability: ${requirement}`);
      }
    }
    return { candidate, exclusions };
  });

  const eligible = evaluated.filter((item) => item.exclusions.length === 0);
  if (eligible.length === 0) throw new Error("no available native candidate satisfies the task");

  const ranges = {
    cost: rangeFor(eligible, "cost"),
    latency: rangeFor(eligible, "latency"),
  };
  const taskTerms = terms(task);
  const ranked = eligible
    .map(({ candidate }) => {
      const quality = boundedNumber(candidate.quality, 0.5);
      const cost = inverseNormalized(candidate.cost, ranges.cost);
      const latency = inverseNormalized(candidate.latency, ranges.latency);
      const taskFit = strengthMatch(candidate.strengths, taskTerms);
      const score =
        0.85 * (quality * weights.quality + cost * weights.cost + latency * weights.latency) +
        0.15 * taskFit;
      return {
        id: candidate.id,
        kind: typeof candidate.kind === "string" ? candidate.kind : "model",
        score: Number(score.toFixed(6)),
        signals: { quality, cost, latency, taskFit },
      };
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

  const affinity = typeof input.affinity === "string" ? input.affinity : undefined;
  const affinityWinner = affinity ? ranked.find((item) => item.id === affinity) : undefined;
  const winner = affinityWinner ?? ranked[0];
  const excluded = evaluated
    .filter((item) => item.exclusions.length > 0)
    .slice(0, 32)
    .map((item) => ({ id: item.candidate.id, reasons: item.exclusions.slice(0, 8) }));
  const reason = affinityWinner
    ? `Kept eligible task affinity for ${winner.id}.`
    : `Selected ${winner.id} locally with the highest ${profile} score.`;

  return {
    selected: { id: winner.id, kind: winner.kind },
    profile,
    affinityUsed: Boolean(affinityWinner),
    explanation: reason.slice(0, 240),
    ranked: ranked.slice(0, 32),
    excluded,
  };
}

function normalizeRequirements(value) {
  if (Array.isArray(value)) return [...new Set(value.filter((item) => typeof item === "string"))];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value)
    .filter(([, required]) => required === true)
    .map(([capability]) => capability);
}

function hasCapability(value, requirement) {
  if (Array.isArray(value)) return value.includes(requirement);
  return Boolean(value && typeof value === "object" && value[requirement] === true);
}

function boundedNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

function rangeFor(items, key) {
  const values = items
    .map(({ candidate }) => candidate[key])
    .filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
  return values.length > 0 ? { min: Math.min(...values), max: Math.max(...values) } : undefined;
}

function inverseNormalized(value, range) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !range) return 0.5;
  if (range.max === range.min) return 0.5;
  return 1 - (value - range.min) / (range.max - range.min);
}

function terms(value) {
  return new Set(
    String(value)
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((item) => item.length > 2),
  );
}

function strengthMatch(strengths, taskTerms) {
  if (!Array.isArray(strengths) || strengths.length === 0 || taskTerms.size === 0) return 0;
  const strengthTerms = new Set(strengths.flatMap((strength) => [...terms(strength)]));
  const matches = [...strengthTerms].filter((term) => taskTerms.has(term)).length;
  return strengthTerms.size === 0 ? 0 : Math.min(1, matches / Math.min(4, strengthTerms.size));
}

async function readStdin() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = JSON.parse(await readStdin());
    process.stdout.write(`${JSON.stringify(selectNativeRoute(input), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

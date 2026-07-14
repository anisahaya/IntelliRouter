import { pathToFileURL } from "node:url";

/**
 * Select the best configured model across route_task results for multiple protocols.
 *
 * @param {{ routes?: Array<Record<string, unknown>> }} input
 */
export function selectCatalogRoute(input) {
  if (!Array.isArray(input?.routes) || input.routes.length === 0) {
    throw new Error("routes must contain at least one route_task result");
  }

  const bestByModel = new Map();
  for (const route of input.routes) {
    const protocol = typeof route.protocol === "string" ? route.protocol : undefined;
    if (!protocol || !Array.isArray(route.candidates)) continue;
    for (const candidate of route.candidates) {
      if (!candidate || typeof candidate !== "object" || candidate.eligible !== true) continue;
      const id = typeof candidate.modelId === "string" ? candidate.modelId : undefined;
      const score = candidate.scores?.total;
      if (!id || typeof score !== "number" || !Number.isFinite(score)) continue;
      const current = bestByModel.get(id);
      if (
        !current ||
        score > current.score ||
        (score === current.score && protocol.localeCompare(current.protocol) < 0)
      ) {
        bestByModel.set(id, { id, protocol, score });
      }
    }
  }

  const ranked = [...bestByModel.values()].sort(
    (left, right) =>
      right.score - left.score ||
      left.id.localeCompare(right.id) ||
      left.protocol.localeCompare(right.protocol),
  );
  if (ranked.length === 0) throw new Error("no eligible catalog model has a valid score");

  return {
    selected: ranked[0],
    ranked: ranked.slice(0, 32),
  };
}

async function readStdin() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = JSON.parse(await readStdin());
    process.stdout.write(`${JSON.stringify(selectCatalogRoute(input), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

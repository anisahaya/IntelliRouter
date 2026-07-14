import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { selectCatalogRoute } from "../scripts/select-catalog-route.mjs";

const route = (
  protocol: string,
  candidates: Array<{ modelId: string; eligible: boolean; total: number }>,
) => ({
  protocol,
  candidates: candidates.map(({ modelId, eligible, total }) => ({
    modelId,
    eligible,
    scores: { total },
  })),
});

describe("selectCatalogRoute", () => {
  it("selects the highest eligible score across protocols", () => {
    const result = selectCatalogRoute({
      routes: [
        route("openai-chat", [
          { modelId: "fast", eligible: true, total: 0.7 },
          { modelId: "offline", eligible: false, total: 1 },
        ]),
        route("anthropic-messages", [{ modelId: "reasoner", eligible: true, total: 0.9 }]),
      ],
    });

    expect(result.selected).toEqual({
      id: "reasoner",
      protocol: "anthropic-messages",
      score: 0.9,
    });
  });

  it("deduplicates models and breaks exact ties by model id", () => {
    const result = selectCatalogRoute({
      routes: [
        route("openai-responses", [
          { modelId: "shared", eligible: true, total: 0.6 },
          { modelId: "z-model", eligible: true, total: 0.8 },
        ]),
        route("openai-chat", [
          { modelId: "shared", eligible: true, total: 0.9 },
          { modelId: "a-model", eligible: true, total: 0.9 },
        ]),
      ],
    });

    expect(result.selected.id).toBe("a-model");
    expect(result.ranked.filter((candidate) => candidate.id === "shared")).toHaveLength(1);
    expect(result.ranked.find((candidate) => candidate.id === "shared")?.score).toBe(0.9);
  });

  it("rejects empty or unusable route results", () => {
    expect(() => selectCatalogRoute({ routes: [] })).toThrow(/routes/);
    expect(() =>
      selectCatalogRoute({
        routes: [route("openai-chat", [{ modelId: "x", eligible: false, total: 1 }])],
      }),
    ).toThrow(/no eligible catalog model/);
  });

  it("accepts route results on stdin", () => {
    const script = fileURLToPath(new URL("../scripts/select-catalog-route.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script], {
      input: JSON.stringify({
        routes: [route("openai-chat", [{ modelId: "winner", eligible: true, total: 0.8 }])],
      }),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).selected.id).toBe("winner");
  });
});

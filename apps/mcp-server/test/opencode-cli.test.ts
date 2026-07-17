import { describe, expect, it } from "vitest";
import {
  discoverOpenCodeModels,
  type OpenCodeCommandRunner,
  parseVerboseModels,
} from "../src/opencode-cli.js";

function catalog(...models: Array<Record<string, unknown>>): string {
  return models
    .map(
      (model) =>
        `${String(model.providerID)}/${String(model.id)}\n${JSON.stringify(model, null, 2)}`,
    )
    .join("\n");
}

function model(id: string, name: string, variants = ["low", "medium", "high"]) {
  return {
    id,
    providerID: "openai",
    name,
    family: id,
    status: "active",
    limit: { context: 500_000 },
    capabilities: { toolcall: true, attachment: true, input: { image: true } },
    variants: Object.fromEntries(
      variants.map((variant) => [variant, { reasoningEffort: variant }]),
    ),
  };
}

describe("OpenCode native catalog discovery", () => {
  it("parses verbose records and maps model capabilities and variants", async () => {
    const output = catalog(
      model("gpt-5.6-sol", "GPT-5.6 Sol", ["low", "high", "max"]),
      model("gpt-5.6-luna", "GPT-5.6 Luna", ["low", "medium", "ultra"]),
      { ...model("retired", "Retired"), status: "deprecated" },
    );
    const runner: OpenCodeCommandRunner = {
      async execFile(_file, args) {
        expect(args).toEqual(["models", "openai", "--verbose"]);
        return { stdout: output };
      },
    };
    const candidates = await discoverOpenCodeModels({ runner, provider: "openai" });
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      id: "openai/gpt-5.6-luna",
      kind: "harness-model",
      harness: "opencode",
      supportedEfforts: ["low", "medium", "ultra"],
      capabilities: { tools: true, vision: true, search: true, edit: true },
    });
    expect(candidates.find((candidate) => candidate.id.endsWith("sol"))?.quality).toBeGreaterThan(
      candidates.find((candidate) => candidate.id.endsWith("luna"))?.quality ?? 1,
    );
  });

  it("rejects malformed verbose metadata and an empty executable catalog", async () => {
    expect(() => parseVerboseModels('openai/model\n{"id":')).toThrow("invalid metadata");
    await expect(
      discoverOpenCodeModels({
        runner: {
          async execFile() {
            return { stdout: "diagnostic only" };
          },
        },
      }),
    ).rejects.toThrow("no visible executable models");
  });
});

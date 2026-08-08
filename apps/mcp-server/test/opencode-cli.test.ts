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
      async execFile(file, args, options) {
        expect(file).toBe("/custom/opencode");
        expect(args).toEqual(["models", "openai", "--verbose"]);
        expect(options).toEqual({
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
          shell: false,
          encoding: "utf8",
          env: {
            NO_COLOR: "1",
            HOME: "/home/test",
            PATH: "/test/bin",
            TMPDIR: "/tmp/test",
            LANG: "en_US.UTF-8",
            LC_ALL: "en_US.UTF-8",
            XDG_CONFIG_HOME: "/config",
            XDG_DATA_HOME: "/data",
            XDG_CACHE_HOME: "/cache",
          },
        });
        return { stdout: output };
      },
    };
    const candidates = await discoverOpenCodeModels({
      runner,
      provider: "openai",
      env: {
        OPENCODE_BIN: "/custom/opencode",
        HOME: "/home/test",
        PATH: "/test/bin",
        TMPDIR: "/tmp/test",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        XDG_CONFIG_HOME: "/config",
        XDG_DATA_HOME: "/data",
        XDG_CACHE_HOME: "/cache",
        TEST_SECRET: "must-not-pass",
      },
    });
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

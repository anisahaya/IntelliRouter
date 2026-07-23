import { describe, expect, it } from "vitest";
import { evaluateHistoricalCommit, importSeedDataset } from "../src/index.js";

describe("evaluation boundaries", () => {
  it("imports scoped seed records", async () => {
    let got: any;
    const n = await importSeedDataset(
      {
        manifest: {
          provenance: "x",
          revision: "1",
          license: "MIT",
          modelPair: { source: "a", target: "b" },
          labelSemantics: "correct",
        },
        records: (async function* () {
          yield { externalId: "e", input: "i", label: "correct", strength: "attested" as const };
        })(),
      },
      "s",
      (r) => {
        got = r;
      },
    );
    expect(n).toBe(1);
    expect(got.labelNamespace).toContain("a->b");
  });
  it("does not label invalid boundaries", async () => {
    const r = await evaluateHistoricalCommit({
      baseSha: "bad",
      targetSha: "bad",
      clean: true,
      allowedPaths: ["src"],
      objective: "x",
      heldOut: [["test"]],
      candidateExecutor: {} as any,
      commandRunner: {} as any,
      sandboxFactory: {} as any,
    });
    expect(r.label).toBe("unknown");
  });
});

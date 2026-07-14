import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { selectNativeRoute } from "../scripts/select-native-route.mjs";

const host = {
  id: "current-host",
  kind: "model",
  available: true,
  capabilities: { tools: true, vision: false },
  quality: 0.7,
  cost: 0.5,
  latency: 0.5,
  strengths: ["general coding"],
};

describe("selectNativeRoute", () => {
  it("filters unavailable and incapable candidates before local scoring", () => {
    const result = selectNativeRoute({
      task: "Inspect a screenshot with vision",
      requirements: { vision: true },
      candidates: [
        host,
        {
          id: "vision-agent",
          kind: "agent",
          available: true,
          capabilities: ["vision", "tools"],
          quality: 0.8,
          strengths: ["vision screenshot"],
        },
        {
          id: "offline-agent",
          available: false,
          capabilities: ["vision"],
          quality: 1,
        },
      ],
    });

    expect(result.selected.id).toBe("vision-agent");
    expect(result.excluded).toEqual([
      { id: "current-host", reasons: ["missing capability: vision"] },
      { id: "offline-agent", reasons: ["unavailable"] },
    ]);
  });

  it("honors eligible affinity even when another candidate scores higher", () => {
    const result = selectNativeRoute({
      task: "Continue the implementation",
      affinity: "current-host",
      candidates: [host, { ...host, id: "premium-agent", quality: 1 }],
    });

    expect(result.selected.id).toBe("current-host");
    expect(result.affinityUsed).toBe(true);
  });

  it("uses task strengths then id as deterministic tie breakers", () => {
    const candidates = [
      { ...host, id: "z-general" },
      { ...host, id: "reviewer", strengths: ["security review"] },
      { ...host, id: "a-general" },
    ];
    expect(selectNativeRoute({ task: "Perform a security review", candidates }).selected.id).toBe(
      "reviewer",
    );
    expect(
      selectNativeRoute({ task: "Unrelated objective", candidates: [candidates[0], candidates[2]] })
        .selected.id,
    ).toBe("a-general");
  });

  it("changes the winner when the local profile priorities change", () => {
    const candidates = [
      { ...host, id: "high-quality", quality: 1, cost: 100, latency: 100 },
      { ...host, id: "economical", quality: 0.4, cost: 0, latency: 10 },
    ];

    expect(
      selectNativeRoute({ task: "Implement feature", profile: "premium", candidates }).selected.id,
    ).toBe("high-quality");
    expect(
      selectNativeRoute({ task: "Implement feature", profile: "economy", candidates }).selected.id,
    ).toBe("economical");
  });

  it("returns the current host when it is the only discovered candidate", () => {
    const result = selectNativeRoute({ task: "Continue here", candidates: [host] });
    expect(result.selected).toEqual({ id: "current-host", kind: "model" });
    expect(result.affinityUsed).toBe(false);
  });

  it("rejects missing, malformed, and duplicate candidate inventories", () => {
    expect(() => selectNativeRoute({ task: "x", candidates: [] })).toThrow(/candidates/);
    expect(() => selectNativeRoute({ task: "x", candidates: [{}] })).toThrow(/non-empty id/);
    expect(() => selectNativeRoute({ task: "x", candidates: [host, host] })).toThrow(
      /duplicate candidate id/,
    );
  });

  it("accepts inventory JSON on stdin for host-neutral CLI use", () => {
    const script = fileURLToPath(new URL("../scripts/select-native-route.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script], {
      input: JSON.stringify({ task: "Continue", candidates: [host] }),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).selected.id).toBe("current-host");
  });
});

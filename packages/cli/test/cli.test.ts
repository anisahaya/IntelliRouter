import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initConfig } from "../src/config-init.js";
import { doctor } from "../src/doctor.js";
import { explainRoute } from "../src/explain.js";
import { submitFeedback } from "../src/feedback.js";
import { controlRequest } from "../src/http.js";
import { routeTask } from "../src/route.js";
import { getStats } from "../src/stats.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MODEL_ROUTER_BASE_URL;
  delete process.env.MODEL_ROUTER_AUTH_TOKEN;
  delete process.env.DOCTOR_MISSING_KEY;
});

describe("CLI clients", () => {
  it("sends route, stats, feedback, and explain options", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    process.env.MODEL_ROUTER_BASE_URL = "http://router/";
    process.env.MODEL_ROUTER_AUTH_TOKEN = "secret";
    await routeTask("task", "custom", { protocol: "openai-responses", model: "a" });
    await getStats("1h", "a", "code");
    await submitFeedback("r1", "success", 1, ["accepted"]);
    await explainRoute("r1");
    expect(calls).toHaveLength(4);
    expect(calls[0]?.url).toBe("http://router/router/route");
    expect(calls[1]?.url).toContain("model=a");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer secret");
  });

  it("handles non-json errors and absolute since values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("plain failure", { status: 502 })),
    );
    await expect(controlRequest("/bad")).rejects.toThrow("plain failure");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    await getStats("2026-01-01T00:00:00Z");
  });

  it("creates a safe example config without overwriting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-cli-"));
    const path = join(directory, "router.yaml");
    expect(await initConfig(path)).toBe(path);
    const original = await readFile(path, "utf8");
    expect(original).toContain("storePrompts: false");
    await writeFile(path, "mine");
    await expect(initConfig(path)).rejects.toThrow();
  });

  it("diagnoses configuration, placeholders, missing keys, and optional probes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-doctor-"));
    const path = join(directory, "router.yaml");
    const databasePath = join(directory, "router.db");
    await writeFile(
      path,
      `server:\n  databasePath: ${databasePath}\nmodels:\n  - id: example\n    provider: openai-compatible\n    upstreamModel: provider/model\n    baseUrl: https://api.example/v1\n    apiKeyEnv: DOCTOR_MISSING_KEY\n    capabilities:\n      protocols: [openai-chat]\n      maxContextTokens: 1000\nrouting:\n  defaultProfile: balanced\n  profiles:\n    balanced:\n      weights: { quality: 0.5, cost: 0.3, latency: 0.2 }\n`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: "probe" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const result = await doctor(path, true);
    expect(result).toMatchObject({ config: "ok", database: "ok", models: 1 });
    expect(result.missingEnvironment).toContain("DOCTOR_MISSING_KEY");
    expect(result.placeholders).toHaveLength(2);
    expect(result.probes).toEqual([{ model: "example", reachable: false }]);
    process.env.DOCTOR_MISSING_KEY = "probe-key";
    expect((await doctor(path, true)).probes).toEqual([
      { model: "example", reachable: true, status: 200 },
    ]);
  });
});

import { loadConfig, requiredEnvironmentVariables, resolveApiKey } from "@model-router/config";
import { adapterFor } from "@model-router/providers";
import { TelemetryStore } from "@model-router/telemetry";
import { normalizeRequest } from "../../../apps/proxy/src/routes/normalize.js";

export async function doctor(configPath?: string, probe = false): Promise<Record<string, unknown>> {
  const config = await loadConfig(configPath, { validateEnv: false });
  const store = new TelemetryStore(config.server.databasePath);
  store.close();
  const result: Record<string, unknown> = {
    config: "ok",
    database: "ok",
    models: config.models.length,
    missingEnvironment: requiredEnvironmentVariables(config).filter((name) => !process.env[name]),
    placeholders: config.models.flatMap((model) => {
      const fields: string[] = [];
      if (/\.example(?:\/|$)/i.test(model.baseUrl)) fields.push("baseUrl");
      if (/provider\/model|provider-model/i.test(model.upstreamModel)) fields.push("upstreamModel");
      return fields.map((field) => ({ model: model.id, field }));
    }),
  };
  if (probe) {
    result.probes = await Promise.all(
      config.models
        .filter((model) => model.enabled)
        .map(async (model) => {
          try {
            const protocol = model.capabilities.protocols[0];
            if (!protocol) throw new Error("model has no supported protocol");
            const body =
              protocol === "openai-responses"
                ? { model: "auto", input: "health probe", max_output_tokens: 1 }
                : {
                    model: "auto",
                    messages: [{ role: "user", content: "health probe" }],
                    max_tokens: 1,
                  };
            const adapter = adapterFor(model);
            const request = normalizeRequest(protocol, body);
            const prepared = adapter.prepareRequest(model, request, resolveApiKey(model));
            const response = await adapter.send(prepared, AbortSignal.timeout(10_000));
            await response.body?.cancel();
            return { model: model.id, reachable: response.ok, status: response.status };
          } catch {
            return { model: model.id, reachable: false };
          }
        }),
    );
  }
  return result;
}

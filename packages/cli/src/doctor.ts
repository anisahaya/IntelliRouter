import { loadConfig } from "@model-router/config";
import { TelemetryStore } from "@model-router/telemetry";

export async function doctor(configPath?: string, probe = false): Promise<Record<string, unknown>> {
  const config = await loadConfig(configPath);
  const store = new TelemetryStore(config.server.databasePath);
  store.close();
  const result: Record<string, unknown> = {
    config: "ok",
    database: "ok",
    models: config.models.length,
  };
  if (probe) {
    result.probes = await Promise.all(
      config.models
        .filter((model) => model.enabled)
        .map(async (model) => {
          try {
            const response = await fetch(model.baseUrl, {
              method: "HEAD",
              signal: AbortSignal.timeout(5_000),
            });
            return { model: model.id, reachable: response.status < 500 };
          } catch {
            return { model: model.id, reachable: false };
          }
        }),
    );
  }
  return result;
}

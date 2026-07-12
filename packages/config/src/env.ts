import type { ModelDefinition, RouterConfig } from "@model-router/contracts";

export function requiredEnvironmentVariables(config: RouterConfig): string[] {
  const variables = config.models.filter((model) => model.enabled).map((model) => model.apiKeyEnv);
  if (config.server.authTokenEnv) variables.push(config.server.authTokenEnv);
  return [...new Set(variables)];
}

export function resolveApiKey(model: ModelDefinition, env = process.env): string {
  const value = env[model.apiKeyEnv];
  if (!value) throw new Error(`missing environment variable: ${model.apiKeyEnv}`);
  return value;
}

export function validateEnvironment(config: RouterConfig, env = process.env): void {
  const missing = requiredEnvironmentVariables(config).filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`missing environment variables: ${missing.join(", ")}`);
}

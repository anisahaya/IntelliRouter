import { loadConfig, validateEnvironment } from "@model-router/config";
import { type RouterConfig, routerConfigSchema } from "@model-router/contracts";
import { RoutingEngine } from "@model-router/router-core";
import { TelemetryStore } from "@model-router/telemetry";
import Fastify, { type FastifyInstance } from "fastify";
import { installAuth } from "./plugins/auth.js";
import { installErrors } from "./plugins/errors.js";
import { installRequestContext } from "./plugins/request-context.js";
import { registerAnthropicMessages } from "./routes/anthropic-messages.js";
import { registerControl } from "./routes/control.js";
import { registerHealth } from "./routes/health.js";
import { registerModels } from "./routes/models.js";
import { registerOpenAIChat } from "./routes/openai-chat.js";
import { registerOpenAIResponses } from "./routes/openai-responses.js";

export interface RouterRuntime {
  config: RouterConfig;
  store: TelemetryStore;
  engine: RoutingEngine;
  env: NodeJS.ProcessEnv;
}

export interface BuildAppOptions {
  config?: RouterConfig;
  configPath?: string;
  store?: TelemetryStore;
  env?: NodeJS.ProcessEnv;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? process.env;
  const config = options.config
    ? routerConfigSchema.parse(options.config)
    : await loadConfig(options.configPath, { env });
  validateEnvironment(config, env);
  for (const model of config.models.filter((item) => item.enabled)) {
    if (
      /\.example(?:\/|$)|provider\/model|provider-model/i.test(
        `${model.baseUrl} ${model.upstreamModel}`,
      )
    ) {
      throw new Error(`enabled model ${model.id} uses placeholder provider configuration`);
    }
  }
  const store =
    options.store ??
    new TelemetryStore(config.server.databasePath, {
      privacy: config.privacy,
    });
  store.taskRuns.configurePrivacy(config.privacy);
  store.configureHealth(config.routing.health);
  const engine = new RoutingEngine(
    config,
    store,
    env.MODEL_ROUTER_SESSION_SALT ?? store.sessionSalt(),
  );
  const runtime: RouterRuntime = { config, store, engine, env };
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.proxy-authorization",
                "req.headers.x-api-key",
                "req.headers.cookie",
                "res.headers.set-cookie",
              ],
              censor: "[REDACTED]",
            },
          },
    bodyLimit: config.server.bodyLimitBytes,
    requestIdHeader: "x-request-id",
  });
  const token = config.server.authTokenEnv ? env[config.server.authTokenEnv] : undefined;
  if (config.server.authTokenEnv && !token?.trim()) {
    throw new Error(
      `Authentication token environment variable ${config.server.authTokenEnv} is configured but unresolved; refusing to start an unauthenticated server`,
    );
  }
  installAuth(app, token);
  installRequestContext(app);
  installErrors(app);
  registerHealth(app, runtime);
  registerModels(app, runtime);
  registerOpenAIChat(app, runtime);
  registerOpenAIResponses(app, runtime);
  registerAnthropicMessages(app, runtime);
  registerControl(app, runtime);
  app.addHook("onClose", async () => store.close());
  return app;
}

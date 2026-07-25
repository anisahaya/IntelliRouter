import { fileURLToPath } from "node:url";
import { loadConfig } from "@model-router/config";
import { buildApp } from "./app.js";

export async function startServer(configPath?: string): Promise<void> {
  const config = await loadConfig(configPath);
  const app = await buildApp({ config });
  if (
    config.privacy.storePrompts ||
    config.privacy.storeResponses ||
    config.privacy.storeSource ||
    config.privacy.storeEmbeddings
  ) {
    app.log.warn(
      "opt-in task content or embedding storage was requested; automatic runtime capture remains disabled and only explicit bounded task-run APIs can persist it",
    );
  }
  const address = await app.listen({ host: config.server.host, port: config.server.port });
  app.log.info({ address }, "model router listening");
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const force = setTimeout(() => process.exit(1), 10_000).unref();
    await app.close();
    clearTimeout(force);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer(process.env.MODEL_ROUTER_CONFIG).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

import { Command } from "commander";
import { initConfig } from "./config-init.js";
import { doctor } from "./doctor.js";
import { explainRoute } from "./explain.js";
import { submitFeedback } from "./feedback.js";
import { routeTask } from "./route.js";
import { serve } from "./serve.js";
import { getStats } from "./stats.js";

const program = new Command()
  .name("model-router")
  .description("Local, harness-aware model router")
  .version("0.1.0");
program
  .command("serve")
  .option("--config <path>")
  .action((options) => serve(options.config));
program
  .command("doctor")
  .option("--config <path>")
  .option("--probe")
  .action(async (options) => print(await doctor(options.config, options.probe)));
program
  .command("route")
  .requiredOption("--task <task>")
  .option("--profile <profile>", "routing profile", "balanced")
  .action(async (options) => print(await routeTask(options.task, options.profile)));
program.command("explain <route-id>").action(async (id) => print(await explainRoute(id)));
program
  .command("stats")
  .option("--since <time>")
  .action(async (options) => print(await getStats(options.since)));
program
  .command("feedback <route-id>")
  .requiredOption("--outcome <outcome>")
  .action(async (id, options) => print(await submitFeedback(id, options.outcome)));
program
  .command("config")
  .command("init [path]")
  .action(async (path) => print({ path: await initConfig(path) }));

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

program.parseAsync().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

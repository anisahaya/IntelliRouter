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
  .option("--protocol <protocol>", "request protocol", "openai-chat")
  .option("--session <session>")
  .option("--model <model>")
  .option("--tools")
  .option("--json")
  .option("--vision")
  .option("--streaming")
  .option("--minimum-context <tokens>", "minimum context tokens", Number)
  .action(async (options) =>
    print(
      await routeTask(options.task, options.profile, {
        protocol: options.protocol,
        session: options.session,
        model: options.model,
        requirements: {
          tools: options.tools,
          json: options.json,
          vision: options.vision,
          streaming: options.streaming,
          minimumContextTokens: options.minimumContext,
        },
      }),
    ),
  );
program.command("explain <route-id>").action(async (id) => print(await explainRoute(id)));
program
  .command("stats")
  .option("--since <time>")
  .option("--model <model>")
  .option("--task <task>")
  .action(async (options) => print(await getStats(options.since, options.model, options.task)));
program
  .command("feedback <route-id>")
  .requiredOption("--outcome <outcome>")
  .option("--score <score>", "score from 0 to 1", Number)
  .option("--tag <tag...>")
  .action(async (id, options) =>
    print(await submitFeedback(id, options.outcome, options.score, options.tag ?? [])),
  );
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

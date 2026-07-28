import { Command } from "commander";
import { routeHarnessTask } from "../../../apps/mcp-server/src/harness-router.js";
import { getRouteRecord } from "../../../apps/mcp-server/src/route-state.js";
import { initConfig } from "./config-init.js";
import { doctor } from "./doctor.js";
import { explainRoute } from "./explain.js";
import { submitFeedback } from "./feedback.js";
import { nativeDoctor } from "./native-doctor.js";
import { routeTask } from "./route.js";
import { serve } from "./serve.js";
import { setupHarness } from "./setup.js";
import { getStats } from "./stats.js";

const invokedAs = process.argv[1]?.toLowerCase().split(/[\\/]/).pop() ?? "";
if (
  process.env.INTELLIROUTER_LEGACY_ALIAS === "1" ||
  invokedAs === "model-router" ||
  invokedAs === "model-router.js"
) {
  process.stderr.write("Warning: model-router is deprecated; use intellirouter instead.\n");
}
const program = new Command()
  .name("intellirouter")
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
  .option("--harness <harness>", "codex, opencode, claude-code, pi, or all")
  .option("--strict", "require every selected harness to pass")
  .action(async (options) =>
    print(
      options.harness
        ? await nativeDoctor(options.harness, Boolean(options.strict))
        : await doctor(options.config, options.probe),
    ),
  );
program
  .command("setup")
  .option("--harness <harness>", "codex, opencode, claude-code, pi, or all", "codex")
  .option("--force", "replace an existing Codex MCP entry")
  .option("--opencode-config <path>", "override the OpenCode config path")
  .action(async (options) =>
    print(
      await setupHarness(options.harness, {
        force: options.force,
        configPath: options.opencodeConfig,
      }),
    ),
  );
program
  .command("route-native")
  .description("Dry-run the signed-in Codex/OpenCode models or Claude Code aliases")
  .requiredOption("--harness <harness>", "codex, opencode, or claude-code")
  .requiredOption("--objective <objective>")
  .option("--workspace <path>", "trusted workspace", process.cwd())
  .option("--current-model <model>")
  .option("--session <id>")
  .option("--profile <profile>", "balanced, quality, economy, or speed", "balanced")
  .option("--edit")
  .option("--vision")
  .option("--search")
  .option("--minimum-context <tokens>", "minimum context tokens", Number, 0)
  .action(async (options) =>
    print(
      await routeHarnessTask({
        harness: options.harness,
        objective: options.objective,
        workspaceRoot: options.workspace,
        currentModel: options.currentModel,
        sessionId: options.session,
        profile: options.profile,
        requirements: {
          tools: true,
          edit: Boolean(options.edit),
          vision: Boolean(options.vision),
          search: Boolean(options.search),
          minimumContextTokens: options.minimumContext,
        },
      }),
    ),
  );
program
  .command("explain-native <route-id>")
  .description("Read persisted privacy-safe native route diagnostics")
  .action(async (routeId) => {
    const route = await getRouteRecord(routeId);
    if (!route) throw new Error(`Unknown harness route: ${routeId}`);
    print(route);
  });
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

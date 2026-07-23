import type { HarnessId } from "@model-router/contracts";
import { setupClaude, setupCodex } from "./setup-native.js";
import { setupOpenCode } from "./setup-opencode.js";
import { installedAssets } from "./setup-shared.js";

export { claudeMcpAddArgs } from "./setup-native.js";
export { parseJsonc } from "./setup-opencode.js";

export async function setupHarness(
  harness: HarnessId | "all",
  options: { force?: boolean; configPath?: string } = {},
): Promise<Record<string, unknown>> {
  const assets = await installedAssets();
  const selected = harness === "all" ? (["codex", "opencode", "claude-code"] as const) : [harness];
  const results = [];
  for (const value of selected) {
    if (value === "codex") results.push(await setupCodex(assets, options.force));
    else if (value === "opencode") {
      results.push(await setupOpenCode(assets, options.configPath));
    } else if (value === "claude-code") results.push(await setupClaude(assets, options.force));
    else {
      results.push({
        harness: value,
        configured: false,
        nativeAdapter: false,
        message: "Use the compatibility gateway example for this harness.",
      });
    }
  }
  return { assets, results, restartRequired: true };
}

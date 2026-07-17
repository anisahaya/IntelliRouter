import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ClaudeCommandRunner,
  discoverClaudeModels,
  parseClaudeAuth,
} from "../src/claude-cli.js";

describe("Claude Code native catalog discovery", () => {
  it("uses signed-in model aliases and honors the configured allowlist", async () => {
    const runner: ClaudeCommandRunner = {
      async execFile(_file, args) {
        expect(args).toEqual(["auth", "status", "--json"]);
        return { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) };
      },
    };
    const candidates = await discoverClaudeModels({
      runner,
      availableModels: ["opus", "sonnet", "haiku"],
    });
    expect(candidates.map((candidate) => candidate.id)).toEqual(["haiku", "opus", "sonnet"]);
    expect(candidates.find((candidate) => candidate.id === "opus")).toMatchObject({
      harness: "claude-code",
      quality: 0.98,
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      capabilities: { tools: true, vision: true, search: true, edit: true },
    });
  });

  it("rejects invalid auth output and signed-out sessions", async () => {
    expect(() => parseClaudeAuth("not-json")).toThrow("invalid authentication status");
    await expect(
      discoverClaudeModels({
        runner: {
          async execFile() {
            return { stdout: JSON.stringify({ loggedIn: false }) };
          },
        },
      }),
    ).rejects.toThrow("not signed in");
    await expect(
      discoverClaudeModels({
        runner: {
          async execFile() {
            return { stdout: JSON.stringify({ loggedIn: true }) };
          },
        },
        availableModels: [],
      }),
    ).rejects.toThrow("no routable model aliases");
  });

  it("reads availableModels from the configured Claude settings directory", async () => {
    const config = await mkdtemp(join(tmpdir(), "model-router-claude-config-"));
    await writeFile(
      join(config, "settings.json"),
      JSON.stringify({ availableModels: ["sonnet", 42, "haiku", "sonnet"] }),
    );
    const runner: ClaudeCommandRunner = {
      async execFile(_file, _args, options) {
        expect(options.env).toMatchObject({
          NO_COLOR: "1",
          CLAUDE_CONFIG_DIR: config,
          PATH: "/test/bin",
        });
        return { stdout: JSON.stringify({ loggedIn: true }) };
      },
    };
    const candidates = await discoverClaudeModels({
      runner,
      env: { CLAUDE_CONFIG_DIR: config, PATH: "/test/bin" },
    });
    expect(candidates.map((candidate) => candidate.id)).toEqual(["haiku", "sonnet"]);
  });

  it("uses default aliases when settings are absent and reports malformed settings", async () => {
    const config = await mkdtemp(join(tmpdir(), "model-router-claude-defaults-"));
    const runner: ClaudeCommandRunner = {
      async execFile() {
        return { stdout: JSON.stringify({ loggedIn: true }) };
      },
    };
    await expect(
      discoverClaudeModels({ runner, env: { CLAUDE_CONFIG_DIR: config } }),
    ).resolves.toHaveLength(3);
    const settingsPath = join(config, "settings.json");
    await writeFile(settingsPath, "not-json");
    await expect(discoverClaudeModels({ runner, settingsPath })).rejects.toThrow(
      "Unable to read Claude Code model settings",
    );
  });
});

import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectRepoSignals, type RepoCommandRunner } from "../src/repo-signals.js";

describe("repository signal collection", () => {
  it("collects aggregate metadata without following symlinks or including ignored secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "router-repo-signals-"));
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "package.json"), "secret source contents");
    await writeFile(join(root, ".env.local"), "API_KEY=secret");
    await writeFile(join(root, "src", "index.ts"), "const secret = 'do not read';");
    await writeFile(join(root, "src", "index.test.ts"), "test('x', () => {});");
    await writeFile(join(root, "node_modules", "ignored.js"), "ignored");
    await symlink(join(root, "src"), join(root, "linked-src"));
    const calls: Array<{ file: string; args: string[]; shell: boolean }> = [];
    const runner: RepoCommandRunner = {
      async execFile(file, args, options) {
        calls.push({ file, args, shell: options.shell });
        return {
          stdout:
            args[0] === "status"
              ? " M src/index.ts\n?? src/index.test.ts\n"
              : "3\t1\tsrc/index.ts\n-\t-\tbinary\n",
        };
      },
    };

    const signals = await collectRepoSignals(root, { runner });
    expect(signals).toMatchObject({
      fileCount: 3,
      testFileCount: 1,
      manifests: ["package.json"],
      changedFileCount: 2,
      diffInsertions: 3,
      diffDeletions: 1,
      hasTests: true,
      dirty: true,
      truncated: false,
    });
    expect(signals.languages).toEqual([{ name: "TypeScript", count: 2 }]);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.file === "git" && call.shell === false)).toBe(true);
    expect(calls[1]?.args).toEqual(["diff", "--numstat", "--no-renames", "--", "."]);
    expect(JSON.stringify(signals)).not.toContain("secret");
  });

  it("enforces traversal caps and degrades safely outside git", async () => {
    const root = await mkdtemp(join(tmpdir(), "router-repo-caps-"));
    await writeFile(join(root, "a.ts"), "a");
    await writeFile(join(root, "b.ts"), "b");
    const runner: RepoCommandRunner = {
      async execFile() {
        throw new Error("not a git repository");
      },
    };
    const signals = await collectRepoSignals(root, { runner, maxFiles: 1 });
    expect(signals.fileCount).toBe(1);
    expect(signals.truncated).toBe(true);
    expect(signals.changedFileCount).toBe(0);
  });
});

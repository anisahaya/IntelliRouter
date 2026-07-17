import { execFile } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import type { RepoSignals } from "@model-router/contracts";

const execFileAsync = promisify(execFile);
const ignoredDirectories = new Set([".git", "node_modules", "dist", "coverage"]);
const manifestNames = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "Gemfile",
]);
const languageByExtension: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".py": "Python",
  ".rs": "Rust",
  ".go": "Go",
  ".java": "Java",
  ".rb": "Ruby",
  ".swift": "Swift",
  ".kt": "Kotlin",
  ".c": "C",
  ".cc": "C++",
  ".cpp": "C++",
  ".cs": "C#",
};

export interface RepoSignalLimits {
  maxFiles?: number;
  maxDirectories?: number;
  maxDepth?: number;
  maxDurationMs?: number;
}

export interface RepoSignalOptions extends RepoSignalLimits {
  runner?: RepoCommandRunner;
}

export interface RepoCommandRunner {
  execFile(
    file: string,
    args: string[],
    options: { cwd: string; timeout: number; maxBuffer: number; shell: false },
  ): Promise<{ stdout: string }>;
}

export async function collectRepoSignals(
  root: string,
  options: RepoSignalOptions = {},
): Promise<RepoSignals> {
  const runner = options.runner ?? systemRunner;
  const workspace = await realpath(root);
  if (!(await stat(workspace)).isDirectory()) throw new Error("workspace root must be a directory");
  const maxFiles = options.maxFiles ?? 5_000;
  const maxDirectories = options.maxDirectories ?? 500;
  const maxDepth = options.maxDepth ?? 12;
  const deadline = Date.now() + (options.maxDurationMs ?? 2_000);
  const queue: Array<{ path: string; depth: number }> = [{ path: workspace, depth: 0 }];
  const languages = new Map<string, number>();
  const manifests = new Set<string>();
  let fileCount = 0;
  let testFileCount = 0;
  let directoryCount = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (Date.now() >= deadline) {
      truncated = true;
      break;
    }
    const current = queue.shift();
    if (!current) break;
    if (++directoryCount > maxDirectories) {
      truncated = true;
      break;
    }
    const entries = await readdir(current.path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name) || entry.name.startsWith(".env")) continue;
        if (current.depth >= maxDepth) {
          truncated = true;
          continue;
        }
        queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || entry.name.startsWith(".env")) continue;
      if (++fileCount > maxFiles) {
        fileCount = maxFiles;
        truncated = true;
        queue.length = 0;
        break;
      }
      if (manifestNames.has(entry.name)) manifests.add(entry.name);
      if (/(?:^|[._-])(?:test|spec)(?:[._-]|$)|^tests?$/i.test(entry.name)) testFileCount++;
      const language = languageByExtension[extname(entry.name).toLowerCase()];
      if (language) languages.set(language, (languages.get(language) ?? 0) + 1);
    }
  }

  const git = await collectGitSignals(workspace, runner);
  return {
    rootName: basename(workspace),
    languages: [...languages.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([name, count]) => ({ name, count })),
    fileCount,
    testFileCount,
    manifests: [...manifests].sort(),
    changedFileCount: git.changedFileCount,
    diffInsertions: git.diffInsertions,
    diffDeletions: git.diffDeletions,
    hasTests: testFileCount > 0,
    monorepo: manifests.has("pnpm-workspace.yaml"),
    dirty: git.changedFileCount > 0,
    truncated,
  };
}

async function collectGitSignals(root: string, runner: RepoCommandRunner) {
  try {
    const [statusResult, diffResult] = await Promise.all([
      runner.execFile(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        gitOptions(root),
      ),
      runner.execFile("git", ["diff", "--numstat", "--no-renames", "--", "."], gitOptions(root)),
    ]);
    const changedFileCount = statusResult.stdout.split("\n").filter(Boolean).length;
    let diffInsertions = 0;
    let diffDeletions = 0;
    for (const line of diffResult.stdout.split("\n")) {
      const [insertions, deletions] = line.split("\t", 3);
      if (insertions && /^\d+$/.test(insertions)) diffInsertions += Number(insertions);
      if (deletions && /^\d+$/.test(deletions)) diffDeletions += Number(deletions);
    }
    return { changedFileCount, diffInsertions, diffDeletions };
  } catch {
    return { changedFileCount: 0, diffInsertions: 0, diffDeletions: 0 };
  }
}

function gitOptions(cwd: string) {
  return { cwd, timeout: 5_000, maxBuffer: 512 * 1024, shell: false as const };
}

const systemRunner: RepoCommandRunner = {
  async execFile(file, args, options) {
    const result = await execFileAsync(file, args, { ...options, encoding: "utf8" });
    return { stdout: result.stdout };
  },
};

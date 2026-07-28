import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn } from "cross-spawn";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const root = await mkdtemp(join(tmpdir(), "intellirouter-smoke-"));
try {
  const packed = await run(npm, ["pack", "--json", "--pack-destination", root], {
    cwd: process.cwd(),
  });
  const tarball = JSON.parse(packed.stdout)[0]?.filename;
  if (!tarball) throw new Error("npm pack did not produce an artifact");
  await run(npm, ["init", "-y"], { cwd: root });
  await run(npm, ["install", join(root, tarball)], { cwd: root });
  const bin =
    process.platform === "win32"
      ? join(root, "node_modules", ".bin", "intellirouter.cmd")
      : join(root, "node_modules", ".bin", "intellirouter");
  const help = await run(bin, ["--help"], { cwd: root });
  const version = await run(bin, ["--version"], { cwd: root });
  const legacy = await run(
    process.platform === "win32"
      ? join(root, "node_modules", ".bin", "model-router.cmd")
      : join(root, "node_modules", ".bin", "model-router"),
    ["--version"],
    { cwd: root },
  );
  if (
    !help.stdout.includes("Usage: intellirouter") ||
    !/^0\.1\.0/.test(version.stdout.trim()) ||
    !legacy.stderr.includes("deprecated")
  )
    throw new Error("package CLI smoke assertions failed");

  const fakeBin = join(root, "fake-bin");
  const isolatedHome = join(root, "home");
  await Promise.all([mkdir(fakeBin), mkdir(isolatedHome)]);
  const fakeCodex = join(fakeBin, "codex.mjs");
  const fakeSource = [
    "const args = process.argv.slice(2);",
    'if (args[0] === "mcp" && args[1] === "get") process.exit(1);',
    'if (args[0] === "mcp" && args[1] === "add") process.exit(0);',
    'if (args[0] === "--version") { console.log("codex-cli smoke"); process.exit(0); }',
    "console.error(`unexpected fake Codex args: ${JSON.stringify(args)}`);",
    "process.exit(2);",
    "",
  ].join("\n");
  await writeFile(fakeCodex, fakeSource);
  if (process.platform === "win32") {
    await writeFile(
      join(fakeBin, "codex.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0\\codex.mjs" %*\r\n`,
    );
  } else {
    const launcher = join(fakeBin, "codex");
    await writeFile(launcher, `#!/usr/bin/env node\n${fakeSource}`);
    await chmod(launcher, 0o755);
  }
  const setup = await run(bin, ["setup"], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      CODEX_HOME: join(isolatedHome, ".codex"),
    },
  });
  const setupResult = JSON.parse(setup.stdout);
  const codexSetup = setupResult.results?.[0];
  if (codexSetup?.configured !== true || codexSetup.changed !== true) {
    throw new Error(`isolated Codex setup smoke failed: ${setup.stdout.trim()}`);
  }
  console.log("package smoke passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      ...options,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `${file} exited ${code}`));
    });
  });
}

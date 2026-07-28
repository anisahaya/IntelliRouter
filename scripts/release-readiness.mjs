import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const ref = process.env.GITHUB_REF ?? "";
const tag = process.env.GITHUB_REF_NAME;
if (ref.startsWith("refs/tags/") && tag !== `v${pkg.version}`)
  throw new Error(`tag ${tag} does not match package version ${pkg.version}`);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packDirectory = await mkdtemp(join(tmpdir(), "intellirouter-release-readiness-"));
const { stdout } = await execFileAsync(
  npm,
  ["pack", "--json", "--pack-destination", packDirectory],
  { encoding: "utf8" },
);
const artifact = JSON.parse(stdout)[0];
if (!artifact?.filename || !artifact.filename.startsWith(`${pkg.name}-${pkg.version}`)) {
  throw new Error(`unexpected packed artifact: ${artifact?.filename ?? "none"}`);
}
const names = new Set((artifact.files ?? []).map((file) => file.path));
for (const required of [
  "dist/cli/index.js",
  "dist/mcp-server/index.js",
  "skills/intelligent-model-router/SKILL.md",
  ".mcp.json",
  ".codex-plugin/plugin.json",
  "README.md",
  "LICENSE",
  "SECURITY.md",
]) {
  if (!names.has(required)) throw new Error(`missing required package file: ${required}`);
}
const unsafe = [...names].filter((name) =>
  /(^|\/)(?:\.env|node_modules|\.git|coverage|\.model-router|.*\.log$)/i.test(name),
);
if (unsafe.length) throw new Error(`unsafe files in package: ${unsafe.join(", ")}`);
console.log(
  JSON.stringify({
    version: pkg.version,
    artifact: artifact.filename,
    files: artifact.files?.length ?? 0,
  }),
);

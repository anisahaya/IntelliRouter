import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const kind = process.argv[2];
const root = fileURLToPath(new URL("..", import.meta.url));
const fail = (message) => {
  throw new Error(`validate: ${message}`);
};

async function exists(path) {
  try {
    await access(resolve(root, path));
    return true;
  } catch {
    return false;
  }
}

async function validateSkill() {
  const path = "skills/intelligent-model-router/SKILL.md";
  if (!(await exists(path))) fail(`missing ${path}`);
  const text = await readFile(resolve(root, path), "utf8");
  if (!text.startsWith("---\n") || !text.includes("name: intelligent-model-router"))
    fail("skill frontmatter is missing name");
  for (const required of ["description:", "route_harness_task", "references/"])
    if (!text.includes(required)) fail(`skill missing ${required}`);
  console.log("skill validation passed");
}

async function validatePlugin() {
  const path = ".codex-plugin/plugin.json";
  if (!(await exists(path))) fail(`missing ${path}`);
  const plugin = JSON.parse(await readFile(resolve(root, path), "utf8"));
  for (const key of ["name", "version", "description", "skills", "interface"])
    if (typeof plugin[key] === "undefined") fail(`plugin missing ${key}`);
  if (plugin.skills !== "./skills/") fail("plugin skills must point to ./skills/");
  if (!(await exists("skills/intelligent-model-router"))) fail("plugin skill directory missing");
  console.log("plugin validation passed");
}

try {
  if (kind === "skill") await validateSkill();
  else if (kind === "plugin") await validatePlugin();
  else {
    console.error("validate: usage node scripts/validate.mjs skill|plugin");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

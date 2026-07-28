import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "cross-spawn";
import { collectPostmanOffenders } from "./postman-policy.mjs";
import { startHarness } from "./test-harness.mjs";

await assertPostmanCollectionLoopback();

const harness = await startHarness();
try {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      [
        "exec",
        "newman",
        "run",
        "postman/model-router.postman_collection.json",
        "-e",
        "postman/local.postman_environment.json",
        "--env-var",
        `baseUrl=${harness.baseUrl}`,
      ],
      { stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`newman exited ${code}`)),
    );
  });
} finally {
  await harness.close();
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLoopbackUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0) return false;
  if (raw.startsWith("{{")) return true;
  try {
    const parsed = new URL(raw);
    return LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

async function assertPostmanCollectionLoopback() {
  const collectionPath = join(process.cwd(), "postman", "model-router.postman_collection.json");
  const raw = await readFile(collectionPath, "utf8");
  const collection = JSON.parse(raw);
  const offenders = collectPostmanOffenders(collection);
  if (offenders.length > 0) {
    console.error(
      `postman-smoke: refusing to run. ${offenders.length} request(s) target a non-loopback host:`,
    );
    for (const { name, url } of offenders) console.error(`  - ${name}: ${String(url)}`);
    process.exit(1);
  }
}

import { spawn } from "node:child_process";
import { startHarness } from "./test-harness.mjs";

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

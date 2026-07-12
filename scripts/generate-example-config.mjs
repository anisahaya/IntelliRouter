import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const target = resolve(process.argv[2] ?? "router.config.yaml");
await mkdir(dirname(target), { recursive: true });
await copyFile(new URL("../examples/router.config.example.yaml", import.meta.url), target);
process.stdout.write(`${target}\n`);

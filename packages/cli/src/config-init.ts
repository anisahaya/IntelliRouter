import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { expandHome } from "@model-router/config";

const example = `server:
  host: 127.0.0.1
  port: 8856
  databasePath: ~/.model-router/router.db
privacy:
  storePrompts: false
  storeResponses: false
  storeSource: false
  storeEmbeddings: false
  contentMaxItemBytes: 65536
  contentMaxRunBytes: 131072
  contentMaxTotalBytes: 52428800
  contentRetentionDays: 7
  hashSessionIds: true
models:
  - id: local-model
    provider: openai-compatible
    upstreamModel: replace-me
    baseUrl: http://127.0.0.1:8000/v1
    apiKeyEnv: LOCAL_MODEL_API_KEY
    capabilities:
      protocols: [openai-chat, openai-responses]
      tools: true
      json: true
      vision: false
      streaming: true
      maxContextTokens: 128000
routing:
  defaultProfile: balanced
  affinityTtlSeconds: 3600
  fallbackOn: [timeout, rate_limit, overloaded, upstream_5xx]
  profiles:
    balanced:
      weights: { quality: 0.45, cost: 0.35, latency: 0.20 }
`;

export async function initConfig(path = "~/.model-router/config.yaml"): Promise<string> {
  const target = expandHome(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, example, { flag: "wx" });
  return resolve(target);
}

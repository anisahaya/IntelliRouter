import { startServer } from "../../../apps/proxy/src/server.js";

export async function serve(config?: string): Promise<void> {
  await startServer(config);
}

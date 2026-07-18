import { describe, expect, it } from "vitest";
import type { ProxyClient } from "../src/client.js";
import { createMcpServer } from "../src/index.js";

describe("MCP server registration", () => {
  it("constructs the twelve-tool stdio server without connecting", () => {
    const server = createMcpServer({} as ProxyClient);
    expect(server).toBeDefined();
  });
});

import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Unfenced } from "@unfenced-ai/sdk";
import { registerTools } from "../src/tools.js";

describe("an approval held past the ordinary request budget", () => {
  it("reaches the agent as the server's parked wall, not a transport timeout", async () => {
    const server = createServer((request, response) => {
      if (request.url !== "/session/s1/act") {
        response.writeHead(404).end();
        return;
      }
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: false,
            approvalRequired: "example.test",
            reason: "held open - waiting for the account owner to approve",
          }),
        );
      }, 45_250);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
    const mcp = {
      registerTool(
        name: string,
        _config: unknown,
        handler: (input: Record<string, unknown>) => Promise<unknown>,
      ) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;
    registerTools(mcp, new Unfenced({ baseUrl: `http://127.0.0.1:${address.port}` }));
    try {
      const result = (await handlers.get("act")!({
        sessionId: "s1",
        kind: "click",
        on: "Approve",
      })) as { content: Array<{ text: string }>; isError?: boolean };
      const body = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
      expect(result.isError).toBe(true);
      expect(body).toMatchObject({
        error: "approval-required",
        detail: "held open - waiting for the account owner to approve",
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 70_000);
});

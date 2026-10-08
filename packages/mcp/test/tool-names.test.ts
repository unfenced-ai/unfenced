import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as RealMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Unfenced } from "@unfenced-ai/sdk";
import { registerTools, TOOL_NAMES } from "../src/tools.js";

/**
 * `TOOL_NAMES` and `registerTools` must agree.
 *
 * The declaration is what `scripts/pack-check.ts` holds the published tarball
 * to, so a declaration that drifts from the code turns the publish gate into
 * either a false alarm or, worse, a green light for a surface nobody meant to
 * ship. Checking the two against each other is what makes the list safe to
 * depend on elsewhere.
 *
 * The same fake server the other tool tests use: `registerTools` only ever
 * calls `server.registerTool`, so recording each call is enough.
 */
function registeredNames(): string[] {
  const names: string[] = [];
  const server = {
    registerTool: (name: string) => {
      names.push(name);
      return {};
    },
  } as unknown as McpServer;
  registerTools(server, {} as Unfenced);
  return names;
}

describe("TOOL_NAMES", () => {
  it("lists exactly what registerTools registers, in order", () => {
    expect(registeredNames()).toEqual([...TOOL_NAMES]);
  });

  it("registers each name once", () => {
    const names = registeredNames();
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("cloud MCP metadata", () => {
  it("advertises OAuth for every tool and keeps the preview binding", () => {
    const tools = new Map<string, Record<string, unknown>>();
    const server = {
      registerTool(name: string, config: Record<string, unknown>) {
        tools.set(name, config);
      },
    } as unknown as McpServer;

    registerTools(server, {} as Unfenced, undefined, true);

    expect([...tools.keys()]).toEqual(TOOL_NAMES);
    for (const config of tools.values()) {
      const scheme = [{ type: "oauth2", scopes: ["mcp"] }];
      expect(config["securitySchemes"]).toEqual(scheme);
      expect(config["_meta"]).toMatchObject({ securitySchemes: scheme });
      expect(config["annotations"]).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
    }
    expect(tools.get("fetch_page")?.["_meta"]).toMatchObject({
      ui: { resourceUri: "ui://unfenced/page-preview-v1.html" },
    });
  });

  it("serves the preview as a network-free MCP Apps resource", async () => {
    let readResource: (() => Promise<{ contents: Array<Record<string, unknown>> }>) | undefined;
    const server = {
      registerTool() {},
      registerResource(_name: string, _uri: string, _config: unknown, callback: unknown) {
        readResource = callback as typeof readResource;
      },
    } as unknown as McpServer;

    registerTools(server, {} as Unfenced);
    expect(readResource).toBeDefined();
    const resource = await readResource!();
    expect(resource.contents[0]).toMatchObject({
      uri: "ui://unfenced/page-preview-v1.html",
      mimeType: "text/html;profile=mcp-app",
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
    });
    expect(resource.contents[0]?.["text"]).toContain("ui/notifications/tool-result");
  });

  it("publishes OAuth and preview metadata through the actual MCP transport", async () => {
    const server = new RealMcpServer({ name: "unfenced-test", version: "0.1.0" });
    registerTools(server, {} as Unfenced, undefined, true);
    const client = new Client({ name: "metadata-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let wireTools: Array<Record<string, unknown>> = [];
    const send = serverTransport.send.bind(serverTransport);
    serverTransport.send = async (message, options) => {
      if ("result" in message && message.result && "tools" in message.result) {
        wireTools = message.result.tools as Array<Record<string, unknown>>;
      }
      return send(message, options);
    };
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const listed = await client.listTools();
      const fetch = listed.tools.find((tool) => tool.name === "fetch_page");
      expect(fetch?._meta).toMatchObject({
        securitySchemes: [{ type: "oauth2", scopes: ["mcp"] }],
        ui: { resourceUri: "ui://unfenced/page-preview-v1.html" },
      });
      expect(wireTools).toHaveLength(TOOL_NAMES.length);
      expect(
        wireTools.every(
          (tool) =>
            JSON.stringify(tool["securitySchemes"]) ===
            JSON.stringify([{ type: "oauth2", scopes: ["mcp"] }]),
        ),
      ).toBe(true);
      const resource = await client.readResource({ uri: "ui://unfenced/page-preview-v1.html" });
      expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

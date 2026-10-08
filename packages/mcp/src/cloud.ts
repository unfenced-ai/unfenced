#!/usr/bin/env node
/**
 * unfenced MCP - stdio (local) mode.
 *
 * A thin, self-contained MCP server that plugs a local MCP client (Claude Code,
 * Claude Desktop, Cursor, Windsurf, Cline, …) into a hosted unfenced service.
 * It runs no browser of its own: every tool forwards to the service over HTTP,
 * where the work runs on a worker and is metered to the account behind the token.
 *
 * Configure with two environment variables:
 *   UNFENCED_URL    your API base, e.g. https://<host>/api
 *   UNFENCED_TOKEN  an API key from your unfenced dashboard
 *
 * For clients that speak remote MCP over HTTP (the claude.ai "custom connector"
 * dialog, for instance) see http.ts - the same tools over a URL.
 *
 * IMPORTANT: stdout is the MCP transport. Nothing here may console.log to it -
 * diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Unfenced } from "@unfenced-ai/sdk";
import { registerTools, SERVER_INFO, SERVER_INSTRUCTIONS } from "./tools.js";
import { attributeClient } from "./client-id.js";

const CLOUD_URL = process.env["UNFENCED_URL"]?.replace(/\/$/, "");
const CLOUD_TOKEN = process.env["UNFENCED_TOKEN"];
if (!CLOUD_URL || !CLOUD_TOKEN) {
  console.error(
    "unfenced-mcp: missing configuration.\n" +
      "  Set UNFENCED_URL and UNFENCED_TOKEN, then restart your MCP client.\n" +
      "  UNFENCED_URL    your API base, e.g. https://<host>/api\n" +
      "  UNFENCED_TOKEN  an API key from your unfenced dashboard",
  );
  process.exit(1);
}

// Filled in once the peer identifies itself; shared by reference with the
// client, which spreads it fresh on every request.
const clientHeaders: Record<string, string> = { "x-unfenced-token-meter": "mcp" };
const cloud = new Unfenced({ baseUrl: CLOUD_URL, apiKey: CLOUD_TOKEN, headers: clientHeaders });
const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
attributeClient(server, clientHeaders);
registerTools(server, cloud, (usage) => cloud.recordTokenUsage(usage));

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = (): void => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

main().catch((error) => {
  console.error("unfenced-mcp fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});

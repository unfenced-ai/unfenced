import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Unfenced } from "@unfenced-ai/sdk";
import { TOOL_NAMES, SERVER_INFO } from "@unfenced-ai/mcp/tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);
assert.equal(typeof Unfenced, "function");
assert.equal(typeof require("@unfenced-ai/sdk").Unfenced, "function");
assert.equal(typeof require("@unfenced-ai/mcp/tools").registerTools, "function");
const dir = path.dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(dir, "node_modules/@unfenced-ai/mcp/dist/cloud.mjs")],
  env: { UNFENCED_URL: "http://127.0.0.1:1", UNFENCED_TOKEN: "test-token" },
  stderr: "pipe",
});
const client = new Client({ name: "packed-client-test", version: "1.0.0" });
try {
  await client.connect(transport);
  assert.equal(client.getServerVersion().version, SERVER_INFO.version);
  const result = await client.listTools();
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
} finally {
  await client.close();
}

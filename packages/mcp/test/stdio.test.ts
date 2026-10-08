import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { TOOL_NAMES } from "../src/tools.js";

it("the built stdio connector exposes the complete public tool set", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/cloud.mjs", import.meta.url))],
    env: { UNFENCED_URL: "http://127.0.0.1:1", UNFENCED_TOKEN: "test-token" },
    stderr: "pipe",
  });
  const client = new Client({ name: "public-client-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
  } finally {
    await client.close();
  }
});

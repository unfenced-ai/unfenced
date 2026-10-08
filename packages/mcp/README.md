# @unfenced-ai/mcp

The MCP connector for [Unfenced](https://unfenced.ai). Node.js **22.12+** required.
The connector forwards calls to an authorized Unfenced service; it runs no browser itself.

Set `UNFENCED_URL=https://unfenced.ai/api` and `UNFENCED_TOKEN` in your environment, then run:

```sh
npx -y -p @unfenced-ai/mcp unfenced-mcp
```

For Claude Desktop, Cursor, or another stdio MCP client:

```json
{
  "mcpServers": {
    "unfenced": {
      "command": "npx",
      "args": ["-y", "-p", "@unfenced-ai/mcp", "unfenced-mcp"],
      "env": {
        "UNFENCED_URL": "https://unfenced.ai/api",
        "UNFENCED_TOKEN": "YOUR_UNFENCED_API_KEY"
      }
    }
  }
}
```

Unfenced is in private preview. You need an admitted account and an API key from
the dashboard's Connect panel. Installing this package does not grant hosted access.
Keep your key in your client's protected configuration, not in a prompt or public file.

For remote MCP clients, use `https://unfenced.ai/api/mcp` and the dashboard's
authentication instructions. No npm installation is required for that connection.

Try: "Read https://example.com and summarize it with the source URL."

For more integrations, see the [quick start](https://github.com/unfenced-ai/unfenced#connect-in-a-minute).
The package also exposes `unfenced-mcp-http`, a local Streamable HTTP bridge. It defaults
to loopback port 8788 and `/mcp`; set `UNFENCED_URL` to your API base and authenticate
requests with an API key. Most users should use the hosted MCP endpoint directly.

Public tool schemas and registration helpers are exported from `@unfenced-ai/mcp/tools`.
Both transports register the same tool set.

[Source and issues](https://github.com/unfenced-ai/unfenced) ·
[Security](https://github.com/unfenced-ai/unfenced/blob/main/SECURITY.md) ·
[MIT license](https://github.com/unfenced-ai/unfenced/blob/main/LICENSE)

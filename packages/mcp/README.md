# @unfenced-ai/mcp

The MCP connector for [Unfenced](https://unfenced.ai). Node.js **22.12+** required.
The connector forwards calls to an authorized Unfenced service; it runs no browser itself.

Set `UNFENCED_URL=https://unfenced.ai/api` and `UNFENCED_TOKEN` in your environment, then run:

```sh
npx -y -p @unfenced-ai/mcp unfenced-mcp
```

For client configuration and the hosted endpoint, see the [quick start](../../README.md).
The package also exposes `unfenced-mcp-http`, a local Streamable HTTP bridge. It defaults
to loopback port 8788 and `/mcp`; set `UNFENCED_URL` to your API base and authenticate
requests with an API key. Most users should use the hosted MCP endpoint directly.

Public tool schemas and registration helpers are exported from `@unfenced-ai/mcp/tools`.
Both transports register the same tool set.

[Security](../../SECURITY.md) · [MIT license](./LICENSE)

# Examples

You need an admitted Unfenced account. Create an API key in the dashboard's Connect
panel and keep it in your local environment as `UNFENCED_TOKEN`.

## Claude Desktop or Cursor: read and act through MCP

Problem: give an MCP client access to rendered pages and authorized browser sessions.

Copy the complete [stdio configuration](../README.md#local-stdio-connector) into your
client's MCP configuration. Replace the token placeholder locally and restart the client.
For Claude Desktop, use `claude_desktop_config.json`; for Cursor, use `.cursor/mcp.json`.
Do not commit a configuration containing a real key.

Prompt: "Read https://example.com and summarize it with the source URL."

Expected result: the client discovers Unfenced tools and returns content from the page.
If the connector exits, check both environment variables and Node.js 22.12+.
If calls return 401, replace the key; if access is denied, check account admission and permissions.

## JavaScript: fetch clean content

Problem: read a page without handling HTML or browser setup in your own application.

From the repository root:

```sh
pnpm install
pnpm build
node --env-file=.env examples/fetch.mjs https://example.com
```

Create `.env` locally with `UNFENCED_TOKEN=your-key` first. This file is ignored by Git.
The example uses the SDK built from this checkout. To use it outside the checkout,
install `@unfenced-ai/sdk` and change the import to that package name.

Expected result: readable content on stdout, or a structured failure on stderr.
A denied or blocked website may require human sign-in or may remain unavailable.

## JavaScript: inspect a live page

Problem: observe a page and read its content while keeping a session open.

```sh
node --env-file=.env examples/session.mjs https://example.com
```

Expected result: the page's observation and extracted content. The session closes in a
`finally` block even if extraction fails. For authenticated sites, connect the site in
your dashboard first. Acting additionally requires site permission.

Example agent prompt: "Inspect the form and tell me which fields need values. Do not submit."

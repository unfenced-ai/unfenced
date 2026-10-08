# Unfenced

**Full-web browser access for AI agents.**

Read public, JavaScript-rendered, and authenticated pages as clean content.
Open a live browser session, observe the page, and act on sites you authorize.

[Get access](https://unfenced.ai) · [Connect your agent](https://app.unfenced.ai) · [Examples](./examples/README.md) · [Security](./SECURITY.md)

Unfenced is a hosted service in private preview. Installing a client does not grant
hosted access: you need an admitted account and an API key or a supported OAuth connection.

## Connect in a minute

### Remote MCP

In a client that supports Streamable HTTP MCP, add:

```text
https://unfenced.ai/api/mcp
```

Use the dashboard's **Connect** instructions for your client's authentication flow.
Clients that accept custom headers can use `Authorization: Bearer <UNFENCED_TOKEN>`.
Keep API keys out of URLs, prompts, and committed configuration.

See the [remote connection guide](./docs/REMOTE-MCP.md) for setup and troubleshooting.

### Grok Build plugin

The [Grok Build plugin](./plugins/grok/unfenced/README.md) connects to Unfenced's
hosted page-reading profile. It provides page fetching, bounded comparisons,
and links without browser actions or credential entry. Marketplace publication
is pending; the package README includes local evaluation instructions.

### Local stdio connector

Requires Node.js **22.12+**. Add this to your MCP client's configuration,
replacing the placeholder locally with an API key from your dashboard:

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

Both environment variables are required. The connector runs locally and forwards
tool calls to Unfenced over HTTPS. The browser runs on the hosted service.

### TypeScript / JavaScript SDK

```sh
npm install @unfenced-ai/sdk
```

```js
import { Unfenced } from "@unfenced-ai/sdk";

const client = new Unfenced({
  baseUrl: "https://unfenced.ai/api",
  apiKey: process.env.UNFENCED_TOKEN,
});
const result = await client.fetch("https://example.com");
if (!result.ok) throw new Error(JSON.stringify(result));
console.log(result.content);
```

The SDK is a typed HTTP client with no runtime dependencies. Use it from a server
or agent runtime; do not embed your API key in a browser application.

## Try these prompts

- "Read this JavaScript-heavy page and summarize the main findings with source links."
- "Open my supplier portal using my saved login, download the latest invoice, and summarize it. Ask me if sign-in needs human input."
- "Fill this form using the details I supplied. Stop before submitting and show me what you entered."

## What runs where

| Component           | Runs                        | Purpose                                                                                  |
| ------------------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| Remote MCP          | Hosted                      | Connect an MCP client directly to Unfenced.                                              |
| npm stdio connector | Your computer or agent host | Forward MCP tool calls to the hosted API.                                                |
| TypeScript SDK      | Your application            | Call the API with typed requests and responses.                                          |
| Browser service     | Hosted                      | Render pages, hold sessions, execute authorized actions, and resolve stored credentials. |

This repository contains the client code, public types, tool schemas, and client tests.
The browser engine, extraction engine, backend, credential vault implementation, and
deployment infrastructure are proprietary and are not included.

## Permissions and credentials

Site permissions are enforced by the service. Stored credentials are filled by name;
their persistent values are not returned to the model. Submission actions require an
explicit confirmation flag. This flag is a protocol safeguard, not proof that a human
approved an action: your agent should obtain your approval before consequential submissions.

Sessions can provide action outcomes and receipts for review. Sign-in challenges may
require you to take over. See [Security](./SECURITY.md) for the client/service boundary.

## Develop the clients

Use Node.js 22.19+ for the development tools. Published client packages require 22.12+.

```sh
corepack enable
pnpm install
pnpm verify
```

`verify` builds both packages, checks types and lint, runs client tests, and checks
formatting and documentation links. Tests use local fixtures and mock APIs; they do
not benchmark the hosted browser service.

- [MCP connector](./packages/mcp/README.md)
- [SDK](./packages/sdk/README.md)
- [Examples](./examples/README.md)
- [Contributing](./CONTRIBUTING.md)
- [Roadmap](./ROADMAP.md)

## License

The files in this repository are available under the [MIT license](./LICENSE).
This license does not grant access to, or license the implementation of, the hosted service.
Previously published npm versions retain the license shipped in their own package.

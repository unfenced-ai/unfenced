# Unfenced for Grok Build

Read a specific web page, compare up to 20 URLs, or extract page links with the
existing hosted Unfenced service. This package is maintained in the public
Unfenced client repository at `unfenced-ai/unfenced`.
Unfenced operates under Gigamiga Solutions Ltd, as authorized by its publisher.

## Components and access

- One skill: `unfenced-web-reading`.
- One Streamable HTTP MCP server: `unfenced`.
- Endpoint: `https://unfenced.ai/api/mcp?profile=reading`.
- Tools: `fetch_page`, `fetch_batch`, `get_page_links`.
- No executable scripts, installation hooks, agents, or LSP servers.

An admitted Unfenced account is required during private preview. Installing
the plugin does not create an account or grant access. Authenticate through
Grok's MCP OAuth flow using your existing Unfenced account. The package embeds
no tokens, API keys or client secrets and reads no local credential files.

Requests send the selected URLs and bounded reading options to Unfenced. Grok
receives the fetched text, links and source metadata. Fetching creates metered
jobs, account history and usage receipts. The hosted browser retrieves the
requested external HTTP(S) pages. The plugin cannot submit forms, enter
credentials, upload files, make purchases, solve CAPTCHAs, or archive an entire
site. Do not supply URLs containing secrets or restricted personal data.

Grok displays readable results and source links. Interactive preview support
depends on the host; the ChatGPT-specific preview is not promised in Grok.

## Install and verify

After xAI accepts the marketplace entry, open `/marketplace` in Grok Build,
find `unfenced` and install it. Installation from the official marketplace is
pending until xAI accepts a marketplace submission.

For local evaluation of this repository's package:

```sh
grok plugin validate ./plugins/grok/unfenced
grok --plugin-dir ./plugins/grok/unfenced
```

Complete MCP authorization when prompted, then inspect `/mcps`. Try:

- Read `https://www.w3.org/WAI/` and show its title, summary and source link.
- Compare `https://www.w3.org/WAI/` and `https://www.w3.org/standards/`.
- List links from `https://www.w3.org/WAI/`.

The upstream catalog generator and validator can inspect the package without
executing it. A real Grok sign-in and live host rehearsal are separate checks;
static validation is not evidence of completed OAuth or tool calls in Grok.

## Support and license

- Website: https://unfenced.ai/mcp
- Support: https://unfenced.ai/plugin-support
- Privacy: https://unfenced.ai/legal/privacy-policy
- Terms: https://unfenced.ai/legal/terms-of-service

This plugin is distributed under the public client repository's MIT license.
See [LICENSE](./LICENSE). This package contains no Unfenced engine or server
source. Hosted service access remains subject to the service terms.

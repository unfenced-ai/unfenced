# Releasing clients

The public repository is the release source for `@unfenced-ai/sdk` and
`@unfenced-ai/mcp`. Both packages move together. Changes made in another checkout
must be ported here and tested before publishing; do not publish competing builds
of these packages from the private service repository.

1. Update both package versions and `SERVER_INFO.version`.
2. Update the changelog and npm-facing READMEs. Use absolute links in package READMEs.
3. Run `pnpm install --lockfile-only`, `pnpm format`, `pnpm verify`, and `pnpm pack-check`.
4. Commit and push to `main`.
5. Run the **Publish clients** workflow (`publish.yml`) on `main`.
6. Verify both npm versions and provenance before creating the matching GitHub release tag.

The workflow builds and tests from a clean checkout, then installs the actual package
archives into an isolated consumer project. It checks ESM and CommonJS imports,
TypeScript declarations, MCP initialization and tools, and the npm executable alias.
Only those tested archives are published, SDK first and MCP second.

## npm authentication

Configure a GitHub Actions trusted publisher on each npm package:

- Organization: `unfenced-ai`
- Repository: `unfenced`
- Workflow filename: `publish.yml`
- Environment: leave empty (this workflow does not use a GitHub environment)
- Permit direct publishing with `npm publish`

The workflow uses OIDC and provenance. No npm write token is stored in GitHub.
`pnpm pack` rewrites workspace dependencies; `npm publish` uploads the verified
archives. Never run `npm publish` against the workspace directories directly.

## MCP Registry

`server.json` uses the domain namespace `ai.unfenced/browser`. Verify control of
`unfenced.ai` with the official `mcp-publisher` before publishing. The MCP npm
package's `mcpName` must match the manifest. Registry publication is a separate
operation and is not implied by a successful npm release.

The current manifest lists only the hosted Streamable HTTP connection. It can be
published independently of npm. Its version identifies the registry listing and
does not have to match the client package version. Increment it for each registry
publication, including when adding a package connection later.

1. Authenticate the official publisher for the `ai.unfenced` domain namespace.
2. Run `mcp-publisher validate` from this repository.
3. Run `mcp-publisher publish` and verify the published entry in the official registry.

After npm publishing is available, add a `packages` entry with registry type `npm`,
identifier `@unfenced-ai/mcp`, the published version, and transport type `stdio`.
Declare required `UNFENCED_URL` (default `https://unfenced.ai/api`) and secret
`UNFENCED_TOKEN` environment variables. Validate that manifest against the registry
before publishing the next listing version. Never advertise an unpublished package.

Sources: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[MCP authentication](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/authentication.mdx).

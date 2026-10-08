# Roadmap

Planned work, without promised dates:

- Publish a client release built from this repository with npm provenance.
- Verify the `ai.unfenced` domain namespace and publish the MCP registry listing.
- Add runnable framework integrations and authenticated test-site examples.
- Publish an independently runnable browser evaluation harness with methods and failures.

Use [issues](https://github.com/unfenced-ai/unfenced/issues) for concrete requests.

The [registry manifest](./server.json) describes the hosted remote connection, so
registry publication does not depend on an npm release. Domain ownership must be
verified before publishing `ai.unfenced/browser`. Add the npm connection after the
matching client version is published; the `mcp` executable alias supports standard
registry installation commands. See the
[official manifest specification](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md).

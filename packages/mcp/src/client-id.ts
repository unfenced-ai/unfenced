import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Tell the API which MCP client is asking.
 *
 * Every fetch through MCP used to arrive indistinguishable from a bare script:
 * the SDK sets no User-Agent, so Node's default `node` was the only trace, and
 * the answer to "did this come from Claude Code or from cron?" was nowhere in
 * the system. Only the server-mounted /mcp forwarded anything, and what it
 * forwarded was the raw HTTP User-Agent of a browser.
 *
 * MCP already carries the answer. `initialize` includes the peer's
 * `clientInfo` - name and version - which is exactly "claude-code 1.2.3" or
 * "Cursor 0.44". This wires that into a header the API records.
 *
 * The headers object is shared with the Unfenced client by reference, because
 * the client is constructed before the handshake happens: the SDK spreads
 * `extraHeaders` at request time, so filling this in later reaches every
 * subsequent call without rebuilding anything.
 */
export function attributeClient(server: McpServer, headers: Record<string, string>): void {
  const low = server.server;
  const previous = low.oninitialized;
  low.oninitialized = () => {
    try {
      const peer = low.getClientVersion();
      const label = clientLabel(peer?.name, peer?.version);
      if (label) headers["x-unfenced-client"] = label;
    } catch {
      // Attribution is a nicety. A client that reports nothing, or an SDK whose
      // shape moved, must never stop the tools from working.
    }
    previous?.();
  };
}

/**
 * "claude-code" + "1.2.3" -> "claude-code 1.2.3".
 *
 * Capped at 120 to match what the server stores, and stripped of control
 * characters so a hostile clientInfo cannot inject line breaks into a log.
 */
export function clientLabel(name?: string, version?: string): string | undefined {
  // Escaped explicitly: a literal control-character class in the source is
  // invisible in a diff and does not survive a copy-paste.
  const clean = (s?: string): string =>
    (s ?? "")
      // eslint-disable-next-line no-control-regex -- Strip control characters from the client header.
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const n = clean(name);
  if (!n) return undefined;
  const v = clean(version);
  return `${n}${v ? ` ${v}` : ""}`.slice(0, 120);
}

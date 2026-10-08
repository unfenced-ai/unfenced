/** Text returned by a tool/API, not provider-billed model usage. */
export interface TokenUsage {
  category: "fetch" | "session" | "other";
  operation: string;
  textChars: number;
  imageCount: number;
  sessionId?: string;
}

/** Count MCP text once; structuredContent duplicates text in our tool replies. */
export function toolTokenUsage(operation: string, input: unknown, result: unknown): TokenUsage {
  const args = input as { sessionId?: unknown } | null;
  let sessionId = typeof args?.sessionId === "string" ? args.sessionId : undefined;
  let textChars = 0;
  let imageCount = 0;
  const blocks = (result as { content?: unknown } | null)?.content;
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (block?.type === "text" && typeof block.text === "string") {
        textChars += block.text.length;
        if (!sessionId) {
          try {
            const payload = JSON.parse(block.text) as { sessionId?: unknown };
            if (typeof payload?.sessionId === "string") sessionId = payload.sessionId;
          } catch {
            /* prose is also a valid text block */
          }
        }
      } else if (block?.type === "image") imageCount++;
    }
  }
  const category =
    sessionId || operation === "open_page" || operation === "switch_account"
      ? "session"
      : /^(fetch_page|fetch_batch|get_page_links)$/.test(operation)
        ? "fetch"
        : "other";
  return { category, operation, textChars, imageCount, ...(sessionId ? { sessionId } : {}) };
}

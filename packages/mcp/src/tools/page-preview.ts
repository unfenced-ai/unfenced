import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const PAGE_PREVIEW_URI = "ui://unfenced/page-preview-v1.html";

const PAGE_PREVIEW_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unfenced page preview</title>
  <style>
    :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; background: #101315; color: #e9eeeb; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 14px; }
    main { border: 1px solid #303a38; border-radius: 9px; background: #171c1d; padding: 16px; max-width: 720px; }
    .eyebrow, .meta { color: #a5b3ae; font-size: 12px; }
    .eyebrow { letter-spacing: .08em; text-transform: uppercase; }
    h1 { font-size: 18px; line-height: 1.35; margin: 9px 0 8px; overflow-wrap: anywhere; }
    .meta { display: flex; flex-wrap: wrap; gap: 7px 14px; font-variant-numeric: tabular-nums; }
    p { margin: 14px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; font-size: 13px; }
    .actions { display: flex; gap: 10px; align-items: center; margin-top: 16px; }
    a, button { color: #d9f7e7; background: #243a31; border: 1px solid #517562; border-radius: 6px; padding: 9px 11px; min-height: 40px; font: inherit; font-size: 12px; cursor: pointer; text-decoration: none; }
    a:hover, button:hover { background: #2d4b3b; }
    a:focus-visible, button:focus-visible { outline: 2px solid #b8ebca; outline-offset: 2px; }
    [hidden] { display: none !important; }
    @media (max-width: 480px) { body { padding: 8px; } main { padding: 13px; } a, button { min-height: 44px; } }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">Unfenced / page</div>
    <h1 id="title">Loading page preview</h1>
    <div class="meta" id="meta"></div>
    <p id="excerpt" hidden></p>
    <div class="actions" id="actions" hidden>
      <a id="source" target="_blank" rel="noopener noreferrer">Open source</a>
      <button id="toggle" type="button" hidden>Show excerpt</button>
    </div>
  </main>
  <script type="module">
    const title = document.querySelector('#title');
    const meta = document.querySelector('#meta');
    const excerpt = document.querySelector('#excerpt');
    const actions = document.querySelector('#actions');
    const source = document.querySelector('#source');
    const toggle = document.querySelector('#toggle');
    let expanded = false;

    function render(result) {
      const page = result?.structuredContent?.preview;
      if (!page) {
        title.textContent = 'Page preview unavailable';
        meta.textContent = 'The fetch did not return a page. Check the tool result for details.';
        actions.hidden = true;
        excerpt.hidden = true;
        return;
      }
      title.textContent = page.title || 'Untitled page';
      const parts = [page.pageType, 'tier ' + page.tier];
      if (page.renderedJs) parts.push('JavaScript rendered');
      if (page.contentTruncated) parts.push('content truncated');
      meta.textContent = parts.filter(Boolean).join(' / ');
      const url = typeof page.url === 'string' ? page.url : '';
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
          source.href = parsed.href;
          actions.hidden = false;
        }
      } catch { /* No safe source URL to open. */ }
      excerpt.textContent = page.excerpt || '';
      toggle.hidden = !page.excerpt;
    }

    toggle.addEventListener('click', () => {
      expanded = !expanded;
      excerpt.hidden = !expanded;
      toggle.textContent = expanded ? 'Hide excerpt' : 'Show excerpt';
    });

    window.addEventListener('message', (event) => {
      if (event.source !== window.parent || event.data?.jsonrpc !== '2.0') return;
      if (event.data.method === 'ui/notifications/tool-result') render(event.data.params);
      if (event.data.id === 1 && !event.data.error) {
        window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*');
      }
    });
    window.parent.postMessage({
      jsonrpc: '2.0', id: 1, method: 'ui/initialize',
      params: { appInfo: { name: 'unfenced-page-preview', version: '0.1.0' }, appCapabilities: {}, protocolVersion: '2026-01-26' }
    }, '*');
    if (window.openai?.toolOutput) render({ structuredContent: window.openai.toolOutput });
  </script>
</body>
</html>`;

/** Register the self-contained, network-free MCP Apps resource. */
export function registerPagePreview(server: McpServer): void {
  server.registerResource(
    "Unfenced page preview",
    PAGE_PREVIEW_URI,
    { mimeType: "text/html;profile=mcp-app" },
    async () => ({
      contents: [
        {
          uri: PAGE_PREVIEW_URI,
          mimeType: "text/html;profile=mcp-app",
          text: PAGE_PREVIEW_HTML,
          _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
        },
      ],
    }),
  );
}

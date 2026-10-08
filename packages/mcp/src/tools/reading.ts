/**
 * The reading tools - fetch a URL, or read a live page's content.
 *
 * fetch_page / fetch_batch / get_page_links fetch remote URLs; extract_page runs
 * the extraction pipeline over a page already open. None of them act.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Unfenced } from "@unfenced-ai/sdk";
import { PAGE_PREVIEW_URI } from "./page-preview.js";
import {
  asToolResult,
  asObject,
  failurePayload,
  fetchPayload,
  rankForCrawling,
  toolError,
  DEFAULT_MAX_WORDS,
  DEFAULT_MAX_LINKS,
  DEFAULT_HTML_CHARS,
  MAX_BATCH_URLS,
  MIN_BATCH_HTML_CHARS,
  BATCH_DEADLINE_MS,
  WEB_READ,
} from "./shared.js";

const FORMATS = ["markdown", "json", "text", "html"] as const;
const FALLBACK_DEADLINE_MS = 45_000;
const MIN_RENDER_BUDGET_MS = 15_000;
const READING_SCOPE =
  "Use only for specific pages, not automatic recursive crawling or complete-site archives. " +
  "For an entire-site archive request, explain that Unfenced cannot do that before calling any tool; " +
  "offer specific page fetches or one page's links instead. ";

export function registerFetchPage(server: McpServer, cloud: Unfenced): void {
  server.registerTool(
    "fetch_page",
    {
      title: "Fetch a web page",
      description:
        READING_SCOPE +
        "Fetch a URL as a real user would see it (real browser + IP, JS rendering when needed) " +
        "and return clean LLM-ready content. format: markdown (default) | json | text | html. " +
        "For a focused question, start with maxWords:5000; if the answer is missing and contentTruncated is true, increase the budget before concluding it is absent. " +
        "forceRender skips the cheap HTTP tier and goes straight to the browser. " +
        `The word budget governs the EXTRACTED prose - markdown, text and json. Content is capped at ${DEFAULT_MAX_WORDS.toLocaleString("en-US")} words unless maxWords says otherwise; the reply carries contentTruncated whenever anything was cut, omissions naming what was lost, and totalWords only when the full source was counted. A very large page is cut by byte size before it is parsed, so there is no full word count to give for that one. format:"html" is the document as it arrived rather than a rendering of the prose, so maxWords does not narrow it - it is bounded by SIZE alone, at ${DEFAULT_HTML_CHARS.toLocaleString("en-US")} characters, with contentTruncated and totalChars saying so when it bites. A 5-word cap on html still returns that much. Ask for markdown when you want the word budget honoured. ` +
        "Some publishers serve a declared agent a richer, cheaper rendering than they serve a browser; " +
        "this is negotiated automatically per host, and identify overrides it. robots chooses whether to ignore, report, or obey robots.txt. Explicit stealth requests with a disallowed robots rule and low-confidence unrendered content receive 1 browser-rendered retry when time remains. " +
        "Web pages, feeds, JSON and PDFs: a PDF is read as text, so arxiv.org/pdf/ID works as " +
        "well as arxiv.org/abs/ID and a filing or datasheet with no HTML version is readable. " +
        'A scanned PDF returns error "no-text-layer"; an image or other binary returns ' +
        '"unsupported-content-type". A queued job that reaches its deadline returns queue-timeout; accepted timed-out work is cancelled. An archived job returns only a history receipt; fetch the URL again for content.',
      inputSchema: {
        url: z.string().url().describe("Absolute URL to fetch"),
        format: z.enum(FORMATS).optional().describe("Output format, default markdown"),
        forceRender: z.boolean().optional().describe("Go straight to the browser tier"),
        maxWords: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Cap the content at this many words; the reply then carries contentTruncated, omissions, and totalWords when the full source was counted",
          ),
        force: z
          .boolean()
          .optional()
          .describe(
            "Ignore our own back-off for this host and try anyway - for a deliberate retest",
          ),
        identify: z
          .enum(["auto", "agent", "stealth"])
          .optional()
          .describe(
            "Whether to tell the site what we are. auto (default) uses what has been learned about the host; agent asks for the machine rendering some publishers serve; stealth arrives as an ordinary browser",
          ),
        locale: z
          .string()
          .optional()
          .describe(
            "Language to present, e.g. en-US (default), he-IL, ja-JP. Sets Accept-Language and the browser's own language, so the site chooses content in it. Without this the worker's geography decided the language and the same call answered differently from different workers",
          ),
        robots: z
          .enum(["ignore", "report", "obey"])
          .optional()
          .describe(
            "Robots policy: ignore without reading, report the verdict, or obey a disallow rule",
          ),
      },
      annotations: WEB_READ,
      _meta: { ui: { resourceUri: PAGE_PREVIEW_URI } },
    },
    async ({ url, format, forceRender, maxWords, force, identify, locale, robots }) => {
      // The SDK returns a structured failure only for a 400 rejection of the
      // target; a revoked key, a quota refusal, a dead tunnel or a network
      // fault all THROW, and the MCP SDK flattens a throw to a plain sentence
      // with no `error` field at all. The connector's own instructions tell an
      // agent that failures are structured and the code is the instruction, so
      // an unenveloped throw is exactly the outage on which the agent has no
      // code to branch on.
      try {
        const startedAt = Date.now();
        const fetchOptions = {
          format: format ?? "markdown",
          ...(forceRender ? { forceRender: true } : {}),
          ...(force ? { force: true } : {}),
          ...(identify ? { identify } : {}),
          ...(locale ? { locale } : {}),
          ...(robots ? { robots } : {}),
          maxWords: maxWords ?? DEFAULT_MAX_WORDS,
        };
        let r = await cloud.fetch(url, fetchOptions);
        const renderBudgetMs = FALLBACK_DEADLINE_MS - (Date.now() - startedAt);
        if (
          identify === "stealth" &&
          !forceRender &&
          format !== "html" &&
          r.outcome === "delivered" &&
          r.meta.robotsDisallowed &&
          !r.meta.renderedJs &&
          r.doc.confidence?.level === "low" &&
          renderBudgetMs >= MIN_RENDER_BUDGET_MS
        ) {
          const first = r;
          try {
            const rendered = await cloud.fetch(url, {
              ...fetchOptions,
              forceRender: true,
              timeoutMs: renderBudgetMs,
            });
            if (rendered.outcome === "delivered") r = rendered;
            else first.doc.confidence?.reasons.push("browser rendering failed");
          } catch {
            first.doc.confidence?.reasons.push("browser rendering failed");
          }
        }
        if (r.outcome === "offered") return asToolResult({ offered: r.offer });
        if (r.outcome === "failed") return asToolResult(failurePayload(r), true);
        if (r.outcome === "archived")
          return asToolResult({
            archived: true,
            entry: r.entry,
            note: "full content expired; fetch again if needed",
          });
        const payload = fetchPayload(r as never, format);
        return {
          ...asToolResult(payload),
          structuredContent: {
            preview: {
              title: r.doc.title,
              url: r.meta.finalUrl,
              pageType: r.doc.pageType,
              tier: r.meta.tier,
              renderedJs: r.meta.renderedJs,
              contentTruncated: Boolean(r.meta.contentTruncated),
              excerpt:
                typeof payload["content"] === "string" ? payload["content"].slice(0, 700) : "",
            },
          },
        };
      } catch (error) {
        return asToolResult(toolError("fetch-failed", error), true);
      }
    },
  );
}

export function registerFetchBatch(server: McpServer, cloud: Unfenced): void {
  server.registerTool(
    "fetch_batch",
    {
      title: "Fetch several web pages",
      description:
        READING_SCOPE +
        `Fetch up to ${MAX_BATCH_URLS} URLs with bounded concurrency (default 3). Returns one entry per URL in input ` +
        "order; a failed URL carries its structured error, remedy, and retryAfterMs when supplied, in place instead of failing the batch. Busy submissions wait for the server's retry hint within the deadline; queued expiry says queue-timeout, and accepted stragglers are cancelled. identify and robots apply to every URL in the batch. " +
        `Repeated URLs are fetched once. A batch SHARES a ${DEFAULT_MAX_WORDS.toLocaleString("en-US")}-word budget, so more pages means less of each; maxWords sets a per-page cap instead. ` +
        "homepages can otherwise run to tens of thousands of words. " +
        `The word budget governs the EXTRACTED prose. Every delivered entry carries omissions when content was left out and totalWords only when the full source was counted. format:"html" is the document as it arrived, so it is bounded by SIZE instead - the batch shares ${DEFAULT_HTML_CHARS.toLocaleString("en-US")} characters the same way, and each entry carries contentTruncated, totalChars, and a character-cap omission when its share bites. An archived entry is only a history receipt; fetch the URL again for content.`,
      inputSchema: {
        urls: z.array(z.string().url()).min(1).max(MAX_BATCH_URLS).describe("URLs to fetch"),
        format: z.enum(FORMATS).optional().describe("Output format, default markdown"),
        maxWords: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Cap the content at this many words; entries carry contentTruncated, omissions, and totalWords when the full source was counted",
          ),
        locale: z
          .string()
          .optional()
          .describe(
            "Language to present, e.g. en-US (default), he-IL, ja-JP. Sets Accept-Language and the browser's own language, so the site chooses content in it. Without this the worker's geography decided the language and the same call answered differently from different workers",
          ),
        identify: z
          .enum(["auto", "agent", "stealth"])
          .optional()
          .describe("Identify as an agent, an ordinary browser, or use the learned host policy"),
        robots: z
          .enum(["ignore", "report", "obey"])
          .optional()
          .describe(
            "Robots policy for every URL: ignore, report the verdict, or obey a disallow rule",
          ),
      },
      annotations: WEB_READ,
    },
    async ({ urls, format, maxWords, locale, identify, robots }) => {
      // Shared, not per page: the cap exists to bound a reply, and ten pages
      // each at the cap is ten times the reply it was meant to bound.
      const perPage =
        maxWords ?? Math.max(500, Math.floor(DEFAULT_MAX_WORDS / Math.max(1, urls.length)));
      // And the same arithmetic for html, which the word budget does not reach:
      // twenty pages at the engine's own per-page megabyte is ~20 MB in one
      // tool result, under a description promising a shared budget.
      //
      // The floor is MIN_BATCH_HTML_CHARS, which is the budget divided by the
      // schema's own maximum. A hand-written 25,000 sat here and beat the share
      // from eleven URLs up, so the documented 20-page html batch returned
      // 500,000 characters against a sentence promising 250,000.
      const perPageChars = Math.max(
        MIN_BATCH_HTML_CHARS,
        Math.floor(DEFAULT_HTML_CHARS / Math.max(1, urls.length)),
      );
      // Below the client's transport timeout, deliberately.
      //
      // `batch` resolves only when every URL has, so one slow host decided when
      // this tool returned — and a ten-URL batch was observed blowing a
      // sixty-second MCP timeout, which returns NOTHING. Every sibling that had
      // already succeeded went with it, and the caller got a transport error
      // naming no URL, so it could not even retry the right ones.
      //
      // Answering late with most of the results beats answering never with all
      // of them, and an agent can act on the difference.
      try {
        const results = await cloud.batchWithin(urls, BATCH_DEADLINE_MS, {
          format: format ?? "markdown",
          ...(locale ? { locale } : {}),
          ...(identify ? { identify } : {}),
          ...(robots ? { robots } : {}),
          maxWords: perPage,
        });
        const payload = results.map((r, i) => ({
          url: urls[i],
          ...(r.outcome === "delivered"
            ? // `format`, which this call used to omit. `fetchPayload` unwraps
              // the JSON body only when it is told the caller asked for JSON, so
              // fetch_batch(format:"json") handed back a STRING of JSON in the
              // field where fetch_page(format:"json") hands back an object —
              // the same double-encoding the branch above it was written to end,
              // still live on one of the two readers.
              { ok: true, ...fetchPayload(r as never, format, perPageChars) }
            : r.outcome === "offered"
              ? { ok: false, offered: r.offer }
              : r.outcome === "archived"
                ? { archived: true, entry: r.entry }
                : { ok: false, ...failurePayload(r) }),
        }));
        return asToolResult(payload);
      } catch (error) {
        return asToolResult(toolError("fetch-failed", error), true);
      }
    },
  );
}

export function registerGetPageLinks(server: McpServer, cloud: Unfenced): void {
  server.registerTool(
    "get_page_links",
    {
      title: "List a page's links",
      description:
        READING_SCOPE +
        "Fetch one URL and return its deduped absolute links with anchor text " +
        "without paying for its full content. Returns every link on the " +
        'page by default, navigation included; scope: "content" narrows it to the article. An archived job has no links, only a history receipt.',
      inputSchema: {
        url: z.string().url().describe("Absolute URL to fetch"),
        scope: z
          .enum(["all", "content"])
          .optional()
          .describe(
            "all (default) returns every link on this page, including navigation. content returns only links inside the extracted article",
          ),
        maxLinks: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Cap how many links come back (default ${DEFAULT_MAX_LINKS}); the reply carries totalLinks and linksTruncated`,
          ),
      },
      annotations: WEB_READ,
    },
    async ({ url, scope, maxLinks }) => {
      // Enveloped like every other tool: without this a revoked key or a dead
      // worker reached the agent as a bare sentence with no `error` field.
      try {
        return await linksBody(cloud, url, scope, maxLinks);
      } catch (error) {
        return asToolResult(toolError("links-failed", error), true);
      }
    },
  );
}

async function linksBody(
  cloud: Unfenced,
  url: string,
  scope: "all" | "content" | undefined,
  maxLinks: number | undefined,
): Promise<ReturnType<typeof asToolResult>> {
  const r = await cloud.fetch(url, {
    format: "json",
    // A crawl tool that returns only the article's own links is not a crawl
    // tool: a ministry front page yielded six links from its content region
    // and dozens from the page.
    ...(scope === "content" ? {} : { wholePageLinks: true }),
  });
  if (r.outcome === "offered") return asToolResult({ offered: r.offer });
  if (r.outcome === "failed") return asToolResult(failurePayload(r), true);
  if (r.outcome === "archived")
    return asToolResult({
      archived: true,
      entry: r.entry,
      note: "full content expired; fetch again if needed",
    });
  // One entry per destination — the description promises deduped links, and
  // a nav item repeated in a header and a footer was arriving three times.
  // Deduping HERE, not in the shared collector: the live-page reader needs
  // repeats kept, because a tag repeated on every card is per-card data.
  const raw = (r.doc as { links?: Array<{ url: string; text: string }> }).links ?? [];
  const byUrl = new Map<string, { url: string; text: string }>();
  for (const link of raw) {
    const seen = byUrl.get(link.url);
    // Keep the most descriptive text for a destination, and never keep "".
    if (!seen || link.text.length > seen.text.length) byUrl.set(link.url, link);
  }
  const all = [...byUrl.values()];
  // An index page can carry thousands. 3,000 links came back as a 262KB
  // reply — around 67k tokens, a third of a context window — with nothing
  // in it saying so. The cap is generous enough that ordinary pages never
  // meet it, and the reply says what was left behind so a caller that
  // wants the rest can ask for it.
  const cap = maxLinks ?? DEFAULT_MAX_LINKS;
  const links = rankForCrawling(all).slice(0, cap);
  return asToolResult({
    links,
    count: links.length,
    totalLinks: all.length,
    ...(all.length > links.length ? { linksTruncated: true } : {}),
    tier: r.meta.tier,
    finalUrl: r.meta.finalUrl,
  });
}

export function registerExtractPage(server: McpServer, cloud: Unfenced): void {
  server.registerTool(
    "extract_page",
    {
      title: "Extract a live page's content",
      description:
        "Run the extraction pipeline on an open page as it currently stands - after logging in, " +
        "after paginating, after expanding a section. Returns clean markdown or JSON, typically a " +
        "fraction of the raw-HTML tokens. TWO ceilings can cut it, and contentTruncated is set by " +
        "either: a page whose DOM is over 1 MB is cut before it is parsed, so what you have is " +
        "the first megabyte rather than the page; and the extracted prose is capped at " +
        `${DEFAULT_MAX_WORDS.toLocaleString("en-US")} words unless maxWords says otherwise, with totalWords saying how much there was. ` +
        "The second is the one a long logged-in listing or thread meets, and reducing the page " +
        "does nothing about it - raise maxWords instead. The word budget governs the EXTRACTED " +
        'prose - markdown, text and json. format:"html" is the document as it arrived rather than ' +
        "a rendering of the prose, so maxWords does not narrow it: it is bounded by that 1 MB " +
        "alone, which on a big logged-in page is a quarter of a million tokens in one reply. " +
        "Ask for markdown when you want the budget honoured.",
      inputSchema: {
        sessionId: z.string(),
        format: z.enum(FORMATS).optional().describe("Default markdown"),
        maxWords: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Cap the extracted prose at this many words (default ${DEFAULT_MAX_WORDS.toLocaleString("en-US")}); the reply carries contentTruncated and totalWords`,
          ),
      },
      annotations: WEB_READ,
    },
    async ({ sessionId, format, maxWords }) => {
      try {
        // BOUNDED, LIKE EVERY OTHER READER HERE. The schema was {sessionId,
        // format} and the chain had no knob at any layer - the SDK signature
        // took no budget and the route passed none - so one call on a live,
        // logged-in page (the flagship case for this tool) could put a megabyte
        // of html, a measured 1,000,000 characters and 250,000-330,000 tokens,
        // into the caller's context with no parameter to ask for less.
        const e = await cloud.extract(sessionId, format ?? "markdown", maxWords);
        return asToolResult({
          url: e.url,
          title: e.doc.title,
          pageType: e.doc.pageType,
          wordCount: e.doc.wordCount,
          // A cut page that claims to be whole is worse than a cut page. The
          // live-extract route sets this when the DOM went past the 1 MB
          // pre-parse ceiling, and this projection dropped it — so the flagship
          // case for the tool, a large logged-in listing or thread, came back
          // as clean markdown with a word count taken on the truncated document
          // and no signal at all. The fetch reply carries the same flag for the
          // same reason.
          ...(e.contentTruncated ? { contentTruncated: true } : {}),
          // WHICH ceiling, in the only form a caller can act on. `wordCount`
          // above is counted on the document after the budget bit, so a reply
          // that only said `contentTruncated` left an agent with one documented
          // remedy — a smaller DOM — that does nothing when the word budget was
          // what cut it.
          ...(e.totalWords === undefined ? {} : { totalWords: e.totalWords }),
          // Same parameter, same representation as fetch_page. It used to hand
          // back a *string* of JSON here and an object there.
          content: format === "json" ? asObject(e.content) : e.content,
        });
      } catch (error) {
        return asToolResult(toolError("extract-failed", error), true);
      }
    },
  );
}

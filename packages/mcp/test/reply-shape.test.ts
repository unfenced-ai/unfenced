import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Unfenced } from "@unfenced-ai/sdk";
import { UnfencedError } from "@unfenced-ai/sdk";
import {
  DEFAULT_DOWNLOAD_CHARS,
  DEFAULT_HTML_CHARS,
  MAX_BATCH_URLS,
  MAX_FORM_FIELDS,
  registerTools,
} from "../src/tools.js";

/**
 * WHAT A TOOL HANDS BACK, DRIVEN THROUGH THE REGISTERED HANDLER.
 *
 * Every defect this file covers is a reply that was a valid reply and a wrong
 * one, which is precisely what a running server never complains about:
 *
 *   - `fetch_batch(format:"json")` returned a STRING of JSON where the
 *     identical `fetch_page(format:"json")` returned an object, because the
 *     batch projection omitted the trailing `format` argument. The comment
 *     above that branch records the same double-encoding as already fixed.
 *   - `extract_page` dropped `contentTruncated`, so a page cut at the 1 MB
 *     ceiling was presented as whole.
 *   - Five handlers had no try/catch, so a revoked key, a quota refusal or a
 *     dead worker reached the agent as a bare sentence with no `error` field -
 *     on a server whose own instructions say failures are structured and the
 *     code is the instruction.
 *   - `fill_form` accepted any number of fields and the engine silently kept
 *     the first 24, answering `ok: true` with no entry for the rest.
 */

interface Registered {
  config: { description?: string; inputSchema?: Record<string, z.ZodTypeAny> };
  handler: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function tools(cloud: Partial<Unfenced>): Map<string, Registered> {
  const registry = new Map<string, Registered>();
  const server = {
    registerTool(name: string, config: Registered["config"], handler: Registered["handler"]) {
      registry.set(name, { config, handler });
    },
  } as unknown as McpServer;
  registerTools(server, cloud as Unfenced);
  return registry;
}

/** What the handler put in the one text block, parsed back. */
async function reply(
  tool: Registered,
  input: Record<string, unknown>,
): Promise<{ body: Record<string, unknown>; isError: boolean }> {
  const out = await tool.handler(input);
  return {
    body: JSON.parse(out.content[0]!.text) as Record<string, unknown>,
    isError: Boolean(out.isError),
  };
}

const delivered = (
  content: string,
): {
  outcome: "delivered";
  doc: Record<string, unknown>;
  meta: Record<string, unknown>;
  content: string;
} => ({
  outcome: "delivered",
  doc: { markdown: "# hi", title: "hi", pageType: "article", wordCount: 2 },
  meta: { tier: 1, renderedJs: false, finalUrl: "https://ex.com/a", durationMs: 5 },
  content,
});

const JSON_BODY = '{"title":"hi","items":[1,2,3]}';

describe("explicit stealth robots fallback", () => {
  const weak = () => ({
    ...delivered(""),
    doc: {
      markdown: "",
      title: "",
      pageType: "article",
      wordCount: 0,
      confidence: { level: "low", reasons: ["empty page"] },
    },
    meta: { tier: 1, renderedJs: false, robotsDisallowed: true },
  });

  it("retries one low-confidence disallowed page in the browser", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(weak())
      .mockResolvedValueOnce(delivered("# rendered"));
    const { body, isError } = await reply(
      tools({ fetch } as Partial<Unfenced>).get("fetch_page")!,
      {
        url: "https://ex.com/a",
        identify: "stealth",
      },
    );
    expect(isError).toBe(false);
    expect(body["content"]).toBe("# rendered");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      identify: "stealth",
      forceRender: true,
      timeoutMs: expect.any(Number),
    });
  });

  it("keeps the first result and warns when browser rendering fails", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(weak())
      .mockRejectedValueOnce(new Error("browser down"));
    const { body, isError } = await reply(
      tools({ fetch } as Partial<Unfenced>).get("fetch_page")!,
      {
        url: "https://ex.com/a",
        identify: "stealth",
      },
    );
    expect(isError).toBe(false);
    expect(body["contentConfidence"]).toBe("low");
    expect(body["contentWarnings"]).toContain("browser rendering failed");
  });

  it.each([
    { identify: "agent" },
    { identify: "auto" },
    { identify: "stealth", forceRender: true },
    { identify: "stealth", format: "html" },
  ])("does not broaden other requests: %j", async (input) => {
    const fetch = vi.fn().mockResolvedValue(weak());
    await reply(tools({ fetch } as Partial<Unfenced>).get("fetch_page")!, {
      url: "https://ex.com/a",
      ...input,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry without a robots disallow or low confidence", async () => {
    for (const result of [
      { ...weak(), meta: { robotsDisallowed: false } },
      { ...weak(), doc: { ...weak().doc, confidence: { level: "high", reasons: [] } } },
    ]) {
      const fetch = vi.fn().mockResolvedValue(result);
      await reply(tools({ fetch } as Partial<Unfenced>).get("fetch_page")!, {
        url: "https://ex.com/a",
        identify: "stealth",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("does not rerender a low-confidence result already produced by the browser", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ...weak(),
      meta: { tier: 2, renderedJs: true, robotsDisallowed: true },
    });
    const { body } = await reply(tools({ fetch } as Partial<Unfenced>).get("fetch_page")!, {
      url: "https://ex.com/search",
      identify: "stealth",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(body["contentConfidence"]).toBe("low");
  });

  it("does not start a retry after the available budget is spent", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValue(32_000);
    try {
      const fetch = vi.fn().mockResolvedValue(weak());
      await reply(tools({ fetch } as Partial<Unfenced>).get("fetch_page")!, {
        url: "https://ex.com/a",
        identify: "stealth",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });
});

describe("asking for JSON gets JSON, from both readers", () => {
  const cloud = {
    async fetch() {
      return delivered(JSON_BODY);
    },
    async batchWithin(urls: string[]) {
      return urls.map(() => delivered(JSON_BODY));
    },
  } as unknown as Partial<Unfenced>;

  it("fetch_page unwraps the body", async () => {
    const { body } = await reply(tools(cloud).get("fetch_page")!, {
      url: "https://ex.com/a",
      format: "json",
    });
    expect(body["content"]).toEqual({ title: "hi", items: [1, 2, 3] });
  });

  it("fetch_batch unwraps it the same way, per entry", async () => {
    const { body } = await reply(tools(cloud).get("fetch_batch")!, {
      urls: ["https://ex.com/a", "https://ex.com/b"],
      format: "json",
    });
    const entries = body as unknown as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry["content"], "a batch entry came back as a string of JSON").toEqual({
        title: "hi",
        items: [1, 2, 3],
      });
    }
  });

  it("and the two agree on the shape for the same format", async () => {
    const single = await reply(tools(cloud).get("fetch_page")!, {
      url: "https://ex.com/a",
      format: "json",
    });
    const batched = await reply(tools(cloud).get("fetch_batch")!, {
      urls: ["https://ex.com/a"],
      format: "json",
    });
    const first = (batched.body as unknown as Array<Record<string, unknown>>)[0]!;
    expect(typeof first["content"]).toBe(typeof single.body["content"]);
  });

  it("leaves unparseable content alone rather than throwing", async () => {
    const broken = {
      async batchWithin(urls: string[]) {
        return urls.map(() => delivered("not json at all"));
      },
    } as unknown as Partial<Unfenced>;
    const { body } = await reply(tools(broken).get("fetch_batch")!, {
      urls: ["https://ex.com/a"],
      format: "json",
    });
    expect((body as unknown as Array<Record<string, unknown>>)[0]!["content"]).toBe(
      "not json at all",
    );
  });
});

it("fetch_batch keeps the SDK's busy remedy and retry delay in the agent reply", async () => {
  const cloud = {
    async batchWithin() {
      return [
        {
          outcome: "failed",
          error: "server-busy",
          detail: "one fetch slot is occupied",
          remedy: "wait for the tenant slot, then retry",
          retryAfterMs: 30_000,
        },
      ];
    },
  } as unknown as Partial<Unfenced>;
  const { body, isError } = await reply(tools(cloud).get("fetch_batch")!, {
    urls: ["https://ex.com/a"],
  });
  const [entry] = body as unknown as Array<Record<string, unknown>>;
  expect(isError).toBe(false);
  expect(entry).toMatchObject({
    error: "server-busy",
    detail: "one fetch slot is occupied",
    remedy: "wait for the tenant slot, then retry",
    retryAfterMs: 30_000,
  });
});

describe("a cut page says so", () => {
  it("extract_page forwards contentTruncated", async () => {
    const cloud = {
      async extract() {
        return {
          url: "https://ex.com/a",
          doc: { title: "big", pageType: "listing", wordCount: 90_000 },
          content: "# big",
          contentTruncated: true,
        };
      },
    } as unknown as Partial<Unfenced>;
    const { body } = await reply(tools(cloud).get("extract_page")!, { sessionId: "abc12345" });
    expect(body["contentTruncated"]).toBe(true);
  });

  it("and stays silent when nothing was cut", async () => {
    const cloud = {
      async extract() {
        return {
          url: "https://ex.com/a",
          doc: { title: "small", pageType: "article", wordCount: 12 },
          content: "# small",
        };
      },
    } as unknown as Partial<Unfenced>;
    const { body } = await reply(tools(cloud).get("extract_page")!, { sessionId: "abc12345" });
    expect(body).not.toHaveProperty("contentTruncated");
  });

  /**
   * `contentTruncated` had TWO causes here and the contract named one.
   *
   * `capRendered` defaults an absent `maxWords` to DEFAULT_MAX_WORDS, so
   * `extract_page` cut the prose at 25,000 words - and the description
   * mentioned only the 1 MB DOM cut, whose documented remedy (reduce the page)
   * does nothing about the other. There was also no parameter to raise it: the
   * value exists on `extractPageAsync` and neither caller passed one, so the
   * flagship case for this tool - a long logged-in listing or thread - had no
   * way to ask for the rest of itself.
   */
  it("asks the worker for the budget the caller named, and reports what was withheld", async () => {
    let asked: unknown[] = [];
    const cloud = {
      async extract(...args: unknown[]) {
        asked = args;
        return {
          url: "https://ex.com/a",
          doc: { title: "long thread", pageType: "thread", wordCount: 25_000 },
          content: "# long thread",
          contentTruncated: true,
          totalWords: 91_400,
        };
      },
    } as unknown as Partial<Unfenced>;
    const { body } = await reply(tools(cloud).get("extract_page")!, {
      sessionId: "abc12345",
      maxWords: 60_000,
    });
    expect(asked[2], "maxWords never reached the worker").toBe(60_000);
    expect(body["contentTruncated"]).toBe(true);
    // `wordCount` is counted AFTER the budget bit, so without this a caller
    // could see that something was withheld and never how much.
    expect(body["totalWords"]).toBe(91_400);
  });

  it("takes maxWords in its schema at all", () => {
    const schema = tools({} as Partial<Unfenced>).get("extract_page")!.config.inputSchema;
    expect(schema && "maxWords" in schema).toBe(true);
  });
});

/**
 * Every reading and access tool answers a service failure with the envelope.
 *
 * The SDK converts only a 400 rejection of the TARGET into a structured
 * failure; everything else - 401 on a revoked key, 402 on a quota refusal, a
 * 502 from the single worker, a network fault - throws, and the MCP SDK
 * flattens a throw into plain text with no `error` field. Those are exactly
 * the failures a paying customer meets.
 */
describe("a service failure keeps its code", () => {
  it("tells the agent an unacknowledged action may already have executed", async () => {
    const cloud = {
      async act() {
        throw new UnfencedError(0, "request expired", {
          code: "execution-uncertain",
          remedy: "the action may have executed - observe before retrying",
        });
      },
    } as unknown as Partial<Unfenced>;
    const { body, isError } = await reply(tools(cloud).get("act")!, {
      sessionId: "s1",
      kind: "click",
      on: "Pay",
    });
    expect(isError).toBe(true);
    expect(body).toMatchObject({
      error: "execution-uncertain",
      remedy: "the action may have executed - observe before retrying",
    });
  });

  const revoked = (): never => {
    throw new UnfencedError(401, "that key was revoked", {
      code: "unauthorized",
      remedy: "check the key configured for this connector",
    });
  };
  const network = (): never => {
    throw new TypeError("fetch failed");
  };

  const CASES: Array<{ tool: string; input: Record<string, unknown>; stub: string }> = [
    { tool: "fetch_page", input: { url: "https://ex.com/a" }, stub: "fetch" },
    { tool: "fetch_batch", input: { urls: ["https://ex.com/a"] }, stub: "batchWithin" },
    { tool: "get_page_links", input: { url: "https://ex.com/a" }, stub: "fetch" },
    { tool: "list_permissions", input: {}, stub: "permissionScope" },
    { tool: "pending_approvals", input: {}, stub: "pendingApprovals" },
    { tool: "list_credentials", input: {}, stub: "credentialNames" },
    { tool: "extract_page", input: { sessionId: "abc12345" }, stub: "extract" },
  ];

  for (const { tool, input, stub } of CASES) {
    it.each([0, 12_000])(
      `${tool} retains a retry delay of %s without repeating work`,
      async (delay) => {
        let calls = 0;
        const busy = (): never => {
          calls++;
          throw new UnfencedError(429, "capacity exhausted", {
            code: "server-busy",
            remedy: "wait for available capacity",
            retryAfterMs: delay,
            retryAfter: "Wed, 09 Sep 2026 12:00:00 GMT",
          });
        };
        const { body, isError } = await reply(
          tools({ [stub]: busy } as unknown as Partial<Unfenced>).get(tool)!,
          input,
        );
        expect(isError).toBe(true);
        expect(body).toMatchObject({
          error: "server-busy",
          retryAfterMs: delay,
          retryAfter: "Wed, 09 Sep 2026 12:00:00 GMT",
        });
        expect(calls).toBe(1);
      },
    );

    it(`${tool} answers a revoked key with {error, detail, remedy}`, async () => {
      const { body, isError } = await reply(
        tools({ [stub]: revoked } as unknown as Partial<Unfenced>).get(tool)!,
        input,
      );
      expect(isError, `${tool} did not mark the reply as an error`).toBe(true);
      expect(body["error"], `${tool} lost the server's code`).toBe("unauthorized");
      expect(body["remedy"]).toBeTruthy();
    });

    it(`${tool} still names a code when the network itself failed`, async () => {
      const { body, isError } = await reply(
        tools({ [stub]: network } as unknown as Partial<Unfenced>).get(tool)!,
        input,
      );
      expect(isError).toBe(true);
      // A TypeError carries no code of its own, so the tool's own fallback is
      // what an agent branches on. What must never happen is no `error` at all.
      expect(typeof body["error"]).toBe("string");
      expect(body["detail"]).toBe("fetch failed");
    });
  }
});

/**
 * The fill_form ceiling is refused, not silently applied.
 *
 * The MCP SDK validates `inputSchema` server-side before the handler runs, so
 * asserting the schema here is asserting the wire: a connector holding a stale
 * cached schema sends 26 fields and is refused by the server all the same.
 */
describe("fill_form's field ceiling", () => {
  const field = (i: number): { on: string; text: string } => ({ on: `field ${i}`, text: `v${i}` });
  const schema = (): z.ZodTypeAny => {
    const cloud = {
      async fill() {
        return { ok: true, filled: [] };
      },
    } as unknown as Partial<Unfenced>;
    const registered = tools(cloud).get("fill_form")!;
    return z.object(registered.config.inputSchema as Record<string, z.ZodTypeAny>);
  };

  it(`accepts ${MAX_FORM_FIELDS} fields`, () => {
    const fields = Array.from({ length: MAX_FORM_FIELDS }, (_, i) => field(i));
    expect(schema().safeParse({ sessionId: "abc12345", fields }).success).toBe(true);
  });

  it(`refuses ${MAX_FORM_FIELDS + 1}, naming the ceiling`, () => {
    const fields = Array.from({ length: MAX_FORM_FIELDS + 1 }, (_, i) => field(i));
    const parsed = schema().safeParse({ sessionId: "abc12345", fields });
    expect(parsed.success, "an oversized batch was accepted and would be cut in half").toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain(String(MAX_FORM_FIELDS));
    }
  });
});

/**
 * A DOWNLOADED FILE IS BOUNDED LIKE EVERY OTHER READ.
 *
 * `read_download`'s schema was `sessionId` and `filename` only, and the handler
 * passed the file's text through whole — nothing downstream capped it either. A
 * site answering an export link with a large CSV, JSON or log (an "export"
 * button is the ordinary way to reach this) destroyed the caller's context in
 * one call. `bytes` still reports the WHOLE file, so a caller can see how much
 * it is not being shown.
 */
/**
 * THE HTML READERS PROMISED A BOUNDED REPLY AND HAD NO BOUND.
 *
 * `caps.ts` states outright that `format: "html"` returns the source VERBATIM
 * and that only markdown and text are cut when `maxWords` bites, so the only
 * ceiling on an html body was the engine's own per-page 1 MB
 * `MAX_EXTRACT_BYTES`. `urls` is `.max(20)`. So
 * `fetch_batch({urls: [20 large pages], format: "html"})` is one
 * ordinary-looking call returning on the order of 20 MB of raw markup —
 * roughly five million tokens — into a single tool result, while the tool's own
 * description told the agent the reply SHARES a budget and that more pages
 * means less of each.
 *
 * The misinformation is the worse half: an agent that believes that sentence
 * has no reason to pass `maxWords`, and `maxWords` would not have helped.
 */
describe("the html budget both readers promise", () => {
  const huge = `<html><body>${"<p>x</p>".repeat(200_000)}</body></html>`;
  const cloud = {
    async fetch() {
      return delivered(huge);
    },
    async batchWithin(urls: string[]) {
      return urls.map(() => delivered(huge));
    },
  } as unknown as Partial<Unfenced>;

  it("fetch_page cuts an html body at the ceiling and says so", async () => {
    const { body } = await reply(tools(cloud).get("fetch_page")!, {
      url: "https://ex.com/a",
      format: "html",
    });
    expect((body["content"] as string).length).toBe(DEFAULT_HTML_CHARS);
    expect(body["contentTruncated"]).toBe(true);
    // What there was, so a caller can tell how much it is not being shown.
    expect(body["totalChars"]).toBe(huge.length);
  });

  /**
   * THE NUMBER IN THE SENTENCE IS THE NUMBER IN THE REPLY.
   *
   * The description tells the agent the batch shares 250,000 characters. The
   * code hand-wrote a 25,000 per-page floor, which beat the share from eleven
   * URLs up, so the documented 20-page html batch returned 500,000 — roughly
   * 125-165k tokens, over half a 200k window, in one tool result with no
   * per-entry parameter able to lower it, because maxWords does not reach html.
   *
   * The old assertion here was `toBeLessThan(600_000)`, which proved only that
   * the result was not catastrophic and passed the whole time the promise was
   * broken by a factor of two. So the bound is PARSED OUT OF THE SENTENCE the
   * agent reads: whatever that number becomes, the reply is held to it.
   */
  it("fetch_batch shares exactly the ceiling its description names", async () => {
    const batch = tools(cloud).get("fetch_batch")!;
    const said = /shares ([\d,]+) characters/.exec(batch.config.description ?? "");
    expect(said, "the description no longer states a shared character budget").toBeTruthy();
    const promised = Number(said![1]!.replace(/,/g, ""));
    expect(promised).toBe(DEFAULT_HTML_CHARS);

    const urls = Array.from({ length: MAX_BATCH_URLS }, (_, i) => `https://ex.com/${i}`);
    const { body } = await reply(batch, { urls, format: "html" });
    const entries = body as unknown as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(MAX_BATCH_URLS);
    const total = entries.reduce((sum, e) => sum + (e["content"] as string).length, 0);
    // 20 x 1 MB before any cap, 500,000 under the hand-written floor, and the
    // promise from the first line either way.
    expect(total).toBeLessThanOrEqual(promised);
    for (const entry of entries) expect(entry["contentTruncated"]).toBe(true);
  });

  it("holds the same promise at every batch size, not only the maximum", async () => {
    // Eleven is where the old floor started winning; one and two are where a
    // share-only rule would be at its most generous. The sentence has to be
    // true at all of them.
    for (const n of [1, 2, 10, 11, 12, MAX_BATCH_URLS]) {
      const urls = Array.from({ length: n }, (_, i) => `https://ex.com/${n}-${i}`);
      const { body } = await reply(tools(cloud).get("fetch_batch")!, { urls, format: "html" });
      const entries = body as unknown as Array<Record<string, unknown>>;
      const total = entries.reduce((sum, e) => sum + (e["content"] as string).length, 0);
      expect(total, `${n} urls`).toBeLessThanOrEqual(DEFAULT_HTML_CHARS);
    }
  });

  it("leaves markdown alone, where the word budget already bites", async () => {
    // The engine caps prose; doing it again here would be a second, silent cut
    // on a body that was already budgeted, reported as if this one made it.
    const { body } = await reply(tools(cloud).get("fetch_page")!, { url: "https://ex.com/a" });
    expect(body["content"]).toBe(huge);
    expect(body["contentTruncated"]).toBeUndefined();
  });
});

describe("read_download's budget", () => {
  const big = "x".repeat(DEFAULT_DOWNLOAD_CHARS + 5_000);
  const cloud = {
    async readDownload() {
      return {
        filename: "export.csv",
        bytes: big.length,
        doc: { title: "export", wordCount: 1 },
        content: big,
      };
    },
  } as unknown as Partial<Unfenced>;

  it("caps the text and says it did", async () => {
    const { body } = await reply(tools(cloud).get("read_download")!, {
      sessionId: "abc12345",
      filename: "export.csv",
    });
    expect((body["content"] as string).length).toBe(DEFAULT_DOWNLOAD_CHARS);
    expect(body["contentTruncated"]).toBe(true);
    expect(body["totalChars"]).toBe(big.length);
    // The whole file's size, so the caller can tell how much is missing.
    expect(body["bytes"]).toBe(big.length);
  });

  it("honours a caller's own maxChars", async () => {
    const { body } = await reply(tools(cloud).get("read_download")!, {
      sessionId: "abc12345",
      filename: "export.csv",
      maxChars: 100,
    });
    expect((body["content"] as string).length).toBe(100);
    expect(body["contentTruncated"]).toBe(true);
  });

  it("says nothing about truncation when a file fits", async () => {
    const small = {
      async readDownload() {
        return {
          filename: "note.txt",
          bytes: 5,
          doc: { title: "note", wordCount: 1 },
          content: "hello",
        };
      },
    } as unknown as Partial<Unfenced>;
    const { body } = await reply(tools(small).get("read_download")!, {
      sessionId: "abc12345",
      filename: "note.txt",
    });
    expect(body["content"]).toBe("hello");
    expect(body).not.toHaveProperty("contentTruncated");
  });
});

/**
 * OPEN_PAGE TELLS AN OUTAGE FROM AN ANSWER.
 *
 * Three pre-open reads each swallowed their rejection into a benign-looking
 * default, so a read fault on the allowlist arrived as "you may act on
 * nothing" — and setupHint then instructed the agent to tell the user they have
 * no permission. That is the exact misreport the route and the SDK were written
 * to prevent: the SDK raises `unreadableAllowlist` whose own text says "this is
 * NOT a refusal by the owner ... treat it as a transient fault", and the route
 * omits `allowed` rather than sending `[]` so the two cannot be confused.
 */
describe("open_page during a read fault", () => {
  const opened = {
    async open() {
      return { id: "abc12345", initial: { url: "https://ex.com/a" } };
    },
    async connectLink() {
      return "https://unfenced.ai/setup";
    },
  };

  it("omits canActHere rather than answering false", async () => {
    const cloud = {
      ...opened,
      async permissionScope(): Promise<never> {
        throw new UnfencedError(503, "the allowlist could not be read", {
          code: "permissions-unavailable",
        });
      },
      async credentialNames() {
        return [];
      },
      async accountPrefs() {
        return { askMode: "always", sites: {} };
      },
    } as unknown as Partial<Unfenced>;
    const { body } = await reply(tools(cloud).get("open_page")!, { url: "https://ex.com/a" });
    expect(body).not.toHaveProperty("canActHere");
    expect(body).not.toHaveProperty("mayActOn");
    expect(body["permissionsUnavailable"]).toBe(true);
    // And no setup link: that is an instruction to the user to grant something,
    // and nothing here knows that anything needs granting.
    expect(body).not.toHaveProperty("setupUrl");
    expect(String(body["note"])).toMatch(/UNKNOWN rather than no/);
  });

  it("still answers canActHere when the read succeeded", async () => {
    const cloud = {
      ...opened,
      async permissionScope() {
        return { entries: [{ host: "ex.com", mode: "approve" }], anySite: false };
      },
      async credentialNames() {
        return [];
      },
      async accountPrefs() {
        return { askMode: "always", sites: {} };
      },
    } as unknown as Partial<Unfenced>;
    const { body } = await reply(tools(cloud).get("open_page")!, { url: "https://ex.com/a" });
    // `approve` permits acting; only `read` does not.
    expect(body["canActHere"]).toBe(true);
    expect(body).not.toHaveProperty("permissionsUnavailable");
  });

  /**
   * ...and the credentials arm, which the permissions fix walked past.
   *
   * A vault read fault leaves `creds` empty, so `loginsHere` is empty, so
   * `setupHint` reached its "and have no saved login for it" branch — the same
   * false statement the permissions arm was fixed for, one field over. The
   * agent then asks the user to save a login they may already have, and the
   * sentence's own advice ("give them THIS link ... once they save it, retry")
   * talks it out of the one move that would have worked.
   */
  it("does not say there is no saved login when the store could not be read", async () => {
    const cloud = {
      ...opened,
      async permissionScope() {
        return { entries: [], anySite: false };
      },
      async credentialNames(): Promise<never> {
        throw new UnfencedError(503, "the vault could not be read", {
          code: "credentials-unavailable",
        });
      },
      async accountPrefs() {
        return { askMode: "always", sites: {} };
      },
    } as unknown as Partial<Unfenced>;
    const { body } = await reply(tools(cloud).get("open_page")!, { url: "https://ex.com/a" });
    expect(body["credentialsUnavailable"]).toBe(true);
    // Omitted, not defaulted: an absent list is a question, `[]` is an answer.
    expect(body).not.toHaveProperty("loginsHere");
    expect(
      String(body["setupHint"]),
      "an outage was reported to the agent as `you have no saved login`",
    ).not.toMatch(/no saved login/);
    expect(String(body["setupHint"])).toMatch(/UNKNOWN/);
    // And the flag is explained rather than left as a field name the agent is
    // told never to quote at a person.
    expect(String(body["credentialNote"])).toMatch(/UNKNOWN rather than none/);
  });

  it("chooses no account when the preferences could not be read", async () => {
    let openedWith: Record<string, unknown> = {};
    const cloud = {
      async open(_url: string, options: Record<string, unknown>) {
        openedWith = options;
        return { id: "abc12345", initial: { url: "https://ex.com/a" } };
      },
      async connectLink() {
        return "https://unfenced.ai/setup";
      },
      async permissionScope() {
        return { entries: [{ host: "ex.com", mode: "free" }], anySite: false };
      },
      async credentialNames() {
        return [
          {
            name: "g1",
            username: "a@b.c",
            kind: "oauth",
            hasTotp: false,
            site: "accounts.google.com",
            provider: "google",
            updatedAt: "",
          },
          {
            name: "site-google",
            username: null,
            kind: "oauth",
            hasTotp: false,
            site: "ex.com",
            provider: "google",
            updatedAt: "",
          },
        ];
      },
      async accountPrefs(): Promise<never> {
        throw new UnfencedError(503, "prefs unreadable", { code: "prefs-unavailable" });
      },
    } as unknown as Partial<Unfenced>;
    const { body } = await reply(tools(cloud).get("open_page")!, { url: "https://ex.com/a" });
    // A single candidate would ordinarily be resolved automatically. It must not
    // be here: an unread curation map and a never-curated site look identical
    // once the failure has become `{}`, and they have opposite right answers.
    expect(openedWith["account"]).toBeUndefined();
    expect(body["accountPrefsUnavailable"]).toBe(true);
  });
});

/**
 * EXTRACT_PAGE HAD NO BUDGET PARAMETER AT ALL, AND THE CHAIN HAD NO KNOB.
 *
 * The whole input schema was {sessionId, format}. The SDK signature was
 * `extract(http, id, format)` and the route called `extractPageAsync(html,
 * {url, format})` with no maxWords — while that function has accepted one for
 * months and every fetch call site passes one. Measured:
 * `extractPageAsync(1.36MB html, {format:"html"})` returned exactly 1,000,000
 * characters, which is 250,000-330,000 tokens of raw HTML in one reply, on the
 * flagship logged-in-page case this tool exists for. The read_download budget
 * landed in the same wave; this reader was the one it missed.
 */
describe("extract_page's budget", () => {
  const asked: Array<number | undefined> = [];
  const cloud = {
    async extract(_id: string, _format: string, maxWords?: number) {
      asked.push(maxWords);
      return {
        url: "https://example.com/thread",
        doc: { title: "thread", pageType: "article", wordCount: 90_000 },
        content: "x".repeat(1000),
      };
    },
  } as unknown as Partial<Unfenced>;

  it("takes a word budget and passes it down the chain", async () => {
    asked.length = 0;
    await reply(tools(cloud).get("extract_page")!, { sessionId: "abc12345", maxWords: 500 });
    expect(asked, "maxWords stopped at the tool boundary").toEqual([500]);
  });

  it("still works when a caller names none", async () => {
    asked.length = 0;
    const { body } = await reply(tools(cloud).get("extract_page")!, { sessionId: "abc12345" });
    expect(asked).toEqual([undefined]);
    expect(body["url"]).toBe("https://example.com/thread");
  });

  /**
   * The caveat has to be in the DESCRIPTION, because it is the only place an
   * agent can read it: `format:"html"` returns the document as it arrived and
   * the word budget does not narrow it, exactly as fetch_page already says.
   */
  it("says what the budget does not cover", async () => {
    const tool = tools(cloud).get("extract_page")!;
    const description = String((tool.config as { description?: unknown }).description ?? "");
    expect(description).toContain("maxWords does not narrow it");
  });
});

it("opens the explicitly selected workspace account even when a private account has the same name", async () => {
  let selected: unknown;
  const cloud = {
    async permissionScope() {
      return { entries: [{ host: "claude.com", mode: "free" }], anySite: false };
    },
    async credentialNames() {
      return [
        {
          name: "google",
          kind: "oauth",
          provider: "google",
          site: "accounts.google.com",
          username: "Private",
        },
        {
          name: "google",
          browserAccount: "workspace:google",
          kind: "oauth",
          provider: "google",
          site: "accounts.google.com",
          username: "Workspace",
        },
        { name: "claude-login", kind: "oauth", provider: "google", site: "claude.com" },
      ];
    },
    async accountPrefs() {
      return {
        askMode: "always",
        sites: { "claude.com": { accounts: ["workspace:google"], main: "workspace:google" } },
      };
    },
    async open(_url: string, options: unknown) {
      selected = options;
      return { id: "opened", initial: { url: "https://claude.com/" } };
    },
  } as unknown as Partial<Unfenced>;
  const result = await reply(tools(cloud).get("open_page")!, {
    url: "https://claude.com/",
    intent: "act",
  });
  expect(result.isError).toBe(false);
  expect(selected).toMatchObject({ account: "workspace:google" });
});

it("tells the agent requests are disabled and never auto-requests an outside site", async () => {
  let connections = 0;
  const cloud = {
    permissionScope: async () => ({
      entries: [{ host: "allowed.example", mode: "free" }],
      anySite: false,
      allowSiteRequests: false,
    }),
    credentialNames: async () => [],
    accountPrefs: async () => ({ askMode: "always", sites: {} }),
    open: async () => ({
      sessionId: "s1",
      page: {
        url: "https://outside.example",
        title: "Outside",
        controls: [],
        links: [],
        excerpt: "",
      },
    }),
    connectLink: async () => {
      connections++;
      return "https://setup.example";
    },
  } as unknown as Partial<Unfenced>;
  const registry = tools(cloud);
  const permissions = await reply(registry.get("list_permissions")!, {});
  expect(permissions.body).toMatchObject({
    allowSiteRequests: false,
    mayActOn: ["allowed.example"],
  });
  expect(permissions.body.note).toContain("Do not call connect_site");
  const opened = await reply(registry.get("open_page")!, { url: "https://outside.example" });
  expect(opened.body).toMatchObject({ canActHere: false, allowSiteRequests: false });
  expect(opened.body).not.toHaveProperty("setupUrl");
  expect(connections).toBe(0);
});

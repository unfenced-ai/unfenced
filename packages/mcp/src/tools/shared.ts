/**
 * Shared support for the unfenced MCP tool set.
 *
 * The one tool-result envelope, the one error shape, the fetch/failure payload
 * shapers, the remedy table, and the see_page legend - everything a tool body
 * calls that is not itself a tool. Kept in one sibling module so every domain
 * module and the barrel reach the SAME copy, and so nothing here imports back
 * from the barrel: the graph is one-way, barrel -> tool modules -> shared.
 *
 * The act input/output fold lives beside this in ./act-fold.ts; the four things
 * docs-check reads out of tools.ts by text (TOOL_NAMES, FAILURE_TAXONOMY,
 * SERVER_INSTRUCTIONS and the act `kind` enum) stay in the barrel.
 */
import { UnfencedError } from "@unfenced-ai/sdk";
import type { InterruptKind } from "@unfenced-ai/sdk";

/**
 * Tool annotations (MCP `annotations`) - how a client should treat each tool.
 *
 * These matter more than they look: without them a client assumes the worst
 * (readOnlyHint defaults to false) and prompts the user for approval before
 * every call. A read-only tool that sits behind an approval prompt reads to the
 * agent as a failure - `list_permissions` returned "No approval received", which
 * looks exactly like a permission denial from the server.
 *
 * WEB_READ: reads a remote page, changes nothing anywhere.
 * LOCAL_READ: reads our own state, touches no external entity.
 */
/**
 * What a page may spend of a caller's context when nobody said.
 *
 * `maxWords` bounds a fetch, and a caller who sets nothing received everything:
 * one RFC came back at 64,822 words, about 85k tokens, a third of a context
 * window from a single call. The tool description said to use maxWords, which
 * is a documented hazard rather than a bound.
 *
 * Set well above what pages actually weigh, so it almost never bites. Measured
 * across real pages: MDN 168, python.org 282, nodejs.org 181, a feed 717,
 * Hacker News 1,055, a dev blog 1,475, Wikipedia's cast iron article 4,205 -
 * and the RFC at 64,822, which is the case this exists for. Twenty-five
 * thousand passes every one of those but the outlier, and the outlier truncates
 * honestly: `contentTruncated` says it happened and `totalWords` says how much
 * there was, so a caller that genuinely wants the whole specification asks for
 * it and gets it.
 *
 * A batch shares this budget rather than each page taking it, because ten pages
 * at the per-page cap is still ten times the reply.
 */
export const DEFAULT_MAX_WORDS = 25_000;

/** Links returned by get_page_links when the caller does not say. See the tool. */
export const DEFAULT_MAX_LINKS = 500;

/**
 * What a downloaded file may spend of a caller's context when nobody said.
 *
 * `read_download` took `sessionId` and `filename` and nothing else, and passed
 * the file's text through whole - no cap here, none in the route, none in the
 * engine, though `options.maxChars` exists and is threaded as far as core. A
 * site answering an export link with a large CSV, JSON or log is the ordinary
 * case, not the exotic one: an "export" button is how a person gets their data
 * out, and the reply is `JSON.stringify(payload)` into one tool
 * result.
 *
 * In the same register as fetch_page's 25,000-word default: generous enough
 * that an ordinary statement or invoice never meets it, and small enough that
 * one call cannot take the window. Characters rather than words because a log
 * or a minified JSON blob has few "words" and a great many bytes, which is
 * exactly the payload a word budget fails open on.
 */
export const DEFAULT_DOWNLOAD_CHARS = 120_000;

/**
 * What `format: "html"` may spend of a caller's context when nobody said.
 *
 * The word budget governs the EXTRACTED PROSE - `caps.ts` says outright that
 * html returns the source verbatim and that only markdown and text are cut when
 * `maxWords` bites - so for html the only ceiling was the engine's own 1 MB
 * `MAX_EXTRACT_BYTES`. Per page. `urls` is capped at `MAX_BATCH_URLS`, so
 * `fetch_batch({urls: [20 large pages], format: "html"})` is one
 * ordinary-looking call that returns on the order of 20 MB of raw markup into a
 * single tool result - roughly five million tokens - while the tool's own
 * description told the agent the reply was bounded and that more pages means
 * less of each.
 *
 * The misinformation was the worse half: an agent that trusts that sentence has
 * no reason to pass `maxWords`, and `maxWords` would not have helped if it had.
 *
 * Characters rather than words for the reason DEFAULT_DOWNLOAD_CHARS gives -
 * markup has few "words" and a great many bytes, which is exactly the payload a
 * word budget fails open on - and in the same register as the prose budget:
 * 25,000 words of prose is roughly 150,000 characters, and html carries the
 * same document with its markup still on.
 */
export const DEFAULT_HTML_CHARS = 250_000;

/**
 * How many URLs one `fetch_batch` may carry.
 *
 * Written once because three things divide by it: the schema's `.max()`, the
 * sentence the agent reads, and the per-page share below.
 */
export const MAX_BATCH_URLS = 20;

/**
 * The smallest html share a batch entry can be given.
 *
 * DERIVED, and that is the whole point. The floor was a hand-written 25,000,
 * which beat the share from eleven URLs up: twenty pages returned 500,000
 * characters under a description that told the agent the batch SHARES 250,000
 * - roughly 125-165k tokens, over half a 200k window, in one tool result with
 * no per-entry parameter able to lower it, because `maxWords` does not reach
 * html by design.
 *
 * The word budget beside it never had the problem, and its shape is why: a 500
 * floor against a 25,000 budget cannot bite until 50 URLs, and the schema stops
 * at 20. So the floor there is insurance against a future `.max()`, not a
 * second policy. Deriving this one from the same two numbers gives it the same
 * property - inside the documented maximum the share always wins, and the
 * sentence is true.
 */
export const MIN_BATCH_HTML_CHARS = Math.floor(DEFAULT_HTML_CHARS / MAX_BATCH_URLS);

/**
 * Cut an html body to the ceiling, and say so in the same reply.
 *
 * Only for `format: "html"`. Every other format is the extracted prose, which
 * the word budget already governs at the engine - and cutting a rendered JSON
 * document here would produce the unparseable body `capRendered`'s own header
 * refuses to produce.
 */
export function capHtml(
  content: string,
  maxChars: number,
): { content: string; truncated: boolean; totalChars: number } {
  if (content.length <= maxChars) {
    return { content, truncated: false, totalChars: content.length };
  }
  return { content: content.slice(0, maxChars), truncated: true, totalChars: content.length };
}

/**
 * How many fields one `fill_form` call may carry.
 *
 * A SECOND copy of `MAX_FIELDS` in core/src/session/fill-form.ts, and it is
 * here because the alternative is worse: importing the value would put a
 * runtime dependency on the private `@unfenced/core` inside the published
 * package. `reply-shape.test.ts` reads core's own source and fails if the
 * two numbers stop agreeing, which is the binding this repository asks for
 * when a fact cannot be deleted.
 *
 * The engine USED to truncate at this number - `fields.slice(0, MAX_FIELDS)`,
 * with `ok` computed over what survived - so a 26-field call was answered with
 * 24 entries, `ok: true`, and nothing naming the two that were never attempted.
 * Measured on production. The documented next step after a fill is a deliberate
 * submit, so the caller then submitted a form it believed was complete.
 *
 * This schema closed that for the agent and for nobody else: the HTTP route and
 * the SDK validate only that the array is non-empty. So the engine now refuses
 * the fields past its ceiling INSTEAD of dropping them - one entry per field
 * sent, `ok` false, and the untried ones named - which is the answer every
 * surface gets. This stays because it is still the better answer HERE: an agent
 * told the ceiling before the call spends no acts at all, where the engine's
 * refusal arrives after 24 of them.
 */
export const MAX_FORM_FIELDS = 24;

export const WEB_READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
export const LOCAL_READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function asToolResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** An action's optional screenshot is an image, never base64 prose for the model to read. */
export function actToolResult(result: import("@unfenced-ai/sdk").ActResult) {
  if (!result.view) return asToolResult(result);
  const { image: uri, ...view } = result.view;
  const picture = parseDataUri(uri);
  if (!picture) return asToolResult(result);
  return {
    content: [...asToolResult({ ...result, view }).content, { type: "image" as const, ...picture }],
  };
}

/**
 * Split a `data:<mime>;base64,<data>` URI into the parts an MCP image block
 * wants. The screenshot route hands back a data URI; an image content block
 * wants the base64 and the mime type apart. Null when it is not a data URI, so
 * the caller can report "no frame" rather than send garbage as an image.
 */
export function parseDataUri(uri: string): { mimeType: string; data: string } | null {
  const m = uri.match(/^data:([^;]+);base64,(.*)$/s);
  if (!m || !m[1] || !m[2]) return null;
  return { mimeType: m[1], data: m[2] };
}

/** Flatten an SDK fetch result to the shape agents consume. */
/**
 * A failure an agent can act on.
 *
 * `retryAfter` matters as much as the reason: when the wait is only stated in
 * prose inside `detail` ("waiting 55m"), an agent cannot schedule against it and
 * treats a temporary hold as a dead end.
 */
export function failurePayload(r: {
  error: string;
  detail?: string;
  remedy?: string;
  retryAfterMs?: number;
  meta?: Record<string, unknown>;
}): Record<string, unknown> {
  const retryAfter = r.meta?.["retryAfter"];
  const retryAfterMs = r.retryAfterMs ?? r.meta?.["retryAfterMs"];
  const remedy = r.remedy ?? remedyFor(r.error, r.detail);
  return {
    error: r.error,
    ...(r.detail ? { detail: r.detail } : {}),
    ...(typeof retryAfter === "string" ? { retryAfter } : {}),
    ...(typeof retryAfterMs === "number" ? { retryAfterMs } : {}),
    ...(remedy ? { remedy } : {}),
  };
}

/**
 * Is the description worth its own line, or is it the first paragraph again?
 *
 * `<meta name="description">` is usually the lede with the end cut off, so it
 * arrived as a second copy of text the caller already had - 15% of the reply on
 * a short article, spent saying the same thing twice. A curated summary that
 * says something the body does not is worth keeping, and that is the only case
 * this lets through.
 *
 * Compared with punctuation and case flattened, because the two copies rarely
 * match byte for byte: a CMS truncates at 155 characters, appends an ellipsis,
 * or straightens the quotes on its way out.
 */
export function saysSomethingNew(description: string | null | undefined, content: string): boolean {
  if (!description) return false;
  const flatten = (t: string): string =>
    t
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, " ")
      .trim();
  const flat = flatten(description);
  if (!flat) return false;
  return !flatten(content).includes(flat);
}

export function fetchPayload(
  r: {
    doc: {
      markdown: string;
      title: string;
      pageType: string;
      wordCount?: number;
      description?: string | null;
      author?: string | null;
      publishedAt?: string | null;
      siteName?: string | null;
      lang?: string | null;
      confidence?: { level: string; reasons: string[] };
    };
    meta: {
      tier: number;
      renderedJs: boolean;
      finalUrl: string;
      durationMs: number;
      contentTruncated?: boolean;
      totalWords?: number;
      omissions?: { kind: string; amount?: number; unit?: string }[];
      cached?: boolean;
    };
    content?: string;
  },
  format?: string,
  /** The html ceiling for THIS call. A batch divides it; see DEFAULT_HTML_CHARS. */
  maxHtmlChars: number = DEFAULT_HTML_CHARS,
): Record<string, unknown> {
  const confidence = r.doc.confidence;
  // `format: "html"` is the document as it arrived, so the word budget does not
  // reach it and the engine's only ceiling is a per-page megabyte. Twenty of
  // those is one tool result. See `capHtml`.
  const html = format === "html" ? capHtml(r.content ?? r.doc.markdown, maxHtmlChars) : null;
  return {
    // Asked for JSON, get JSON. It used to arrive as a *string* of JSON inside
    // this field, so a caller had to parse a value out of an already-parsed
    // document - the same double-encoding that made `act`'s errors unreadable.
    content:
      format === "json" ? asObject(r.content) : (html?.content ?? r.content ?? r.doc.markdown),
    // What there was, so a caller can tell how much it is not being shown -
    // the same pair `read_download` reports.
    ...(html?.truncated ? { totalChars: html.totalChars } : {}),
    // Counted once, on the extracted text, in the page's own script - not on the
    // emitted string. Splitting the serialisation on whitespace gave a different
    // answer per format and undercounted Japanese by an order of magnitude.
    ...(r.meta.totalWords !== undefined ? { totalWords: r.meta.totalWords } : {}),
    ...(r.meta.omissions?.length || html?.truncated
      ? {
          omissions: [
            ...(r.meta.omissions ?? []),
            ...(html?.truncated
              ? [
                  {
                    kind: "character-cap",
                    amount: html.totalChars - html.content.length,
                    unit: "characters",
                  },
                ]
              : []),
          ],
        }
      : {}),
    ...(r.meta.contentTruncated || html?.truncated ? { contentTruncated: true } : {}),
    // Says plainly that a repeat was served from a recent identical fetch.
    ...(r.meta.cached ? { cached: true } : {}),
    // Already computed, and useful for judging a source: an agent could only
    // reach these by asking for JSON and parsing a string out of a field.
    ...(r.doc.publishedAt ? { publishedAt: r.doc.publishedAt } : {}),
    ...(r.doc.author ? { author: r.doc.author } : {}),
    ...(r.doc.siteName ? { siteName: r.doc.siteName } : {}),
    ...(saysSomethingNew(r.doc.description, r.content ?? r.doc.markdown)
      ? { description: r.doc.description }
      : {}),
    ...(r.doc.lang ? { lang: r.doc.lang } : {}),
    tier: r.meta.tier,
    renderedJs: r.meta.renderedJs,
    finalUrl: r.meta.finalUrl,
    durationMs: r.meta.durationMs,
    pageType: r.doc.pageType,
    title: r.doc.title,
    // Only carried when the extraction looks unreliable. Silence means "this
    // looks like the page"; a warning here is the difference between an agent
    // trusting a suggestions sidebar and knowing to check.
    ...(confidence?.level === "low"
      ? { contentConfidence: "low", contentWarnings: confidence.reasons }
      : {}),
  };
}

/**
 * One error shape, for every tool.
 *
 * Three contracts had grown up side by side: the fetch tools returned a clean
 * {error, detail}; `act` wrapped the transport error and stringified the real
 * one INSIDE it, so a caller had to JSON.parse a field to learn the actual code;
 * and `close_page` let the bare transport string escape with no envelope at all.
 * An agent consuming this had to know three parsing strategies for one class of
 * failure.
 *
 * So unwrap at the boundary. The server already answers with a structured
 * {error, detail}; the SDK raises it as a transport error carrying that body as
 * text, and this puts it back the way it was - plus a line saying what to do,
 * which the fetch path's errors have always had and these never did.
 */
export const REMEDIES: Record<string, string> = {
  "server-busy":
    "the service has no available fetch slot for this account - wait at least retryAfterMs before retrying within your deadline",
  "execution-uncertain":
    "the live-session write may have executed before the connection timed out - observe the session or list open sessions before retrying, especially before submitting",
  "extraction-limit":
    "the page exceeded this worker's extraction memory budget - use a smaller page or a site-provided text/API version; repeating the same fetch or changing browser tier will not reduce its extraction cost",
  // This used to say "that page is no longer open", which is a claim this side cannot
  // make. Measured on a worker switch: the router picks a worker PER ACCOUNT, a live
  // page lives in ONE worker's memory, so the moment an account moves every session id
  // it holds answers 404 no-session on the new worker while the page is still open on
  // the old one. The agent was told the page had closed, reopened, and left the real
  // page holding a browser tab until its idle clock took it.
  //
  // A server that knows better now sends its own `remedy`, which outranks this table
  // (see toolError below); this is the fallback for a server that does not, so it says
  // what is true in every case instead of guessing which one it is.
  "no-session":
    "the worker that answered is not holding a page with that id - it may have closed on its " +
    "own idle clock, or it may still be open on the other worker if this account's worker was " +
    "switched. Either way logins are stored centrally and were kept: call open_page again and " +
    "it comes up signed in. Retrying this id will not bring it back",
  "not-found":
    "nothing here under that id - check it came from this account and has not already been closed or expired",
  unauthorized: "the API key was not accepted - check the key configured for this connector",
  "blocked-target":
    "that address is on a private network and is not reachable from this service - check the URL, including where it redirects to",
  "act-failed": "observe_page for a fresh snapshot, then try the action again",
  // ── act codes, where the generic "observe and try again" is WRONG advice ────
  //
  // Every one of these arrives inside the `act-failed` bucket, whose remedy is
  // "observe_page for a fresh snapshot, then try the action again". That is
  // right for a stale ref and actively harmful for the 6 below: 3 of them
  // cannot be fixed by observing at all, and the other 3 are not failures of
  // the act - the page moved, the page was interrupted, or the network answered.
  // A remedy is the main steering signal an agent gets, so a wrong one does not
  // merely fail to help - it routes the recovery into a loop with no exit.
  "no-history":
    "there is nothing in this session's history in that direction, and no retry creates one - nothing was attempted, so the page is exactly where it was. Navigate to the URL you wanted instead",
  "no-window":
    "there is no window with that number any more - a popup can close itself between a reading and an act. The reply's `windows` field lists what is actually open; re-read it and switch to a number in that range, or carry on in the window you are in",
  "write-failed":
    "the element was found, it is the right kind and it is ready - the TEXT is what did not land, usually a rich-text editor taking its selection back. Do NOT observe and retry: the identical call fails identically. Send `type` WITHOUT `append` to replace the contents outright, clear the field first, or ask the user to take the wheel of this session and edit it by hand",
  "page-moved":
    "the page navigated while the act was being read - this is what a click that goes somewhere does, and it is not a fault. Do not repeat the act; it may well have worked. observe_page once to see where you landed, and continue from there",
  "page-unresponsive":
    "the page's own script stopped yielding, so the reading could not come back; it has been interrupted and the page is still open and still usable. The act itself may have landed - observe_page once to see what the page looks like now, then carry on. If the same act wedges the page a second time, that is the site doing it rather than a fault to retry through: ask the user to take the wheel of this session",
  "navigate-failed":
    "the navigation was attempted and did not arrive - the detail says what the network answered. The page you were on is unchanged, so this is safe to retry once; if it repeats, the address is the problem rather than the act",
  // THE SNAPSHOT IS ALREADY HERE. `ref-stale` is not a fault: a ref names an
  // element, and a page that re-renders between the snapshot and the act - every
  // modern sign-in, in the seconds a model spends deciding - detaches the element
  // the ref named. Refusing is right; clicking whatever now sits in that spot is
  // the bug the refusal exists to prevent. What changed is that the engine now
  // attaches the current page to the refusal, so the observe this used to ask for
  // is a round trip that buys nothing.
  "ref-stale":
    "the element that ref named has been replaced - the page re-rendered while you were " +
    "deciding, which is normal on a sign-in and is not the page refusing you. The CURRENT " +
    "snapshot is attached as `page`: take the new ref for the same control out of it and " +
    "re-send the identical act. Do NOT call observe_page first - you already have what it " +
    "would return. If the same ref goes stale twice, aim by words instead (`on`), which " +
    "survives a re-render because it is resolved fresh each time",
  "permission-required": "the account owner allows a site with: webfetch allow <site>",
  "confirmation-required": "repeat the same call with confirm: true",
  // ── the rest of ACT_CODES ──────────────────────────────────────────────────
  //
  // Only the 21 FETCH codes were ever bound to advice: taxonomy.test.ts parsed
  // `FetchErrorCode` out of core and asserted a remedy for each. The act code
  // space is a second, LARGER authority - `ACT_CODES` in core/src/session/
  // actions.ts, 44 members - and nothing bound it, so 32 of them had no entry
  // here at all. Two of those are what a customer meets on the flow the product
  // rests on: `no-credential` and `bad-totp-seed` come back from the route as
  // 404/422 and reach the agent through `toolError`, whose remedy is
  // `REMEDIES[code]` - undefined. The rest fell through `actFailure`'s tail to
  // `remedyFor("act-failed")`, the generic "observe and try again", which the
  // comment above calls a loop with no exit for refusals no observation can
  // change. taxonomy.test.ts now reads ACT_CODES the same way it reads the
  // fetch codes, so the next verb cannot arrive without advice.
  "session-busy":
    "another act is still running on this page - a page has one pointer and one keyboard, so acts are serialised. Wait for the one in flight to answer instead of piling on: two overlapping types interleave their characters",
  "agent-scope-required":
    "this API key is narrowed to particular sites and this is not one of them. The narrowing is on the KEY, so granting the site does not widen it - tell the person which site the key needs and let them re-scope it",
  "approval-required":
    "this site is granted in ask-each-time mode, so the account owner has to approve this action before it runs. Say so in the conversation rather than leaving it in a dashboard nobody opens; pending_approvals shows what is waiting and until when",
  "credential-wrong-site":
    "that stored login belongs to a different site, and filling it here would hand one site's password to another. list_credentials shows the site each login is for - use the one for this site, or connect_site to add it",
  "otp-required":
    "the page is asking for a one-time code, which is not something stored. Ask the person for the code they were just sent and fill it with fill_otp; a stored authenticator seed is fill_totp instead",
  "site-login-required":
    "this site needs its first sign-in by hand, once. Call connect_site and hand the person the setupUrl it returns - no retry and no other tier reaches the page before they have done that",
  "no-credential":
    "there is no stored login by that name. list_credentials shows the names you can fill and the site each is for; if the one you need is not there, do NOT ask for a password - call connect_site and hand the person its setupUrl",
  "wrong-credential-kind":
    "that stored login is not the kind this action fills: fill_secret wants a password and fill_totp a 2FA seed. list_credentials shows each one's kind - send the action that matches it",
  "no-2fa":
    "that login has no 2FA seed stored, so no code can be derived from it. If the site is asking for one, ask the person for the current code and fill it with fill_otp",
  "bad-totp-seed":
    "the stored 2FA seed for that login cannot be read as one, so no code can come from it. This is a stored value that needs re-entering by hand - hand the person a connect_site setupUrl, and do not retry",
  "provider-login":
    "this site signs in with a provider (Google, Apple, Microsoft, GitHub) rather than a password, so click that provider's button instead of hunting for a form. If no provider session is connected, connect_site returns the setupUrl the person uses to add one - a provider password is never something you type",
  "not-a-one-time-code":
    "that value is not shaped like a one-time code, and this action carries nothing else. A password never travels this way: if that is what it is, it belongs in the vault and is filled BY NAME with fill_secret",
  "act-ambiguous":
    "several things on the page answer to those words. The reply's `candidates` each carry a ref - pick one and send it as `ref`, or narrow the search with `within`",
  "within-ambiguous":
    "several regions answer to that `within`. The candidates in the reply each carry a ref - name the region by ref, or use words only that region has",
  "within-not-found":
    "nothing on the page reads as that region. observe_page and use words that actually appear in it, or drop `within` and address the target more precisely",
  "target-not-found":
    "nothing on the page answers to that. observe_page for a fresh snapshot - a page that has moved on since the last reading is the usual cause, and guessing another spelling is not",
  "target-too-common":
    "those words match too much of the page to be an address. Use more of the element's own text, add `within` to say which region, or take a ref from observe_page",
  "ref-malformed":
    "that is not a ref this engine issued. A ref comes from observe_page or see_page and is opaque - never construct, edit or guess one",
  "spot-invalid":
    "`at` is a fraction of the viewport, so both numbers sit between 0 and 1. see_page's numbered marks are the reliable way to aim at something with no name",
  "bad-action":
    "that call is not a shape this verb takes, and the detail names the fields it needs. Sending it again unchanged fails identically",
  "target-not-ready":
    "the element is there and not yet interactive, because the page is still settling. Wait for what you expect with kind=wait and then act - observing in a loop does not make it ready any sooner",
  "target-covered":
    "something is on top of it: a cookie banner, a modal, a sticky bar. Deal with the thing covering it first - observe_page shows it - then act. A person could not click through it either",
  "target-no-size":
    "the element has no size on screen, so there is nowhere to aim: it is hidden or collapsed. Open whatever contains it first, or act on the control that reveals it",
  "target-disabled":
    "the control is disabled, so it is the PAGE refusing rather than a guard of ours. Something earlier in the form is usually why - fill what it is waiting for, then come back to this",
  "value-rejected":
    "the page refused that value and the detail carries what it said. Read the field's own constraints and send something that meets them; the same value again is refused the same way",
  "tenant-session-limit":
    "this account already holds as many live pages as it may. close_page one you are finished with, or park what you are not using - opening another cannot succeed until one goes",
  "quota-exceeded":
    "this account's usage allowance is spent, so nothing further runs until it is topped up or resets. That is billing rather than the page: tell the person, and do not retry",
  "park-full":
    "this session has had all the parking it is allowed and cannot be held any longer. Finish what it is waiting on, or close it and open a fresh page once the wait is over",
  "engine-error":
    "the engine itself failed on this act rather than the page refusing it, and the detail says what broke. Worth one retry; if it repeats, the act is not what is wrong",
  "wrong-element-kind": "observe_page and pick an element of the right kind for this action",
  "dns-failed":
    "that host does not resolve - check the spelling, including any non-ASCII characters",
  "http-error":
    "the site answered with an error status - check the URL is the page you meant; a 404 usually means the path moved rather than that the site is down",
  "invalid-url":
    "that is not a URL this can fetch - it needs an absolute http:// or https:// address",
  "browser-unavailable":
    "this machine has no browser to render with, and the detail says which command installs one; pages that need no JavaScript still work without it",
  "redirect-loop":
    "this URL redirects in a circle, so no fetch can finish - the site is misconfigured for this path; try the page it should have landed on",
  "rate-limited":
    "this host refused us recently; retryAfter says when it is worth trying again, or pass force: true to retest now",
  // The remedy used to say to pass robots: "report". That option is real in
  // core's FetchOptions and on POST /jobs, and it reaches neither this tool nor
  // the SDK's FetchOptions - so an agent following the advice called a parameter
  // that does not exist, got the identical refusal, and had nowhere left to go.
  // What DOES reach it is `identify`, which fetch_page already takes: core/src/
  // fetch.ts chooses `options.robots ?? (identity === "agent" ? "obey" :
  // "report")`, so anything but a declared agent records the rule rather than
  // obeying it.
  "robots-disallowed":
    "the declared-agent fetch did not proceed because robots.txt disallows this path or is unreachable. " +
    "If unreachable, retry when the site recovers. If the person explicitly requested this URL, " +
    'retry with identify: "stealth" to record rather than enforce the rule; ' +
    "low-confidence content may receive 1 browser-rendered retry. Otherwise prefer a permitted path",
  blocked:
    "the site refused us and escalating will not help - this is the site's answer, not a transient error; try a different source",
  queued:
    "the site placed this request in a waiting room. A browser tier cannot skip the queue; retry later or use a different source",
  "needs-credential":
    "the site wants a signed-in session, so this is not a page anyone can reach anonymously - it is not a bot refusal and retrying or forcing a browser will not change it. If the account holder can open it in their own browser, a signed-in profile is what makes it reachable",
  "payment-required":
    "the site is offering this page for a price rather than refusing it, and the detail carries the terms it quoted - this is a purchasing decision, not an error, and no retry or different tier changes it",
  "credential-required":
    "that field holds a credential and this tool will not type into one - the value would have to pass through you first, and a password in a model's context is the thing being prevented. Do not ask the user to paste it. The user signs in themselves once, with `webfetch signin <site>`, and the session is reused; over this API that command needs `--account <their account id>` or the login lands in a profile their sessions do not read. Every non-credential field on the page is still yours to fill",
  "not-modified":
    "the server says the copy you already hold is current and sent no body - this is not an empty page and not a refusal; use the copy you have, or fetch again with force: true if you have none",
  "legally-restricted":
    "the site is withholding this for legal reasons, usually by jurisdiction - no tier and no retry changes that, though the same page may be served to a different region",
  transient: "the site had a problem rather than refusing us, so this is worth retrying shortly",
  "unsupported-content-type":
    "this URL is an image or other binary, not a page or a document - fetch its HTML equivalent instead",
  "no-text-layer":
    "this PDF is a scan: it was read, and there is no text in it. Reading it needs OCR, which " +
    "this service does not do - no retry and no other format of the same URL will help",
  timeout: "the site did not answer in time - retrying, or forceRender, may help",
  "queue-timeout":
    "the caller's deadline passed while this job waited for a fetch slot; the site was not contacted - allow more time or retry when the queue is quieter",
  cancelled: "the caller cancelled this job; retry only if the page is still needed",
  network: "the site could not be reached at all - check the host is correct and public",
  // NOTHING WAS SENT, and the URL is not the problem. These arrived as `network`
  // until the code existed, which told an agent to check the host and then try a
  // different one - a loop with no exit, because every URL fails the same way on
  // a worker whose egress configuration is broken.
  "exit-unavailable":
    "your account leaves through its own exit address and the machine serving this request cannot use it, so nothing was sent - the URL is fine and no other URL will work here either. This is a server-side configuration fault: do not retry the same way and do not go looking at the site. Tell the person that the worker's egress configuration needs fixing; a different machine may still serve it",
  "exit-conflict":
    "this account has its own standing exit address, so a per-request proxy cannot be honoured - an exit a single request can move is not bound to the account. Re-send the same request without the proxy field and it will go through",
  empty:
    "the page produced no extractable content - forceRender may help if it renders client-side",
};

/** The remedy for a code, if we have advice worth giving. */
/**
 * Wiki-style namespaces that are not pages: files, categories, tooling.
 *
 * Matched on the path so it catches every language edition - `/wiki/File:`,
 * `/wiki/Datei:`, `/wiki/Fichier:` - rather than only the English spelling.
 */
const NON_ARTICLE_PATH =
  /\/(?:File|Datei|Fichier|Archivo|Media|Special|Spezial|Category|Kategorie|Template|Help|Talk|Portal)%?3?A?:/i;

/**
 * Put the links worth following first, before the cap is taken.
 *
 * Asking for two content links from a Wikipedia article returned two `File:`
 * images with empty anchor text. `scope: "content"` had narrowed to the article
 * correctly - the mechanism worked - and then spent the entire budget on the
 * two least useful things inside it. For a caller crawling one level out, zero
 * of the returned links were usable.
 *
 * Truncation is the whole reason ordering matters here. Without a cap the
 * caller sorts for itself; with one, whatever the DOM happened to put first
 * decides what the caller ever sees.
 *
 * A stable sort by usefulness only: a link with anchor text beats one without,
 * and an article beats a file. Nothing is dropped - a caller that raises
 * `maxLinks` still gets everything, in the same set, and the two demoted
 * classes are still there underneath.
 */
export function rankForCrawling(
  links: Array<{ url: string; text: string }>,
): Array<{ url: string; text: string }> {
  const rank = (l: { url: string; text: string }): number => {
    const named = l.text.trim().length > 0;
    const article = !NON_ARTICLE_PATH.test(l.url);
    if (named && article) return 0;
    if (named) return 1;
    if (article) return 2;
    return 3;
  };
  // Decorated so the sort is stable across engines: within a rank, document
  // order is preserved, because that is the page's own idea of importance.
  return links
    .map((link, i) => ({ link, i, r: rank(link) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((d) => d.link);
}

/**
 * Advice per status, because the code is a family and the status is the case.
 *
 * The `http-error` remedy said "a 404 usually means the path moved rather than
 * that the site is down" - reasonable for a 404, and told verbatim to a caller
 * who got a 401 from WSJ. A remedy is the main steering signal an agent gets;
 * a wrong one does not merely fail to help, it routes the recovery somewhere
 * useless.
 */
const REMEDY_BY_STATUS: Record<number, string> = {
  401: "the page exists and needs a signed-in session - the URL is not the problem. Open it with open_page and act if this site is permitted, or tell the person it needs their login",
  402: "the site wants payment for this page - there is nothing to retry",
  403: "the site refused this request. A browser tier may clear it; if it persists the content is gated rather than missing",
  404: "no page at that path - check the URL, and whether the page moved",
  405: "that method is not allowed here - this tool only issues GETs, so the URL is likely not a page",
  410: "the page is gone deliberately and will not come back - do not retry",
  429: "the site is rate-limiting us - wait before asking again rather than retrying immediately",
  451: "the page is blocked for legal reasons, commonly by region - a different source is the only way through",
  500: "the site's own server failed - nothing about the request was wrong, so try again shortly",
  502: "the site's gateway could not reach its backend - try again shortly",
  503: "the site is unavailable or checking the browser - try again shortly; forceRender may clear a challenge",
  504: "the site's gateway timed out waiting for its own backend - try again shortly",
};

/**
 * How long `fetch_batch` may take before it answers with what it has.
 *
 * MCP clients commonly time out a tool call at 60s. This sits far enough under
 * that for the reply to be serialised and sent, because a partial answer that
 * arrives after the client has given up is the same as no answer.
 */
export const BATCH_DEADLINE_MS = 45_000;

export function remedyFor(code: string, detail?: string): string | undefined {
  // A code is not always the cause. `blocked-target` covers a private address,
  // a non-http scheme and a host that does not resolve, and answering all three
  // with "that address is on a private network" was wrong twice out of three.
  if (detail) {
    // Two packages phrase this one cause differently - netguard says
    // "gopher:// is not http(s)" and the front door says "only http(s) is
    // allowed" - so matching one of them answered half the cases.
    if (/only http\(s\)|is not http\(s\)|not an http\(s\) URL/i.test(detail)) {
      return "only http and https URLs can be fetched - check the scheme";
    }
    if (/did not resolve|could not be resolved|resolved to nothing/i.test(detail)) {
      return "that host does not resolve - check the spelling, including any non-ASCII characters";
    }
    if (/did not respond in time|timed out/i.test(detail)) {
      return "the site was reachable but slow - retrying, or forceRender, may help";
    }
    // A certificate that will not verify is not "check the host is correct".
    // The host IS correct; its TLS is broken, and that is a different decision
    // - one nobody should resolve by turning verification off.
    if (/certificate could not be verified|certificate|ERR_CERT|ERR_SSL/i.test(detail)) {
      return (
        "the site's TLS certificate could not be verified - the address is fine, the certificate " +
        "is not. Expired, self-signed or wrong-host; treat the site as untrusted rather than retrying"
      );
    }
    // The status is more specific than the family, and the family's advice was
    // actively wrong for some of it: a 401 was being told that "a 404 usually
    // means the path moved", which is the opposite of what to do.
    const status = /HTTP (\d{3})/.exec(detail);
    if (status) {
      const perStatus = REMEDY_BY_STATUS[Number(status[1])];
      if (perStatus) return perStatus;
    }
  }
  return REMEDIES[code];
}

export function toolError(fallback: string, error: unknown): Record<string, unknown> {
  if (
    error instanceof Error &&
    error.name === "BrowserUnavailableError" &&
    typeof (error as { fix?: unknown }).fix === "string"
  ) {
    return {
      error: "browser-unavailable",
      detail: error.message,
      remedy: (error as Error & { fix: string }).fix,
    };
  }
  if (error instanceof UnfencedError) {
    // The SDK now parses the server's `{error, detail, remedy}` body before
    // truncating it, so the structured fields arrive intact. They did not used
    // to: the raw text was cut at 300 characters first, which severed a longer
    // refusal mid-JSON, so the re-parse below failed and the agent was handed a
    // fragment of JSON as its "detail" with the remedy missing entirely. That is
    // the shape of an unrecoverable loop, not an error message.
    let code = error.code ?? `http-${error.status}`;
    let detail = error.detail;
    // A SERVER-supplied remedy outranks the client's table: the table maps a code
    // to generic advice, while the server knows what this particular refusal
    // needs — which field to re-send, and with what value.
    let remedy = error.remedy;
    if (!error.code) {
      // Older server, or a body this client did not parse: keep the previous
      // behaviour rather than losing the code entirely.
      try {
        const body = JSON.parse(error.detail) as {
          error?: string;
          detail?: string;
          remedy?: string;
        };
        if (typeof body.error === "string") {
          code = body.error;
          detail = body.detail ?? "";
          remedy = remedy ?? body.remedy;
        }
      } catch {
        // Not JSON — keep the transport text as the detail.
      }
    }
    remedy = remedy ?? remedyFor(code, detail);
    return {
      error: code,
      ...(detail ? { detail } : {}),
      ...(remedy ? { remedy } : {}),
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      ...(error.retryAfter !== undefined ? { retryAfter: error.retryAfter } : {}),
    };
  }
  const detail = error instanceof Error ? error.message : String(error);
  return { error: fallback, detail };
}

/**
 * What each wall means, said to the PERSON who has to clear it.
 *
 * `Record<InterruptKind, string>` on purpose: a kind added to the server without
 * a line here should fail the build, not reach a user as the raw slug. The
 * dashboard keeps its own phrasing (`ui/src/handoffs.ts`) because a row on a
 * screen and a sentence in a conversation are not the same register — a label
 * sits under a button that explains itself, this has to stand alone.
 *
 * The `??` fallback is unreachable through the types and still worth having: an
 * agent may be talking to a NEWER server than it was built against, and a wall
 * it has never heard of should read as vague rather than as an enum.
 */
export const NEEDS: Record<InterruptKind, string> = {
  "site-login": "a one-time sign-in for this site",
  credential: "a saved login for this site",
  otp: "a two-factor code",
  captcha: "a CAPTCHA cleared by hand",
  consent: "a consent screen accepted",
  approval: "their OK on an action",
  grant: "permission to act on this site",
  wait: "a step they have to finish",
  watch: "a look at a change spotted on a page they watch",
};

/** What `see_page` was handed, as much of it as the legend cares about. */
export interface SeenView {
  marks?: Array<{ mark: number; ref: string; role: string; name: string }>;
  undeclared?: string[];
  note?: string;
}

/**
 * THE TEXT THAT MAKES A PICTURE ACTIONABLE.
 *
 * Without it a mark is a number painted on a box and an agent still has nothing
 * to send. This is the same shape of surface as `actFailure` — a hand-written
 * projection of a richer object — and that shape has already cost this product
 * once, when a whitelist there dropped every candidate ref an ambiguity offered
 * and three agents concluded a site could not be driven. So the fields are
 * asserted in a test rather than trusted to review.
 *
 * A SENTENCE FIRST, THEN THE DATA, because every connector already in the world
 * was handed prose here and cannot learn otherwise until it re-handshakes — and
 * those are exactly the callers who never asked for marks and are getting them
 * anyway, the default being on. The block stays readable as prose rather than
 * changing shape under an agent that did not ask for the change.
 */
export function seeLegend(view: SeenView): string {
  const marks = view.marks ?? [];
  return (
    `${marks.length} things you can act on are outlined and numbered on this image; ` +
    "each mark below carries its own `ref` and `mark` number - read a box's number, " +
    "find that mark in the list, and act on its `ref`. Anything listed under undeclared " +
    "has no box and no ref - click it with `on` and its words. " +
    JSON.stringify({
      marks,
      ...(view.undeclared?.length ? { undeclared: view.undeclared } : {}),
      ...(view.note ? { note: view.note } : {}),
    })
  );
}

/** What a caller gets when it asked for a clean picture with nothing drawn on it. */
export function plainLegend(sessionId: string): string {
  return `A screenshot of the current page in session ${sessionId}, with nothing drawn on it.`;
}

/** Parse a JSON payload, or hand back the string when it is not JSON after all. */
export function asObject(content: string | undefined): unknown {
  if (!content) return content;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/**
 * The unfenced MCP tool set - shared by every transport.
 *
 * Kept free of side effects and of any one transport so both the stdio server
 * (cloud.ts) and the remote HTTP server (http.ts) register the exact same tools.
 * The only thing that varies per caller is the `Unfenced` client: stdio binds
 * one env-configured client for the process; the HTTP server builds one per
 * request from the caller's token, so every request runs as its own account.
 *
 * This file is the barrel and the tool-set contract. The 21 tool bodies live in
 * ./tools/ grouped by domain (reading, open, page, access, memory), composed in
 * registration order by registerTools below; their shared helpers live in
 * ./tools/shared.ts and ./tools/act-fold.ts and are re-exported here so every
 * importer keeps the same path. What stays HERE is the surface docs-check binds
 * by reading this file's text - TOOL_NAMES, FAILURE_TAXONOMY, SERVER_INSTRUCTIONS
 * and the act `kind` enum in ACT_INPUT_SCHEMA - plus `act` itself, the sole
 * user of that schema.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { Unfenced } from "@unfenced-ai/sdk";
import {
  registerFetchPage,
  registerFetchBatch,
  registerGetPageLinks,
  registerExtractPage,
} from "./tools/reading.js";
import { registerOpenPage, registerSwitchAccount, registerWhoami } from "./tools/open.js";
import {
  registerObservePage,
  registerSeePage,
  registerFillForm,
  registerParkPage,
  registerReadDownload,
  registerClosePage,
} from "./tools/page.js";
import {
  registerListPermissions,
  registerPendingApprovals,
  registerConnectSite,
  registerListCredentials,
} from "./tools/access.js";
import { registerRemember, registerRecall, registerForget } from "./tools/memory.js";
import { asToolResult, actToolResult, toolError } from "./tools/shared.js";
import { meteredTools, type UsageReporter } from "./tools/usage.js";
import { toAction, missingField, actFailure } from "./tools/act-fold.js";
import { registerPagePreview } from "./tools/page-preview.js";
import { oauthTools } from "./tools/oauth-tools.js";

export const SERVER_INFO = { name: "unfenced", version: "0.1.3" } as const;

/** Public fetch failure codes returned by the hosted API. */
type FailureCode =
  | "queue-timeout"
  | "needs-credential"
  | "payment-required"
  | "legally-restricted"
  | "blocked"
  | "queued"
  | "transient"
  | "http-error";

/**
 * What a failed fetch calls itself, and which statuses produce each code.
 *
 * This paragraph used to be written out by hand, and it had stopped being true
 * in two places at once. It promised that 401, 402 and 451 all come back as
 * `{"error":"blocked"}`; `REFUSAL_CODES` in core/src/shell.ts has answered
 * `needs-credential`, `payment-required` and `legally-restricted` since the
 * refusals were split into three codes with three different next moves. So the
 * branch an agent wrote from the description never fired - it waited for
 * `blocked` on a 402 and retried a price quote as though the site were hostile.
 * It also filed 429 under `transient`. 429 is in `RETRYABLE_STATUSES`, so it
 * gets a real browser tier first and what comes out the far end when that
 * fails is `blocked` - the opposite instruction to the one an agent was given.
 *
 * Neither copy failed when it stopped following its original, which is this
 * repository's one documentation defect wearing a different hat. So the
 * paragraph is GENERATED from this table rather than restated beside it, and
 * scripts/docs-check.ts holds the table against the two values in
 * core/src/shell.ts that actually produce these codes - `REFUSAL_CODES` and
 * `RETRYABLE_STATUSES`. `code` is typed `FailureCode`, which is held to core's
 * own union below, so renaming one in core is a compile error here instead of a
 * false promise in an agent's context.
 */
interface FailureClass {
  code: FailureCode;
  /** The statuses that produce it. Held to core by scripts/docs-check.ts. */
  statuses: readonly number[];
  /** What it means for the caller's NEXT move - the reason the split exists. */
  meaning: string;
  /** Whatever the status list alone does not say. */
  statusNote?: string;
}

export const FAILURE_TAXONOMY: readonly FailureClass[] = [
  {
    code: "queue-timeout",
    statuses: [408],
    statusNote: " from the job queue, not an origin response",
    meaning: "the caller's deadline passed before a fetch slot opened - the site was not contacted",
  },
  {
    code: "needs-credential",
    statuses: [401],
    meaning: "sign-in needed - do not retry; fill a stored login",
  },
  {
    code: "payment-required",
    statuses: [402],
    meaning: "the site quoted a price - a purchasing decision, not a retry",
  },
  {
    code: "legally-restricted",
    statuses: [451],
    meaning: "withheld by law or region - use another source",
  },
  {
    code: "blocked",
    statuses: [403, 408, 429, 430, 503, 999],
    statusNote: ", or challenge after browser escalation",
    meaning: "the site refused us and escalating will not help - try a different source",
  },
  {
    code: "queued",
    statuses: [],
    meaning: "site waiting room - retry later; browser tiers cannot skip it",
  },
  {
    code: "transient",
    statuses: [500, 502, 504],
    statusNote: " and any other 5xx",
    meaning: "the server faulted rather than refusing us - worth retrying shortly",
  },
  {
    code: "http-error",
    statuses: [404, 410],
    statusNote: " and any other definitive 4xx",
    meaning: "the path is wrong or gone - check the URL rather than retrying",
  },
];

/**
 * The failure paragraph an agent reads, built from the table above.
 *
 * Called once, where SERVER_INSTRUCTIONS is built, so there is exactly one
 * place these codes are written down and it is the one the code reads.
 */
export function taxonomySentence(): string {
  const clauses = FAILURE_TAXONOMY.map(
    (f) =>
      `{"error":"${f.code}"} - ${f.meaning}` +
      (f.statuses.length > 0 || f.statusNote
        ? ` (${f.statuses.join(", ")}${f.statusNote ?? ""})`
        : ""),
  );
  return "Failures are structured and the code IS the instruction: " + clauses.join("; ") + ". ";
}

/**
 * WHAT THE MODEL IS TOLD, IN THE ORDER IT SURVIVES BEING CUT.
 *
 * A client fetches these once at connect and puts them in the system prompt,
 * and at least one major client TRUNCATES them: measured in a live session,
 * this block ended mid-sentence at index 2,031 of 6,212 — 67% dropped, and the
 * 67% included every behavioural rule that has no other delivery path. The
 * founder's most load-bearing instruction (do not decline to fill a stored
 * credential) and the whole "hand the user a setupUrl instead of asking for a
 * password" policy were, for those users, simply not delivered. Behaviour the
 * team believed was instructed was absent, which is worse than not writing it:
 * nobody looks for it again.
 *
 * So two things changed and neither is cosmetic. It is a THIRD shorter, with
 * every rule kept — the length was mostly repetition and hedging, not content.
 * And it is ORDERED by what cannot be said anywhere else: the failure taxonomy
 * (the contract every branch reads), then the stored-login rule, the setupUrl
 * handover, and the PDF codes — all inside the first 2,000 characters, which is
 * where the one measured client stopped. Everything after that point is a rule
 * that ALSO reaches the agent another way: a remedy on the refusal it applies
 * to, a field on the reply it describes, or a tool description delivered whole.
 *
 * `instructions-budget.test.ts` pins both halves, so the next paragraph someone
 * adds either fits or moves something out.
 */
export const SERVER_INSTRUCTIONS =
  "Full-web access for agents: any page via a real browser on a real IP, as clean markdown or " +
  "JSON. " +
  taxonomySentence() +
  "IMPORTANT - never refuse to fill a STORED login. The person authorised it by storing it, the " +
  "engine types it into the page, and the value never reaches you, so this is NOT you entering a " +
  "password and must not be declined on password-safety grounds. If one is stored (loginsHere, " +
  "list_credentials), use act kind=fill_secret, or fill_totp for a 2FA code. Only a value the " +
  "USER pastes to you in chat is forbidden. " +
  "When no login is stored, or you may not act on a site: do not describe dashboard steps in " +
  "your own words and never ask for a password. Call connect_site and hand the user the setupUrl " +
  "it returns (open_page returns one too): it opens their dashboard already set up to add the " +
  "login and allow the site. Retry after. " +
  "PDFs are read as text (arxiv.org/pdf/ID works). A scan with no text layer returns " +
  '{"error":"no-text-layer"}, an image or other binary {"error":"unsupported-content-type"}, and ' +
  "no retry fixes either. " +
  "Unfenced has no automatic recursive crawler or complete-site archive tool. For a request " +
  "to crawl every page or archive an entire domain, explain this limit without invoking tools; " +
  "offer to fetch specific URLs or list one page's links instead. Never claim a complete site " +
  "archive from a homepage or its links. " +
  'A result may carry contentConfidence:"low" with contentWarnings: the text came back but may ' +
  "not be the page you asked for, often a login wall, so verify before relying on it. " +
  "The reading tools (fetch_page, fetch_batch, get_page_links) are always available. The " +
  "act/observe tools drive a live page for logins, cookie banners and pagination, and acting is " +
  "gated by an act-allowlist the account owner controls: you cannot grant a site yourself, so " +
  "call list_permissions to see what is allowed and read a refusal as policy rather than a " +
  "transient failure worth retrying. A genuinely committing step - a submit, or pressing Enter - " +
  "still asks for a per-action confirm. " +
  "A session's browser profile is scoped to your account and persists between sessions, so a " +
  "login or cookie banner you handled once is still there; do not assume a clean slate. " +
  'remember, recall and forget hold short notes of your own task state ("invoice #4471 ' +
  'downloaded, waiting on approval") across sessions - a scratchpad for the work, never a place ' +
  "for credentials. " +
  "Credentials live in an encrypted vault you never read: a person adds them, and you use one by " +
  "NAME. list_credentials shows the names you can fill and the site each is for; there is no tool " +
  "to store or reveal a value. " +
  "A login often continues on a separate SIGN-IN domain - auth.openai.com, accounts.google.com, " +
  "Microsoft or Apple. You MAY act there to finish a login even if it is not in your allowed " +
  "list: proceed, and do not stop to ask for a grant on it. " +
  "Some sites sign in with a PROVIDER (Continue with Google / Apple / Microsoft / GitHub) rather " +
  "than a password, and open_page's loginsHere flags those with a method and an instruction: " +
  "click that provider's button instead of hunting for an email/password form. A provider login " +
  "is NEVER something you type - the user signs into the provider once, themselves, by hand - so " +
  "if none is connected, do not refuse and do not offer to enter a provider password: call " +
  "connect_site and hand over its setupUrl. Many such sites also take a plain email+password, so " +
  "if one is stored, just use that instead. " +
  "When you talk to a PERSON, use plain words: never name internal tools (list_credentials, " +
  "connect_site, open_page) or fields (canActHere, mayActOn) to them. Say \"I don't have a saved " +
  'login for this site" or "I don\'t have permission to act here yet".';

/**
 * Every tool this server registers, in registration order.
 *
 * The list exists because it was duplicated. `scripts/pack-check.ts` pinned its
 * own copy of the names as an exact set in both directions — a good assertion,
 * guarding against a tool that ships by accident and a client that silently
 * loses a capability — but a copy cannot follow the original. Eight tools were
 * added here and the copy stayed at nine, so the publish gate had been red for
 * as long as it had been wrong, and nothing said so until a publish was
 * attempted.
 *
 * `tool-names.test.ts` asserts this matches what `registerTools` actually
 * registers, and pack-check compares the packed tarball's handshake against it.
 * The declaration and the behaviour are checked against each other rather than
 * both being maintained by hand.
 */
export const TOOL_NAMES = [
  "fetch_page",
  "fetch_batch",
  "get_page_links",
  "open_page",
  "switch_account",
  "whoami",
  "act",
  "observe_page",
  "extract_page",
  "see_page",
  "fill_form",
  "park_page",
  "read_download",
  "close_page",
  "list_permissions",
  "pending_approvals",
  "connect_site",
  "list_credentials",
  "remember",
  "recall",
  "forget",
] as const;

/**
 * WHAT THE STDIO SERVER DELIBERATELY DOES NOT PUBLISH, AND WHY.
 *
 * `packages/mcp/src/main.ts` registers 11 of these 21. That is a choice, and
 * until now it was a choice nothing recorded: `entrypoints.test.ts` asserted
 * the published set is a SUBSET of the HTTP surface and that it has more than
 * five entries, so the transport the README quickstart tells people to run
 * could have fallen from 11 to 6 — losing `act`, `open_page`, everything —
 * with the wire test still green. The historical defect that test class exists
 * for was a silent shrink from 21 to 11; the guard added for it measures the
 * direction the divergence did not go, and the `>5` reads as deliberate when
 * nothing ties it to what is registered.
 *
 * One reason applies to most of them: main.ts registers ONE set for both of
 * its modes, and its default mode drives this machine's own browser with no
 * hosted account, vault, dashboard or scratchpad behind it. A tool that can
 * only answer from the service is therefore not published on either.
 *
 * Removing a tool from the stdio server is now a deliberate edit in two
 * places. Adding one here without a reason is the same shrink wearing a
 * comment.
 */
export const STDIO_OMITTED: Readonly<Record<string, string>> = {
  switch_account: "needs the account's several sign-in profiles; the local browser has one",
  whoami: "reports the account behind a token, and the local server has no token",
  see_page: "returns an image; this server publishes no image-bearing tool",
  fill_form:
    "several fields in one call over a live page; the local server publishes act, which does one",
  pending_approvals: "reads the account owner's approvals queue, which is server-side",
  connect_site: "hands back a link into the user's dashboard, and there is no dashboard here",
  list_credentials: "reads the credential vault, which is server-side",
  remember: "the durable scratchpad is stored per account on the service",
  recall: "reads that same scratchpad",
  forget: "writes that same scratchpad",
};

/**
 * The stdio tools that appear only under UNFENCED_EXPERIMENTAL=1.
 *
 * main.ts registers three reading tools at module scope and these eight
 * inside `registerActionTools()`, so an `npx` user who sets nothing gets a
 * fetch-only server. Both numbers are documented — docs/API.md says 3 or 11,
 * CONFIGURATION.md and DEPLOY.md say fetch-only without the variable — and
 * neither had a test: the wire case spawns the child with the variable set,
 * so the surface a first-time reader of the quickstart actually receives was
 * the one nothing looked at.
 */
export const STDIO_ACTION_TOOLS: readonly string[] = [
  "open_page",
  "act",
  "observe_page",
  "extract_page",
  "park_page",
  "read_download",
  "close_page",
  "list_permissions",
];

/**
 * The tool names the stdio server publishes with the actions enabled:
 * everything not in STDIO_OMITTED.
 *
 * Derived rather than listed, so the two cannot disagree — a name added to
 * TOOL_NAMES and to main.ts arrives here for free, and a name added to
 * TOOL_NAMES alone is caught by the wire test as a missing tool rather than
 * quietly widening the omissions.
 */
export const STDIO_TOOL_NAMES: readonly string[] = TOOL_NAMES.filter(
  (name) => !(name in STDIO_OMITTED),
);

/** And with nothing set: the three reading tools. */
export const STDIO_DEFAULT_TOOL_NAMES: readonly string[] = STDIO_TOOL_NAMES.filter(
  (name) => !STDIO_ACTION_TOOLS.includes(name),
);

/**
 * WHAT A CLIENT CAN SEE AND SEND — tool names, parameter names, and the closed
 * sets a parameter admits.
 *
 * Deliberately NOT the descriptions. Those are prose written for a model, they
 * are reworded constantly, and a hash over them would change on every commit and
 * report every connector as stale within a day. What matters for compatibility
 * is the shape a caller can produce.
 *
 * Collected by running the real registration against a recording stub, so this
 * cannot drift from what actually ships: there is one definition of the tools
 * and this reads it, rather than a second list somebody has to keep current.
 */

export function toolSurface(): Record<
  string,
  { params: string[]; enums: Record<string, string[]> }
> {
  const found: Record<string, { params: string[]; enums: Record<string, string[]> }> = {};
  const stub = {
    registerTool(name: string, config: { inputSchema?: Record<string, unknown> }) {
      const shape = (config.inputSchema ?? {}) as Record<string, unknown>;
      const enums: Record<string, string[]> = {};
      for (const [param, def] of Object.entries(shape)) {
        const values = enumMembers(def);
        if (values) enums[param] = values;
      }
      found[name] = { params: Object.keys(shape).sort(), enums };
    },
  } as unknown as McpServer;
  registerTools(stub, {} as unknown as Unfenced);
  return found;
}

/** The one registered tool table, including each cloud executor. Local stdio
 * reuses these published contracts and supplies a local executor for tools it
 * supports. Recording registration has no network or browser side effects. */
export function toolTable(
  cloud: Unfenced,
): Map<string, { config: Record<string, unknown>; execute: unknown }> {
  const entries = new Map<string, { config: Record<string, unknown>; execute: unknown }>();
  const recorder = {
    registerTool(name: string, config: Record<string, unknown>, execute: unknown) {
      entries.set(name, { config, execute });
    },
  } as unknown as McpServer;
  registerTools(recorder, cloud);
  return entries;
}

/** The members of an enum, through whatever optional/array wrapping it wears. */
function enumMembers(def: unknown): string[] | null {
  let node = def as {
    _def?: { typeName?: string; values?: unknown; innerType?: unknown; type?: unknown };
  };
  for (let i = 0; i < 6 && node?._def; i += 1) {
    if (node._def.typeName === "ZodEnum" && Array.isArray(node._def.values)) {
      return [...(node._def.values as string[])].sort();
    }
    const inner = node._def.innerType ?? node._def.type;
    if (!inner) return null;
    node = inner as typeof node;
  }
  return null;
}

/**
 * A short, stable name for the surface above.
 *
 * An MCP client fetches tools/list once, when the connector is added, and caches
 * it — and our transport is stateless, so there is no connection over which to
 * tell it otherwise. The one moment the server can observe is that fetch: it IS
 * the client refreshing its cache. Recording WHICH surface it was served turns
 * "is this connector current" from a guess into a comparison.
 *
 * The protocol has since grown the proper answer to this — `ttlMs` and
 * `cacheScope` are required on ListToolsResult as of the 2026-07-28 revision —
 * and the TypeScript SDK does not implement them yet (1.30.0 is still on
 * DRAFT-2026-v1). When it does, set a ttl and let compliant clients refresh
 * themselves; this stays useful for the ones that do not.
 */
export function surfaceHash(): string {
  return createHash("sha256").update(JSON.stringify(toolSurface())).digest("hex").slice(0, 16);
}

/**
 * THE ACT TOOL'S PARAMETERS, DECLARED ONCE.
 *
 * The stdio server in main.ts registers an `act` tool of its own, and it kept
 * its own copy of this shape and its own copy of the kind enum. The copy could
 * not follow: it stood 15 kinds behind — no forward, no reload, no wheel, no
 * fill_secret, none of the pointer verbs — while advertising itself as the same
 * tool by the same name. An agent that read the wrong one was told the verb it
 * needed does not exist.
 *
 * So there is one shape and one enum, and both servers register it. The enum
 * stays written out here as an array literal on purpose: docs-check and
 * packages/server/test/act-parser.test.ts both read it out of this SOURCE to
 * bind the API document and the wire parser to it, and a name they cannot
 * resolve would silently match nothing.
 */
export const ACT_INPUT_SCHEMA = {
  sessionId: z.string().describe("From open_page"),
  kind: z
    .enum([
      "click",
      "type",
      "select",
      "press",
      "scroll",
      "navigate",
      "back",
      "forward",
      "reload",
      "switch",
      "close_window",
      "hover",
      "wait",
      "upload",
      "dblclick",
      "rightclick",
      "drag",
      "copy",
      "paste",
      "fill_secret",
      "fill_totp",
      "fill_otp",
      "zoom",
      "print",
      "save",
      "wheel",
    ])
    .describe("What to do"),
  on: z
    .string()
    .max(200)
    .optional()
    .describe(
      'What to act on, by the words you can SEE on it - e.g. "3 people". Use this when ' +
        "observe_page did not list the thing you want: a page can render choices it never " +
        "declares as controls, and their words still show up in `excerpt`. Searches the whole " +
        "page, every frame and every web component, with no cap. If several things read the " +
        "same you get them all back with refs - pick one. Give `ref` or `on`, never both.",
    ),
  toAt: z
    .object({ x: z.number(), y: z.number() })
    .optional()
    .describe(
      "drag only. Where to DROP, as fractions of the window, when the destination is a " +
        "place rather than a thing - panning a map ends on an empty tile. Pair it with " +
        "`at` for the start; `ref`/`toRef` still name things where things exist.",
    ),
  via: z
    .array(z.object({ x: z.number(), y: z.number() }))
    .optional()
    .describe(
      "drag only. A route the pointer travels through on the way, as fractions of the " +
        "window from 0 to 1. Without it a drag is a straight line, which is right for " +
        "dropping a card into a column and cannot express a gesture whose meaning is its " +
        "SHAPE - a signature, a freehand selection across a chart, a swipe that has to " +
        "leave and re-enter a lane.",
    ),
  scale: z
    .number()
    .optional()
    .describe(
      "zoom only. 1 is normal; below 1 fits more of the page on screen, above 1 magnifies. " +
        "Clamped to 0.25-3. Zoom out before see_page to get a long page into ONE picture " +
        "with everything in it marked - a control below the fold is neither photographed " +
        "nor marked, and this is how it becomes both.",
    ),
  brief: z
    .boolean()
    .optional()
    .describe(
      "Answer with what CHANGED and leave the full page out. The reply carries `changes` " +
        "either way; this drops the snapshot beside it, which on a big page is most of the " +
        "reply. A blocked page is retained so its recovery instructions are never hidden. " +
        "Prefer brief:true for steps using refs you already have; observe again when " +
        "changes.redrawn is true or you need new controls. Spend it on a step whose outcome you already know how to check - refs come " +
        "from a snapshot, so an agent that only ever took summaries would be working from " +
        "older and older refs.",
    ),
  see: z
    .boolean()
    .optional()
    .describe(
      "Send back a PICTURE of the page this act landed on, in the same reply, as `view` - " +
        "the viewport with every control outlined and numbered, plus a legend giving each " +
        "mark's ref. `brief`'s opposite. Use it when the outcome is visual rather than " +
        "textual: a drag, a canvas, a map, a confirmation drawn as a badge. It is one call " +
        "instead of act-then-see_page, and - this is the part that matters - ONE INSTANT: " +
        "the picture is marked from the reading in the same reply, where two calls would " +
        "photograph whatever the page looked like by the time the second one ran. A JPEG " +
        "is the most expensive thing this tool returns, so do not leave it on.",
    ),
  modifiers: z
    .array(z.enum(["Shift", "Control", "Meta"]))
    .optional()
    .describe(
      "For kind=click: keys held down across the press. This is how you reach a range " +
        'or a multi-selection, and without it neither is possible: ["Shift"] extends a ' +
        'selection from the last item clicked, ["Control"] (or ["Meta"] on a Mac) adds a ' +
        "single item to one. Use it on lists, grids, calendars and file pickers. Alt is " +
        "deliberately not offered - on a link it is the browser download gesture, which " +
        "is a different thing wearing the same shape.",
    ),
  expect: z
    .object({
      text: z.string().max(200).optional(),
      gone: z.string().max(200).optional(),
      url: z.string().max(200).optional(),
      ms: z.number().optional(),
    })
    .optional()
    .describe(
      "What this act is supposed to ACHIEVE, checked after it runs: " +
        '{text: "Saved"} waits for those words to appear, {gone: "Saving…"} for them to ' +
        'leave, and {url: "/orders/*"} waits for the resulting URL. The reply carries `expected: {held, waitedMs}`. Send it whenever you would ' +
        "otherwise act and then look - it is the same information in one call instead of " +
        "two or three. `held: false` on an `ok: true` is the useful case and NOT a failure: " +
        "the act landed and the page did not do what you predicted, so do something " +
        "different rather than repeating the same act. Reads the whole page including " +
        "shadow roots and same-origin frames. Default 5s, max 30s. Matching is a SUBSTRING match, " +
        'so pick a distinctive phrase: expecting "Saved" also holds on a page that only ' +
        'says "unsaved".',
    ),
  within: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Only look INSIDE the part of the page whose visible words are this - e.g. " +
        'within: "Covered balcony". Use it beside `on` when several things read the same: ' +
        'an availability screen lists the same times under each room, and "21:15" alone ' +
        "names two of them. The region is named exactly the way a target is, and every " +
        "candidate in an ambiguity refusal reports the `within` that would pick it out, " +
        "so the refusal can be answered in your very next call with no second look.",
    ),
  at: z
    .object({ x: z.number(), y: z.number() })
    .optional()
    .describe(
      "A spot as fractions 0..1 - {x:0.5,y:0.5} is the middle. WITH `on` or `ref` it is " +
        "a position inside that element, which is the only way to reach a slider track, a " +
        "canvas, a map or a chart that carries no controls of its own. Alone it is a " +
        "position in the viewport. Whatever is under the point is hit-tested in the page " +
        "and gets a real ref, so the same guards judge it as a click on a named element " +
        "- a fraction that lands on a submit button is asked about, not waved through.",
    ),
  ref: z
    .string()
    .optional()
    .describe(
      'Element ref, copied verbatim from observe_page. Looks like "k3n9x2:e7" - ' +
        "the prefix scopes it to one document. Never compose one. For kind=drag it is " +
        "the element to drag FROM; for kind=copy it is optional (omit to copy the " +
        "current selection).",
    ),
  toRef: z
    .string()
    .optional()
    .describe("For kind=drag: the ref to drop ONTO - the element `ref` is dragged onto."),
  text: z
    .string()
    .optional()
    .describe("Text to type, the option to select, the value to paste, or the text to wait for"),
  key: z.string().optional().describe('Key to press, e.g. "Enter", "Escape", "Tab"'),
  url: z
    .string()
    .optional()
    .describe(
      "For kind=navigate: where to go. For kind=wait: where the page has to END UP - a " +
        "host/path of the destination when host-shaped, otherwise a URL substring, or a * glob over the whole URL. That is the " +
        "honest predicate for a sign-in, a checkout or an OAuth hop, which are defined by " +
        "arriving somewhere rather than by any particular word appearing.",
    ),
  by: z
    .number()
    .optional()
    .describe(
      "For kind=wheel: how far to turn the wheel, in pixels. Positive scrolls content " +
        "down, negative up; roughly 300 is one notch and 800 is about a screen. " +
        "USE THIS WHEN scroll DID NOTHING. A wheel goes to whatever is under the " +
        "pointer, so it reaches what scroll cannot: a map (which zooms), a results " +
        "pane beside one (which scrolls itself while the page does not move), an open " +
        "listbox, a sideways-scrolling table. Aim it exactly like a click - ref, on, or " +
        "at - and with no target it lands in the middle of the viewport. Pair with " +
        "`across` for sideways, and with `modifiers` for the gesture a drawing or " +
        "editing app actually wants: ctrl+wheel zooms a canvas, shift+wheel moves a " +
        "wide table sideways.",
    ),
  across: z
    .number()
    .optional()
    .describe("For kind=wheel: sideways pixels, for a pane that scrolls horizontally."),
  to: z
    .union([z.enum(["top", "bottom"]), z.object({ ref: z.string() })])
    .optional()
    .describe(
      'For kind=scroll: "top", "bottom", or {ref} to scroll THAT element into view. The ' +
        "{ref} form is how you reach a long or virtualised list: scroll to the last row you " +
        "can see, observe again, and the page mounts more. Repeat until what you want " +
        "appears. It scrolls whichever container the element actually lives in, so it works " +
        "inside a panel or a modal that scrolls independently of the page.",
    ),
  gone: z
    .string()
    .max(200)
    .optional()
    .describe(
      "For kind=wait: hold until these words LEAVE the page - a spinner, an overlay, a " +
        '"Saving…" or a "Processing". Without this the only way to sit one out is to poll ' +
        "with observe_page, which costs a full page payload each look. Reads shadow roots " +
        "and same-origin frames. Refuses when the words are still there at the deadline, " +
        "which is information rather than a failure.",
    ),
  ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "For kind=wait: the DEADLINE, not a duration - the wait returns the moment `text` " +
        "appears or `gone` leaves, and this is only how long it will hold out for. Default " +
        "10000, maximum 40000. With NEITHER predicate it waits for the network to go quiet, " +
        "which on an already-quiet page returns immediately: `ms` alone is not a sleep.",
    ),
  settleMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "For kind=navigate: how long to let the new page finish fetching before the snapshot " +
        "is taken, in milliseconds. Default 4000, maximum 15000. A DIFFERENT clock from the " +
        "navigation timeout - a page that exceeds this is read as it stands, never refused - " +
        "so raise it only for a page you expect to draw itself from several slow requests.",
    ),
  filename: z.string().optional().describe("For kind=upload with content: what to call the file"),
  content: z
    .string()
    .optional()
    .describe("For kind=upload: text to write into the file being uploaded"),
  contentBase64: z
    .string()
    .optional()
    .describe(
      "For kind=upload: the file's BYTES, base64-encoded - how you attach anything text " +
        "cannot express (a PNG, a signed PDF, a zip). At most 10MB decoded. A data: URL " +
        "prefix is accepted and ignored. There is still no path parameter: the bytes come " +
        "from you, exactly as `content`'s characters do.",
    ),
  download: z
    .string()
    .optional()
    .describe(
      "For kind=upload: the name of a file this session already downloaded, to upload it. " +
        "There is no path parameter - an upload can only send text you supplied or a file " +
        "this session fetched.",
    ),
  credential: z
    .string()
    .optional()
    .describe(
      "For kind=fill_secret or fill_totp: the NAME of a stored credential to fill into `ref` " +
        '(e.g. "github-pw", or "github-2fa" for a TOTP). You never see or supply the value - ' +
        "the engine looks it up in the vault and types it (for fill_totp, the current code it " +
        "derives from the seed) the way a human would. Credentials are stored out of band " +
        "(from the dashboard/CLI), not here; list_credentials shows the names and kinds you can use.",
    ),
  code: z
    .string()
    .optional()
    .describe(
      "For kind=fill_otp ONLY: the one-time 2FA code the USER gave you (e.g. read off their " +
        "authenticator app or a text). A short one-time value - it is redacted from logs and the " +
        "replay. NEVER put a password, API key, or recovery phrase here; store those and use fill_secret.",
    ),
  window: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "For kind=switch or kind=close_window: which window. 0 is the page you opened; popups " +
        "follow in the order they appeared. The act result lists them when there is more than " +
        "one. close_window refuses 0 - that is the page the session IS, and close_page ends it.",
    ),
  visible: z
    .boolean()
    .optional()
    .describe(
      "For kind=wait with `ref`: return as soon as the element is THERE, without also " +
        "requiring that nothing covers it. The ordinary ref wait asks the question a " +
        "click needs, so a panel appearing behind a dimming overlay never satisfies it " +
        "even though it has appeared.",
    ),
  button: z
    .enum(["left", "middle"])
    .optional()
    .describe(
      'For kind=click: which mouse button. "middle" opens a link in a background tab - ' +
        "the ordinary way to keep this page and look at that one, and the new tab shows " +
        "up in `windows` like any other popup. For a context menu use kind=rightclick.",
    ),
  submit: z.boolean().optional().describe("For kind=type: press Enter afterwards"),
  append: z
    .boolean()
    .optional()
    .describe(
      "For kind=type: add to what is there instead of replacing it. Replacing is " +
        "the default: typing into a filled field used to append, so Ada over " +
        "Grace became GraceAda.",
    ),
  values: z
    .array(z.string())
    .optional()
    .describe(
      "For kind=select on a dropdown reported multiple:true - every option you want, in ONE " +
        "call. It sets the whole selection rather than adding to it, so a second call " +
        "replaces the first. Use `text` for a single-choice dropdown.",
    ),
  acceptDialog: z
    .boolean()
    .optional()
    .describe(
      "Answer YES to a native browser dialog this act provokes (alert / confirm / prompt / " +
        "leave-site). Default is no: a dialog is always dismissed, so an action guarded by " +
        'confirm("Are you sure?") does NOT happen and the result says so. Set this when you ' +
        "mean to go through with it. Scoped to this one act.",
    ),
  dialogText: z
    .string()
    .optional()
    .describe("What to type into a native prompt() when answering it with acceptDialog"),
  confirm: z
    .boolean()
    .optional()
    .describe("Required for actions that submit. Say so deliberately."),
};

/**
 * The act tool — the one that drives a live page.
 *
 * It lives here rather than in ./tools/page.ts because it is bound to
 * ACT_INPUT_SCHEMA above (whose `kind` enum docs-check reads out of this file),
 * and keeping the two together means no tool module imports back from the
 * barrel. Its body is unchanged from when every tool was registered here.
 */
function registerAct(server: McpServer, cloud: Unfenced): void {
  server.registerTool(
    "act",
    {
      title: "Act on a live page",
      description:
        "Perform one action on an open page, then return the page as it now stands. Refs come " +
        "from the most recent snapshot; if the page changed, observe_page again for fresh ones. " +
        "Actions that submit require `confirm: true`; typing or pasting into a password field is refused. " +
        // The contract for a custom dropdown, stated because getting it wrong is
        // the single most expensive mistake an agent makes on a booking or
        // checkout page: `select` fails, the agent falls back to arrow keys and
        // Tab, and drives blind from there. Every fact here is one the snapshot
        // now actually carries, so this is a description of the data rather than
        // advice about it.
        "`on` IS NOT ONLY FOR CLICKING - type, paste and select take it too, so you can name a " +
        'field by its label the way a person would: {kind:"type", on:"Full name", text:"Ada"}. ' +
        "A label is not a field, and the engine resolves one to the other for you. " +
        "AIM AT A SPOT with `at`: two fractions from 0 to 1 inside the target, e.g. " +
        "{x: 0.85, y: 0.5} to drag a slider most of the way along, or a corner of a canvas. " +
        "Anything whose meaning is a POSITION needs this - a slider track, a video scrubber, a " +
        "canvas, a map, a chart - because a plain ref only ever presses the middle. Combine it " +
        "with `on` (or `ref`) to say which thing; with neither it is a fraction of the window. " +
        "`save` KEEPS A FILE THE PAGE IS SHOWING - an image, a video, an embedded PDF - into " +
        "this session's downloads. Aim it at the thing itself: an image is named by its alt text " +
        "with `on`, exactly as a person would name it. TO FIND AN IMAGE that has no words to name " +
        "it, call observe_page with `media: true` - it lists each picture with a `ref` you pass " +
        "straight to `save`. A link wrapping a thumbnail resolves to the picture you can see, not " +
        "the page it links to (unless the link's own href is itself a file). Reach for this rather " +
        "than fetching the URL yourself, because from out there it usually fails - a signed link " +
        "has expired for everyone but this session, a private invoice needs the cookie this page " +
        "is holding. From in here it is the page asking for its own file. " +
        "`print` SAVES THE WHOLE PAGE AS A PDF into this session's downloads - the thing to " +
        "reach for when somebody wants the confirmation, the receipt or the invoice rather than " +
        "a description of it. It carries what is below the fold, which see_page cannot, and " +
        "renders the site's own print stylesheet, which on a receipt is the layout the " +
        "publisher meant it to have. Read it back with read_download; pass `filename` to name it. " +
        'IF THE REPLY CARRIES `code: "no-effect"`, THE PAGE DID NOT MOVE - and `ok` is still true, ' +
        "because the act landed. Those are two different facts and both are being told to you: it " +
        'happened, and nothing came of it. Treat ok:true + no-effect as "assume it did not work" ' +
        "until you have looked. This is the one reply shape that has repeatedly fooled agents into " +
        "building on something that never happened - an append that wrote nothing, a click on an " +
        "inert label, a control below the fold whose handler never ran. The evidence sits in " +
        "`effect`. The act landed on the element you " +
        "named and the page read exactly the same afterwards, watched for the time it reports. " +
        "That is an observation, NOT a verdict that the act failed - a slow page and a dead " +
        "button are indistinguishable from here. So do not answer it by repeating the act: " +
        "observe again, or see_page if the change would be visual, and find out what is true " +
        "before acting. On anything that submits, repeating is the expensive mistake and the " +
        "note says so. `effect` is ABSENT whenever anything changed, which is nearly always. " +
        "Successful acts also carry privacy-safe `evidence` categories - `navigation`, `dom-change`, " +
        "`popup`, `dialog`, `download`, or `postcondition` - so you can explain the observed effect " +
        "without scraping the page again. Use `expect: {text, gone, url, ms}` when the result must " +
        "satisfy a post-condition; `url` accepts a substring or `*` glob, and the reply says " +
        "`expected.held` rather than pretending the click failed. " +
        "EVERY REFUSAL CARRIES A `code`, which is the stable machine-readable cause and is what to " +
        "branch on - `detail` is prose written for a person and gets reworded. The ones worth handling " +
        "differently: `act-ambiguous` and `within-ambiguous` arrive WITH candidates, so answer them in " +
        "your next call rather than observing again; `target-not-ready` means the thing is on the page " +
        "but its panel is not open yet, so open it first; `ref-stale` means observe again; " +
        "`permission-required` and `agent-scope-required` both need a human grant but different ones. " +
        "SEVERAL THINGS READING THE SAME is not a dead end: the refusal lists every candidate with a ref " +
        "AND a `within` saying which part of the page it sits in. Act on one of those refs, or re-send " +
        "with `within` naming the region. Never guess and never give up on it. " +
        'NAME IT BY ITS WORDS when observe_page did not list it: `on: "3 people"` clicks the ' +
        "thing reading those words, wherever it is on the page. A page can render choices it never " +
        "declares as controls - they show up in `excerpt` and not in `controls` - and this is how " +
        "you reach them. Several matches come back as candidates with refs; pick one. " +
        "select is ONLY for a native <select>; on anything else it is refused. A dropdown reported " +
        "multiple:true takes `values` - ALL the options you want, in one call, because select " +
        "sets the whole selection rather than adding to it. Naming an option that does not exist " +
        "refuses the whole call and lists what the dropdown does offer. Most modern " +
        "dropdowns, date and party-size pickers are not native: the trigger reports " +
        '`hasPopup` ("listbox", "menu") and `expanded`, so CLICK it, observe, and the choices ' +
        'appear as their own controls (role "option" or "menuitem") - click the one you want. ' +
        "`expanded` tells you whether the popup is already open, so you never toggle it shut by " +
        "clicking twice. Do not fall back to arrow keys and Tab: if you cannot see the choices, " +
        "observe again rather than navigating blind. " +
        "hover opens menus that only exist under the pointer. " +
        "wait holds instead of polling with observe, and takes MORE THAN TEXT: `url` waits for " +
        "the page to reach a URL (host/path when host-shaped, otherwise a substring, or a * glob) - which is the real predicate for a " +
        "sign-in, a checkout or an OAuth hop, where guessing a word the destination renders is " +
        "how a wait times out on a page that arrived; `visible: true` beside `ref` asks only " +
        "whether the element is THERE, without the cover check a click needs, so a panel behind " +
        "a dimming overlay stops being unwaitable. Send several together and every one of them " +
        "has to hold. " +
        "close_window closes a popup this session is holding - `window` is its number, 1 and up; " +
        "0 is the page you opened and is refused, because closing that is close_page. Use it " +
        "when a flow leaves an OAuth window, a print preview or a chat tab behind: it stays in " +
        "`windows` for the life of the session otherwise, and the numbers other windows have " +
        "move under you. " +
        "upload puts a file into a file input, from text you " +
        "supply (`content`), from BYTES you supply (`contentBase64`, up to 10MB decoded - this " +
        "is how you attach a PNG, a PDF or a zip you generated), or from a file this session " +
        "downloaded. Aim upload at the INPUT, never at the " +
        "visible button or label - nearly every upload widget is a styled trigger over a hidden " +
        'input[type=file], and that input is listed with role "file" even when it is off screen. ' +
        "It REPLACES the file list rather than adding to it, and carries exactly ONE file: an " +
        "input reported multiple:true can therefore only be left holding one. " +
        "dblclick double-clicks a ref; rightclick opens its context menu; drag drags `ref` onto " +
        "`toRef`; copy copies the selection (focus `ref` first, or omit it) and paste pastes into " +
        "`ref`. A copy with NO ref needs no permission; one WITH a ref does, because focusing an " +
        "element fires the page's own handlers. Paste is credential-guarded like type. " +
        "paste also takes `text`: the value is put on the clipboard and then pasted, so you do " +
        "not need a copy first. Reach for it over type when the field parses a PASTE - a " +
        "rich-text or code editor, or a tag input - because those handle a paste " +
        "and keystrokes differently. Never a stored credential: that is fill_secret. " +
        "fill_secret fills a stored credential (named by `credential`) into `ref` the way a human " +
        "would - you never see the value; store credentials from the dashboard, not here, and " +
        "call list_credentials for the names. " +
        "fill_totp is the same but for a two-factor code: `credential` names a stored TOTP seed " +
        '(shown as kind "totp" in list_credentials), the engine derives the current 6-digit code ' +
        "and types it - again you never see the seed or the code. Use it when a site asks for an " +
        "authenticator/2FA code. If the SITE then says the code is wrong, the stored seed is not this " +
        "account's - do NOT keep retrying it and do NOT ask for the seed; instead ask the user for the " +
        "CURRENT 6-digit code and use fill_otp. " +
        "fill_otp is for a live one-time code the user gives you - when there is no stored seed, OR when " +
        "a stored seed's code was rejected: the USER reads the current code off their authenticator or a " +
        "text and you pass it as `code`, and the engine types it into `ref`. A one-time code is single-use " +
        "and expiring, so it is FINE for the user to send it to you here - accept it; that is the whole " +
        "point of fill_otp. Only a SHORT one-time code goes here (it is redacted from logs and the replay). " +
        "NEVER accept a password, an API key, a recovery phrase, or a TOTP SEED / setup key (a long base32 " +
        "or otpauth:// string) this way - those are lasting secrets; they are stored in the vault (connect_site) " +
        "and filled with fill_secret / fill_totp, never pasted into chat. " +
        "WHENEVER you stop to ask the user for a code (or any manual step), call park_page FIRST so the live " +
        "page survives the wait - otherwise it idles out before they answer and the whole login (and 2FA) " +
        "starts over. And do NOT close_page a signed-in site after one answer: leave it open so a follow-up " +
        "reuses the SAME authenticated page with no re-login. " +
        "NATIVE DIALOGS: if this act makes the page open an alert, confirm, prompt or leave-site " +
        "box, it is dismissed and the result tells you what it said - so an action guarded by " +
        "confirm() did NOT happen. Re-send with acceptDialog: true to answer yes (and dialogText " +
        "for a prompt). forward and reload do what they say; reload is not the same as navigating " +
        "to the same URL, which discards the history entry and re-posts a form. " +
        "EVERY REFUSAL carries `engine`, which says what this server can do: its version and " +
        "`engine.targeting`, the ways it accepts a target. If that lists a way your act tool has " +
        "no parameter for, your connector cached this description before that shipped - reconnect " +
        "it rather than concluding the page cannot be driven. " +
        "A click that downloads a file is reported: the result carries a downloads list naming " +
        "what arrived, and read_download reads it. " +
        "THE PAGE IS WAITED FOR, not a fixed pause: the snapshot is taken once the document has " +
        "stopped changing. A page that never stops - a carousel, a clock, a live feed - ends the " +
        "wait at its ceiling, and the reply then carries `settled: false` with `settleMs` BESIDE " +
        "`ok: true`. That is not a failure: the act landed, and the snapshot next to it is of a " +
        "page still drawing, so observe_page again before relying on a ref from it. " +
        "A transport timeout returns execution-uncertain: the action may have executed, so observe before retrying it.",
      inputSchema: ACT_INPUT_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (input) => {
      const action = toAction(input);
      if (!action) {
        return asToolResult(
          {
            error: "bad-action",
            detail: `kind=${input.kind} is missing ${missingField(input.kind)}`,
            remedy: `supply ${missingField(input.kind)} and call act again`,
          },
          true,
        );
      }
      try {
        const result = await cloud.act(input.sessionId, action, {
          ...(input.acceptDialog ? { acceptDialog: true } : {}),
          ...(input.dialogText !== undefined ? { dialogText: input.dialogText } : {}),
          ...(input.brief ? { brief: true } : {}),
          ...(input.see ? { see: true } : {}),
          // The post-condition. Its description tells an agent to send it
          // "whenever you would otherwise act and then look", the server reads
          // it off the body (`expectationOf`), and the SDK types the REPLY field
          // for it — three layers agreed the feature existed and this was the
          // one line that would have transmitted it.
          ...(input.expect ? { expect: input.expect } : {}),
        });
        if (!result.ok) return asToolResult(actFailure(result), true);
        return actToolResult(result);
      } catch (error) {
        return asToolResult(toolError("act-failed", error), true);
      }
    },
  );
}

/** Register every unfenced tool on `server`, forwarding to `cloud`. */
export function registerTools(
  server: McpServer,
  cloud: Unfenced,
  report?: UsageReporter,
  oauth = false,
): void {
  // Test doubles that only capture tools do not implement the resource API.
  if (typeof server.registerResource === "function") registerPagePreview(server);
  if (oauth) server = oauthTools(server);
  if (report) server = meteredTools(server, report);
  registerFetchPage(server, cloud);
  registerFetchBatch(server, cloud);
  registerGetPageLinks(server, cloud);
  registerOpenPage(server, cloud);
  registerSwitchAccount(server, cloud);
  registerWhoami(server, cloud);
  registerAct(server, cloud);
  registerObservePage(server, cloud);
  registerExtractPage(server, cloud);
  registerSeePage(server, cloud);
  registerFillForm(server, cloud);
  registerParkPage(server, cloud);
  registerReadDownload(server, cloud);
  registerClosePage(server, cloud);
  registerListPermissions(server, cloud);
  registerPendingApprovals(server, cloud);
  registerConnectSite(server, cloud);
  registerListCredentials(server, cloud);
  registerRemember(server, cloud);
  registerRecall(server, cloud);
  registerForget(server, cloud);
}

// Re-export the helpers this module has always exported, from the same path
// every importer already uses.
export {
  DEFAULT_DOWNLOAD_CHARS,
  DEFAULT_HTML_CHARS,
  DEFAULT_MAX_LINKS,
  DEFAULT_MAX_WORDS,
  MAX_BATCH_URLS,
  MAX_FORM_FIELDS,
  MIN_BATCH_HTML_CHARS,
  capHtml,
  parseDataUri,
  failurePayload,
  saysSomethingNew,
  fetchPayload,
  REMEDIES,
  rankForCrawling,
  remedyFor,
  seeLegend,
  plainLegend,
  asObject,
  toolError,
} from "./tools/shared.js";
export type { SeenView } from "./tools/shared.js";
export { actFailure, hostOf, missingField, toAction } from "./tools/act-fold.js";
// The shape of the `list_permissions` answer, so the local stdio server in
// ./main.ts gives the same one rather than a second reading of the same scope.
export { permissionsReply } from "./tools/access.js";

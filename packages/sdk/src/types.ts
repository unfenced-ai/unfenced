/**
 * The public domain and wire types of the Unfenced SDK.
 *
 * Split out of the client so a consumer that only wants the shapes - a dashboard
 * that may take no runtime dependency on this package - can `import type` them,
 * and so the client modules share one copy. Every name here is re-exported
 * unchanged from the package entry (`index.ts`); this is a move, not a redesign.
 */
import type { ExtractedDoc, FetchFailureMeta, FetchMeta, OutputFormat, Tier } from "./protocol.js";

export interface UnfencedOptions {
  /** Where the server is. Defaults to http://127.0.0.1:8787. */
  baseUrl?: string;
  /** The access token, if the server sets UNFENCED_TOKEN. */
  apiKey?: string;
  /**
   * Injectable fetch (for tests / non-standard runtimes). Defaults to global.
   *
   * Declared as what this client actually calls rather than as `typeof fetch`.
   * It only ever passes a string URL, so demanding a function that also handles
   * `URL` and `Request` objects asked callers to satisfy a contract the library
   * never exercises - and made an ordinary test double, typed by the one shape
   * it receives, fail to typecheck. The global `fetch` still satisfies this.
   */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Extra headers sent on every request - e.g. to attribute the calling client. */
  headers?: Record<string, string>;
  /**
   * Cancel every request this client makes.
   *
   * Combined with each call's own deadline rather than replacing it, so a
   * caller that aborts a whole task does not have to reach into per-call
   * options, and a per-call `timeoutMs` still bounds a request this never
   * aborts.
   */
  signal?: AbortSignal;
}

/** The protocol calls this `OutputFormat`; `Format` is the name the SDK shipped. */
export type Format = OutputFormat;

export interface FetchOptions {
  format?: Format;
  /**
   * Stable creation key for safe replay if the POST acknowledgement is lost.
   * When omitted, the SDK generates one per fetch call and reuses it only for
   * its own bounded transport retry. Batch calls derive a per-URL suffix from
   * this base key. The server retains keys for the job's normal 30-minute
   * result lifetime, process-locally.
   */
  idempotencyKey?: string;
  /** Batch only: maximum concurrent fetch jobs, 1-32. Default 3, matching the production tenant share. */
  concurrency?: number;
  /** Skip straight to a rendered browser instead of trying plain HTTP first. */
  forceRender?: boolean;
  /** Route this fetch through a proxy, e.g. "http://user:pass@host:8080". */
  proxy?: string;
  /**
   * How long this fetch may take in total, in ms. Default 120s.
   * Integer 0..2147483647. Zero returns timeout without submitting a job;
   * invalid durations reject with RangeError before work starts.
   *
   * The WALL CLOCK, not the gap between polls. It used to bound only the poll
   * loop's own check, which ran after each request returned - so a hung `POST
   * /jobs` never reached the check at all and a hung `GET /jobs/:id` blocked
   * forever. Against this repository's own documented failure (a Cloudflare
   * quick tunnel dead at the edge while cloudflared is alive) `timeoutMs: 5000`
   * meant "until the OS gives up". Every request now carries an AbortSignal cut
   * from the remaining budget.
   */
  timeoutMs?: number;
  /** Ignore our own back-off for this host - for a deliberate retest. */
  force?: boolean;
  /**
   * Whether to tell the site what we are.
   *
   * `auto` (default) uses what has been learned about this host: sites that
   * serve agents a purpose-built rendering get told, sites that refuse bots do
   * not. Some publishers hand a declared agent strictly more than they hand a
   * browser - g2 answers one with markdown carrying scores and summaries the
   * human page does not show.
   */
  identify?: "auto" | "agent" | "stealth";
  /** Ignore robots.txt, report its verdict, or obey it. Defaults to the identity-aware server policy. */
  robots?: "ignore" | "report" | "obey";
  /** Cap the content at this many words, counted in the page's own script. */
  maxWords?: number;
  /**
   * The language to present, e.g. "en-US" (default), "he-IL", "ja-JP".
   *
   * Sets `Accept-Language` and the browser's own language, so the site chooses
   * content in it. Without it the worker's geography decided: the same call
   * answered in Hebrew from one worker and English from another, which is
   * irreproducible and invisible to the caller.
   */
  locale?: string;
  /**
   * Collect links from the whole page rather than just the extracted article.
   *
   * Crawling needs the navigation the cleaner strips: a ministry front page
   * yields six links from its content region and dozens from the page.
   */
  wholePageLinks?: boolean;
}

/**
 * What a fetch actually returns, which is more than this used to say.
 *
 * The client passes the server's job result through untouched, and that result
 * carries six fields - verified over the wire: `ok, url, format, content, doc,
 * meta`. This type declared three of them. The missing one that matters is
 * `content`: the clean page text the call was made to get. A consumer writing
 * TypeScript could not reach `result.content` without a cast, on the primary
 * method of the client library, while it sat there at runtime the whole time.
 *
 * The failure branch was thinner still, and it contradicted a promise the
 * product makes in its own source: "an agent must be able to tell 'the site
 * blocked us' from 'the page is empty' - every failure says which tier failed
 * and why, in machine-readable form". `tier` was not in the type, so it did not
 * say so here.
 *
 * `url`, `tier` and `status` are optional on a failure because not every
 * failure comes from the server. A request rejected before it was sent, a job
 * that never finished - those are the client's own, and they have no tier to
 * report. Declaring them required would be the mirror of this bug: a type
 * promising a field that is sometimes absent.
 */
/** Whose fault it was. Mirrors the engine's own `Fault`. */
export type Fault = "site" | "network" | "us" | "caller" | "policy";

/** A door the server found and did not open. Mirrors the engine's `Offer`. */
export interface Offer {
  need: "payment" | "compute" | "human";
  because: string;
  site: string;
  ticket: string;
  expiresAt: string;
  expiresInMs: number;
  quote: {
    micros: number;
    cents: number;
    currency: "USD";
    estimateMs: number;
    payee: "unfenced" | "site";
    capped: boolean;
  };
  accept:
    | { kind: "call"; tool: string; arguments: Record<string, unknown> }
    | { kind: "visit"; url: string; why: string };
  for: { url: string; title: string | null; why: string };
}

/**
 * Four outcomes: delivered content, a refusal, an offer, or an archived
 * receipt whose full content has expired.
 *
 * `ok` is gone rather than kept alongside `outcome`. Keeping it would compile
 * everywhere and route every offer into whichever branch each caller already
 * had for failure - silently, and discovered by whoever is holding the bill.
 */
export type FetchResult =
  | {
      outcome: "delivered";
      /** The URL as asked for; `meta.finalUrl` is where it ended up. */
      url: string;
      format: Format;
      /** The page, in the requested format. The reason for the call. */
      content: string;
      doc: ExtractedDoc;
      meta: FetchMeta;
    }
  | {
      outcome: "offered";
      url: string;
      offer: Offer;
      /** What was visible without paying: the abstract, page one, the teaser. */
      partial?: ExtractedDoc;
      meta?: FetchMeta;
    }
  | {
      outcome: "archived";
      url: string;
      /** The full result aged out; only the small history receipt remains. */
      entry: {
        id: string;
        url: string;
        ok: boolean;
        fetchedAt: string;
        title?: string;
        error?: string;
        [field: string]: unknown;
      };
    }
  | {
      outcome: "failed";
      error: string;
      fault?: Fault;
      detail?: string;
      /** Server advice for a refused request, when one was supplied. */
      remedy?: string;
      /** Server-supplied delay before retrying, in milliseconds. */
      retryAfterMs?: number;
      url?: string;
      /** Which tier failed. Absent on a failure the client produced itself. */
      tier?: Tier;
      /** The HTTP status, when the site answered with one. */
      status?: number;
      /**
       * Not `Partial<FetchMeta>`: a failure carries `retryAfter`/`retryAfterMs`,
       * which a success never does, and carries none of the fields that only
       * exist once a document was produced. Still optional, because a failure
       * the client produced itself never reached the server and has no meta.
       */
      meta?: FetchFailureMeta;
    };

/**
 * A pointer action addressed by the words visible on the target, rather than by a
 * ref from a snapshot.
 *
 * For the choices a page renders without declaring them as controls - they appear
 * in `excerpt` and never in `controls`, so no ref exists for them. The engine
 * resolves the words to an ordinary ref before any guard runs, so these are
 * gated exactly as a ref-addressed action is.
 */
/** A spot inside a target, as fractions from 0 to 1 of its box. */
export interface Spot {
  x: number;
  y: number;
}

/**
 * A pointer action aimed at a SPOT rather than at a thing.
 *
 * For anything whose meaning is a position: a slider track, a video scrubber, a
 * canvas, a map, a chart. Combine `at` with `on` or `ref` to say which thing;
 * with neither it is a fraction of the window. The engine hit-tests the pixel and
 * judges whatever is actually under it, so these are gated at least as strictly
 * as a ref-addressed action.
 */
export type AtAction =
  | {
      kind: "click";
      at: Spot;
      ref?: string;
      on?: string;
      confirm?: boolean;
      button?: "left" | "middle";
    }
  | { kind: "dblclick"; at: Spot; ref?: string; on?: string; confirm?: boolean }
  | { kind: "rightclick"; at: Spot; ref?: string; on?: string; confirm?: boolean }
  | { kind: "hover"; at: Spot; ref?: string; on?: string }
  /**
   * The one whose ADDRESS is usually a spot and nothing else: a map tile, an
   * empty part of a scrolling pane, a chart. `by` is how far down, `across` how
   * far sideways, and the modifiers are held across the gesture - Control+wheel
   * is how a map zooms.
   */
  | {
      kind: "wheel";
      at: Spot;
      ref?: string;
      on?: string;
      within?: string;
      by: number;
      across?: number;
      modifiers?: readonly ("Shift" | "Control" | "Meta")[];
    }
  /**
   * THE WRITING VERBS A COORDINATE CAN AIM, mirrored from core.
   *
   * Rich text is the case: a contenteditable is the field, and everything a
   * pixel can land on inside it is a p or a span, so a position is the only
   * address the surface has. The engine has always hit-tested `at` for any kind
   * and judged the element actually under it, so the capability was real over
   * the wire while this type said the call did not type-check - which meant a
   * spot-addressed `type` into a canvas-hosted editor, and `contentBase64` on a
   * spot-addressed upload, were unreachable from this package alone.
   *
   * NOT the `fill_*` verbs, deliberately: a credential resolved from a
   * coordinate is a secret typed into whatever happened to be under a pixel.
   */
  | {
      kind: "type";
      at: Spot;
      ref?: string;
      on?: string;
      within?: string;
      text: string;
      submit?: boolean;
      append?: boolean;
      confirm?: boolean;
    }
  | {
      kind: "select";
      at: Spot;
      ref?: string;
      on?: string;
      within?: string;
      value: string | string[];
    }
  | { kind: "paste"; at: Spot; ref?: string; on?: string; within?: string; text?: string }
  | {
      kind: "upload";
      at: Spot;
      ref?: string;
      on?: string;
      within?: string;
      filename?: string;
      content?: string;
      contentBase64?: string;
      download?: string;
    };

export type OnAction =
  | { kind: "click"; on: string; within?: string; confirm?: boolean; button?: "left" | "middle" }
  | { kind: "dblclick"; on: string; within?: string; confirm?: boolean }
  | { kind: "rightclick"; on: string; within?: string; confirm?: boolean }
  | { kind: "hover"; on: string; within?: string }
  /** Scroll a pane by naming something inside it, when the pane itself has no
   *  name of its own. `by` is how far down, `across` how far sideways. */
  | { kind: "wheel"; on: string; within?: string; by: number; across?: number }
  /**
   * THE WRITING VERBS BY THE WORDS ON THE PAGE, mirrored from core.
   *
   * A field is often labelled and never named - "Attach a file" is the words a
   * person reads, and the `<input type=file>` behind it has no accessible name
   * of its own; the same is true of half the text inputs on the web. Naming the
   * label resolves to the field before any guard runs, exactly as it does for a
   * ref, so these gate identically.
   *
   * `type` and `select` were the ones this package could not express, and they
   * are the half of `on` that matters most: an agent could click "3 people" and
   * could not type into "Full name". The wire has accepted both since the
   * server's `worded()` learned them - only this declaration said otherwise.
   */
  | {
      kind: "type";
      on: string;
      within?: string;
      text: string;
      submit?: boolean;
      append?: boolean;
      confirm?: boolean;
    }
  /** `values` is the plural spelling, for a `<select multiple>`; both land on
   *  core's one field, because "what to choose" is one idea. */
  | { kind: "select"; on: string; within?: string; value?: string; values?: readonly string[] }
  | { kind: "paste"; on: string; within?: string; text?: string; confirm?: boolean }
  | {
      kind: "upload";
      on: string;
      within?: string;
      filename?: string;
      content?: string;
      contentBase64?: string;
      download?: string;
    };

/** One control or link on a live page. */
export interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  /** True when `value` was cut to length: it is a PREFIX of what the field holds.
   *  Without it, checking a long write against what came back looks like a failed
   *  write on a field that is correct. */
  valueTruncated?: boolean;
  disabled?: boolean;
  /**
   * A count that sat in its own element beside the name, e.g. "232" on a
   * "Summer 2026" filter - split out because textContent glues them together.
   */
  badge?: string;
  /** True when `name` was cut to length: it is a prefix, not the whole value. */
  truncated?: boolean;
  /** True when this holds a credential - typing here is refused. */
  secret?: boolean;
  /** Whether a secret field has something in it. Never what. */
  filled?: boolean;
  /** True when acting here submits a form - requires confirm. */
  submits?: boolean;
  /**
   * Why it submits: `type=submit` is written on the control, while a bare
   * `<button>` inside a form is the form's default one and says nothing at all.
   * Present only when `submits` is true.
   */
  submitsBecause?: "type=submit" | "default button in a form";
  /**
   * WIDGET STATE, mirrored from core's `SnapshotElement`. Absent means the page
   * did not say - never that the answer is false.
   */
  /** Is this menu / accordion / picker currently open? */
  expanded?: boolean;
  /** Clicking this opens a popup rather than acting: "menu", "listbox",
   *  "dialog", "tree", "grid". Tells you to click and then look for the choices,
   *  instead of trying `select` on something that is not a `<select>`. */
  hasPopup?: string;
  /** Checkbox, radio, switch or menu item: is it on? */
  checked?: boolean;
  /** Tab, option or treeitem: is this the chosen one? */
  selected?: boolean;
  /** Takes MORE THAN ONE value - `<input type=file multiple>` or `<select
   *  multiple>`. Both REPLACE rather than accumulate, so adding items one call at
   *  a time silently ends with the last one. */
  multiple?: boolean;
  /** Which embedded document this lives in - the frame's name, or its host.
   *  Absent for the page's own, which is where most controls are. The merged
   *  list is flat, so this is the only thing separating a page's "Continue"
   *  from an embedded checkout's. */
  frame?: string;
}

/** What an agent can see and act on, per observe. */
/**
 * Why a page did or did not open carrying the account's sign-in-provider session.
 *
 * `carried` is the good case. `agent-scoped` and `fresh-signin` are DECISIONS,
 * not faults. `held-elsewhere` means another machine legitimately holds it - a
 * provider session may live in exactly one browser at a time, because a
 * duplicate gets BOTH invalidated. `store-unavailable` is an outage - or a
 * stored provider profile the worker could not open, which is the same answer to
 * the same question - and `none-stored` an account that has never connected one.
 *
 * All of them render as the same logged-out page, which is why they are named: a
 * caller reading this can tell "correctly refused" from "try again shortly" from
 * "the owner has to sign in once", instead of guessing from a screenshot.
 */
export type ProviderSessionReason =
  | "carried"
  | "agent-scoped"
  | "fresh-signin"
  | "none-stored"
  | "held-elsewhere"
  | "store-unavailable";

/**
 * One thing waiting on the account owner - a sign-in, a 2FA code, a consent, a
 * per-action approval, or a site that needs its first provider login.
 */
/**
 * Every wall the server can raise, mirrored from `server/src/interrupts.ts`.
 *
 * Declared as a union rather than `string` so a consumer that maps kinds to
 * something a person reads is checked for exhaustiveness by `tsc` instead of
 * silently falling through to the raw slug. `interrupt-kinds.test.ts` binds
 * this list to the producer's, because a mirror that cannot drift is worth
 * more here than one more `string`.
 */
export type InterruptKind =
  | "credential"
  | "otp"
  | "captcha"
  | "consent"
  | "approval"
  | "grant"
  | "site-login"
  | "wait"
  | "watch";

export interface PendingApproval {
  id: string;
  kind: InterruptKind;
  host: string;
  url?: string | null;
  reason?: string | null;
  status: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * One saveable picture, video or embed, present only when `observe`/`read` was
 * called with `media: true`. A content image is not a control and has no ref
 * anywhere else, so this is the handle `save` is pointed at. `w`/`h` are the
 * rendered size; the scan skips anything under 64x64.
 */
export interface MediaItem {
  ref: string;
  kind: "image" | "video" | "audio" | "embed";
  /** Its alt text, or a filename derived from the URL. */
  name: string;
  w: number;
  h: number;
}

export interface PageSnapshot {
  url: string;
  title: string;
  controls: SnapshotElement[];
  links: SnapshotElement[];
  excerpt: string;
  truncated: { controls: number; links: number; media?: number };
  /**
   * Saveable media, present ONLY when `media: true` was asked for. Each entry's
   * `ref` goes straight to `save`. Off by default - it is extra payload the
   * ordinary reading does not carry.
   */
  media?: MediaItem[];
  /**
   * A few examples of what the page DRAWS as clickable and never declared, so
   * they carry no ref and can only be named by their words. Absent when the page
   * declares everything it means, which is what keeps it a signal.
   */
  undeclared?: string[];
  /**
   * Why this reading may not be enough on its own, when it is not: a screen that is mostly
   * canvas or picture, or several controls the page never named. Names see_page as the
   * remedy. Absent whenever the reading stands alone, which is most pages.
   */
  look?: { code: "pictorial" | "unnamed"; reason: string };
  /**
   * The embedded documents this reading could and could not see. Absent on a page
   * with no frames.
   *
   * A skipped frame is a whole document missing from the answer with nothing to
   * mark its absence - which reads exactly like a page that has no such control.
   * `more.reason` says the same thing in words when this is non-empty.
   */
  frames?: {
    included: number;
    skipped: Array<{
      host: string;
      /** cross-origin is a legacy label; unreadable does not guess the cause. */
      reason: "cross-origin" | "unreadable" | "detached" | "over-limit";
    }>;
  };
  /** The page had not finished loading when this was read. Absent means it had.
   *  A thin reading with an innocent explanation, and a different remedy from
   *  every other thin reading: observe again in a moment. */
  loading?: boolean;
  /** Identifies the document these refs belong to; refs go stale on navigation. */
  document: string;
}

/**
 * A picture of a page with the things that can be acted on drawn onto it.
 *
 * `marks` and `controls` describe the same instant: mark N is controls[N - 1].
 * A control with no mark is scrolled out of view or covered, and `note` says so
 * when that happens - it is still listed and still actable by ref.
 */
/**
 * A reading, plus a picture when the reading says it needs one.
 *
 * `picture` is present only when the snapshot carries `look` - a screen that is
 * mostly canvas or picture, or controls the page never named - and only for the
 * first reading that hits a given wall on a given document.
 */
export interface ReadPage {
  page: PageSnapshot;
  /** JPEG data URI, with every control outlined and numbered. */
  picture?: string;
  /** Mark N is the Nth control. Empty unless `picture` is present. */
  marks?: Array<{ mark: number; ref: string; role: string; name: string }>;
  /** Why some controls have no box. */
  pictureNote?: string;
}

/** One field in a batched fill. Needs a `ref` or an `on`. */
export interface FormField {
  ref?: string;
  /** The field's visible words - its label, or its placeholder. */
  on?: string;
  /** Narrow `on` to one region, when a page has two of the same field. */
  within?: string;
  text: string;
  /** Add to what is there instead of replacing it. */
  append?: boolean;
}

export interface FormFillResult {
  ok: boolean;
  /** One entry per field, in the order sent, whether or not it worked. */
  filled: Array<{ target: string; ok: boolean; code?: string; reason?: string }>;
  page: PageSnapshot;
}

export interface SeenPage {
  /** JPEG data URI of the current viewport. */
  image: string;
  marks: Array<{ mark: number; ref: string; role: string; name: string }>;
  controls: SnapshotElement[];
  /**
   * The page's links, present only when `links` was asked for.
   *
   * Beside `controls` rather than inside it, because `controls` has meant "the
   * things this page declares as controls" since the first version and a caller
   * resolving a mark to a list entry looks in both.
   */
  links?: SnapshotElement[];
  /** What the page draws as clickable and never declared. No ref, so no box. */
  undeclared?: string[];
  note?: string;
}

/** A file a page handed to the browser during a session. */
export interface DownloadInfo {
  filename: string;
  bytes: number;
  at: string;
  fromUrl: string;
  /** Set instead of the rest when the transfer failed. */
  failed?: string;
}

/**
 * WHY AN ACT ANSWERED WHAT IT ANSWERED, as a value rather than a sentence.
 *
 * `reason` is written for a reader and is reworded whenever a clearer sentence
 * is found; this is written for a `switch` and is not. The server has sent it on
 * every act since codes existed and this type did not declare it, so the field
 * arrived, type-checked as nothing, and was invisible to every SDK caller - the
 * same hole `credentialRequired` had one layer up, with the same cause.
 *
 * A MIRROR OF `ACT_CODES` in `@unfenced/core`, which is the authority. This
 * package has zero dependencies on purpose - it runs in a browser - so it cannot
 * import the union, and a copy that could not follow its original is exactly the
 * defect this repo keeps finding. So it is BOUND BY A CHECK instead:
 * `scripts/docs-check.ts` compares the two lists in both directions and goes red
 * on the first one to drift.
 *
 * Optional because an older server answers without it, never because a newer one
 * might omit it.
 */
export type ActCode =
  | "ok"
  | "no-effect"
  | "session-busy"
  | "permission-required"
  | "agent-scope-required"
  | "approval-required"
  | "confirmation-required"
  | "credential-required"
  | "credential-wrong-site"
  | "otp-required"
  | "site-login-required"
  | "no-credential"
  | "wrong-credential-kind"
  | "no-2fa"
  | "bad-totp-seed"
  | "provider-login"
  | "not-a-one-time-code"
  | "act-ambiguous"
  | "within-ambiguous"
  | "within-not-found"
  | "target-not-found"
  | "target-too-common"
  | "ref-stale"
  | "ref-malformed"
  | "wrong-element-kind"
  | "spot-invalid"
  | "bad-action"
  | "no-window"
  | "target-not-ready"
  | "target-covered"
  | "target-no-size"
  | "target-disabled"
  | "value-rejected"
  | "write-failed"
  | "page-moved"
  | "page-unresponsive"
  | "blocked-target"
  | "navigate-failed"
  | "no-history"
  | "no-session"
  | "tenant-session-limit"
  | "quota-exceeded"
  | "park-full"
  | "engine-error";

/**
 * What an act changed, as a summary rather than a second copy of the page.
 *
 * The mirror of core's `PageChanges`. Attached to an act as `changes` when
 * something moved and the change is describable; a navigation reports `redrawn`
 * instead of listing every control twice. A SUMMARY, NOT A SUBSTITUTE - refs
 * come from `page`, and a diff carries none for what did not change.
 */
export interface PageChanges {
  url?: { from: string; to: string };
  title?: { from: string; to: string };
  /** Controls that were not there before. */
  appeared?: SnapshotElement[];
  /** What vanished, by name - a ref that is gone cannot be acted on anyway. */
  vanished?: string[];
  /** Same element, different words - how a page says it accepted a choice. */
  renamed?: Array<{ ref: string; from: string; to: string }>;
  /** Words on the page now that were not on it before. */
  newText?: string;
  /** The page was replaced rather than adjusted. Read the snapshot instead. */
  redrawn?: boolean;
  /**
   * A wall that just appeared - the act ran into a block page. `blocked` also
   * rides on `page`, but a `brief:true` act drops `page` and keeps only this
   * diff, so a submit that navigated into an "Access Denied" would otherwise
   * lose the structured signal. Set only on the transition into a block.
   */
  blocked?: { by: string; reason: string };
}

export type ActEvidenceKind =
  "navigation" | "dom-change" | "popup" | "dialog" | "download" | "postcondition";

export interface ActEvidence {
  kind: ActEvidenceKind;
}

export interface ActExpectation {
  text?: string;
  gone?: string;
  /** A substring or `*` glob matched against the resulting URL. */
  url?: string;
  ms?: number;
}

export interface ActResult {
  ok: boolean;
  /** Privacy-safe evidence categories observed while completing the act. */
  evidence?: ActEvidence[];
  /** Why the action was refused - actionable, recoverable. */
  reason?: string;
  /**
   * The same answer as `reason`, from a closed set. Present on successes too
   * (`"ok"`, or `"no-effect"` when the act landed and the page did not move), so
   * a caller can group every act by outcome without special-casing absence.
   */
  code?: ActCode;
  /**
   * What the page asked NATIVELY during this act: alert, confirm, prompt or
   * beforeunload. Reported whether or not it changed the outcome, because a
   * dismissed confirm is the case that otherwise looks like a successful no-op.
   */
  dialogs?: Array<{ type: string; message: string; handled: "accepted" | "dismissed" }>;
  /** Something worth knowing about an otherwise successful act. Not `reason`,
   *  which means the action was refused. */
  note?: string;
  /**
   * Whether the page had stopped changing when this reading was taken. Sent
   * only as `false`, and only when the wait after the act hit its ceiling - a
   * page that settled says nothing.
   *
   * It sits on a successful act deliberately, like `expected.held` above: the
   * act landed, and the snapshot beside it is of a page still drawing. Observe
   * again if the next act depends on something that was still arriving.
   */
  settled?: boolean;
  /** How long that wait took, in milliseconds. Sent with `settled: false` and
   *  never on its own. */
  settleMs?: number;
  /**
   * Whether a post-condition supplied as `expect` held, and how long it was
   * waited for. `held: false` sits on a successful act deliberately: the act
   * landed and the page did something else, which is a different problem from
   * the act not landing.
   */
  expected?: { held: boolean; waitedMs: number };
  /**
   * PRESENT ONLY WHEN THE PAGE DID NOT MOVE - the act landed and the page read
   * exactly the same afterwards, watched for `waitedMs`.
   *
   * An observation, not a verdict. A slow page and a dead button are
   * indistinguishable from here, so the answer is never to repeat the act:
   * observe again, or look. The note says as much, and says it more strongly
   * when the act submits.
   */
  effect?: { changed: false; waitedMs: number; note: string };
  /**
   * WHAT THIS ACT CHANGED, as a summary rather than a second copy of the page.
   *
   * Present when something moved and the change is describable; a navigation
   * reports `redrawn` instead. Asked for with `brief`, which drops `page` in its
   * favour - so `changes.blocked` is where a block reached by a brief submit
   * surfaces. A SUMMARY, NOT A SUBSTITUTE: refs come from `page`.
   */
  changes?: PageChanges;
  /**
   * What the server can do, attached to REFUSALS.
   *
   * A tool description is cached when a client connects, so one that connected
   * before a capability shipped cannot see it and will misread the page as
   * impossible. `targeting` lists the ways this engine accepts a target; a mode
   * here that your client has no parameter for means the client is stale.
   */
  engine?: {
    version: string;
    commit: string;
    targeting: readonly string[];
    note: string;
  };
  /** The several things that read the same, when `on` did not name exactly one.
   *  Each carries a ref, so choosing costs one round trip. `frame` is set when
   *  a candidate is in an embedded document rather than the page's own - the
   *  distinction `within` cannot draw. */
  candidates?: Array<{
    ref: string;
    role: string;
    name: string;
    within?: string;
    frame?: string;
  }>;
  /** What a words-addressed target turned out to be, so the next act on the same
   *  thing can use the ref. */
  resolved?: { ref: string; name: string; role: string; within?: string };
  /** Set when the action needs { confirm: true } to proceed. */
  confirmationRequired?: string;
  /** Set when the site is not on the act-allowlist - carries the site to allow. */
  permissionRequired?: string;
  /**
   * Set when the action was refused because the field holds a credential.
   *
   * Its own signal rather than a `reason` string, because it needs its own
   * advice: do not ask the user for the password, and do not retry. The core
   * has carried this since the refusal was fixed and this type did not, so an
   * SDK caller could not tell a credential refusal from any other failure -
   * which is the same hole one layer up.
   */
  credentialRequired?: string;
  /**
   * Set alongside `credentialRequired` when the refused field is a ONE-TIME-CODE
   * field, not a password - so the remedy is "enter this 2FA code once" (via
   * fill_otp, or by taking the wheel), not "add a login". Never a value.
   */
  otpField?: boolean;
  /** Set when the action needs the account owner's approval to act on the site. */
  approvalRequired?: string;
  /**
   * WHAT THE AUTHORITY GATE DECIDED - present on an allow as well as a refusal.
   *
   * MIRRORED HERE DELIBERATELY. This package hand-copies the engine's result
   * shape, so a field the engine adds and this file does not arrives over the
   * wire, type-checks nowhere, and is dropped before any SDK or MCP caller can
   * see it - silently, which is the failure mode the engine's own comment on
   * this type warns about at length. The server writes its own audit row from
   * the engine's value, so a receipt does not depend on this copy; a CALLER
   * wanting to show why an act was permitted does.
   *
   * ABSENT WHEN THE GATE DID NOT RUN - a scroll, a hover, an ordinary wheel.
   * Absent is not an allow: it means no decision was taken, and a caller that
   * renders it as permission is reporting something the engine never said.
   */
  authorization?: {
    decision: "allow" | "deny" | "require-approval";
    /** The hostname the gate judged. */
    host?: string;
    /**
     * The allowlist key the verdict was decided by. Absent when the allowlist
     * was never consulted - an any-site credential, or a sign-in provider a
     * login is continuing on - so its presence is the stronger claim.
     */
    site?: string;
    deniedBy?: "account" | "agent";
    /**
     * A PERSON CLEARED THIS ONE. Set only alongside
     * `decision: "require-approval"`, and deliberately not flattened into an
     * ordinary allow: "a standing grant covered it" and "a human looked at
     * this act and said yes" are different claims, and the second is the one
     * worth forwarding to somebody who does not trust you.
     */
    approved?: true;
  };
  /**
   * A deep link that opens the dashboard already set up to clear this wall - a
   * missing login opens the Add-login drawer for the host, a missing permission
   * the Sites grant. Present on a credential/permission/approval refusal so the
   * caller can offer the user a click instead of an instruction. Carries only the
   * blocked host, never a secret.
   */
  setupUrl?: string;
  /** Files the page handed to the browser while this action ran. */
  downloads?: DownloadInfo[];
  /** The page after the action. */
  page?: PageSnapshot;
  /**
   * A marked picture of the instant `page` describes. Present only when the call
   * asked for it with `see`.
   *
   * ONE instant, which act-then-see_page cannot promise: that is two calls, and
   * a page may move between them with nothing in either answer saying so. Carries
   * no reading of its own - that is `page` above.
   */
  view?: {
    /** JPEG data URI of the viewport, with the controls outlined and numbered. */
    image: string;
    /** Mark N is the Nth control in `page.controls`. */
    marks?: Array<{ mark: number; ref: string; role: string; name: string }>;
    /** Why some controls have no box. */
    note?: string;
  };
}

export type Action =
  | {
      kind: "click";
      ref: string;
      confirm?: boolean;
      modifiers?: readonly ("Shift" | "Control" | "Meta")[];
      /** Which button. `middle` opens a link in a background tab, which shows
       *  up in `windows` like any other popup. A right click is `rightclick`. */
      button?: "left" | "middle";
    }
  | {
      kind: "type";
      ref: string;
      text: string;
      submit?: boolean;
      confirm?: boolean;
      /** Add to the field instead of replacing it. Replacing is the default. */
      append?: boolean;
    }
  /** Choose in a dropdown. One value, or several for a `<select multiple>` - it
   *  sets the whole selection rather than adding to it. */
  | { kind: "select"; ref: string; value: string | string[] }
  | { kind: "press"; key: string; confirm?: boolean }
  | { kind: "scroll"; to: "top" | "bottom" | { ref: string } }
  /** Move between the windows this session holds. 0 is the page you opened. */
  | { kind: "switch"; to: number }
  /**
   * Close one of the windows this session holds - the other half of `switch`.
   *
   * For a popup a flow left behind: an OAuth window that did not close itself,
   * a print preview, a chat tab. `0` is refused, because window 0 is the page
   * the session was opened on and closing that is closing the session.
   */
  | { kind: "close_window"; to: number }
  /** Move the pointer onto something without pressing it - for hover menus. */
  | { kind: "hover"; ref: string }
  /**
   * Scroll with a real wheel, optionally over one element.
   *
   * Positive `by` scrolls content downward, the way a wheel pulled toward you
   * does; `across` is the sideways half, for a pane that scrolls that way. The
   * modifiers are held across the gesture - Control+wheel is how a map zooms.
   *
   * It was declared for `on` and for `at` and NOT here, so the one address a
   * caller usually has for a scrollable pane - the ref of something inside it,
   * straight out of the last snapshot - did not typecheck, while the wire had
   * accepted it since the verb shipped. `action-kinds.test.ts` now compares all
   * three unions against core's own, so the next verb cannot arrive in two of
   * three places again.
   */
  | {
      kind: "wheel";
      by: number;
      across?: number;
      ref?: string;
      modifiers?: readonly ("Shift" | "Control" | "Meta")[];
    }
  /**
   * Wait for the page to say something, go somewhere, or show something -
   * rather than for a fixed time.
   *
   * `url` is a substring of the URL, or a `*` glob against the whole of it: the
   * honest predicate for a sign-in or a checkout, which are defined by arriving
   * somewhere. `visible` beside `ref` asks only whether the element is THERE,
   * skipping the cover check a click needs. Everything sent has to hold.
   */
  | {
      kind: "wait";
      text?: string;
      gone?: string;
      ref?: string;
      url?: string;
      visible?: boolean;
      ms?: number;
    }
  /**
   * Put a file into a file input.
   *
   * `content` writes one from text you supply, `contentBase64` from bytes you
   * supply (10MB decoded, for a PNG, a PDF, a zip); `download` re-uses a file
   * this session downloaded. There is deliberately no path parameter - an
   * upload can only send bytes the caller already had.
   */
  | {
      kind: "upload";
      ref: string;
      filename?: string;
      content?: string;
      contentBase64?: string;
      download?: string;
    }
  /** Double-click an element - the real mouse, at the ref's point, like click. */
  /**
   * `confirm` is carried on all three pointer verbs, not just click.
   *
   * The guard asks one predicate over click, dblclick and rightclick before any
   * of them activates a submit control. Omitting it here - while the MCP layer
   * builds it with a SPREAD, which slips past tsc's excess-property check -
   * meant the refusal said "re-send with confirm: true" and the re-sent call
   * left byte-identical to the first. An agent doing exactly what it was told
   * could not read its way out.
   */
  | { kind: "dblclick"; ref: string; confirm?: boolean }
  /** Context-menu click - the real right button, opening the page's own menu. */
  | { kind: "rightclick"; ref: string; confirm?: boolean }
  /** Drag one element onto another with the real pointer, so drag handlers fire. */
  /**
   * Drag from one thing to another, optionally along a route.
   *
   * `via` is viewport fractions the pointer travels through. Without it a drag
   * is a straight line, which is right for dropping a card into a column and
   * cannot express a gesture whose meaning is its shape.
   */
  | {
      kind: "drag";
      /** A ref, or a SPOT as viewport fractions - a map has nothing to name. */
      from: string | { x: number; y: number };
      to: string | { x: number; y: number };
      via?: ReadonlyArray<{ x: number; y: number }>;
    }
  /**
   * Change the page's zoom, 0.25 to 3.
   *
   * `see_page` photographs the viewport and marks only what is on screen, so a
   * control below the fold is neither photographed nor markable. Zooming out is
   * how a long page becomes one picture with everything in it addressable.
   */
  | { kind: "zoom"; scale: number }
  /**
   * The page as a PDF, filed in the session's downloads.
   *
   * The one durable artefact an agent could not make. Carries the WHOLE page
   * rather than the viewport, and renders the site's print stylesheet, which on
   * a receipt is the layout the publisher meant it to have. Read it back with
   * `readDownload`.
   */
  | { kind: "print"; filename?: string }
  /**
   * Save what the page is SHOWING as a file - an image, a video, an embedded PDF.
   *
   * Fetched from inside the page, with the session it already holds, which is
   * why it reaches a signed link or a private invoice that a plain fetch cannot.
   * Aimed at an element rather than a URL; the address it resolves to is checked
   * before it is read.
   */
  | { kind: "save"; ref: string; filename?: string }
  /** Copy the current selection. Focuses `ref` first if given. Not mutating. */
  | { kind: "copy"; ref?: string }
  /**
   * Paste into a field. Focuses `ref`, then the paste shortcut. Credential-guarded.
   *
   * `text` puts that value on the clipboard first, so a paste no longer needs a
   * `copy` to have found the value somewhere on the page. Reach for it over
   * `type` when the field parses a PASTE - a rich-text or code editor, a tag
   * input, a card-number box. Never for a stored credential: that is
   * `fill_secret`, and the value never travels.
   */
  | { kind: "paste"; ref: string; text?: string }
  /**
   * Fill a stored credential into a field by NAME - never by value.
   *
   * `credential` is the name of a secret stored in the vault ("github-pw"); the
   * value is resolved engine-side and typed in without ever passing through the
   * caller or the model. There is no value field, deliberately: storing a secret
   * is a separate, human action (`storeCredential`), and using one is by name.
   */
  | { kind: "fill_secret"; ref: string; credential: string }
  // fill_totp names a stored TOTP seed; the engine derives the current 2FA code
  // and fills it. Like fill_secret, no value is ever carried on the action.
  | { kind: "fill_totp"; ref: string; credential: string }
  // fill_otp carries an actual one-time code the user provided (e.g. read off their
  // authenticator) - for when there is NO stored TOTP seed. A one-time code is not a
  // lasting secret, so it may pass through the model; the server shape-checks it,
  // redacts it from the audit, and keeps it out of the replay. Never a password.
  | { kind: "fill_otp"; ref: string; code: string }
  /** `settleMs`: how long to let the network go quiet after the document
   *  commits, before the reading is taken. Default 4000, maximum 15000 - raise
   *  it for a page you know draws from several slow fetches. */
  | { kind: "navigate"; url: string; settleMs?: number }
  | { kind: "back" }
  /** Forward, the other half of back. */
  | { kind: "forward" }
  /** Reload the current page - NOT the same as navigating to the same URL, which
   *  discards the history entry and re-posts or drops what was typed. */
  | { kind: "reload" };

export interface SessionInfo {
  connection?: ConnectionSnapshot;
  id: string;
  url: string;
  type: "ephemeral" | "agent" | "cdp";
  /** Why the provider login was or was not carried into this live session. */
  providerSession?: ProviderSessionReason;
  openedAt: string;
  lastUsedAt: string;
  /**
   * True once something has been done to this page rather than only read.
   *
   * It decides which idle clock the page gets - 5 minutes for one only read,
   * 15 once acted on - because the two differ in what closing destroys.
   */
  actedOn?: boolean;
  /** Set while the page is held open waiting on something out of band. */
  parkedUntil?: string;
  /** What it is waiting for, if it was said. */
  parkedReason?: string;
}

/**
 * A finished run in the recorded-session library.
 *
 * This and the two types under it are hand-mirrored from the server's
 * `packages/server/src/sessions-db.ts`, deliberately and not by oversight: this
 * client has zero dependencies and never imports the server, and cross-package
 * types here resolve through `dist/`, so importing one would tie a browser-side
 * client to a Node build. The cost is that the mirror has to be updated when the
 * server's shape moves - as it did when `api` joined the kinds and `stepCount`
 * joined the summary.
 */
export interface ConnectionSnapshot {
  kind: "direct" | "proxy" | "unknown";
  name: string;
  country?: string;
}

export interface SessionSummary {
  connection?: ConnectionSnapshot;
  id: string;
  /** `api` is a run driven through this SDK / the MCP connector, as opposed to
   *  one of the dashboard's own demo, console, or bridge runs. */
  kind: "demo" | "agent" | "bridge" | "api";
  title: string;
  url: string;
  status: "ok" | "blocked" | "error";
  label: string;
  startedAt: string;
  durationMs: number;
  frameCount: number;
  /** How many steps the log holds - with film and an answer, what makes a run
   *  worth opening. Runs recorded before it was counted report 0. */
  stepCount: number;
  /**
   * Which of the fleet's machines produced this run, and what OS it ran.
   *
   * BOTH are absent on a row recorded before the columns existed, and `worker`
   * alone is absent on a worker with neither UNFENCED_WORKER set nor a router
   * in front of it. Absent means UNKNOWN and must be rendered that way.
   */
  worker?: string;
  workerOs?: string;
}

/**
 * One thing that happened, in order - the unit the trace is made of.
 *
 * The trace used to be `string[]`, one pre-formatted sentence per step, so a
 * client could print it and nothing else: which step failed, what it was aimed
 * at, and when it happened had all been flattened away before storage.
 *
 * A step never carries a secret. `chars` is why: a typed value is reported as a
 * LENGTH, so `type 11 chars into "Search"` reaches a client and the eleven
 * characters do not. There is no field that can hold a credential, a one-time
 * code, or field content, and that is the design rather than an omission.
 */
export interface SessionStep {
  /** Milliseconds since the session started - replay time, not wall clock. */
  at: number;
  /** `open`, `click`, `type`, `navigate`, `observe`, `fill_secret`, `note`, `tool`, … */
  kind: string;
  /** The one line a person reads: `click "Sign in"`. */
  text: string;
  /** Did it do what it was asked? Absent for steps that are not attempts. */
  ok?: boolean;
  /** Why not - a refusal reason, a wall hit, an error. */
  detail?: string;
  /** Privacy-safe proof of the effect observed after an action. */
  evidence?: ActEvidence[];
  /** Whether a post-condition held, and how long it was waited. */
  expected?: { held: boolean; waitedMs: number };
  /** A measured no-change observation, not a failure verdict. */
  effect?: { changed: false; waitedMs: number; note: string };
  /** Present only when the settle ceiling was reached. */
  settled?: false;
  /** The settle wait paired with `settled: false`. */
  settleMs?: number;
  /** Where the page ended up after this step. */
  url?: string;
  /** How many characters were typed. The characters themselves never appear. */
  chars?: number;
  /**
   * WHY this step ended as it did, as a value a query can group by.
   *
   * `detail` is the sentence written for the agent and is free to be reworded;
   * this is the same answer as a literal from the engine's closed `ACT_CODES`
   * set. Typed as a string rather than that union because this package takes no
   * dependency on the engine.
   */
  code?: string;
  /** How far into the run this step happened: 1-based, monotonic, and counted
   *  even after the trace stopped recording at its ceiling. */
  act?: number;
  /**
   * Index into `SessionDetail.frames` of the moment this step is visible, resolved
   * server-side after the strip was thinned, so it can be used as-is. ABSENT is
   * normal, not an error: a credential fill stops the camera on purpose, an
   * observe takes no picture, and a hand-driven run keeps no film at all.
   */
  frame?: number;
}

export interface SessionDetail extends SessionSummary {
  answer: string;
  /**
   * The log, structured. This is the field to read.
   *
   * It was declared as `trace` here and the wire has never sent structured
   * steps under that name: the server sends `steps: SessionStep[]` and keeps
   * `trace: string[]` beside it, deliberately and permanently, so a reader
   * older than `steps` degrades rather than crashes. A typed caller doing
   * `detail.trace[0].kind` therefore read `undefined` off a string, and nothing
   * said so - the mirror had simply been written against the wrong field.
   */
  steps: SessionStep[];
  /** The same log as plain lines, for readers older than `steps`. */
  trace: string[];
  frames: string[];
}

/**
 * One durable note an agent has stored for itself.
 *
 * The task-memory scratchpad, scoped to (account, agent) on the server: a short
 * `key` to find it by, a small `value` that is the note, and when it was last
 * written. Survives across sessions - it is the agent's memory of its own WORK,
 * distinct from the browser profile's memory of the WEB.
 */
export interface MemoryEntry {
  key: string;
  value: string;
  updatedAt: string;
}

/** Bounded recall filters, useful when an agent keeps namespaced task notes. */
export interface MemoryRecallOptions {
  /** Return only keys beginning with this prefix. */
  prefix?: string;
  /** Return at most this many newest notes (1..64). */
  limit?: number;
}

/**
 * One stored credential, as the client ever sees it: a NAME and a time.
 *
 * There is deliberately no `value`. A secret goes IN through `storeCredential`
 * and is never handed back - no client method returns a stored secret value.
 * The agent uses one only by name, via a `fill_secret` action.
 */
export interface CredentialName {
  /** Pass this selector to open_page/account when reusing a linked workspace login. */
  browserAccount?: string;
  name: string;
  /** The account identifier (email/username) this login is for, or null for a
   *  bare token. Shown back so a login is recognizable; the SECRET never is. */
  username: string | null;
  /** "password" (typed verbatim by fill_secret), "totp" (an authenticator seed the
   *  engine turns into the current 2FA code via fill_totp), or "oauth" (a per-site
   *  marker: this site signs in with `provider` - no fillable secret of its own). */
  kind: "password" | "totp" | "oauth";
  /** Whether a `kind:"password"` login ALSO carries a 2FA seed (fill it with
   *  fill_totp under this same name). A standalone `kind:"totp"` reports false. */
  hasTotp: boolean;
  /** The site (host) this login is for, or null if tied to no site. Lets an agent
   *  match a stored credential to the page it is on, rather than guess by name. */
  site: string | null;
  /** The sign-in provider (google/apple/microsoft/github), or null for a direct
   *  login. On a sign-in account it names the account's provider; on an oauth
   *  marker it names which provider the site signs in with. */
  provider: string | null;
  updatedAt: string;
}

/**
 * How the agent should choose among a person's several sign-in accounts.
 *   - askMode "always": ask which account every time a site's provider is ambiguous.
 *   - askMode "remember": ask once per site, then reuse that choice silently.
 * `sites` maps host → its CURATED accounts (the allow-list of account names the
 * agent may use there) and the `main` default among them ("" = ask every time).
 */
export interface SitePref {
  accounts: string[];
  main: string;
  /**
   * The DOWNSTREAM identity each curated account resolves to on this site (account
   * name → e.g. "person@example.com"), learned as the agent signs in with each. Lets a
   * caller flag two accounts that resolve to the SAME underlying account, or one not
   * linked yet. A plaintext identifier, never a secret.
   */
  identities?: Record<string, string>;
  /** The profile photo URL each curated account resolves to here (account name → an
   *  https avatar URL), so an account can wear its own face. A public URL, not a secret. */
  avatars?: Record<string, string>;
}
export interface AccountPrefs {
  askMode: "always" | "remember";
  sites: Record<string, SitePref>;
  /** sign-in account name → its profile photo URL, captured at sign-in. */
  accountAvatars?: Record<string, string>;
}

/**
 * What GET /permissions answers with. Three arms, and on the unavailable one
 * the arrays are ABSENT rather than empty - so no caller can count them as
 * zero and conclude the owner granted nothing.
 */
export interface PermissionsAnswer {
  allowed?: string[];
  entries?: Array<{ host: string; mode: "free" | "approve" | "read" }>;
  /** Explicit per-agent denies. These override every positive scope mode. */
  excludedSites?: string[];
  /** Rolling-deploy capability: explicit denies are enforced before every agent scope. */
  agentExclusionsAllScopes?: boolean;
  /** Served from the last good read; the store could not be refreshed. */
  stale?: boolean;
  /** The allowlist could not be read at all. The arrays are absent. */
  unavailable?: boolean;
  detail?: string;
}

/**
 * The wire, declared once.
 *
 * Every client of the unfenced server needs the same handful of shapes - the
 * cleaned document, the fetch metadata, the outcome envelope - and until this
 * file existed each one declared its own. Three copies of `ExtractedDoc` were in
 * the tree at the same time: `packages/extract/src/types.ts` (the producer, 21
 * fields), this package (8 fields plus `[key: string]: unknown`), and
 * `packages/ui/src/api.ts` (15 fields, hand-typed). They disagreed, and the
 * disagreement was invisible: an index signature makes `doc.markdwn` compile and
 * return `undefined`, and a field the dashboard never declared is a field no
 * dashboard view can render.
 *
 * @unfenced-ai/sdk is the right home for it. It has no runtime dependencies and is
 * meant to keep none, so a browser bundle can carry it; every other client
 * already depends on it; and it is one of the two packages that actually
 * publish, so its types are the ones a stranger receives.
 *
 * WHY THIS FILE IS SEPARATE FROM `index.ts`: this module is pure declaration -
 * no imports, no client, no `fetch`. `packages/ui` may therefore
 * `import type` from it and get the types with nothing to erase, honouring the
 * boundary in docs/ARCHITECTURE.md that the dashboard owns no `@unfenced/*`
 * runtime import. Importing `index.ts` would put the `Unfenced` class in the
 * dashboard's module graph for a type it does not need.
 *
 * THIS IS STILL A MIRROR, and mirrors drift - that is the whole reason this file
 * exists. So it is BOUND rather than trusted: `test/wire-contract.test.ts` reads
 * the producer's own declarations off disk and fails when a field is renamed,
 * dropped or added on either side. See that file for why the binding runs
 * against the source rather than against a live server.
 */

/** Which payload the server renders as `content`. */
export type OutputFormat = "markdown" | "json" | "text" | "html";

/** 1 = plain HTTP, 2 = stealth headless browser, 3 = headed browser. */
export type Tier = 1 | 2 | 3;

export interface ContentOmission {
  kind:
    | "hidden-text"
    | "listing-prose"
    | "pruned"
    | "pdf-page-cap"
    | "settle-timeout"
    | "byte-cap"
    | "word-cap"
    | "character-cap"
    | "navigation-incomplete";
  amount?: number;
  unit?: "words" | "pages" | "bytes" | "characters";
}

export interface LinkRef {
  /** Absolute when the page had a base URL to resolve against, else the raw href. */
  url: string;
  /** Anchor text, whitespace-collapsed. */
  text: string;
}

export interface ImageRef {
  src: string;
  alt: string;
  title?: string;
}

export type StructuredDataKind = "ld+json" | "next-data" | "initial-state" | "embedded-json";

export interface StructuredDatum {
  kind: StructuredDataKind;
  /** Where it came from, e.g. `script#__NEXT_DATA__` or `window.__INITIAL_STATE__`. */
  source: string;
  data: unknown;
}

/** What kind of other address the page declared for itself. */
export type AlternateKind =
  "markdown" | "amp" | "feed" | "canonical" | "print" | "language" | "other";

export interface Alternate {
  kind: AlternateKind;
  /** Absolute, resolved against the document's base. */
  url: string;
  /** The MIME type the document declared, verbatim, or null. */
  type: string | null;
  title: string | null;
  /** Present on language alternates: "de", "en-GB", "x-default". */
  hreflang: string | null;
}

/** How the main content was isolated. Useful for judging a bad extraction. */
export type ExtractionMethod =
  | "readability"
  | "heuristic"
  | "whole-body"
  | "listing"
  | "thread"
  | "plain-text"
  /** A PDF's own text layer. Never OCR: a scan has no text layer to read. */
  | "pdf";

export type PageType = "article" | "listing" | "thread" | "data" | "feed";

/**
 * How much to trust that what came back is what the URL is about.
 *
 * `low` does not mean the content is useless - it means check before relying on
 * it. The canonical case is a login wall: the extractor cleanly pulls the
 * suggestions sidebar and reports a tidy result about the wrong thing.
 */
export interface ContentConfidence {
  level: "high" | "low";
  /** Plain-language reasons, safe to show an agent or a human. */
  reasons: string[];
}

/**
 * The cleaned document a fetch returns - the whole of it.
 *
 * Produced by `packages/extract/src/index.ts#extractDoc` and passed to the
 * client untouched: core caps `markdown` and `text` when `maxWords` bites
 * (`packages/core/src/fetch.ts#capRendered`) and the job route sends the result
 * verbatim (`packages/server/src/routes/jobs.ts`, `result: job.result`).
 * Nothing in between adds or removes a field, which is what lets the contract
 * test bind this declaration to the producer's.
 *
 * There is deliberately NO index signature. The previous one made every typo a
 * silent `undefined` on the primary return value of the client library, and it
 * let thirteen real fields go undeclared for as long as nobody noticed.
 */
export interface ExtractedDoc {
  /** The URL the document was extracted for, or null when none was supplied. */
  url: string | null;
  title: string;
  description: string | null;
  author: string | null;
  /** ISO 8601, normalised from whichever of three sources answered. */
  publishedAt: string | null;
  siteName: string | null;
  lang: string | null;
  dir: "ltr" | "rtl" | null;

  /** Main content as markdown. Always populated. */
  markdown: string;
  /** Main content as plain text. Always populated. */
  text: string;
  /** Cleaned main-content HTML (not the full page). */
  contentHtml: string;

  links: LinkRef[];
  images: ImageRef[];
  structuredData: StructuredDatum[];
  /**
   * Other addresses this page says it has: a markdown twin, an AMP document, a
   * feed, a canonical, a translation. Each is the SITE declaring an
   * equivalence, so following one is a lookup rather than a guess.
   */
  alternates: Alternate[];

  extractionMethod: ExtractionMethod;
  pageType: PageType;
  /** Counted on the extracted text in the page's own script, not on the render. */
  wordCount: number;
  /** Content supplied by the page but not included in the delivered answer. */
  omissions?: ContentOmission[];
  /** Whether the extraction looks like the page's real content. */
  confidence?: ContentConfidence;
  /**
   * The markdown converter threw and this document fell back to raw DOM text:
   * no headings, no links, no tables - the prose, in reading order, and
   * nothing else.
   *
   * On the document rather than only inside the confidence it produced,
   * because the confidence is RE-ASSESSED downstream once a browser tier is
   * known. Declared here because a field the SDK does not declare arrives at a
   * typed caller as nothing: the reason a page came back without its structure
   * would reach the extractor's own return and no customer.
   */
  converterFailed?: boolean;
  /** Populated for listing pages so the caller can see what was detected. */
  listing?: {
    itemCount: number;
    /** Other qualifying result sets on the page that were not rendered. */
    otherSetsFound: number;
  };
  /** Populated for threaded discussion, so a flat render is explainable. */
  thread?: {
    itemCount: number;
    maxDepth: number;
    /** How reply depth was established: DOM nesting, an attribute, or neither. */
    depthSource: "nesting" | "attribute" | "flat";
  };
}

export interface TokenEstimate {
  /** Tokens the agent would have burned on the raw HTML. */
  rawHtml: number;
  /** Tokens in the emitted content for the requested format. */
  output: number;
  /** Percentage saved, 0-100, rounded to one decimal. */
  savedPct: number;
}

export interface EscalationRecord {
  from: Tier;
  to: Tier;
  reason: string;
}

/**
 * What the fetch consumed. Present on every arm including the failures: a fetch
 * that ended in a 403 still ran a browser and still moved bytes.
 */
export interface Meter {
  /** Response bytes read. Exact at tier 1; see `basis` for the browser tiers. */
  bytesIn: number;
  /** Wall-clock in plain HTTP. */
  httpMs: number;
  /** Wall-clock with a browser up. The expensive second. */
  browserMs: number;
  /** True when any byte went through a paid egress. */
  proxied: boolean;
  /**
   * How much of `bytesIn` was actually observed. `partial` means the total is a
   * floor, not a figure - do not compare it to an invoice as if it were one.
   */
  basis: "measured" | "partial" | "none";
  /** How many responses could not report a size. Zero when `basis` is measured. */
  unsizedResponses: number;
}

/** What that consumption is worth, priced from the meter. */
export interface Cost {
  /** Authoritative. */
  micros: number;
  /** ceil(micros / 10_000). Display only - never compared, never summed. */
  cents: number;
  currency: "USD";
  /** A price computed from a floor is a floor, and says so here. */
  basis: "measured" | "partial" | "estimated";
  rateCardVersion: string;
  breakdown: { egressMicros: number; browserMicros: number; httpMicros: number };
}

/**
 * The metadata on a DELIVERED fetch.
 *
 * No index signature, for the same reason `ExtractedDoc` has none: with one,
 * `meta.tokenEstimte` compiled and fourteen real fields stayed undeclared - so
 * every caller that wanted the token saving or the cache flag had to cast.
 */
export interface FetchMeta {
  meter: Meter;
  cost: Cost;
  tier: Tier;
  renderedJs: boolean;
  /**
   * robots.txt forbade this path and we fetched it anyway - only ever set in
   * `report` mode. On the SUCCESS shape deliberately: a log that records only
   * refusals cannot answer "did you know?".
   */
  robotsDisallowed?: boolean;
  /** The rule that decided it, so the record can be checked rather than trusted. */
  robotsRule?: string;
  finalUrl: string;
  fetchedAt: string;
  status: number | null;
  durationMs: number;
  /** ms spent per stage, e.g. `{ tier1: 380, tier2: 4120, extracting: 46 }`. */
  timings: Record<string, number>;
  tokenEstimate: TokenEstimate;
  extractionMethod: string;
  escalations: EscalationRecord[];
  /** Which tier the domain cache suggested we start at. */
  startedAtTier: Tier;
  /** The locale this fetch actually presented, so a caller need not assume. */
  locale?: string;
  /** True when `maxWords` cut the content. `doc.wordCount` is the full count. */
  contentTruncated?: boolean;
  omissions?: ContentOmission[];
  /** How many words the body held before the cap bit. */
  totalWords?: number;
  /** True when this answer came from a recent identical fetch, not the network. */
  cached?: boolean;
}

/**
 * The metadata on a FAILED fetch, which is not `Partial<FetchMeta>`.
 *
 * It carries two fields a success never does - `retryAfterMs` and `retryAfter`,
 * the answer to "when may I try again" - and it omits the ones that only exist
 * once a document was produced. Typing it as a partial success said the
 * schedulable fields did not exist, which is why the MCP layer reads them
 * through `meta?.["retryAfter"]` instead of by name.
 *
 * A type alias rather than an interface, deliberately: an interface has no
 * implicit index signature, so it is not assignable to `Record<string, unknown>`
 * - and `packages/mcp/src/tools.ts#failurePayload` takes exactly that.
 */
export type FetchFailureMeta = {
  meter?: Meter;
  cost?: Cost;
  durationMs: number;
  timings?: Record<string, number>;
  escalations: EscalationRecord[];
  startedAtTier: Tier;
  finalUrl?: string;
  /** How long until we will contact the site again, as a duration. */
  retryAfterMs?: number;
  /**
   * …and as an ISO instant. Both forms, because a duration is measured from a
   * moment the caller cannot see and so cannot be scheduled against.
   */
  retryAfter?: string;
  robotsDisallowed?: boolean;
  robotsRule?: string;
};

/**
 * Every field name on `ExtractedDoc`, as data.
 *
 * The contract test needs the declared field set at RUNTIME to diff it against
 * the producer's source, and a TypeScript interface leaves nothing behind to
 * read. `satisfies` stops the list naming a field that does not exist; the
 * `_DocFieldsAreComplete` alias below stops it omitting one. Between them the
 * list cannot drift from the interface it describes without failing `tsc`.
 */
export const WIRE_DOC_FIELDS = [
  "url",
  "title",
  "description",
  "author",
  "publishedAt",
  "siteName",
  "lang",
  "dir",
  "markdown",
  "text",
  "contentHtml",
  "links",
  "images",
  "structuredData",
  "alternates",
  "extractionMethod",
  "pageType",
  "wordCount",
  "omissions",
  "confidence",
  "converterFailed",
  "listing",
  "thread",
] as const satisfies readonly (keyof ExtractedDoc)[];

/** The same, for the delivered-fetch metadata. */
export const WIRE_META_FIELDS = [
  "meter",
  "cost",
  "tier",
  "renderedJs",
  "robotsDisallowed",
  "robotsRule",
  "finalUrl",
  "fetchedAt",
  "status",
  "durationMs",
  "timings",
  "tokenEstimate",
  "extractionMethod",
  "escalations",
  "startedAtTier",
  "locale",
  "contentTruncated",
  "omissions",
  "totalWords",
  "cached",
] as const satisfies readonly (keyof FetchMeta)[];

/** `Assert<false>` is a type error, which is the point. */
type Assert<T extends true> = T;

/**
 * Fails to compile if a field is added to the interface and not to the list.
 * Unused at runtime on purpose - the check IS the declaration.
 */
type _DocFieldsAreComplete = Assert<
  [Exclude<keyof ExtractedDoc, (typeof WIRE_DOC_FIELDS)[number]>] extends [never] ? true : false
>;
type _MetaFieldsAreComplete = Assert<
  [Exclude<keyof FetchMeta, (typeof WIRE_META_FIELDS)[number]>] extends [never] ? true : false
>;

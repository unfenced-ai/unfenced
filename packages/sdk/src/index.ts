/**
 * The unfenced SDK - a typed client for the unfenced server.
 *
 * unfenced fetches any page as clean, agent-ready content and drives a real
 * browser (observe, click, type, extract) from the machine the server runs on,
 * using that machine's IP and logged-in cookies. This client is how code talks
 * to it: point it at a running server, and you get fetch, live sessions, and
 * the recorded-session library, all typed. Zero dependencies - it uses the
 * platform `fetch`.
 *
 * Node 22.12 or newer. This comment shipped inside the published `.d.ts` saying
 * "Node 20+ and in the browser alike", which is what a customer's editor showed
 * on hover, and both halves were false: the manifest has never been tested
 * below 22, and `exports` now declares a `require` condition that Node loads
 * through require(esm) only from 22.12. The browser half is contradicted by the
 * README two paragraphs down - every request carries an `x-unfenced-client`
 * header, which is not CORS-safelisted, so a cross-origin call preflights and
 * the worker does not answer it.
 *
 *   const ac = new Unfenced({ baseUrl: "http://127.0.0.1:8787", apiKey });
 *   const page = await ac.fetch("https://example.com");        // clean markdown
 *   const s = await ac.open("https://news.ycombinator.com");   // a live browser
 *   const snap = await s.observe();                            // what's on it
 *   await s.click(snap.controls[0].ref);                       // do things
 *   await s.close();
 *
 * This file is the package entry and now a thin barrel: the client class lives
 * in `./client.ts`, the `Session` handle in `./session.ts`, the domain and wire
 * types in `./types.ts` and `./protocol.ts`, and the request bodies in the
 * per-concern modules those two classes call (`fetch`, `sessions`, `library`,
 * `permissions`, `memory`, `credentials`, over a shared `http` transport). Every
 * name below was exported from here before the split and is re-exported from
 * here unchanged - no consumer import needs to move.
 */

/**
 * The wire shapes live in `./protocol.js` and are re-exported here.
 *
 * They were declared inline until three copies of `ExtractedDoc` had drifted
 * apart across this package, `@unfenced/extract` and the dashboard. `protocol`
 * imports nothing and holds no runtime code beyond two field lists, so a client
 * that only wants the types - the dashboard, which may not take a runtime
 * dependency on any `@unfenced/*` package - can `import type` from it without
 * pulling this class in behind it.
 */
export type {
  Alternate,
  AlternateKind,
  ContentConfidence,
  Cost,
  EscalationRecord,
  ExtractedDoc,
  ExtractionMethod,
  FetchFailureMeta,
  FetchMeta,
  ImageRef,
  LinkRef,
  Meter,
  OutputFormat,
  PageType,
  StructuredDataKind,
  StructuredDatum,
  Tier,
  TokenEstimate,
} from "./protocol.js";
export { WIRE_DOC_FIELDS, WIRE_META_FIELDS } from "./protocol.js";

export type {
  AccountPrefs,
  ActCode,
  ActEvidence,
  ActEvidenceKind,
  ActExpectation,
  Action,
  ActResult,
  AtAction,
  CredentialName,
  DownloadInfo,
  Fault,
  FetchOptions,
  FetchResult,
  Format,
  FormField,
  FormFillResult,
  InterruptKind,
  MediaItem,
  MemoryEntry,
  MemoryRecallOptions,
  Offer,
  OnAction,
  PageChanges,
  PageSnapshot,
  PendingApproval,
  PermissionsAnswer,
  ProviderSessionReason,
  ReadPage,
  SeenPage,
  SessionDetail,
  SessionInfo,
  SessionStep,
  SessionSummary,
  ConnectionSnapshot,
  SitePref,
  SnapshotElement,
  Spot,
  UnfencedOptions,
} from "./types.js";

export { UnfencedError } from "./http.js";
export { Unfenced } from "./client.js";
export { urlIdentity } from "./url-identity.js";
export { toolTokenUsage, type TokenUsage } from "./token-usage.js";
export { Session, type SessionActOptions } from "./session.js";

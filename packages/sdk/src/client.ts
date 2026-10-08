/**
 * The `Unfenced` client class - the package's public entry point.
 *
 * Every method's signature and doc comment is exactly what it was in the former
 * single-file `index.ts`; only the bodies changed, from inline logic to a one
 * line call into the domain module that now holds it (`fetching`, `live`,
 * `library`, `perms`, `memory`, `vault`). The four transport fields and the
 * private `request`/`awaitJob` helpers moved into `Transport` and `fetch.ts`, so
 * the one private field left is `http`. The public surface is unchanged.
 */
import { Transport } from "./http.js";
import type { TokenUsage } from "./token-usage.js";
import type { Session } from "./session.js";
import * as fetching from "./fetch.js";
import * as live from "./sessions.js";
import * as library from "./library.js";
import * as perms from "./permissions.js";
import * as memory from "./memory.js";
import * as vault from "./credentials.js";
import type { ExtractedDoc } from "./protocol.js";
import type {
  AccountPrefs,
  Action,
  ActResult,
  ActExpectation,
  AtAction,
  CredentialName,
  DownloadInfo,
  FetchOptions,
  FetchResult,
  Format,
  FormField,
  FormFillResult,
  MemoryEntry,
  MemoryRecallOptions,
  OnAction,
  PageSnapshot,
  PendingApproval,
  ProviderSessionReason,
  ReadPage,
  SeenPage,
  SessionDetail,
  SessionInfo,
  SessionSummary,
  UnfencedOptions,
} from "./types.js";

export class Unfenced {
  /** The transport. Holds the base URL, the token, the fetch, and the extra
   *  headers - the four things every method's request needs - so the methods
   *  themselves carry none of it. */
  private readonly http: Transport;

  constructor(options: UnfencedOptions = {}) {
    this.http = new Transport(options);
  }

  /** Report counts only. Never sends tool arguments, page text, or image data. */
  async recordTokenUsage(usage: TokenUsage): Promise<void> {
    await this.http.request("POST", "/usage/tokens", usage, 1500);
  }

  // ---- fetch -------------------------------------------------------------

  /**
   * Fetch a URL as clean content. Escalates from plain HTTP to a stealth
   * browser to a headed browser only as far as the site forces, and resolves
   * when the job is done.
   */
  fetch(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    return fetching.fetch(this.http, url, options);
  }

  /**
   * Fetch many URLs concurrently (each escalates independently).
   *
   * One entry per URL, in input order, with a failed URL carrying its structured
   * error in place. A single bad URL must never cost the caller the whole batch -
   * an agent batching 20 URLs would otherwise lose all 20 and have to bisect to
   * find the offender.
   */
  batch(urls: string[], options: FetchOptions = {}): Promise<FetchResult[]> {
    return fetching.batch(this.http, urls, options);
  }

  /**
   * The same, but it always answers.
   *
   * `batch` resolves when every URL has, so one slow host decides when the
   * whole call returns. An external QA run watched a ten-URL batch blow its
   * client's sixty-second transport timeout - which returns NOTHING: every
   * sibling that had already succeeded was discarded with it, and the caller
   * got an opaque transport error naming no URL, so it could not even retry
   * intelligently.
   *
   * The per-URL error isolation this tool promises only ever covered fast
   * failures. This covers slow ones. Each URL races one shared deadline;
   * whatever has not arrived becomes a `timeout` entry, in input order.
   *
   * A partial answer is worth far more to an agent than none - it can use what
   * came back and retry exactly what did not.
   */
  batchWithin(
    urls: string[],
    deadlineMs: number,
    options: FetchOptions = {},
  ): Promise<FetchResult[]> {
    return fetching.batchWithin(this.http, urls, deadlineMs, options);
  }

  // ---- live sessions -----------------------------------------------------

  /**
   * Open a live browser session on a URL and get a handle to drive it.
   *
   * `account` names a sign-in account to act as (e.g. a specific one of several
   * Google logins). It selects that account's isolated, stored session - so the
   * page opens already signed in as that account and cookie changes persist back
   * to it. Absent means the default session.
   *
   * A SIGN-IN ACCOUNT's name ("google", "google-2") - not a site or host, and
   * not the name of a per-site login ("namecheap.com"), which is a password used
   * INSIDE an account rather than an account. A credential's `site` says where a
   * login is used, not what it is called, and the two sit next to each other in
   * every listing; passing either opened a Chrome profile and a stored session
   * that nothing else ever read, so the login was asked for again and never
   * reached the next machine. The server now answers `unknown-account` (400)
   * rather than quietly creating that drawer - unless the name already HAS a
   * stored session, which is a drawer it opens rather than mints. A roster it
   * could not read answers `accounts-unreadable` (503): retry, or omit `account`.
   */
  open(
    url: string,
    options: {
      headless?: boolean;
      profile?: "ephemeral" | "agent";
      proxy?: string;
      account?: string;
      /**
       * What you mean to do with the page. `"act"` states that it will be
       * clicked, typed into or submitted.
       *
       * It matters because a live browser costs a measured ~819 MB and one of the
       * account's session slots, held until it idles out. A page that domain
       * memory already knows a plain fetch answers, with no stored login for it,
       * is refused with `use-fetch` rather than spending that on bytes
       * `fetch()` returns. Passing `"act"` opens it.
       */
      intent?: "read" | "act";
      /**
       * How long to let the network go quiet after the page commits, before the
       * opening snapshot is taken. Default 4000ms, maximum 15000.
       *
       * A different clock from the navigation's own timeout: a page that
       * exceeds THIS one is read as it stands rather than refused, so raising
       * it buys a more complete first reading of a page that draws from several
       * slow fetches, and never turns a slow page into an error.
       */
      settleMs?: number;
    } = {},
  ): Promise<
    Session & {
      providerSession?: ProviderSessionReason;
      /** True when this is a page you already had open on the host, not a new one. */
      reusedExistingSession?: boolean;
      /** True when that reused page was navigated to the URL you asked for. */
      navigated?: boolean;
      /**
       * Something about THIS open worth saying, when there is anything.
       *
       * Two producers, one field: a reused page that was navigated, and an open
       * whose settle budget ran out with the network still busy - meaning the
       * snapshot beside it may not be the finished page. Both answer "what would
       * you otherwise have to guess about this reading", which is why they share
       * a name rather than each having one.
       */
      note?: string;
    }
  > {
    return live.open(this, this.http, url, options);
  }

  /**
   * Switch an open session to a DIFFERENT sign-in account - "check my other
   * account". An account is bound to a page's isolated profile at open, so this
   * is not a live swap: the current account's jar is saved, its page closed, and
   * the same SITE reopened signed in as `account`. Returns a NEW Session (a new
   * id) - use it going forward; the old one is closed. A one-off that never
   * changes the site's configured default.
   *
   * `account` is a sign-in account's NAME, never a site or host - an unknown one
   * is refused with `unknown-account` (400) BEFORE the open page is torn down, so
   * a bad name costs nothing and leaves the current session usable.
   */
  switchAccount(
    sessionId: string,
    account: string,
  ): Promise<{
    session: Session;
    restoredSession: boolean;
    requestedAccount?: string;
    observedIdentity?: string;
  }> {
    return live.switchAccount(this, this.http, sessionId, account);
  }

  /**
   * Which account the page is actually signed in as - the DOWNSTREAM identity (e.g.
   * which ChatGPT account), not the provider login that reached it. A non-disruptive
   * same-origin read, so it can confirm identity mid-task. `identity` is null when the
   * site is not one the server knows how to read (then observe the account menu).
   */
  /**
   * What the account owner has to clear before the agent can continue.
   *
   * Read-only, and it must stay that way: a wall is cleared by a
   * human-authenticated action, never by the caller that is blocked on it. An
   * agent asking this is asking "what do you need from me" on the user's behalf,
   * which is worth having as a question because most people do not live in the
   * dashboard and would otherwise never learn a sign-in was waiting.
   *
   * `clearAt` is where the person goes. Hand that over rather than describing a
   * screen.
   */
  pendingApprovals(): Promise<{ interrupts: PendingApproval[]; clearAt: string }> {
    return live.pendingApprovals(this.http);
  }

  whoami(sessionId: string): Promise<{ identity: string | null; source: string | null }> {
    return live.whoami(this.http, sessionId);
  }

  /** Every live session currently open on the server. */
  liveSessions(): Promise<SessionInfo[]> {
    return live.liveSessions(this.http);
  }

  // Internal - used by Session.
  observe(
    id: string,
    opts?: {
      match?: string;
      maxControls?: number;
      maxLinks?: number;
      excerptChars?: number;
      media?: boolean;
    },
  ): Promise<PageSnapshot> {
    return live.observe(this.http, id, opts);
  }

  /** Read the current page together with its provider-session continuity state. */
  refresh(
    id: string,
    opts?: { match?: string },
  ): Promise<{ page: PageSnapshot; providerSession?: ProviderSessionReason }> {
    return live.refresh(this.http, id, opts);
  }

  /**
   * Read a page, and receive a picture with it when the reading cannot describe
   * the page on its own.
   *
   * `observe` above returns the snapshot alone and keeps doing so, because that
   * is what its callers expect. This one hands back the whole envelope - the
   * server attaches `picture` and `marks` when the reading reports `look`, and a
   * projection that quietly dropped them would put the agent back where it
   * started: told that something is missing and made to spend a turn asking for
   * it.
   */
  read(
    id: string,
    opts?: {
      match?: string;
      maxControls?: number;
      maxLinks?: number;
      excerptChars?: number;
      media?: boolean;
    },
  ): Promise<ReadPage> {
    return live.read(this.http, id, opts);
  }
  /**
   * `opts` are OPTIONS on the call, not fields of the action - a native dialog is
   * raised by the page mid-act and is not part of what was asked of it.
   */
  act(
    id: string,
    action: Action | OnAction | AtAction,
    opts?: {
      acceptDialog?: boolean;
      dialogText?: string;
      brief?: boolean;
      /**
       * Return a marked picture of the page this act landed on, in the same
       * reply, as `view`. `brief`'s opposite, and the same kind of option: it
       * changes the shape of the ANSWER, not what the page is asked to do.
       */
      see?: boolean;
      /**
       * What the act is supposed to ACHIEVE, checked after it runs. The reply
       * carries `expected: {held, waitedMs}`. This type declared that reply
       * field long before anything could ask for it.
       */
      expect?: ActExpectation;
    },
  ): Promise<ActResult> {
    return live.act(this.http, id, action, opts);
  }
  extract(id: string, format: Format = "markdown", maxWords?: number) {
    return live.extract(this.http, id, format, maxWords);
  }
  screenshot(id: string): Promise<string> {
    return live.screenshot(this.http, id);
  }

  /**
   * A picture of the page with everything actable outlined and numbered.
   *
   * Separate from `screenshot` rather than an option on it, because the two have
   * different callers and different costs: `screenshot` feeds a replay stream
   * many times a turn and must stay a bare frame, while this one pays for a
   * snapshot in order to guarantee the boxes and the list describe one instant.
   */
  see(
    id: string,
    opts: {
      /** Box the links too, numbered after the controls. Off by default: a page
       *  with two hundred of them is papered over. */
      links?: boolean;
      /** Raise the 50-box cap, up to 120. Anything else falls back to 50. */
      maxMarks?: number;
    } = {},
  ): Promise<SeenPage> {
    return live.see(this.http, id, opts);
  }

  /**
   * Fill several fields in one call.
   *
   * The saving is model round trips, not network ones. Text only and never
   * submits - a password goes through `act` as a fill_secret, which is the one
   * path allowed to resolve a stored value.
   */
  fill(id: string, fields: readonly FormField[]): Promise<FormFillResult> {
    return live.fill(this.http, id, fields);
  }
  /**
   * Hold a page open while something happens elsewhere.
   *
   * For the wait a login actually involves: a code sent to email, an approval
   * in an app. Capped by the server, and a parked page still holds a real tab,
   * so only a few may be parked at once.
   */
  park(id: string, minutes?: number, reason?: string): Promise<{ ok: boolean; until?: string }> {
    return live.park(this.http, id, minutes, reason);
  }
  /** Files this session's page has handed to the browser. Names and sizes. */
  downloads(id: string): Promise<{ downloads: DownloadInfo[] }> {
    return live.downloads(this.http, id);
  }
  /**
   * Read one of them as text.
   *
   * A PDF goes through the same reader a fetched PDF does, so downloading a
   * statement and reading it is one capability rather than two halves of one.
   */
  readDownload(
    id: string,
    filename: string,
  ): Promise<{ filename: string; bytes: number; content: string; doc: ExtractedDoc }> {
    return live.readDownload(this.http, id, filename);
  }
  /**
   * Release a live page. Idempotent: closing one that has already closed - or
   * idled out - succeeds and says so, because that is the state you asked for.
   */
  /**
   * Release a page. Idempotent: closing one that is already gone is the state
   * the caller asked for, so it succeeds rather than erroring - an agent
   * closing in a `finally` must not be punished for a slow task.
   *
   * `wasOpen` says whether anything was actually released. It is false for an
   * id that is not open FOR YOU, which covers a mistyped id, one that idled
   * out, and one that was closed earlier - deliberately not told apart, since
   * three different answers would let an 8-character id be probed for
   * existence across accounts.
   */
  closeSession(id: string): Promise<{ alreadyClosed?: boolean; wasOpen?: boolean }> {
    return live.closeSession(this.http, id);
  }

  // ---- library & memory --------------------------------------------------

  /** Recorded runs (demo / agent / live-channel), newest first. */
  sessions(query: { kind?: string; q?: string; limit?: number } = {}): Promise<SessionSummary[]> {
    return library.sessions(this.http, query);
  }
  /** A recorded session with its replay frames, tool trace, and answer. */
  recordedSession(id: string): Promise<SessionDetail> {
    return library.recordedSession(this.http, id);
  }
  history(limit = 50): Promise<unknown[]> {
    return library.history(this.http, limit);
  }
  domains(): Promise<unknown[]> {
    return library.domains(this.http);
  }

  // ---- act-allowlist -----------------------------------------------------

  /** Sites the agent may act on WITHOUT asking (the free bucket only). */
  permissions(): Promise<string[]> {
    return perms.permissions(this.http);
  }
  /**
   * Every saved site with its mode. This - not permissions() - is what "may I act
   * here?" must read: BOTH `free` and `approve` permit acting (approve just asks
   * the human per action); only `read` does not. permissions() returns free-only,
   * so a site granted "Ask each time" is invisible to it - which made agents give
   * up on approve-granted sites they were in fact allowed to act on.
   */
  /**
   * The act-allowlist AND whether this key is exempt from it.
   *
   * `permissionEntries` returns the granted hosts and nothing else, which reads
   * as "these and no others" - wrong for a key carrying any-site, whose list is
   * usually empty precisely because it needs no grants. Callers that decide
   * whether to ATTEMPT something must use this one; the older method stays for
   * callers that only want to display the grants.
   */
  permissionScope(): Promise<{
    entries: Array<{ host: string; mode: "free" | "approve" | "read" }>;
    anySite: boolean;
    excludedSites: string[];
    allowSiteRequests?: boolean;
  }> {
    return perms.permissionScope(this.http);
  }
  permissionEntries(): Promise<Array<{ host: string; mode: "free" | "approve" | "read" }>> {
    return perms.permissionEntries(this.http);
  }
  /**
   * A deep link that opens the dashboard set up to unblock a site - the Add-login
   * drawer for a missing login (mode "credential", the default), or the Sites
   * grant for a missing permission (mode "permission"). Hand this to a person so
   * they fix it in one screen; it carries only the host, never a secret.
   */
  connectLink(
    host: string,
    opts: { label?: string; mode?: "credential" | "permission" } = {},
  ): Promise<string> {
    return perms.connectLink(this.http, host, opts);
  }
  /** Allow the agent to act on a site. Returns the host key that was stored. */
  allow(site: string): Promise<string> {
    return perms.allow(this.http, site);
  }
  /** Revoke acting on a site. */
  deny(site: string): Promise<boolean> {
    return perms.deny(this.http, site);
  }

  // ---- task memory -------------------------------------------------------

  /**
   * Jot a durable note keyed by a short label, scoped to this agent.
   *
   * Survives across sessions - the agent's own scratchpad for task state, not a
   * secret store. Setting the same key again overwrites it. Rejected server-side
   * for an empty/oversized key or value, or when the scratchpad is full.
   */
  remember(key: string, value: string): Promise<MemoryEntry> {
    return memory.remember(this.http, key, value);
  }
  /** Every note this agent holds, newest first. */
  recall(): Promise<MemoryEntry[]>;
  /** A bounded/prefix-filtered list of notes, newest first. */
  recall(options: MemoryRecallOptions): Promise<MemoryEntry[]>;
  /** One note by key, or `undefined` when nothing is stored under it. */
  recall(key: string): Promise<MemoryEntry | undefined>;
  recall(
    keyOrOptions?: string | MemoryRecallOptions,
  ): Promise<MemoryEntry | MemoryEntry[] | undefined> {
    return memory.recall(this.http, keyOrOptions);
  }
  /** Forget a note. Returns whether one was actually removed. */
  forget(key: string): Promise<boolean> {
    return memory.forget(this.http, key);
  }

  // ---- credential vault --------------------------------------------------

  /**
   * Store (or rotate) a secret under a name, scoped to this account+agent.
   *
   * This is the HUMAN path: a person at a dashboard/CLI puts the secret in once,
   * and the agent thereafter fills it by name with a `fill_secret` action,
   * never seeing the value. Returns the name, the account identifier, and the
   * time - never the secret. There is deliberately no method that reads a stored
   * secret back.
   *
   * `username` is the optional account email/login this credential is for, shown
   * back so a login is recognizable. OMIT it on a password rotation to preserve
   * the existing identifier; pass an empty string to clear it.
   *
   * `kind` is "password" (default) or "totp" - for a TOTP, `secret` is the
   * authenticator SEED (a base32 string or otpauth:// URI), and the agent fills
   * the current code with a fill_totp action, never seeing the seed or the code.
   */
  storeCredential(
    name: string,
    secret: string,
    username?: string,
    kind?: "password" | "totp",
  ): Promise<CredentialName> {
    return vault.storeCredential(this.http, name, secret, username, kind);
  }

  /** The NAMES of the credentials stored for this account+agent. Never values. */
  credentialNames(): Promise<CredentialName[]> {
    return vault.credentialNames(this.http);
  }

  /** Delete a stored credential by name. Returns whether one was removed. */
  deleteCredential(name: string): Promise<boolean> {
    return vault.deleteCredential(this.http, name);
  }

  /**
   * How this account wants the agent to choose among several sign-in accounts:
   * `askMode` "always" (ask every time a provider is ambiguous) or "remember"
   * (reuse a per-site choice), plus the remembered site→account map. open_page
   * reads this to decide whether to ask or reuse.
   */
  accountPrefs(): Promise<AccountPrefs> {
    return vault.accountPrefs(this.http);
  }
}

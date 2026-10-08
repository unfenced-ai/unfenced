/**
 * The live-session tier: open a page, drive it, read it, close it.
 *
 * These are the bodies of the `Unfenced` methods under its `// ---- live
 * sessions` heading, moved out and re-shaped from methods to functions that
 * take a `Transport`. `open` and `switchAccount` also take the `client`, because
 * they hand it to the `Session` they build. `this.request` became `http.request`
 * and nothing else changed - the request paths, shapes, and comments are as they
 * were.
 */
import { Transport, UnfencedError } from "./http.js";
import { Session } from "./session.js";
import type { Unfenced } from "./client.js";
import type { ExtractedDoc } from "./protocol.js";
import type {
  Action,
  ActResult,
  ActExpectation,
  AtAction,
  DownloadInfo,
  Format,
  FormField,
  FormFillResult,
  OnAction,
  PageSnapshot,
  PendingApproval,
  ProviderSessionReason,
  ReadPage,
  SeenPage,
  SessionInfo,
} from "./types.js";

/** The server may wait 120 seconds for configured human approval, then settle. */
const LIVE_WRITE_BUDGET_MS = 150_000;

async function liveWrite<T>(
  http: Transport,
  path: string,
  body: unknown,
  remedy: string,
): Promise<T> {
  try {
    return await http.request<T>("POST", path, body, LIVE_WRITE_BUDGET_MS);
  } catch (error) {
    if (error instanceof UnfencedError && error.code === "timeout") {
      throw new UnfencedError(error.status, error.detail, {
        code: "execution-uncertain",
        remedy,
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * A session id, safe to splice into a path.
 *
 * Every call below builds `/session/<id>/...` by interpolation, and the id
 * reaches the client from whatever asked for it - an MCP tool argument written
 * by a model, a CLI flag, a caller's own storage. An id carrying `/`, `?`, `#`
 * or `..` therefore chooses a DIFFERENT route on the worker while looking like
 * a session that does not exist: `../../permissions` reads the allowlist,
 * `x?account=other` appends a parameter the caller never passed. Nothing on
 * this path validated it.
 *
 * Deliberately a shape check and not a format check. Ids are 8 hex characters
 * today (`randomUUID().slice(0, 8)`), but pinning that here would make a
 * perfectly reasonable change to the generator break every client; what has to
 * hold is only that the value is ONE path segment. `encodeURIComponent` is
 * belt to the braces - it would neutralise the traversal on its own, and the
 * throw is what makes a bad id readable rather than a 404 from the worker.
 *
 * Every caller below is `async` so this arrives as a REJECTION. A promise-
 * returning method that throws synchronously is caught by `await` and missed by
 * `.catch()`, which is a difference no caller should have to know about.
 */
export function sessionPath(id: string): string {
  // A standalone dot segment is normalized by URL parsers even when encoded.
  // Embedded dots remain valid, but these two values cannot identify a session.
  if (id === "." || id === ".." || !/^[A-Za-z0-9._~-]{1,128}$/.test(id)) {
    throw new UnfencedError(400, `not a session id: ${JSON.stringify(id.slice(0, 40))}`, {
      code: "bad-session-id",
      remedy:
        "a session id is the `id` open_page returned - one path segment of letters, digits, dot, dash, underscore or tilde. Open a page and use the id it gives you",
    });
  }
  return encodeURIComponent(id);
}

export async function open(
  client: Unfenced,
  http: Transport,
  url: string,
  options: {
    headless?: boolean;
    profile?: "ephemeral" | "agent";
    proxy?: string;
    account?: string;
    intent?: "read" | "act";
    settleMs?: number;
  } = {},
): Promise<
  Session & {
    providerSession?: ProviderSessionReason;
    reusedExistingSession?: boolean;
    navigated?: boolean;
    note?: string;
  }
> {
  const { id, page, providerSession, reusedExistingSession, navigated, note } = await liveWrite<{
    id: string;
    page: PageSnapshot;
    providerSession?: ProviderSessionReason;
    reusedExistingSession?: boolean;
    navigated?: boolean;
    note?: string;
  }>(
    http,
    "/session",
    { url, ...options },
    "open_page may have executed - list sessions and observe the page before retrying to avoid opening it twice",
  );
  // Attached rather than returned separately, so every existing caller keeps
  // working unchanged and a caller that wants to know WHY a page opened
  // without the account's provider session can ask.
  // Attached the same way `providerSession` is, and for the same reason: the
  // server has always said when it handed back a page you already had, and
  // this destructuring is where that sentence used to stop. An agent asking
  // for a second page on a site got the first one with nothing saying so.
  return Object.assign(new Session(client, id, page), {
    providerSession,
    ...(reusedExistingSession ? { reusedExistingSession, navigated } : {}),
    // Outside the reuse branch: an ordinary open can carry one too, and it was
    // being dropped for every caller who had not reused a session.
    ...(note ? { note } : {}),
  });
}

export async function switchAccount(
  client: Unfenced,
  http: Transport,
  sessionId: string,
  account: string,
): Promise<{
  session: Session;
  restoredSession: boolean;
  requestedAccount?: string;
  observedIdentity?: string;
}> {
  // `restoredSession` says whether this account had a STORED session to restore. When
  // false the reopened page is logged out and the resulting identity is whatever a
  // fresh OAuth resolves — NOT a guarantee it is `account`. `observedIdentity` is who
  // the page is ACTUALLY signed in as, when the site is one the server can read —
  // the truth to check against the requested name and across switches.
  const { id, page, restoredSession, requestedAccount, observedIdentity } = await http.request<{
    id: string;
    page: PageSnapshot;
    restoredSession?: boolean;
    requestedAccount?: string;
    observedIdentity?: string;
  }>("POST", `/session/${sessionPath(sessionId)}/switch`, { account });
  return {
    session: new Session(client, id, page),
    restoredSession: Boolean(restoredSession),
    requestedAccount,
    observedIdentity,
  };
}

export function pendingApprovals(
  http: Transport,
): Promise<{ interrupts: PendingApproval[]; clearAt: string }> {
  return http.request<{ interrupts: PendingApproval[]; clearAt: string }>("GET", "/interrupts");
}

export async function whoami(
  http: Transport,
  sessionId: string,
): Promise<{ identity: string | null; source: string | null }> {
  return http.request<{ identity: string | null; source: string | null }>(
    "GET",
    `/session/${sessionPath(sessionId)}/whoami`,
  );
}

export function liveSessions(http: Transport): Promise<SessionInfo[]> {
  return http.request<{ sessions: SessionInfo[] }>("GET", "/session").then((r) => r.sessions);
}

export async function observe(
  http: Transport,
  id: string,
  opts?: {
    match?: string;
    maxControls?: number;
    maxLinks?: number;
    excerptChars?: number;
    media?: boolean;
  },
) {
  return http
    .request<{ page: PageSnapshot }>("POST", `/session/${sessionPath(id)}/observe`, opts ?? {})
    .then((r) => r.page);
}

/**
 * Read the current page and the server's last provider-session continuity
 * decision. Unlike `observe`, this keeps the small status envelope so a caller
 * reconnecting after a network interruption can distinguish a carried login
 * from a session that needs re-authentication.
 */
export function refresh(
  http: Transport,
  id: string,
  opts?: { match?: string },
): Promise<{ page: PageSnapshot; providerSession?: ProviderSessionReason }> {
  return http.request<{ page: PageSnapshot; providerSession?: ProviderSessionReason }>(
    "GET",
    `/session/${sessionPath(id)}${opts?.match ? `?match=${encodeURIComponent(opts.match)}` : ""}`,
  );
}

export async function read(
  http: Transport,
  id: string,
  opts?: {
    match?: string;
    maxControls?: number;
    maxLinks?: number;
    excerptChars?: number;
    media?: boolean;
  },
): Promise<ReadPage> {
  return http.request<ReadPage>("POST", `/session/${sessionPath(id)}/observe`, opts ?? {});
}

export async function act(
  http: Transport,
  id: string,
  action: Action | OnAction | AtAction,
  opts?: {
    acceptDialog?: boolean;
    dialogText?: string;
    brief?: boolean;
    see?: boolean;
    expect?: ActExpectation;
  },
): Promise<ActResult> {
  // Merged into the body, because the wire is one object — the server reads
  // `acceptDialog`/`dialogText` off it and hands them to the engine as call
  // options rather than as part of the action.
  return liveWrite<ActResult>(
    http,
    `/session/${sessionPath(id)}/act`,
    { ...onTheWire(action), ...opts },
    "the action may have executed - observe the session before retrying; do not submit it twice",
  );
}

/**
 * The one place an action's field names are translated for the wire.
 *
 * A multi-select carried its options as an ARRAY under the SINGULAR key —
 * `{kind:"select", ref, value:["Olive","Caper"]}` — and the server's parser
 * reads the PLURAL key for arrays: `const many = b["values"]; if
 * (Array.isArray(many)) …`, falling through otherwise to `String(b["value"])`,
 * which is `"Olive,Caper"`. That string matches no option on any page, so
 * multi-select failed on every call and failed in a way that looked like the
 * site's fault. Reproduced end to end against the two real functions.
 *
 * Done HERE rather than in the MCP fold because this function is what writes
 * the body: every caller — the connector, a typed SDK user, a script — goes
 * through it, and a fix in one caller leaves the others broken. The action
 * types keep `value: string | string[]`, which is what the idea actually is;
 * the wire's two spellings are a wire detail and stop here.
 */
function onTheWire(action: Action | OnAction | AtAction): Record<string, unknown> {
  const body = { ...action } as Record<string, unknown>;
  if (body["kind"] === "select" && Array.isArray(body["value"])) {
    body["values"] = body["value"];
    delete body["value"];
  }
  return body;
}

export async function extract(
  http: Transport,
  id: string,
  format: Format = "markdown",
  maxWords?: number,
) {
  // `contentTruncated` is on the wire and was not in this type, so every typed
  // caller lost it: the route sets it when `capExtractInput` cut the DOM at the
  // 1 MB ceiling, with the comment "a cut page that claims to be whole is worse
  // than a cut page", and a client that cannot see the field cannot pass it on.
  //
  // `maxWords` and `totalWords` are the SECOND ceiling, which had no parameter
  // and no report: the route defaults to core's 25,000-word budget, so a long
  // logged-in listing came back cut with `contentTruncated` set for a reason
  // every description of this call attributed to the megabyte cut instead — and
  // its only documented remedy, a smaller DOM, does nothing about it.
  //
  // Absent means the route's own default, which is what every existing caller
  // already gets — adding the parameter changed nobody's result, only what a
  // careful caller is able to ask for.
  const budget = maxWords === undefined ? "" : `&maxWords=${encodeURIComponent(String(maxWords))}`;
  return http.request<{
    doc: ExtractedDoc;
    content: string;
    url: string;
    contentTruncated?: boolean;
    /** Present when something was withheld: how many words the page held. */
    totalWords?: number;
  }>("GET", `/session/${sessionPath(id)}/extract?format=${format}${budget}`);
}

export async function screenshot(http: Transport, id: string): Promise<string> {
  return http
    .request<{ image: string }>("GET", `/session/${sessionPath(id)}/screenshot`)
    .then((r) => r.image);
}

export async function see(
  http: Transport,
  id: string,
  opts: {
    links?: boolean;
    maxMarks?: number;
  } = {},
): Promise<SeenPage> {
  const query = new URLSearchParams({ marks: "1" });
  if (opts.links) query.set("links", "1");
  if (opts.maxMarks !== undefined) query.set("maxMarks", String(opts.maxMarks));
  return http.request<SeenPage>(
    "GET",
    `/session/${sessionPath(id)}/screenshot?${query.toString()}`,
  );
}

export async function fill(
  http: Transport,
  id: string,
  fields: readonly FormField[],
): Promise<FormFillResult> {
  return liveWrite<FormFillResult>(
    http,
    `/session/${sessionPath(id)}/fill`,
    { fields },
    "fill_form may have executed - observe the session before retrying; do not submit it twice",
  );
}

export async function park(
  http: Transport,
  id: string,
  minutes?: number,
  reason?: string,
): Promise<{ ok: boolean; until?: string }> {
  return http.request("POST", `/session/${sessionPath(id)}/park`, {
    ...(minutes !== undefined ? { minutes } : {}),
    ...(reason !== undefined ? { reason } : {}),
  });
}

export async function downloads(
  http: Transport,
  id: string,
): Promise<{ downloads: DownloadInfo[] }> {
  return http.request<{ downloads: DownloadInfo[] }>(
    "GET",
    `/session/${sessionPath(id)}/downloads`,
  );
}

export async function readDownload(
  http: Transport,
  id: string,
  filename: string,
): Promise<{ filename: string; bytes: number; content: string; doc: ExtractedDoc }> {
  return http.request(
    "GET",
    `/session/${sessionPath(id)}/downloads/${encodeURIComponent(filename)}`,
  );
}

export async function closeSession(
  http: Transport,
  id: string,
): Promise<{ alreadyClosed?: boolean; wasOpen?: boolean }> {
  // The response type has to name every field that is read below, or the
  // passthrough silently drops it again — which is the whole defect here.
  return http
    .request<{ ok: boolean; alreadyClosed?: boolean; wasOpen?: boolean }>(
      "DELETE",
      `/session/${sessionPath(id)}`,
    )
    .then((r) => ({
      // Passed through rather than rebuilt. This mapped only `alreadyClosed`,
      // so `wasOpen` — added so a mistyped id stops reading as success — was
      // dropped here and the MCP tool reported `wasOpen: true` unconditionally.
      // Its false branch was dead the day it shipped.
      ...(r.alreadyClosed ? { alreadyClosed: true } : {}),
      ...(typeof r.wasOpen === "boolean" ? { wasOpen: r.wasOpen } : {}),
    }));
}

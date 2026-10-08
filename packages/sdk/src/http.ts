/**
 * The transport and error plumbing shared by every client method.
 *
 * `Transport` owns the four things a request needs - the base URL, the token,
 * the fetch implementation, and the extra headers - and the one method that
 * turns them into a request; the domain modules take a `Transport` and stay
 * ignorant of how a call is made. `UnfencedError` and `parseErrorBody` sit here
 * because the transport raises the first using the second, and the memory and
 * fetch modules read a thrown status back off it. All moved verbatim from the
 * former single-file client.
 */
import type { UnfencedOptions } from "./types.js";

/** Sent as x-unfenced-client unless the caller overrides it. */
const SDK_CLIENT = "unfenced-sdk";
/** Keep unbudgeted session and account calls inside a normal client request window. */
const DEFAULT_REQUEST_BUDGET_MS = 45_000;

/**
 * Raised for any non-2xx response, carrying the server's status and detail.
 *
 * `code` and `remedy` exist because the server's refusals are structured and the
 * actionable half was being thrown away. The body arrives as
 * `{error, detail, remedy}`; this used to store the raw text truncated to 300
 * characters, which cut a longer refusal mid-string - so the JSON no longer
 * parsed downstream, the caller got a blob of half-JSON as its "detail", and the
 * `remedy` that says how to proceed was simply gone. A refusal an agent cannot
 * read its way out of is an infinite loop, which is the failure the act-guard in
 * core already paid for once.
 */
export class UnfencedError extends Error {
  /** The server's error code, e.g. `use-fetch`, when the body carried one. */
  public readonly code: string | undefined;
  /** What the server said to do instead. The half worth keeping. */
  public readonly remedy: string | undefined;
  /** Validated server delay in milliseconds; does not authorize retrying a write. */
  public readonly retryAfterMs: number | undefined;
  /** Original HTTP Retry-After value (delay-seconds or HTTP-date), when present. */
  public readonly retryAfter: string | undefined;

  constructor(
    public readonly status: number,
    public readonly detail: string,
    parts: {
      code?: string | undefined;
      remedy?: string | undefined;
      retryAfterMs?: number | undefined;
      retryAfter?: string | undefined;
      cause?: unknown;
    } = {},
  ) {
    super(`unfenced ${status}: ${detail}${parts.remedy ? ` - ${parts.remedy}` : ""}`, {
      ...(parts.cause !== undefined ? { cause: parts.cause } : {}),
    });
    this.name = "UnfencedError";
    this.code = parts.code;
    this.remedy = parts.remedy;
    this.retryAfterMs = parts.retryAfterMs;
    this.retryAfter = parts.retryAfter;
  }
}

/**
 * One signal from up to two, without needing `AbortSignal.any`.
 *
 * `AbortSignal.any` landed in Node 20 and is still absent from some runtimes
 * this client is meant to run in, and a client whose whole pitch is "platform
 * fetch, runs anywhere that has one" should not acquire a floor for a
 * convenience. Returns the single signal when there is only one, so the common
 * case allocates nothing.
 */
function combineSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): { signal: AbortSignal | undefined; release: () => void } {
  const nothing = (): void => {};
  if (!a) return { signal: b, release: nothing };
  if (!b) return { signal: a, release: nothing };
  const controller = new AbortController();
  for (const s of [a, b]) {
    if (s.aborted) {
      controller.abort(s.reason);
      return { signal: controller.signal, release: nothing };
    }
  }
  // A controller whose only job is to take the two listeners off again.
  //
  // WHY IT HAS TO. `{once: true}` fires a listener once and removes it only
  // when it FIRES; a request that succeeds never aborts, so both listeners
  // stayed registered forever. One of the two signals is the per-request
  // `AbortSignal.timeout`, which is garbage the moment the call returns - the
  // other is the CLIENT's, which lives as long as the caller's task. So using
  // the documented feature as documented ("Cancel every request this client
  // makes") grew that signal's listener array by two per request and retained
  // a closure with each: measured at 80 listeners after 40 successful calls,
  // with nothing reporting it, because Node emits no MaxListenersExceeded
  // warning for a bare AbortSignal.
  //
  // `signal` on addEventListener is the removal that cannot be forgotten: one
  // `cleanup.abort()` in the request's `finally` detaches both.
  const cleanup = new AbortController();
  for (const s of [a, b]) {
    s.addEventListener("abort", () => controller.abort(s.reason), {
      once: true,
      signal: cleanup.signal,
    });
  }
  return { signal: controller.signal, release: () => cleanup.abort() };
}

export function parseErrorBody(
  text: string,
): { error?: string; detail?: string; remedy?: string; retryAfterMs?: number } | null {
  try {
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const fields = body as Record<string, unknown>;
    return {
      ...(typeof fields["error"] === "string" ? { error: fields["error"] } : {}),
      ...(typeof fields["detail"] === "string" ? { detail: fields["detail"] } : {}),
      ...(typeof fields["remedy"] === "string" ? { remedy: fields["remedy"] } : {}),
      ...(typeof fields["retryAfterMs"] === "number" &&
      Number.isSafeInteger(fields["retryAfterMs"]) &&
      fields["retryAfterMs"] >= 0
        ? { retryAfterMs: fields["retryAfterMs"] }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Keep durations inside the timer range shared by supported runtimes. */
export function validateDuration(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError(`${name} must be an integer from 0 to 2147483647 milliseconds`);
  }
}

/** Sends requests; identity headers remain live by reference until submission. */
export class Transport {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  /** Narrowed to what this client calls: a string URL and an init object. */
  private readonly doFetch: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly extraHeaders: Record<string, string>;
  /** A caller's cancel for the whole client, combined with each call's budget. */
  private readonly clientSignal: AbortSignal | undefined;

  constructor(options: UnfencedOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:8787").replace(/\/$/, "");
    this.apiKey = options.apiKey;
    // Held BY REFERENCE, not copied. An MCP server passes an object it fills in
    // later, once its peer identifies itself in `initialize` — copying here
    // would freeze it empty and lose the client's name.
    this.extraHeaders = options.headers ?? {};
    this.clientSignal = options.signal;
    const f = options.fetch ?? globalThis.fetch;
    if (!f) throw new Error("no fetch available - pass options.fetch");
    this.doFetch = f.bind(globalThis);
  }

  /**
   * Make a request, bounded.
   *
   * `budgetMs` is what is LEFT of the caller's `timeoutMs`, not a per-request
   * allowance: `fetch()` computes a deadline once and hands each request the
   * remainder, so ten polls cannot each take the whole budget. Nothing on this
   * path carried a signal at all before — `grep -n AbortSignal packages/sdk`
   * returned nothing — so `timeoutMs` bounded only the check between polls and
   * a stalled connection wedged the call until the OS gave up.
   */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    budgetMs?: number,
    requestHeaders?: Record<string, string>,
  ): Promise<T> {
    const requestBudgetMs = budgetMs ?? DEFAULT_REQUEST_BUDGET_MS;
    if (requestBudgetMs <= 0)
      throw new UnfencedError(0, "request budget expired before submission", { code: "timeout" });
    validateDuration(requestBudgetMs, "request budget");
    // The default identity is applied per request, so a caller's object that
    // gains a name after construction still overrides it. Node's fetch sends
    // `user-agent: node`, so without this every SDK caller was anonymous.
    const headers: Record<string, string> = {
      "x-unfenced-client": SDK_CLIENT,
      ...this.extraHeaders,
      ...requestHeaders,
    };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const { signal, release } = combineSignals(
      this.clientSignal,
      // A budget already spent is a request that must not be made at all.
      AbortSignal.timeout(requestBudgetMs),
    );
    // `release` runs once this call is completely done — after the body, not
    // after the headers. Releasing at `doFetch`'s resolve would leave a client
    // cancel unable to interrupt a slow body read, which is most of the wait on
    // a large page.
    try {
      return await this.send<T>(method, path, headers, body, signal);
    } finally {
      release();
    }
  }

  /** The request itself, so the listener teardown above is one `finally`. */
  private async send<T>(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    let response: Response;
    try {
      // Cancellation is our boundary too: an injected fetch implementation
      // may ignore an already-aborted signal and still submit a write.
      if (signal?.aborted) throw signal.reason;
      response = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(signal ? { signal } : {}),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (cause) {
      // The commonest runtime failure for a hosted-service client — DNS gone,
      // the worker down, a tunnel dropped, the deadline reached — reached the
      // caller as a bare `TypeError: fetch failed` with no status, no code and
      // no remedy, so the `catch (e) { if (e instanceof UnfencedError) }` shape
      // the README teaches missed it entirely. Status 0 because nothing
      // answered; `cause` is kept so the platform error is still readable.
      const timedOut =
        signal?.aborted ||
        (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError"));
      throw new UnfencedError(
        0,
        cause instanceof Error ? cause.message : String(cause),
        timedOut
          ? {
              code: "timeout",
              remedy:
                "No response arrived within the request budget. The request may already have been accepted; check its state before retrying a write, and verify service availability or timeoutMs.",
              cause,
            }
          : {
              code: "unreachable",
              remedy:
                "No response was received. Check baseUrl, the network, and service availability. The request may already have been accepted; check its state before retrying a write.",
              cause,
            },
      );
    }
    const retryAfter = response.headers?.get("retry-after") ?? undefined;
    try {
      if (!response.ok && response.status !== 202) {
        const text = await response.text();
        // Parse BEFORE truncating. Truncating first cut a structured refusal
        // mid-JSON, so nothing downstream could read it back and the `remedy` —
        // the only part that tells the caller what to do instead — was lost.
        const body = parseErrorBody(text);
        throw new UnfencedError(response.status, body?.detail ?? text.slice(0, 300), {
          ...(body?.error ? { code: body.error } : {}),
          ...(body?.remedy ? { remedy: body.remedy } : {}),
          ...(body?.retryAfterMs !== undefined ? { retryAfterMs: body.retryAfterMs } : {}),
          ...(retryAfter !== undefined ? { retryAfter } : {}),
        });
      }
      return (await response.json()) as T;
    } catch (cause) {
      if (cause instanceof UnfencedError) throw cause;
      // Headers do not complete the request. A stalled/truncated body must
      // follow the same structured failure contract as a failed connection.
      const timedOut =
        signal?.aborted ||
        (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError"));
      throw new UnfencedError(response.status, "The response body could not be read", {
        ...(retryAfter !== undefined ? { retryAfter } : {}),
        code: timedOut
          ? "timeout"
          : cause instanceof SyntaxError
            ? "invalid-response"
            : "unreachable",
        remedy:
          "The request may already have been accepted. Check its state before retrying a write; verify service availability and the response format.",
        cause,
      });
    }
  }
}

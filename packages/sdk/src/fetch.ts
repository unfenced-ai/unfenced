/**
 * The fetch tier of the client: one URL, a batch, and a batch on a deadline.
 *
 * These are the bodies of `Unfenced.fetch`/`batch`/`batchWithin`, moved out
 * verbatim and re-shaped from methods to functions that take a `Transport`.
 * `this.request` became `http.request`, `this.awaitJob` and `this.fetch` became
 * the module-local `awaitJob` and `fetch` below; nothing else changed. The error
 * helpers (`errorCodeOf`, `targetRejection`, `toFetchFailure`) live here because
 * fetch is their only caller. URL identity is shared with the worker.
 */
import { Transport, UnfencedError, parseErrorBody, validateDuration } from "./http.js";
import type { FetchOptions, FetchResult } from "./types.js";
import { urlIdentity } from "./url-identity.js";

/** A batch bounds work in flight, not just the size of its final answer. */
async function mapBatch<T>(
  urls: string[],
  options: FetchOptions,
  run: (url: string, index: number) => Promise<T>,
): Promise<T[]> {
  // The production queue gives one tenant three waiting positions. Keep the
  // default inside that share; callers with a larger deployment can opt up.
  const concurrency = options.concurrency ?? 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new RangeError("batch concurrency must be an integer from 1 to 32");
  }
  const results = new Array<T>(urls.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= urls.length) return;
        results[index] = await run(urls[index]!, index);
      }
    }),
  );
  return results;
}

/** Keep a caller's base key unique per submitted URL, within the server bound. */
function batchIdempotencyKey(base: string | undefined, index: number): string | undefined {
  if (base === undefined) return undefined;
  const suffix = `:${index}`;
  return `${base.slice(0, Math.max(1, 128 - suffix.length))}${suffix}`;
}

/**
 * A 400 rejection of the target itself, as a structured failure — or null when
 * the error is about something else (auth, the service, the network).
 *
 * The server answers `{ "error": "blocked-target", "detail": "host did not
 * resolve" }` with a 400; `request` surfaces that body as the thrown error's
 * detail, so parse it back into the shape callers already handle.
 */
/**
 * The server's own code for this failure, however the error carries it.
 *
 * `UnfencedError.code` is now filled at the throw site, from the body parsed
 * before truncation. Both readers below used to re-parse `detail` as JSON
 * instead - which worked only while `detail` WAS the raw body, and silently
 * stopped the moment it became the parsed message. That is the whole regression
 * this helper exists to prevent recurring: one place decides, and the fallback
 * to re-parsing stays for an error constructed the old way.
 */
function errorCodeOf(error: UnfencedError): { code?: string; detail?: string } {
  if (error.code) return { code: error.code, detail: error.detail };
  const body = parseErrorBody(error.detail);
  return {
    ...(body?.error ? { code: body.error } : {}),
    ...(body?.detail ? { detail: body.detail } : {}),
  };
}

function targetRejection(error: unknown): FetchResult | null {
  if (!(error instanceof UnfencedError) || error.status !== 400) return null;
  const { code, detail } = errorCodeOf(error);
  if (code) {
    return {
      outcome: "failed",
      error: code,
      ...(detail ? { detail } : {}),
      ...(error.remedy ? { remedy: error.remedy } : {}),
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    };
  }
  return { outcome: "failed", error: "bad-request", detail: error.detail || error.message };
}

/** Any thrown error as a structured failure - used to keep a batch intact. */
function toFetchFailure(error: unknown): FetchResult {
  const rejection = targetRejection(error);
  if (rejection) return rejection;
  if (error instanceof UnfencedError) {
    const { code, detail } = errorCodeOf(error);
    return {
      outcome: "failed",
      error: code ?? `http-${error.status}`,
      detail: detail ?? error.detail ?? error.message,
      ...(error.remedy ? { remedy: error.remedy } : {}),
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    };
  }
  return {
    outcome: "failed",
    error: "request-failed",
    detail: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Same page? Ignores a fragment that is only an anchor.
 *
 * The fragment used to be blanked unconditionally, on the stated ground that it
 * "never varies content". That is true of `#section-3` and false of hash
 * ROUTING, where the fragment IS the page: `https://app.example/#/orders` and
 * `#/invoices` are two different screens of every dashboard and admin console
 * built that way. A batch across several routes of one SPA returned the FIRST
 * route's content under every other route's URL, marked `cached: true` and
 * nothing else. A silent wrong answer, which the agent then reasons and acts on.
 *
 * A route is what a router would read: a fragment beginning `/`, `!` or `?`.
 * An ordinary anchor still dedups, which is the case the collapse was for.
 * A non-root trailing slash stays significant: HTTP servers may route
 * `/resource` and `/resource/` to different representations.
 *
 * The worker cache and live-session reuse now import the same predicate from
 * `url-identity.ts`, so a correction in one cannot leave the others behind.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A poll that nobody is waiting on must not hold a process open. A batch
    // abandons its stragglers, and an un-unref'd 500ms timer in each of them
    // kept a script or a serverless invocation alive long after it had answered.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

/** A bounded opaque key for replaying a submission whose response was lost. */
function generatedIdempotencyKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `unfenced-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Poll a job to its end, inside a deadline that bounds the wall clock.
 *
 * `deadline` is an absolute instant rather than a duration, and every request
 * is handed what is LEFT of it. Before, the check ran only after a request came
 * back, so a hung poll never reached it — the loop simply stopped, holding the
 * caller for as long as the socket did.
 */
async function awaitJob(
  http: Transport,
  id: string,
  deadline: number,
  state: { lastStatus?: string } = {},
): Promise<FetchResult> {
  const timedOut = (): FetchResult => ({
    outcome: "failed",
    error: state.lastStatus === "queued" ? "queue-timeout" : "timeout",
    detail:
      state.lastStatus === "queued"
        ? `job ${id} expired before it got a fetch slot`
        : `job ${id} did not finish in time`,
  });
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return timedOut();
    let job: {
      status: string;
      result?: FetchResult;
      archived?: boolean;
      entry?: Extract<FetchResult, { outcome: "archived" }>["entry"];
    };
    try {
      job = await http.request<{
        status: string;
        result?: FetchResult;
        archived?: boolean;
        entry?: Extract<FetchResult, { outcome: "archived" }>["entry"];
      }>("GET", `/jobs/${id}`, undefined, left);
    } catch (error) {
      // A deadline reached mid-poll is this call's own timeout, not a fault of
      // the job, and it must read as one rather than as a transport error the
      // caller has no branch for.
      if (error instanceof UnfencedError && error.code === "timeout") {
        // A poll can lose its response after the job was accepted. Re-reading
        // the same immutable job id is safe, unlike replaying POST /jobs, and
        // lets a brief socket reset recover without asking the caller to guess
        // whether a fetch already ran. A request that consumed the deadline
        // still falls through to the bounded timeout result below.
        if (error.status === 0 && Date.now() < deadline) {
          await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
          continue;
        }
        return timedOut();
      }
      if (
        error instanceof UnfencedError &&
        error.status === 0 &&
        (error.code === "unreachable" || error.code === "timeout") &&
        Date.now() < deadline
      ) {
        // The job id is the recovery key. Never repeat the creation request;
        // only retry the read, and only while the caller's original deadline
        // still has time left.
        await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
        continue;
      }
      throw error;
    }
    if (job.status === "archived" || job.archived === true) {
      if (job.entry) return { outcome: "archived", url: job.entry.url, entry: job.entry };
      return { outcome: "failed", error: "no-result", detail: "archived job has no history entry" };
    }
    if (job.status === "done" || job.status === "error") {
      if (job.result) return job.result;
      return { outcome: "failed", error: "no-result", detail: "job finished without a result" };
    }
    state.lastStatus = job.status;
    if (Date.now() >= deadline) return timedOut();
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
  }
}

export async function fetch(
  http: Transport,
  url: string,
  options: FetchOptions = {},
  retryBusy = false,
  cancelOnTimeout = true,
  state: { lastStatus?: string } = {},
): Promise<FetchResult> {
  // One deadline for the whole call, taken before anything is sent, so the
  // submit and every poll after it share the budget the caller asked for.
  const timeoutMs = options.timeoutMs ?? 120_000;
  validateDuration(timeoutMs, "timeoutMs");
  if (timeoutMs === 0)
    return {
      outcome: "failed",
      error: "timeout",
      detail: "fetch budget expired before submission",
    };
  const deadline = Date.now() + timeoutMs;
  // Leave a small readback window for the server's queue-timeout result.
  const serverExpiresAt = deadline - Math.min(1_500, Math.floor(timeoutMs / 4));
  let jobId: string;
  const idempotencyKey = options.idempotencyKey ?? generatedIdempotencyKey();
  const body = {
    url,
    expiresAt: serverExpiresAt,
    format: options.format ?? "markdown",
    ...(options.forceRender ? { forceRender: true } : {}),
    ...(options.force ? { force: true } : {}),
    ...(options.identify ? { identify: options.identify } : {}),
    ...(options.robots ? { robots: options.robots } : {}),
    ...(options.maxWords ? { maxWords: options.maxWords } : {}),
    ...(options.locale ? { locale: options.locale } : {}),
    ...(options.wholePageLinks ? { wholePageLinks: true } : {}),
    ...(options.proxy ? { proxy: options.proxy } : {}),
  };
  let submissionRetried = false;
  let busyAttempts = 0;
  try {
    for (;;) {
      try {
        ({ jobId } = await http.request<{ jobId: string }>(
          "POST",
          "/jobs",
          body,
          deadline - Date.now(),
          { "idempotency-key": idempotencyKey },
        ));
        break;
      } catch (error) {
        if (
          retryBusy &&
          error instanceof UnfencedError &&
          error.code === "server-busy" &&
          Date.now() < deadline
        ) {
          const remaining = deadline - Date.now();
          // A full queue is not a license to probe four times a second. Honor
          // the server's earliest useful retry; absent a hint, back off with
          // bounded jitter so concurrent batches do not synchronize.
          const base =
            error.retryAfterMs !== undefined
              ? Math.max(25, error.retryAfterMs)
              : Math.min(5_000, 250 * 2 ** Math.min(busyAttempts, 5));
          busyAttempts++;
          await sleep(Math.min(remaining, Math.ceil(base * (1 + Math.random() * 0.1))));
          if (Date.now() < deadline) continue;
        }
        const canReplay =
          !submissionRetried &&
          error instanceof UnfencedError &&
          error.status === 0 &&
          (error.code === "timeout" || error.code === "unreachable") &&
          Date.now() < deadline;
        if (!canReplay) throw error;
        submissionRetried = true;
        await sleep(Math.min(25, Math.max(0, deadline - Date.now())));
      }
    }
  } catch (error) {
    // The server rejects an unfetchable target (unresolvable host, private
    // address, non-http scheme) with a 400 before any job exists. That is a
    // fact about this URL, not an exceptional condition — so return it in the
    // same structured shape as any other fetch failure rather than throwing.
    // Auth, 5xx, and network problems still throw: they are about the client
    // or the service, not the target.
    const rejection = targetRejection(error);
    if (rejection) return rejection;
    // A submit that never answered is this call's timeout, in the same shape as
    // one that timed out waiting for the job.
    if (error instanceof UnfencedError && error.code === "timeout") {
      return {
        outcome: "failed",
        error: "timeout",
        detail: `no complete submission response arrived inside ${options.timeoutMs ?? 120_000}ms; the job may have been accepted, so check its state before retrying`,
      };
    }
    throw error;
  }
  const result = await awaitJob(http, jobId, deadline, state);
  if (
    cancelOnTimeout &&
    result.outcome === "failed" &&
    (result.error === "timeout" || result.error === "queue-timeout")
  ) {
    // The caller's answer is already fixed. Send a bounded cancellation without
    // making the batch wait for a second network round trip past its deadline.
    void http.request("DELETE", `/jobs/${jobId}`, undefined, 2_000).catch(() => {});
  }
  return result;
}

export async function batch(
  http: Transport,
  urls: string[],
  options: FetchOptions = {},
): Promise<FetchResult[]> {
  if (options.timeoutMs !== undefined) validateDuration(options.timeoutMs, "timeoutMs");
  // Fetch each distinct URL once. A repeated URL in a batch used to be
  // fetched again from scratch — two full browser renders of the same page,
  // seconds apart — and the caller is billed and made to wait for both.
  // Every position still gets its entry, so the contract is unchanged.
  const byUrl = new Map<string, Promise<FetchResult>>();
  return mapBatch(urls, options, async (u, index) => {
    const key = urlIdentity(u) ?? u;
    const pending = byUrl.get(key);
    if (pending) {
      // Say so on the repeat. The server marks its own cache hits, but a
      // duplicate inside one batch never reaches the server at all — so
      // without this the only evidence of dedup was two identical
      // durations, which is exactly the inference a caller should not have
      // to make.
      const first = await pending;
      return first.outcome === "delivered"
        ? { ...first, meta: { ...first.meta, cached: true } }
        : first;
    }
    const started = fetch(
      http,
      u,
      {
        ...options,
        ...(options.idempotencyKey !== undefined
          ? { idempotencyKey: batchIdempotencyKey(options.idempotencyKey, index) }
          : {}),
      },
      true,
    ).catch(toFetchFailure);
    byUrl.set(key, started);
    return started;
  });
}

export async function batchWithin(
  http: Transport,
  urls: string[],
  deadlineMs: number,
  options: FetchOptions = {},
): Promise<FetchResult[]> {
  validateDuration(deadlineMs, "deadlineMs");
  if (options.timeoutMs !== undefined) validateDuration(options.timeoutMs, "timeoutMs");
  const expiresAt = Date.now() + deadlineMs;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deadlineMs);
    // Never hold the process open for a deadline nobody is waiting on.
    (timer as unknown as { unref?: () => void }).unref?.();
  });

  const states = new Map<string, { lastStatus?: string }>();
  const timeout = (url: string): FetchResult => ({
    outcome: "failed",
    error:
      states.get(urlIdentity(url) ?? url)?.lastStatus === "queued" ? "queue-timeout" : "timeout",
    url,
    detail: `the batch deadline of ${Math.round(deadlineMs / 1000)}s passed before this URL answered`,
  });

  const byUrl = new Map<string, Promise<FetchResult>>();
  try {
    return await mapBatch(urls, options, async (u, index) => {
      const key = urlIdentity(u) ?? u;
      let started = byUrl.get(key);
      const duplicate = started !== undefined;
      if (!started) {
        const state: { lastStatus?: string } = {};
        states.set(key, state);
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) return timeout(u);
        // Bounded by the SHARED deadline, not by the 120s default. A URL that
        // loses the race is already reported as `timeout` and its answer can
        // never be delivered, yet its poll loop went on issuing ~150 more
        // requests over the following 75 seconds — a held browser slot on the
        // single worker and a bill for a read the caller was told it did not
        // get. There is no cancel route to call, so the honest bound is the one
        // instant everything here shares.
        //
        // `Math.min`, not `??`. `options.timeoutMs ?? deadlineMs` bounded only
        // the caller who passed nothing, and the signature invites the other
        // case: `batchWithin(urls, 30_000, { timeoutMs: 120_000 })` is a
        // perfectly ordinary call — the caller's own per-fetch budget, plus a
        // tighter deadline for this batch — and it put the straggler right back
        // where it started, polling a worker for 90 seconds after its answer
        // was reported as `timeout` and became undeliverable. Nothing here can
        // deliver an answer past the deadline, so nothing here may outlive it.
        started = fetch(
          http,
          u,
          {
            ...options,
            timeoutMs: Math.min(options.timeoutMs ?? deadlineMs, remaining),
            ...(options.idempotencyKey !== undefined
              ? { idempotencyKey: batchIdempotencyKey(options.idempotencyKey, index) }
              : {}),
          },
          true,
          true,
          state,
        ).catch(toFetchFailure);
        byUrl.set(key, started);
      }
      // The deadline is shared, so a straggler cannot extend the answer.
      const settled = await Promise.race([started, deadline]);
      if (!settled) {
        return timeout(u);
      }
      return duplicate && settled.outcome === "delivered"
        ? { ...settled, meta: { ...settled.meta, cached: true } }
        : settled;
    });
  } finally {
    clearTimeout(timer!);
  }
}

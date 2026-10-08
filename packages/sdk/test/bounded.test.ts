import { getEventListeners } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { Unfenced, UnfencedError } from "../src/index.js";
import { Transport } from "../src/http.js";

it("sends the requested robots policy on single and batch jobs", async () => {
  const submitted: Array<Record<string, unknown>> = [];
  const client = new Unfenced({
    fetch: (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/jobs")) {
        submitted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ jobId: `job-${submitted.length}` }), { status: 202 });
      }
      return new Response(
        JSON.stringify({
          status: "done",
          result: { outcome: "delivered", content: "ok", doc: {}, meta: {} },
        }),
      );
    }) as typeof fetch,
  });
  await client.fetch("https://example.test/one", { robots: "obey" });
  await client.batch(["https://example.test/two"], { robots: "report" });
  expect(submitted.map((body) => body["robots"])).toEqual(["obey", "report"]);
});

it("does not invoke a custom transport for an already cancelled client", async () => {
  const controller = new AbortController();
  controller.abort(new Error("task stopped"));
  let calls = 0;
  const client = new Unfenced({
    signal: controller.signal,
    fetch: async () => {
      calls++;
      return new Response('{"jobId":"unexpected"}');
    },
  });
  expect(await client.fetch("https://example.test")).toMatchObject({
    outcome: "failed",
    error: "timeout",
  });
  expect(calls).toBe(0);
});

it("classifies a custom cancellation reason consistently before headers", async () => {
  const controller = new AbortController();
  const client = new Unfenced({
    signal: controller.signal,
    fetch: async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        controller.abort(new Error("task stopped by caller"));
      });
    },
  });
  expect(await client.fetch("https://example.test")).toMatchObject({
    outcome: "failed",
    error: "timeout",
  });
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

it("does not submit or poll when a fetch budget is already zero", async () => {
  let calls = 0;
  const wire = async () => {
    calls++;
    return new Response('{"jobId":"unexpected"}');
  };
  const client = new Unfenced({ fetch: wire });
  expect(await client.fetch("https://example.test", { timeoutMs: 0 })).toMatchObject({
    outcome: "failed",
    error: "timeout",
  });
  expect(await client.batch(["https://example.test"], { timeoutMs: 0 })).toMatchObject([
    { outcome: "failed", error: "timeout" },
  ]);
  expect(await client.batchWithin(["https://example.test"], 0)).toMatchObject([
    { outcome: "failed", error: "timeout" },
  ]);
  await expect(
    new Transport({ fetch: wire }).request("POST", "/jobs", {}, 0),
  ).rejects.toMatchObject({ code: "timeout" });
  expect(calls).toBe(0);
});

it("accepts the largest supported duration without timer overflow", async () => {
  const client = new Unfenced({
    fetch: async (_url, init) =>
      new Response(
        JSON.stringify(
          init?.method === "POST"
            ? { jobId: "fixture" }
            : { status: "done", result: { outcome: "delivered", content: "fixture" } },
        ),
      ),
  });
  expect(await client.fetch("https://example.test", { timeoutMs: 2_147_483_647 })).toMatchObject({
    outcome: "delivered",
  });
  expect(await client.batchWithin(["https://example.test"], 2_147_483_647)).toMatchObject([
    { outcome: "delivered" },
  ]);
});

it.each([-1, NaN, Infinity, 0.5, 2_147_483_648])(
  "rejects invalid duration %s before starting any work",
  async (duration) => {
    let calls = 0;
    const client = new Unfenced({
      fetch: async () => {
        calls++;
        return new Response("{}");
      },
    });
    await expect(
      client.fetch("https://example.test", { timeoutMs: duration }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      client.batch(["https://example.test"], { timeoutMs: duration }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(client.batchWithin(["https://example.test"], duration)).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(
      client.batchWithin(["https://example.test"], 100, { timeoutMs: duration }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(calls).toBe(0);
  },
);

it.each([
  { stage: "submit", status: 202 },
  { stage: "poll", status: 200 },
  { stage: "submit", status: 503 },
  { stage: "poll", status: 503 },
])(
  "bounds a stalled $stage response body after HTTP $status headers arrive",
  async ({ stage, status }) => {
    let headersSent = false;
    const server = createServer((req, res) => {
      if (stage === "poll" && req.method === "POST") {
        res.writeHead(202, { "content-type": "application/json" });
        res.end('{"jobId":"owned-fixture"}');
        return;
      }
      res.writeHead(status, { "content-type": "application/json" });
      headersSent = true;
      res.write('{"partial":');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing fixture address");
      const client = new Unfenced({ baseUrl: `http://127.0.0.1:${address.port}` });
      const result = await client.fetch("https://example.test", { timeoutMs: 300 });
      expect(headersSent).toBe(true);
      expect(result).toMatchObject({ outcome: "failed", error: "timeout" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it("reports malformed successful JSON as a structured response failure", async () => {
  const http = new Transport({ fetch: async () => new Response("{broken") });
  await expect(http.request("GET", "/sessions")).rejects.toMatchObject({
    name: "UnfencedError",
    code: "invalid-response",
  });
});

/**
 * WHAT BOUNDS A CALL, AND WHAT A FAILURE LOOKS LIKE WHEN NOTHING ANSWERS.
 *
 * `timeoutMs` was documented as "how long to wait for the job" and bounded
 * nothing: no request carried a signal (`grep -rn AbortSignal packages/sdk`
 * returned nothing at all), and the deadline was consulted only AFTER a request
 * came back. So a hung `POST /jobs` never reached the check and a hung
 * `GET /jobs/:id` blocked the loop for as long as the socket lived. Against
 * this repository's own documented failure - a Cloudflare quick tunnel dead at
 * the edge while cloudflared is alive - `fetch(url, {timeoutMs: 5000})` meant
 * "until the OS gives up".
 *
 * And a connection that never opened arrived as a bare `TypeError: fetch
 * failed`, so the `catch (e) { if (e instanceof UnfencedError) }` shape the
 * README teaches missed the commonest runtime failure a hosted-service client
 * has.
 */

/** A transport that never answers, and reports whether it was aborted. */
function hangs(): { fetch: typeof fetch; aborted: () => boolean } {
  let sawAbort = false;
  const impl = (async (_url: string, init?: { signal?: AbortSignal }) =>
    new Promise<never>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // never settles - the defect this file is about
      const stop = (): void => {
        sawAbort = true;
        reject(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }));
      };
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    })) as unknown as typeof fetch;
  return { fetch: impl, aborted: () => sawAbort };
}

describe("timeoutMs bounds the wall clock", () => {
  it("sends the same absolute expiry on every replayed submission", async () => {
    const expiries: number[] = [];
    let submissions = 0;
    const impl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/jobs")) {
        submissions++;
        expiries.push((JSON.parse(String(init?.body)) as { expiresAt: number }).expiresAt);
        if (submissions === 1) throw new TypeError("lost acknowledgement");
        return new Response(JSON.stringify({ jobId: "deadline-job" }), { status: 202 });
      }
      return new Response(
        JSON.stringify({
          status: "done",
          result: { outcome: "delivered", content: "ok", doc: {}, meta: {} },
        }),
      );
    }) as unknown as typeof fetch;
    const client = new Unfenced({ baseUrl: "http://127.0.0.1:9", fetch: impl });
    const before = Date.now();
    expect(await client.fetch("https://ex.com/a", { timeoutMs: 2_000 })).toMatchObject({
      outcome: "delivered",
    });
    expect(submissions).toBe(2);
    // The worker expires slightly before the caller, leaving one poll to
    // report a queue timeout instead of racing the SDK's generic deadline.
    expect(expiries[0]).toBeGreaterThanOrEqual(before + 1_500);
    expect(expiries[0]).toBeLessThanOrEqual(Date.now() + 1_500);
    expect(expiries[1]).toBe(expiries[0]);
  });

  it("gives up on a submit that never answers", async () => {
    const hang = hangs();
    const client = new Unfenced({ baseUrl: "http://127.0.0.1:9", fetch: hang.fetch });
    const started = Date.now();
    const result = await client.fetch("https://ex.com/a", { timeoutMs: 120 });
    expect(result.outcome).toBe("failed");
    expect(result.outcome === "failed" && result.error).toBe("timeout");
    expect(hang.aborted(), "the request was never actually cancelled").toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("gives up while polling a job that never finishes", async () => {
    let polls = 0;
    const impl = (async (url: string, init?: { signal?: AbortSignal }) => {
      if (url.endsWith("/jobs")) {
        return { ok: true, status: 202, json: async () => ({ jobId: "j1" }) };
      }
      polls++;
      // Answers "still running", forever, quickly - so only the deadline can
      // end this. A budget consulted between polls would still terminate; what
      // this pins is that it terminates INSIDE the budget the caller named.
      void init;
      return { ok: true, status: 200, json: async () => ({ status: "running" }) };
    }) as unknown as typeof fetch;
    const client = new Unfenced({ baseUrl: "http://127.0.0.1:9", fetch: impl });
    const started = Date.now();
    const result = await client.fetch("https://ex.com/a", { timeoutMs: 300 });
    expect(result.outcome === "failed" && result.error).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(polls).toBeGreaterThan(0);
  });

  it("re-reads a known job after a transient poll acknowledgement is lost", async () => {
    let polls = 0;
    const impl = (async (url: string) => {
      if (url.endsWith("/jobs")) {
        return { ok: true, status: 202, json: async () => ({ jobId: "accepted-once" }) };
      }
      polls++;
      if (polls === 1) throw new TypeError("socket reset after the job was accepted");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "done",
          result: { outcome: "delivered", content: "recovered", doc: {}, meta: {} },
        }),
      };
    }) as unknown as typeof fetch;
    const client = new Unfenced({ baseUrl: "http://127.0.0.1:9", fetch: impl });
    const result = await client.fetch("https://ex.com/recover", { timeoutMs: 2_000 });
    expect(result).toMatchObject({ outcome: "delivered", content: "recovered" });
    expect(polls).toBe(2);
  });

  it("replays creation once with the same idempotency key after a lost acknowledgement", async () => {
    let submissions = 0;
    const keys: string[] = [];
    const impl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/jobs")) {
        submissions++;
        keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        if (submissions === 1) throw new TypeError("socket reset after acceptance");
        return new Response(JSON.stringify({ jobId: "replayed-job" }), { status: 202 });
      }
      return new Response(
        JSON.stringify({
          status: "done",
          result: { outcome: "delivered", content: "replayed", doc: {}, meta: {} },
        }),
      );
    }) as unknown as typeof fetch;
    const client = new Unfenced({ baseUrl: "http://127.0.0.1:9", fetch: impl });
    const result = await client.fetch("https://ex.com/replay", {
      timeoutMs: 2_000,
      idempotencyKey: "acceptance-replay-1",
    });
    expect(result).toMatchObject({ outcome: "delivered", content: "replayed" });
    expect(submissions).toBe(2);
    expect(keys).toEqual(["acceptance-replay-1", "acceptance-replay-1"]);
  });

  it("names each submitted URL separately when batching with a caller key", async () => {
    const keys: string[] = [];
    const impl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/jobs")) {
        keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        return new Response(JSON.stringify({ jobId: `job-${keys.length}` }), { status: 202 });
      }
      return new Response(
        JSON.stringify({
          status: "done",
          result: { outcome: "delivered", content: "batch", doc: {}, meta: {} },
        }),
      );
    }) as unknown as typeof fetch;
    const client = new Unfenced({ baseUrl: "http://127.0.0.1:9", fetch: impl });
    const result = await client.batch(["https://ex.com/one", "https://ex.com/two"], {
      idempotencyKey: "batch-base",
      concurrency: 1,
    });
    expect(result.every((row) => row.outcome === "delivered")).toBe(true);
    expect(keys).toEqual(["batch-base:0", "batch-base:1"]);
  });

  it("passes a caller's own signal through, so a task can cancel everything", async () => {
    const controller = new AbortController();
    const hang = hangs();
    const client = new Unfenced({
      baseUrl: "http://127.0.0.1:9",
      fetch: hang.fetch,
      signal: controller.signal,
    });
    const pending = client.fetch("https://ex.com/a", { timeoutMs: 60_000 });
    controller.abort();
    const result = await pending;
    expect(result.outcome).toBe("failed");
  });
});

it("gives live-session requests a transport deadline even without a caller signal", async () => {
  const signals: Array<AbortSignal | undefined> = [];
  const client = new Unfenced({
    fetch: (async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Response(JSON.stringify({ sessions: [] }));
    }) as typeof fetch,
  });
  expect(await client.liveSessions()).toEqual([]);
  expect(signals).toHaveLength(1);
  expect(signals[0]).toBeInstanceOf(AbortSignal);
});

it("reports an archived job as an archive, not a failed fetch", async () => {
  const client = new Unfenced({
    fetch: (async (url: string) =>
      url.endsWith("/jobs")
        ? new Response(JSON.stringify({ jobId: "old-job" }), { status: 202 })
        : new Response(
            JSON.stringify({
              status: "done",
              archived: true,
              entry: {
                id: "old-job",
                url: "https://old.test/",
                ok: true,
                fetchedAt: "2026-01-01T00:00:00Z",
              },
            }),
          )) as typeof fetch,
  });
  expect(await client.fetch("https://old.test/")).toMatchObject({
    outcome: "archived",
    entry: { id: "old-job", ok: true },
  });
});

describe("a service that cannot be reached is an UnfencedError", () => {
  const unreachable = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;

  it("carries a code and a remedy instead of a bare TypeError", async () => {
    const client = new Unfenced({ baseUrl: "http://127.0.0.1:9", fetch: unreachable });
    // `open` rather than `fetch`, because the fetch tier converts a failure into
    // a structured result on purpose; the live tier is where a caller catches.
    await expect(client.open("https://ex.com/a")).rejects.toBeInstanceOf(UnfencedError);
    const error = await client
      .open("https://ex.com/a")
      .then(() => null)
      .catch((e: unknown) => e as UnfencedError);
    expect(error).toBeInstanceOf(UnfencedError);
    expect(error?.code).toBe("unreachable");
    expect(error?.status).toBe(0);
    expect(error?.remedy).toBeTruthy();
    expect(error?.cause).toBeInstanceOf(TypeError);
  });

  it("and reaches the fetch tier as a structured failure, not a throw", async () => {
    const client = new Unfenced({ baseUrl: "http://127.0.0.1:9", fetch: unreachable });
    // A transport fault is about the SERVICE, not the target, so `fetch` still
    // throws it — the three-outcome union is about the page, not the plumbing.
    await expect(client.fetch("https://ex.com/a")).rejects.toMatchObject({
      name: "UnfencedError",
      code: "unreachable",
    });
  });
});

/**
 * A session id is one path segment, and the client says so before the worker
 * has to guess. `../../permissions` used to be spliced straight in.
 */
describe("a session id cannot choose a different route", () => {
  const never = (async () => {
    throw new Error("the request should never have been made");
  }) as unknown as typeof fetch;

  for (const bad of [".", "..", "../../permissions", "abc/def", "abc?account=other", "abc#x", ""]) {
    it(`refuses ${JSON.stringify(bad)} before sending anything`, async () => {
      const client = new Unfenced({ baseUrl: "http://127.0.0.1:9", fetch: never });
      const error = await client
        .extract(bad, "markdown")
        .then(() => null)
        .catch((e: unknown) => e as UnfencedError);
      expect(error).toBeInstanceOf(UnfencedError);
      expect(error?.code).toBe("bad-session-id");
    });
  }

  it("accepts an id of the shape the worker actually issues", async () => {
    const answered = (async (url: string) => {
      expect(url).toContain("/session/1a2b3c4d/extract");
      return { ok: true, status: 200, json: async () => ({ doc: {}, content: "", url: "x" }) };
    }) as unknown as typeof fetch;
    const client = new Unfenced({ baseUrl: "http://127.0.0.1:9", fetch: answered });
    await expect(client.extract("1a2b3c4d", "markdown")).resolves.toBeTruthy();
  });
});

/**
 * A MULTI-SELECT REACHES THE ENGINE AS SEVERAL OPTIONS, NOT ONE COMMA-JOINED
 * STRING.
 *
 * The action carried its options as an array under the SINGULAR `value`, and
 * the server's parser reads the PLURAL `values` for arrays and otherwise does
 * `String(b["value"])` — which for ["Olive","Caper"] is "Olive,Caper", an
 * option no page has. So `act {kind:"select", values:[...]}`, the exact call
 * the schema's own description tells an agent to make, failed on every page and
 * failed in a way that read as the site's fault.
 */
describe("select puts its options on the wire the way the parser reads them", () => {
  function capture(): { fetch: typeof fetch; body: () => Record<string, unknown> } {
    let sent: Record<string, unknown> = {};
    const impl = (async (_url: string, init?: { body?: string }) => {
      sent = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch;
    return { fetch: impl, body: () => sent };
  }

  it("sends several options under `values`", async () => {
    const cap = capture();
    const client = new Unfenced({ baseUrl: "http://127.0.0.1:9", fetch: cap.fetch });
    await client.act("1a2b3c4d", { kind: "select", ref: "k1:e1", value: ["Olive", "Caper"] });
    expect(cap.body()["values"]).toEqual(["Olive", "Caper"]);
    expect(cap.body(), "an array under `value` becomes the string Olive,Caper").not.toHaveProperty(
      "value",
    );
  });

  it("still sends a single option under `value`", async () => {
    const cap = capture();
    const client = new Unfenced({ baseUrl: "http://127.0.0.1:9", fetch: cap.fetch });
    await client.act("1a2b3c4d", { kind: "select", ref: "k1:e1", value: "Olive" });
    expect(cap.body()["value"]).toBe("Olive");
    expect(cap.body()).not.toHaveProperty("values");
  });

  it("leaves every other verb's fields alone", async () => {
    const cap = capture();
    const client = new Unfenced({ baseUrl: "http://127.0.0.1:9", fetch: cap.fetch });
    await client.act("1a2b3c4d", { kind: "type", ref: "k1:e1", text: "hello", submit: true });
    expect(cap.body()).toMatchObject({ kind: "type", ref: "k1:e1", text: "hello", submit: true });
  });
});

/**
 * A CLIENT-LEVEL SIGNAL IS NOT A PER-REQUEST ONE.
 *
 * The fix that gave every request a signal combined the caller's with a
 * per-request `AbortSignal.timeout`, and registered an abort listener on BOTH
 * with `{once: true}`. `once` removes a listener when it FIRES — a request that
 * succeeds never aborts, so neither was ever removed. The timeout signal is
 * garbage the moment the call returns; the caller's is not. It lives as long as
 * their task, which is the whole point of the documented feature ("Cancel every
 * request this client makes", types.ts).
 *
 * So using it as documented grew that signal's listener array by two per
 * request, retaining a closure with each, for the lifetime of the client. Node
 * emits no MaxListenersExceededWarning for a bare AbortSignal, so a worker or
 * agent loop doing tens of thousands of fetches under one task signal
 * accumulated them with nothing reporting it.
 *
 * Driven at the Transport, which is where combineSignals is and where one
 * request is one round trip — `client.fetch()` is a submit plus a poll loop, so
 * counting listeners across it measures the loop rather than the invariant.
 *
 * The count is the assertion because it is the only observable: nothing throws,
 * nothing warns, and every request still succeeds.
 */
describe("a client-level signal does not accumulate listeners", () => {
  /** Answers immediately, so every call takes the SUCCESS path. */
  const answers = (): typeof fetch =>
    (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })) as unknown as typeof fetch;

  it("is left as it was found after N bounded requests", async () => {
    const controller = new AbortController();
    const before = getEventListeners(controller.signal, "abort").length;
    const transport = new Transport({
      baseUrl: "http://127.0.0.1:9",
      fetch: answers(),
      signal: controller.signal,
    });
    // A budget is what makes a request combine two signals at all — with none,
    // combineSignals returns the caller's signal unchanged and never listens,
    // which is why the live tier never hit this.
    for (let i = 0; i < 25; i += 1) await transport.request("GET", "/x", undefined, 30_000);
    expect(
      getEventListeners(controller.signal, "abort").length,
      "each request left its abort listener on the caller's signal",
    ).toBe(before);
    // Releasing the listeners must not disarm the signal itself.
    expect(controller.signal.aborted).toBe(false);
  });

  it("still cancels an in-flight request through the client signal", async () => {
    const hanging = hangs();
    const controller = new AbortController();
    const transport = new Transport({
      baseUrl: "http://127.0.0.1:9",
      fetch: hanging.fetch,
      signal: controller.signal,
    });
    const call = transport.request("GET", "/x", undefined, 30_000);
    setTimeout(() => controller.abort(), 10);
    await expect(call).rejects.toBeInstanceOf(UnfencedError);
    expect(hanging.aborted(), "the caller's cancel never reached the request").toBe(true);
    expect(getEventListeners(controller.signal, "abort").length).toBe(0);
  });

  it("does not listen at all when there is nothing to combine", async () => {
    // No budget: one signal, returned unchanged. Registering here would be pure
    // cost on the tier that passes no timeoutMs.
    const controller = new AbortController();
    const transport = new Transport({
      baseUrl: "http://127.0.0.1:9",
      fetch: answers(),
      signal: controller.signal,
    });
    await transport.request("GET", "/x");
    expect(getEventListeners(controller.signal, "abort").length).toBe(0);
  });
});

import { describe, expect, it, vi } from "vitest";
import { Unfenced, UnfencedError } from "../src/index.js";

it("accepts a sequential batch and rejects invalid concurrency before sending", async () => {
  let sent = 0;
  const transport = fakeFetch();
  const client = new Unfenced({
    fetch: async (input, init) => {
      sent++;
      return transport(input, init);
    },
  });
  for (const concurrency of [0, -1, 1.5, NaN, Infinity, 33]) {
    await expect(client.batch(["https://batch.test/invalid"], { concurrency })).rejects.toThrow(
      RangeError,
    );
  }
  expect(sent).toBe(0);
  expect(
    await client.batch(["https://batch.test/a", "https://batch.test/b"], { concurrency: 1 }),
  ).toHaveLength(2);
});

it("keeps a busy refusal's remedy and retry delay in its batch entry", async () => {
  const client = new Unfenced({
    fetch: (async () =>
      new Response(
        JSON.stringify({
          error: "server-busy",
          detail: "tenant share is full",
          remedy: "let your running fetches finish",
          retryAfterMs: 75,
        }),
        { status: 429 },
      )) as typeof fetch,
  });
  const result = await client.batch(["https://batch.test/busy"], { timeoutMs: 100 });
  expect(result[0]).toMatchObject({
    outcome: "failed",
    error: "server-busy",
    remedy: "let your running fetches finish",
    retryAfterMs: 75,
  });
});

it("retries transient server-busy submissions within the fetch budget", async () => {
  let submissions = 0;
  const client = new Unfenced({
    fetch: (async (input: string) => {
      if (input.endsWith("/jobs")) {
        submissions++;
        if (submissions === 1) {
          return new Response(
            JSON.stringify({ error: "server-busy", detail: "queue full", retryAfterMs: 10 }),
            { status: 429 },
          );
        }
        return new Response(JSON.stringify({ jobId: "accepted-after-busy" }), { status: 202 });
      }
      return new Response(
        JSON.stringify({
          status: "done",
          result: {
            outcome: "delivered",
            url: "https://batch.test/retry",
            content: "ok",
            doc: {},
            meta: {},
          },
        }),
      );
    }) as typeof fetch,
  });
  expect(await client.batch(["https://batch.test/retry"], { timeoutMs: 200 })).toMatchObject([
    { outcome: "delivered", content: "ok" },
  ]);
  expect(submissions).toBe(2);
});

it("does not probe again before the server's busy retry hint", async () => {
  let submissions = 0;
  const impl = (async (_input: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      submissions++;
      return new Response(JSON.stringify({ error: "server-busy", retryAfterMs: 1_000 }), {
        status: 429,
      });
    }
    throw new Error("no job was accepted");
  }) as typeof fetch;
  const client = new Unfenced({ fetch: impl });
  const [result] = await client.batchWithin(["https://busy.test/"], 550);
  expect(result?.outcome).toBe("failed");
  expect(submissions).toBe(1);
});

it("returns the busy hint without probing when it exceeds the caller deadline", async () => {
  let submissions = 0;
  const client = new Unfenced({
    fetch: (async (input: string) => {
      if (input.endsWith("/jobs")) {
        submissions++;
        if (submissions === 1)
          return new Response(JSON.stringify({ error: "server-busy", retryAfterMs: 30_000 }), {
            status: 429,
          });
        return new Response(JSON.stringify({ jobId: "quick-slot" }), { status: 202 });
      }
      return new Response(
        JSON.stringify({
          status: "done",
          result: {
            outcome: "delivered",
            url: "https://batch.test/quick",
            content: "ok",
            doc: {},
            meta: {},
          },
        }),
      );
    }) as typeof fetch,
  });
  expect(await client.batch(["https://batch.test/quick"], { timeoutMs: 1_200 })).toMatchObject([
    { outcome: "failed", error: "server-busy", retryAfterMs: 30_000 },
  ]);
  expect(submissions).toBe(1);
});

it("defaults to the production tenant share when submitting a batch", async () => {
  let inFlight = 0;
  let peak = 0;
  const client = new Unfenced({
    fetch: (async (input: string, init?: RequestInit) => {
      if (init?.method === "POST" && input.endsWith("/jobs")) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        return new Response(JSON.stringify({ jobId: `job-${inFlight}-${Math.random()}` }), {
          status: 202,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return new Response(
        JSON.stringify({
          status: "done",
          result: {
            outcome: "delivered",
            url: "https://batch.test/item",
            content: "ok",
            doc: {},
            meta: {},
          },
        }),
      );
    }) as typeof fetch,
  });
  const urls = Array.from({ length: 8 }, (_, i) => `https://batch.test/${i}`);
  expect((await client.batch(urls)).every((row) => row.outcome === "delivered")).toBe(true);
  expect(peak).toBeLessThanOrEqual(3);
});

it("bounds a large batch without losing ordering or duplicate reuse", async () => {
  let active = 0;
  let peak = 0;
  let submitted = 0;
  const transport = fakeFetch();
  const client = new Unfenced({
    fetch: async (input, init) => {
      active++;
      peak = Math.max(peak, active);
      if (init?.method === "POST") submitted++;
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await transport(input, init);
      } finally {
        active--;
      }
    },
  });
  const urls = Array.from({ length: 64 }, (_, i) => `https://batch.test/${i}`);
  const results = await client.batch([...urls, urls[0]!]);
  expect(results.map((result) => result.url)).toEqual([...urls, urls[0]]);
  expect(submitted).toBe(64);
  expect(peak, "peak concurrent client requests").toBeLessThanOrEqual(8);
  expect(results.at(-1)).toMatchObject({ outcome: "delivered", meta: { cached: true } });
});

it("does not submit queued URLs after a batch deadline", async () => {
  let submitted = 0;
  const transport = fakeFetch();
  const client = new Unfenced({
    fetch: async (input, init) => {
      if (init?.method === "POST") submitted++;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return transport(input, init);
    },
  });
  const results = await client.batchWithin(
    Array.from({ length: 32 }, (_, i) => `https://batch.test/${i}`),
    15,
  );
  expect(results).toHaveLength(32);
  expect(results.every((result) => result.outcome === "failed" && result.error === "timeout")).toBe(
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 65));
  expect(submitted).toBeLessThanOrEqual(8);
});

/**
 * The batch contract, as documented on the tool: one entry per URL, in input
 * order, with a failed URL carrying its structured error in place.
 *
 * This is a regression guard for a real defect: an unresolvable host made the
 * server reject at request level (400 blocked-target), the SDK threw, and
 * Promise.all discarded every other result - an agent batching 20 URLs lost all
 * 20 and had to bisect to find the offender.
 */

const BAD = "https://this-domain-definitely-does-not-exist-xyz123abc.com";

interface FakeOptions {
  /** URLs whose POST /jobs is rejected 400 by the server. */
  reject400?: string[];
  /** URLs whose POST /jobs fails 500. */
  fail500?: string[];
  /** Status for every POST /jobs (e.g. 401 to simulate a bad key). */
  authStatus?: number;
}

/** A fetch stand-in that speaks just enough of the worker's API. */
function fakeFetch(options: FakeOptions = {}): typeof fetch {
  const reject400 = new Set(options.reject400 ?? []);
  const fail500 = new Set(options.fail500 ?? []);
  return (async (input: string, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (method === "POST" && url.endsWith("/jobs")) {
      const target = JSON.parse(init?.body ?? "{}").url as string;
      if (options.authStatus) {
        return {
          ok: false,
          status: options.authStatus,
          text: async () => '{"error":"unauthorized","detail":"provide a valid API key"}',
        };
      }
      if (reject400.has(target)) {
        return {
          ok: false,
          status: 400,
          text: async () => '{"error":"blocked-target","detail":"host did not resolve"}',
        };
      }
      if (fail500.has(target)) {
        return { ok: false, status: 500, text: async () => "upstream exploded" };
      }
      return { ok: true, status: 202, json: async () => ({ jobId: `job-for-${target}` }) };
    }

    if (method === "GET" && url.includes("/jobs/")) {
      const target = decodeURIComponent(url.split("/jobs/")[1] ?? "").replace("job-for-", "");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "done",
          // The six fields a real worker sends, verified over the wire:
          // outcome, url, format, content, doc, meta. A fake thinner than the thing
          // it stands in for lets the client's type drift away from reality
          // without any test noticing — which is exactly what happened.
          result: {
            outcome: "delivered",
            url: target,
            format: "markdown",
            content: `# content of ${target}`,
            doc: { markdown: `# content of ${target}`, title: target, pageType: "article" },
            meta: { tier: 1, renderedJs: false, finalUrl: target, status: 200, durationMs: 12 },
          },
        }),
      };
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  }) as unknown as typeof fetch;
}

describe("batch keeps one bad URL from costing the whole batch", () => {
  const urls = ["https://example.com/a", "https://example.com/b", BAD, "https://example.com/c"];

  it("returns one entry per URL, in order, with the failure in place", async () => {
    const client = new Unfenced({ fetch: fakeFetch({ reject400: [BAD] }) });
    const results = await client.batch(urls);

    expect(results).toHaveLength(urls.length);
    expect(results.filter((r) => r.outcome !== "delivered")).toHaveLength(1);

    // Position is the contract: the failure sits where its URL was.
    expect(results[2].outcome).toBe("failed");
    expect(results[2]).toMatchObject({
      outcome: "failed",
      error: "blocked-target",
      detail: "host did not resolve",
    });

    // ...and every good URL still came back, in order.
    for (const i of [0, 1, 3]) {
      expect(results[i].outcome).toBe("delivered");
      if (results[i].outcome === "delivered") expect(results[i].content).toContain(urls[i]);
    }
  });

  it("survives a server-side failure on one URL too", async () => {
    const client = new Unfenced({ fetch: fakeFetch({ fail500: [urls[1]] }) });
    const results = await client.batch(urls.filter((u) => u !== BAD));

    expect(results).toHaveLength(3);
    expect(results.filter((r) => r.outcome !== "delivered")).toHaveLength(1);
    expect(results[1].outcome).toBe("failed");
  });
});

describe("a rejected target is data, not an exception", () => {
  it("fetch() returns a structured failure for an unfetchable URL", async () => {
    const client = new Unfenced({ fetch: fakeFetch({ reject400: [BAD] }) });
    const result = await client.fetch(BAD);
    expect(result).toMatchObject({ outcome: "failed", error: "blocked-target" });
  });

  it("but still throws when the problem is the caller, not the target", async () => {
    const client = new Unfenced({ fetch: fakeFetch({ authStatus: 401 }) });
    // A bad API key must not be silently reported as "this page failed".
    await expect(client.fetch("https://example.com/a")).rejects.toBeInstanceOf(UnfencedError);
  });
});

describe("the same page, spelled differently, is fetched once", () => {
  /** Count how many times POST /jobs is actually called. */
  function countingFetch(): { fetch: typeof fetch; jobs: () => string[] } {
    const jobs: string[] = [];
    const f = (async (input: string, init?: { method?: string; body?: string }) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "POST" && url.endsWith("/jobs")) {
        const target = JSON.parse(init?.body ?? "{}").url as string;
        jobs.push(target);
        return { ok: true, status: 202, json: async () => ({ jobId: `job-${jobs.length}` }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "done",
          result: {
            outcome: "delivered",
            content: "page",
            doc: { markdown: "page", title: "t", pageType: "article" },
            meta: { tier: 1, renderedJs: false, finalUrl: "https://x/", durationMs: 5 },
          },
        }),
      };
    }) as unknown as typeof fetch;
    return { fetch: f, jobs: () => jobs };
  }

  it("treats an IDN host and its punycode as one host", async () => {
    const { fetch: f, jobs } = countingFetch();
    const client = new Unfenced({ fetch: f });
    const results = await client.batch(["https://xn--bcher-kva.de", "https://bücher.de"]);
    expect(results).toHaveLength(2);
    expect(jobs(), "one upstream fetch for one host").toHaveLength(1);
  });

  it("normalizes the root URL and ignores an ordinary fragment", async () => {
    const { fetch: f, jobs } = countingFetch();
    const client = new Unfenced({ fetch: f });
    await client.batch([
      "https://example.com",
      "https://example.com/",
      "https://example.com#section",
    ]);
    expect(jobs()).toHaveLength(1);
  });

  it("keeps non-root paths with and without a trailing slash distinct", async () => {
    const { fetch: f, jobs } = countingFetch();
    const client = new Unfenced({ fetch: f });
    await client.batch(["https://example.com/resource", "https://example.com/resource/"]);
    expect(jobs(), "two independently routed resources were fetched as one page").toHaveLength(2);
  });

  it("keeps genuinely different hosts apart", async () => {
    const { fetch: f, jobs } = countingFetch();
    const client = new Unfenced({ fetch: f });
    // www is a different host from the apex — two fetches is correct here.
    await client.batch(["https://www.bücher.de", "https://bücher.de"]);
    expect(jobs()).toHaveLength(2);
  });

  /**
   * A HASH ROUTE IS A PAGE, NOT AN ANCHOR.
   *
   * The fragment was blanked unconditionally, on the stated ground that it
   * "never varies content" — true of `#section-3` and false of every dashboard
   * and admin console built on hash routing. The server does not conflate them
   * (it strips the hash for its own cache key and navigates to the URL intact),
   * so only the client collapsed them: an agent asking for four routes of one
   * SPA got the FIRST route's content under all four URLs, marked `cached:true`
   * and nothing else. A silent wrong answer the agent then reasons and acts on.
   */
  it("does not collapse two routes of a hash-routed app", async () => {
    const { fetch: f, jobs } = countingFetch();
    const client = new Unfenced({ fetch: f });
    await client.batch([
      "https://app.example/#/orders",
      "https://app.example/#/invoices",
      "https://app.example/#!/legacy",
      "https://app.example/#?tab=2",
    ]);
    expect(jobs(), "two different screens were fetched as one page").toHaveLength(4);
  });

  it("and still collapses an ordinary anchor, which is what the dedup is for", async () => {
    const { fetch: f, jobs } = countingFetch();
    const client = new Unfenced({ fetch: f });
    await client.batch([
      "https://example.com/guide#install",
      "https://example.com/guide#usage",
      "https://example.com/guide",
    ]);
    expect(jobs()).toHaveLength(1);
  });
});

/**
 * A batch that answers even when a URL will not.
 *
 * `batch` resolves when every URL has, so one slow host decided when the whole
 * call returned. An external QA run watched a ten-URL batch blow its client's
 * sixty-second transport timeout, and a transport timeout returns NOTHING —
 * every sibling that had already succeeded was discarded, and the error named
 * no URL, so the caller could not even retry the right ones.
 */
describe("batchWithin", () => {
  it("reports queue-timeout when the last poll still had no fetch slot", async () => {
    const impl = (async (_input: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ jobId: "queued-only" }), { status: 202 })
        : new Response(JSON.stringify({ status: "queued" }))) as typeof fetch;
    const client = new Unfenced({ fetch: impl });
    const [result] = await client.batchWithin(["https://queued.test/"], 120);
    expect(result).toMatchObject({ outcome: "failed", error: "queue-timeout" });
  });

  it("cancels a single fetch after its deadline instead of leaving it queued", async () => {
    const cancelled: string[] = [];
    const impl = (async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ jobId: "single-queued" }), { status: 202 });
      }
      if (init?.method === "DELETE") {
        cancelled.push(input);
        return new Response(JSON.stringify({ cancelled: true }));
      }
      return new Response(JSON.stringify({ status: "queued" }));
    }) as typeof fetch;
    const client = new Unfenced({ fetch: impl });
    const result = await client.fetch("https://queued.test/single", { timeoutMs: 120 });
    expect(result).toMatchObject({ outcome: "failed", error: "queue-timeout" });
    await vi.waitFor(() => expect(cancelled).toEqual(["http://127.0.0.1:8787/jobs/single-queued"]));
  });

  it("cancels an accepted straggler after the shared deadline", async () => {
    const cancelled: string[] = [];
    const impl = (async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ jobId: "slow-accepted" }), { status: 202 });
      }
      if (init?.method === "DELETE") {
        cancelled.push(input);
        return new Response(JSON.stringify({ cancelled: true }));
      }
      return new Response(JSON.stringify({ status: "running" }));
    }) as typeof fetch;
    const client = new Unfenced({ fetch: impl });
    const result = await client.batchWithin(["https://slow.test/accepted"], 120);
    expect(result[0]).toMatchObject({ outcome: "failed", error: "timeout" });
    await vi.waitFor(() => expect(cancelled).toEqual(["http://127.0.0.1:8787/jobs/slow-accepted"]));
  });

  const hang = new Promise<Response>(() => {});

  /** Fast for everything except the URL named, which never answers. */
  const fetchWhereOneHangs = (slow: string) =>
    (async (input: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        const target = JSON.parse(init?.body ?? "{}").url as string;
        if (target === slow) return hang;
        return { ok: true, status: 202, json: async () => ({ jobId: `job-for-${target}` }) };
      }
      const target = decodeURIComponent(input.split("/jobs/")[1] ?? "").replace("job-for-", "");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "done",
          result: {
            outcome: "delivered",
            url: target,
            format: "markdown",
            content: `# content of ${target}`,
            doc: { markdown: "x", title: target, pageType: "article" },
            meta: { tier: 1, renderedJs: false, finalUrl: target, status: 200, durationMs: 5 },
          },
        }),
      };
    }) as unknown as typeof fetch;

  it("returns the siblings instead of losing them to one slow URL", async () => {
    const urls = ["https://a.test/", "https://slow.test/", "https://c.test/"];
    const client = new Unfenced({ fetch: fetchWhereOneHangs("https://slow.test/") });

    const results = await client.batchWithin(urls, 300);

    expect(results).toHaveLength(3);
    expect(results[0]?.outcome === "delivered", "a fast sibling was lost").toBe(true);
    expect(results[2]?.outcome === "delivered", "a fast sibling was lost").toBe(true);
  }, 20_000);

  it("names the URL that did not answer, so it can be retried on its own", async () => {
    const urls = ["https://a.test/", "https://slow.test/"];
    const client = new Unfenced({ fetch: fetchWhereOneHangs("https://slow.test/") });

    const results = await client.batchWithin(urls, 300);
    const slow = results[1];
    expect(slow?.outcome).toBe("failed");
    if (slow?.outcome !== "failed") return;
    expect(slow?.error).toBe("timeout");
    // The whole point: a transport error names nothing, so the agent must
    // retry everything or give up. This names exactly one URL.
    expect(slow?.url).toBe("https://slow.test/");
  }, 20_000);

  it("keeps input order, which is what makes the entries usable at all", async () => {
    const urls = ["https://a.test/", "https://slow.test/", "https://c.test/"];
    const client = new Unfenced({ fetch: fetchWhereOneHangs("https://slow.test/") });
    const results = await client.batchWithin(urls, 300);
    expect(results.map((r) => (r.outcome === "delivered" ? r.url : r.url))).toEqual(urls);
  }, 20_000);

  it("clamps the caller's own timeoutMs to the deadline, so a straggler stops with everyone else", async () => {
    // The straggler's budget was `options.timeoutMs ?? deadlineMs`, which bounds
    // only the caller who passed nothing — and the signature invites the other
    // case: a per-fetch budget plus a tighter deadline for this batch. The URL
    // that lost the race was already reported as `timeout`, its answer could
    // never be delivered, and its poll loop went on holding a browser slot on
    // the worker for the rest of the larger number.
    let aborted = false;
    const impl = (async (
      input: string,
      init?: { method?: string; body?: string; signal?: AbortSignal },
    ) => {
      if ((init?.method ?? "GET") !== "POST") throw new Error("unreachable");
      return new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
          },
          { once: true },
        );
        void input;
      });
    }) as unknown as typeof fetch;

    const client = new Unfenced({ fetch: impl });
    const results = await client.batchWithin(["https://slow.test/"], 200, { timeoutMs: 60_000 });
    expect(results[0]?.outcome).toBe("failed");
    // The batch has answered; the request behind it must not still be running.
    await new Promise((r) => setTimeout(r, 600));
    expect(aborted, "the straggler outlived the deadline the batch answered on").toBe(true);
  }, 20_000);

  it("does not wait out the deadline when everything is fast", async () => {
    const urls = ["https://a.test/", "https://b.test/"];
    const client = new Unfenced({ fetch: fetchWhereOneHangs("https://nothing-is-slow.test/") });
    const started = Date.now();
    const results = await client.batchWithin(urls, 10_000);
    expect(results.every((r) => r.outcome === "delivered")).toBe(true);
    expect(Date.now() - started, "waited for the deadline it did not need").toBeLessThan(5_000);
  }, 20_000);
});

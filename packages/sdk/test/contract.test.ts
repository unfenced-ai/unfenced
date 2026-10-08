import { describe, expect, it, vi } from "vitest";
import { Unfenced, UnfencedError } from "../src/index.js";

/**
 * The package other people install.
 *
 * @unfenced-ai/sdk is one of the two things published from this repository, and
 * its contract is whatever it does rather than whatever the types say. A caller
 * writes `catch (e) { if (e.status === 401) reauthenticate() }` on the strength
 * of a shape nothing was asserting.
 *
 * Everything here drives a stub fetch, because the question is what the CLIENT
 * does with a response - not whether the server produces one. That is tested
 * elsewhere, thoroughly.
 */
const respond = (status: number, body: unknown, ok = status < 400) =>
  ({
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  }) as unknown as Response;

const clientWith = (impl: (url: string, init?: RequestInit) => Promise<Response>) => {
  const fetch = vi.fn(impl);
  return {
    fetch,
    client: new Unfenced({ baseUrl: "https://api.example", apiKey: "ac_test", fetch }),
  };
};

describe("an error a caller can branch on", () => {
  it("carries the status, not just a sentence", async () => {
    const { client } = clientWith(async () => respond(401, "unauthorized"));
    // A caller reauthenticates on 401 and gives up on 403; a message cannot be
    // switched on.
    await expect(client.fetch("https://example.com")).rejects.toBeInstanceOf(UnfencedError);
    await client.fetch("https://example.com").catch((error: UnfencedError) => {
      expect(error.status).toBe(401);
      expect(error.name).toBe("UnfencedError");
      expect(error.detail).toContain("unauthorized");
    });
  });

  it("is an Error, so it survives being caught by ordinary code", async () => {
    // Asserted on the rejection rather than inside `.catch()`. With every
    // expect in the catch and no `rejects` guard, a version that RESOLVED ran
    // zero assertions and vitest reported a pass - so widening the rejection
    // rule to treat a 5xx as `{ ok: false }` would ship green, and nothing else
    // in this package pins that a 5xx rejects.
    const { client } = clientWith(async () => respond(500, "boom"));
    const error = await client.fetch("https://example.com").then(
      () => null,
      (e: unknown) => e,
    );
    expect(error, "a 500 resolved instead of rejecting").toBeInstanceOf(Error);
    expect(String(error)).toContain("500");
  });

  it("does not let a huge error body become the error message", async () => {
    // A server that returns an HTML error page should not put a page into a
    // caller's logs.
    const { client } = clientWith(async () => respond(502, "x".repeat(5_000)));
    const error = await client.fetch("https://example.com").then(
      () => null,
      (e: UnfencedError) => e,
    );
    expect(error, "a 502 resolved instead of rejecting").toBeInstanceOf(Error);
    expect((error as UnfencedError).detail.length).toBeLessThanOrEqual(300);
  });

  it("does not throw for a 202, which is how a job is accepted", async () => {
    const { client, fetch } = clientWith(async (url) =>
      url.endsWith("/jobs")
        ? respond(202, { jobId: "j1" }, false)
        : respond(200, {
            status: "done",
            result: { outcome: "delivered", content: "hello", doc: {}, meta: {} },
          }),
    );
    const result = await client.fetch("https://example.com");
    expect(result.outcome).toBe("delivered");
    expect(fetch).toHaveBeenCalled();
  });

  it("returns structured omissions from a completed job to a typed caller", async () => {
    const { client } = clientWith(async (url) =>
      url.endsWith("/jobs")
        ? respond(202, { jobId: "j1" }, false)
        : respond(200, {
            status: "done",
            result: {
              outcome: "delivered",
              content: "partial answer",
              doc: {},
              meta: { omissions: [{ kind: "pdf-page-cap", amount: 2, unit: "pages" }] },
            },
          }),
    );
    const result = await client.fetch("https://example.com/report.pdf");
    expect(result.outcome).toBe("delivered");
    if (result.outcome !== "delivered") return;
    expect(result.meta.omissions).toEqual([{ kind: "pdf-page-cap", amount: 2, unit: "pages" }]);
  });
});

describe("what it sends", () => {
  it("presents the API key as a bearer token", async () => {
    const { client, fetch } = clientWith(async (url) =>
      url.endsWith("/jobs")
        ? respond(202, { jobId: "j1" }, false)
        : respond(200, {
            status: "done",
            result: { outcome: "delivered", content: "", doc: {}, meta: {} },
          }),
    );
    await client.fetch("https://example.com");
    const headers = (fetch.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer ac_test");
  });

  it("names itself, so an account can see which client did what", async () => {
    const { client, fetch } = clientWith(async (url) =>
      url.endsWith("/jobs")
        ? respond(202, { jobId: "j1" }, false)
        : respond(200, {
            status: "done",
            result: { outcome: "delivered", content: "", doc: {}, meta: {} },
          }),
    );
    await client.fetch("https://example.com");
    const headers = (fetch.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers["x-unfenced-client"]).toBeTruthy();
  });

  it("sends no authorization header when there is no key", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/jobs")
        ? respond(202, { jobId: "j1" }, false)
        : respond(200, {
            status: "done",
            result: { outcome: "delivered", content: "", doc: {}, meta: {} },
          }),
    );
    const client = new Unfenced({ baseUrl: "https://api.example", fetch });
    await client.fetch("https://example.com");
    // Assert the request was seen before asserting what it lacked. With
    // `?? {}` alone this passes just as happily when no call was recorded at
    // all, which is a test that agrees with anything.
    const init = (fetch.mock.calls[0] as unknown[])[1] as
      { headers?: Record<string, string> } | undefined;
    expect(init, "no request was recorded, so there is nothing to check").toBeTruthy();
    const headers = init?.headers ?? {};
    expect(
      Object.keys(headers).length,
      "a request with no headers at all proves nothing",
    ).toBeGreaterThan(0);
    expect(headers["authorization"]).toBeUndefined();
  });
});

describe("being constructed badly", () => {
  it("says so when there is no fetch to use", () => {
    // Node without global fetch, or a bundler that stripped it: the message has
    // to name the fix rather than fail at the first request.
    const original = globalThis.fetch;
    try {
      // @ts-expect-error deliberately removing it
      delete globalThis.fetch;
      expect(() => new Unfenced({ baseUrl: "https://api.example" })).toThrow(/fetch/i);
    } finally {
      globalThis.fetch = original;
    }
  });
});

/**
 * The declared shape against the shape that arrives.
 *
 * `FetchResult` said `{ ok, doc, meta }`. A worker sends
 * `{ ok, url, format, content, doc, meta }` - checked against a running one,
 * not inferred. The field missing from the type was `content`: the page text,
 * the reason the call is made, unreachable from TypeScript without a cast on
 * the client library's primary method.
 *
 * Nothing failed at runtime, which is why it lasted. The client passes the
 * server's result through untouched, so the data was always there; only the
 * description of it was short. That is the kind of defect a test suite full of
 * fakes will never find, because the fakes were written from the same short
 * description.
 */
describe("a success carries everything the worker sent", () => {
  it("names all six fields, not the three the type used to admit", async () => {
    const client = new Unfenced({
      fetch: (async (input: string, init?: { method?: string }) => {
        if ((init?.method ?? "GET") === "POST") {
          return { ok: true, status: 202, json: async () => ({ jobId: "j1" }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "done",
            result: {
              outcome: "delivered",
              url: "https://example.com",
              format: "markdown",
              content: "# Example Domain",
              doc: { markdown: "# Example Domain", title: "Example Domain" },
              meta: {
                tier: 1,
                renderedJs: false,
                finalUrl: "https://example.com",
                status: 200,
                durationMs: 12,
              },
            },
          }),
        };
      }) as unknown as typeof fetch,
    });

    const result = await client.fetch("https://example.com");
    expect(result.outcome).toBe("delivered");
    if (result.outcome !== "delivered") return;

    // Each of these is a compile error if the type forgets the field again, and
    // a runtime failure if a worker stops sending it.
    expect(result.content).toBe("# Example Domain");
    expect(result.url).toBe("https://example.com");
    expect(result.format).toBe("markdown");
    expect(result.doc.title).toBe("Example Domain");
    expect(result.meta.tier).toBe(1);
    expect(Object.keys(result).sort()).toEqual([
      "content",
      "doc",
      "format",
      "meta",
      "outcome",
      "url",
    ]);
  });
});

import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { Unfenced, UnfencedError } from "../src/index.js";

it.each(["12", "Wed, 09 Sep 2026 12:00:00 GMT"])(
  "preserves HTTP retry guidance %s without automatically repeating a write",
  async (retryAfter) => {
    let calls = 0;
    const client = new Unfenced({
      fetch: async () => {
        calls++;
        return new Response(JSON.stringify({ error: "server-busy", retryAfterMs: 12_000 }), {
          status: 429,
          headers: { "retry-after": retryAfter },
        });
      },
    });
    const error = await rejection(client.open("https://example.test"));
    expect(error).toMatchObject({ status: 429, retryAfterMs: 12_000, retryAfter });
    expect(calls).toBe(1);
  },
);

it.each([0, 1234, Number.MAX_SAFE_INTEGER])(
  "retains a valid numeric delay %s",
  async (retryAfterMs) => {
    const error = await rejection(
      clientAnswering(429, JSON.stringify({ retryAfterMs })).open("https://example.test"),
    );
    expect(error.retryAfterMs).toBe(retryAfterMs);
    expect(error.retryAfter).toBeUndefined();
  },
);

it.each([-1, 0.5, "1000", null, {}, Number.MAX_SAFE_INTEGER + 1])(
  "ignores malformed numeric retry guidance %j",
  async (retryAfterMs) => {
    const error = await rejection(
      clientAnswering(429, JSON.stringify({ retryAfterMs })).open("https://example.test"),
    );
    expect(error.retryAfterMs).toBeUndefined();
  },
);

it("preserves uncertainty when a server receives a write then drops the connection", async () => {
  let received = 0;
  const server = createServer((request) => {
    request.resume();
    request.on("end", () => {
      received++;
      request.socket.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected loopback port");
    const client = new Unfenced({ baseUrl: `http://127.0.0.1:${address.port}` });
    const error = await rejection(client.open("https://example.test"));
    expect(received).toBe(1);
    expect(error).toMatchObject({ status: 0, code: "unreachable" });
    expect(error.remedy).toContain("may already have been accepted");
    expect(error.remedy).toContain("before retrying a write");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("does not expose malformed server error fields as typed strings", async () => {
  const client = new Unfenced({
    fetch: async () =>
      new Response(
        JSON.stringify({
          error: { nested: "code" },
          detail: ["not a string"],
          remedy: 42,
        }),
        { status: 503 },
      ),
  });
  const error = await rejection(client.open("https://example.test"));
  expect(error).toBeInstanceOf(UnfencedError);
  expect(typeof error.detail).toBe("string");
  expect(error.code).toBeUndefined();
  expect(error.remedy).toBeUndefined();
});

/**
 * A refusal has to survive the trip to the caller.
 *
 * The server answers a rejected open with `{error, detail, remedy}`, and the
 * remedy is the only part that says how to proceed. The client took
 * `response.text()` and truncated it to 300 characters BEFORE anything parsed
 * it, so a refusal longer than that was cut mid-JSON: the parse downstream then
 * failed, the caller received a fragment of JSON as its "detail", and the remedy
 * was gone.
 *
 * That is not a cosmetic loss. An agent that is refused and cannot read what to
 * do instead retries the identical request — the failure core already paid for
 * in the submit guard, whose refusal named `confirm: true` while the retry path
 * sent the same bytes back, so "an agent doing exactly what it was told could not
 * read its way out".
 *
 * The refusal below is the real one from `admission.ts`, at its real length,
 * because the bug only appears past 300 characters.
 */
const REFUSAL = {
  error: "use-fetch",
  detail:
    "this page is answered by a plain fetch - the last request for this domain " +
    "succeeded at tier 1, this account holds no credential for it, and no act " +
    "was declared. A live session would hold ~819 MB and one of the account's " +
    "session slots to return the same bytes.",
  remedy:
    "read it with POST /jobs (or the fetch_page tool). If you need to click, " +
    'type or submit on this page, re-send this request with intent: "act".',
};

/**
 * The rejection, typed. `open()` resolves to a Session, so a bare
 * `.catch(e => e)` widens to `UnfencedError | Session` and every field access
 * below stops compiling — and this file exists to assert those fields.
 */
async function rejection(p: Promise<unknown>): Promise<UnfencedError> {
  try {
    await p;
  } catch (e) {
    return e as UnfencedError;
  }
  throw new Error("expected the request to be refused, but it resolved");
}

function clientAnswering(status: number, body: string): Unfenced {
  return new Unfenced({
    baseUrl: "https://unfenced.test",
    apiKey: "ac_live_test",
    fetch: (async () =>
      new Response(body, { status, headers: { "content-type": "application/json" } })) as never,
  });
}

describe("a structured refusal reaching the caller", () => {
  it("keeps the remedy, which is longer than the old truncation point", () => {
    const raw = JSON.stringify(REFUSAL);
    expect(
      raw.length,
      "the fixture must exceed the old 300-char cut or it proves nothing",
    ).toBeGreaterThan(300);
  });

  it("surfaces code, detail and remedy as fields rather than one blob", async () => {
    const client = clientAnswering(400, JSON.stringify(REFUSAL));
    const err = await rejection(client.open("https://example.com"));
    expect(err).toBeInstanceOf(UnfencedError);
    expect(err.code).toBe("use-fetch");
    expect(err.detail).toBe(REFUSAL.detail);
    expect(err.remedy).toBe(REFUSAL.remedy);
    // The remedy names the exact field and value to re-send. If this ever fails,
    // the refusal has become a dead end.
    expect(err.remedy).toContain('intent: "act"');
  });

  it("puts the remedy in the message too, so a bare log line is still actionable", async () => {
    const client = clientAnswering(400, JSON.stringify(REFUSAL));
    const err = await rejection(client.open("https://example.com"));
    expect(err.message).toContain("use-fetch" === err.code ? REFUSAL.remedy : "");
  });

  it("falls back to the raw text when the body is not JSON", async () => {
    const client = clientAnswering(502, "upstream exploded");
    const err = await rejection(client.open("https://example.com"));
    expect(err.status).toBe(502);
    expect(err.detail).toBe("upstream exploded");
    expect(err.code).toBeUndefined();
    expect(err.remedy).toBeUndefined();
  });

  it("still truncates a non-JSON body, so a huge HTML error page cannot flood a context", async () => {
    const client = clientAnswering(500, "<html>" + "x".repeat(5000) + "</html>");
    const err = await rejection(client.open("https://example.com"));
    expect(err.detail.length).toBeLessThanOrEqual(300);
  });
});

it("preserves a failed error-body read as a transport failure with its HTTP status and cause", async () => {
  const cause = new TypeError("controlled body disconnect");
  const client = new Unfenced({
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(cause);
          },
        }),
        { status: 503, headers: { "retry-after": "60" } },
      ),
  });
  const error = await rejection(client.open("https://example.test"));
  expect(error).toMatchObject({ status: 503, code: "unreachable", cause, retryAfter: "60" });
  expect(error.detail).toBe("The response body could not be read");
});

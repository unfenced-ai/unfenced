import { describe, expect, it } from "vitest";
import { Unfenced, UnfencedError } from "../src/index.js";
import { Session } from "../src/session.js";

/**
 * THE MODULES THE COVERAGE REPORT SHOWED AT ZERO.
 *
 * `session.ts`, `library.ts`, `memory.ts` and `credentials.ts` each measured
 * 0% - no test had ever imported them. `session.ts` is the façade the typed
 * client's README leads with, and the other three are the whole of the recorded
 * library, the task scratchpad and the credential vault as an SDK caller sees
 * them. All four could have been refactored into nonsense with every gate green.
 *
 * They need no network: each is a thin wrapper over `Transport.request`, so a
 * stub `fetch` that records the method, the path and the body is enough to hold
 * what actually matters here - the URL each one builds, the shape it unwraps,
 * and the two places that decide something rather than forward it.
 */

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/**
 * A client whose transport answers from a table of `METHOD /path` -> body, and
 * records every call. An unlisted path answers 404, so a wrong URL fails as a
 * missing route rather than passing on a default.
 */
function stub(routes: Record<string, unknown>): { client: Unfenced; calls: Call[] } {
  const calls: Call[] = [];
  const transport = (async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const path = url.replace("http://127.0.0.1:9", "");
    calls.push({
      url: path,
      method,
      body: init?.body ? (JSON.parse(init.body) as unknown) : undefined,
    });
    const key = `${method} ${path}`;
    if (!(key in routes)) {
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: "not-found", detail: key }),
      };
    }
    return { ok: true, status: 200, json: async () => routes[key] };
  }) as unknown as typeof globalThis.fetch;
  return { client: new Unfenced({ baseUrl: "http://127.0.0.1:9", fetch: transport }), calls };
}

describe("the recorded library", () => {
  it("builds a query string only from the filters that were given", () => {
    // An empty `?` is not the same URL, and a filter silently dropped returns
    // somebody else's recordings.
    const { client, calls } = stub({ "GET /sessions": { sessions: [{ id: "s1" }] } });
    return client.sessions().then((sessions) => {
      expect(sessions).toEqual([{ id: "s1" }]);
      expect(calls[0]?.url, "an empty query added a bare ?").toBe("/sessions");
    });
  });

  it("passes kind, q and limit through", async () => {
    const { client, calls } = stub({
      "GET /sessions?kind=login&q=bank&limit=5": { sessions: [] },
    });
    await client.sessions({ kind: "login", q: "bank", limit: 5 });
    expect(calls[0]?.url).toBe("/sessions?kind=login&q=bank&limit=5");
  });

  it("unwraps each envelope to the thing the caller asked for", async () => {
    const { client } = stub({
      "GET /sessions/s7": { session: { id: "s7", frames: 3 } },
      "GET /history?limit=50": { entries: [{ url: "https://example.com" }] },
      "GET /domains": { domains: [{ host: "example.com" }] },
    });
    expect(await client.recordedSession("s7")).toEqual({ id: "s7", frames: 3 });
    expect(await client.history()).toEqual([{ url: "https://example.com" }]);
    expect(await client.domains()).toEqual([{ host: "example.com" }]);
  });
});

describe("the task scratchpad", () => {
  it("stores and reads back one key", async () => {
    const { client, calls } = stub({
      "POST /memory": { entry: { key: "k", value: "v" } },
      "GET /memory/k": { entry: { key: "k", value: "v" } },
    });
    expect(await client.remember("k", "v")).toEqual({ key: "k", value: "v" });
    expect(calls[0]?.body).toEqual({ key: "k", value: "v" });
    expect(await client.recall("k")).toEqual({ key: "k", value: "v" });
  });

  it("answers undefined for a key that is not there, rather than throwing", async () => {
    // The decision this module makes rather than forwards: a 404 on a single
    // key is an ABSENCE, so a caller can ask "do I have this?" without a
    // try/catch. Its own comment says so, and nothing held it.
    const { client } = stub({});
    await expect(client.recall("missing")).resolves.toBeUndefined();
  });

  it("still throws when the store itself fails", async () => {
    // The other side of that decision. Swallowing a 500 the same way would
    // report an outage as an empty scratchpad, and the agent would overwrite.
    const down = (async () => ({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ error: "transient" }),
    })) as unknown as typeof globalThis.fetch;
    const client = new Unfenced({ baseUrl: "http://127.0.0.1:9", fetch: down });
    await expect(client.recall("k")).rejects.toBeInstanceOf(UnfencedError);
  });

  it("lists everything when no key is given, and escapes one that is", async () => {
    const { client, calls } = stub({
      "GET /memory": { entries: [{ key: "a" }, { key: "b" }] },
      "DELETE /memory/a%2Fb": { removed: true },
    });
    expect(await client.recall()).toEqual([{ key: "a" }, { key: "b" }]);
    expect(await client.forget("a/b")).toBe(true);
    // A key with a slash must not become a second path segment.
    expect(calls[1]?.url).toBe("/memory/a%2Fb");
  });

  it("can bound and prefix-filter a memory list", async () => {
    const { client, calls } = stub({
      "GET /memory?prefix=job%2F&limit=2": { entries: [{ key: "job/a" }] },
    });
    expect(await client.recall({ prefix: "job/", limit: 2 })).toEqual([{ key: "job/a" }]);
    expect(calls[0]?.url).toBe("/memory?prefix=job%2F&limit=2");
  });
});

describe("the credential vault", () => {
  it("sends the secret and gets back a NAME", async () => {
    // The invariant the whole vault exists for: what comes back names a
    // credential, and never carries one.
    const { client, calls } = stub({
      "POST /vault": { name: "bank", username: "alice", kind: "password" },
      "GET /vault": { credentials: [{ name: "bank" }] },
      "DELETE /vault/bank": { removed: true },
      "GET /prefs": { prefs: { askWhichAccount: true } },
    });
    const stored = await client.storeCredential("bank", "s3cret", "alice", "password");
    expect(calls[0]?.body).toMatchObject({ name: "bank", secret: "s3cret" });
    expect(JSON.stringify(stored), "a stored secret came back from the vault").not.toContain(
      "s3cret",
    );
    expect(await client.credentialNames()).toEqual([{ name: "bank" }]);
    expect(await client.deleteCredential("bank")).toBe(true);
    expect(await client.accountPrefs()).toEqual({ askWhichAccount: true });
  });

  it("escapes a credential name in the delete path", async () => {
    const { client, calls } = stub({ "DELETE /vault/a%20b": { removed: false } });
    expect(await client.deleteCredential("a b")).toBe(false);
    expect(calls[0]?.url).toBe("/vault/a%20b");
  });
});

describe("the act-allowlist", () => {
  /**
   * The distinction this module exists to preserve: a store that cannot be READ
   * is not an owner who granted nothing. The route omits `allowed` rather than
   * sending `[]` for exactly that reason, and all three readers here have to
   * turn the omission into a throw — an agent that reads an outage as policy
   * stops asking for the grant it needs.
   */
  for (const [name, read] of [
    ["permissions", (c: Unfenced) => c.permissions()],
    ["permissionScope", (c: Unfenced) => c.permissionScope()],
    ["permissionEntries", (c: Unfenced) => c.permissionEntries()],
  ] as const) {
    it(`${name} refuses to report an unreadable allowlist as an empty one`, async () => {
      const { client } = stub({ "GET /permissions": { detail: "sqlite is locked" } });
      await expect(read(client)).rejects.toThrow(/could not be read.*sqlite is locked/s);
      await expect(read(client)).rejects.toThrow(/NOT a refusal by the owner/);
    });
  }

  it.each([{ allowed: ["a.com"] }, { entries: [{ host: "a.com", mode: "free" }] }])(
    "retains disabled requests in either permission response shape",
    async (shape) => {
      const { client } = stub({ "GET /permissions": { ...shape, allowSiteRequests: false } });
      expect(await client.permissionScope()).toMatchObject({
        allowSiteRequests: false,
        anySite: false,
      });
    },
  );

  it("reads a modeless allowlist as free, and carries anySite through", async () => {
    const { client } = stub({ "GET /permissions": { allowed: ["a.com", "b.com"], anySite: true } });
    expect(await client.permissions()).toEqual(["a.com", "b.com"]);
    expect(await client.permissionEntries()).toEqual([
      { host: "a.com", mode: "free" },
      { host: "b.com", mode: "free" },
    ]);
    expect(await client.permissionScope()).toEqual({
      entries: [
        { host: "a.com", mode: "free" },
        { host: "b.com", mode: "free" },
      ],
      anySite: true,
      excludedSites: [],
    });
  });

  it("prefers the entries the server sent over the flat list beside them", async () => {
    // `entries` carries the MODE. Falling back to `allowed` when both are
    // present would report every approve-gated site as free.
    const { client } = stub({
      "GET /permissions": { allowed: ["a.com"], entries: [{ host: "a.com", mode: "approve" }] },
    });
    expect(await client.permissionEntries()).toEqual([{ host: "a.com", mode: "approve" }]);
    expect(await client.permissionScope()).toEqual({
      entries: [{ host: "a.com", mode: "approve" }],
      anySite: false,
      excludedSites: [],
    });
  });

  it("reports explicit per-agent denies with every scope mode", async () => {
    const { client } = stub({
      "GET /permissions": {
        allowed: ["allowed.example"],
        excludedSites: ["blocked.example"],
      },
    });
    expect(await client.permissionScope()).toEqual({
      entries: [{ host: "allowed.example", mode: "free" }],
      anySite: false,
      excludedSites: ["blocked.example"],
    });
  });

  it("escapes a site in the deny path and builds the connect link from its options", async () => {
    const { client, calls } = stub({
      "POST /permissions": { allowed: "shop.example" },
      "DELETE /permissions/a%2Fb": { removed: true },
      "GET /connect-link?host=shop.example&label=Shop&mode=credential": {
        setupUrl: "https://unfenced.ai/connect/xyz",
      },
    });
    expect(await client.allow("shop.example")).toBe("shop.example");
    expect(await client.deny("a/b")).toBe(true);
    expect(calls[1]?.url, "a site with a slash became a second path segment").toBe(
      "/permissions/a%2Fb",
    );
    expect(await client.connectLink("shop.example", { label: "Shop", mode: "credential" })).toBe(
      "https://unfenced.ai/connect/xyz",
    );
  });
});

describe("the Session façade", () => {
  /** A session over a stub, plus the calls its client made. */
  function session(routes: Record<string, unknown>): { page: Session; calls: Call[] } {
    const { client, calls } = stub(routes);
    return {
      page: new Session(client, "abcd1234", { url: "https://example.com" } as never),
      calls,
    };
  }

  const ACTED = { outcome: "acted", snapshot: { url: "https://example.com" } };

  it("folds each shorthand onto the action it names", async () => {
    // Every one of these is a one-line delegation, and a one-line delegation is
    // exactly what gets copy-pasted with the wrong `kind` left in it.
    const routes = { "POST /session/abcd1234/act": ACTED };
    const cases: Array<[(p: Session) => Promise<unknown>, Record<string, unknown>]> = [
      [(p) => p.click("k1:e1"), { kind: "click", ref: "k1:e1" }],
      [
        (p) => p.type("k1:e2", "hello", { submit: true }),
        { kind: "type", ref: "k1:e2", text: "hello", submit: true },
      ],
      [(p) => p.select("k1:e3", "Olive"), { kind: "select", ref: "k1:e3", value: "Olive" }],
      [(p) => p.press("Enter"), { kind: "press", key: "Enter" }],
      [(p) => p.scroll("bottom"), { kind: "scroll", to: "bottom" }],
      [
        (p) => p.navigate("https://example.com/next", { settleMs: 500 }),
        { kind: "navigate", url: "https://example.com/next", settleMs: 500 },
      ],
      [(p) => p.back(), { kind: "back" }],
    ];
    for (const [call, expected] of cases) {
      const { page, calls } = session(routes);
      await call(page);
      expect(calls[0]?.url, `${JSON.stringify(expected)} went to the wrong path`).toBe(
        "/session/abcd1234/act",
      );
      expect(calls[0]?.body).toMatchObject(expected);
    }
  });

  it("carries its own id into every read, so a caller cannot pass the wrong one", async () => {
    const { page, calls } = session({
      "POST /session/abcd1234/observe": { url: "https://example.com" },
      "GET /session/abcd1234?match=account": {
        page: { url: "https://example.com/account" },
        providerSession: "carried",
      },
      "GET /session/abcd1234/extract?format=markdown": {
        doc: { title: "T" },
        content: "x",
        url: "u",
      },
      "GET /session/abcd1234/downloads": { downloads: [{ filename: "a.csv" }] },
      "POST /session/abcd1234/park": { ok: true },
      "GET /session/abcd1234/screenshot": { image: "data:image/png;base64,AAA" },
      "DELETE /session/abcd1234": { wasOpen: true },
    });
    await page.observe({ match: "next" });
    await expect(page.refresh({ match: "account" })).resolves.toEqual({
      page: { url: "https://example.com/account" },
      providerSession: "carried",
    });
    await page.extract();
    await page.downloads();
    await page.park(5, "waiting for a code");
    await page.screenshot();
    const closed = await page.close();
    for (const call of calls) {
      expect(call.url, `${call.url} did not carry the session id`).toContain("abcd1234");
    }
    // `wasOpen` survives the façade. Narrowing this return drops it for every
    // caller who goes through a Session, which is what the method's own comment
    // in session.ts warns about.
    expect(closed).toEqual({ wasOpen: true });
  });

  it("forwards reporting options separately from the action fields", async () => {
    const { page, calls } = session({ "POST /session/abcd1234/act": ACTED });
    await page.click("k1:e1", {
      confirm: true,
      expect: { url: "/orders/*", ms: 900 },
      brief: true,
    });
    expect(calls[0]?.body).toEqual({
      kind: "click",
      ref: "k1:e1",
      confirm: true,
      expect: { url: "/orders/*", ms: 900 },
      brief: true,
    });
  });

  it("keeps the snapshot it was opened with", () => {
    const { page } = session({});
    expect(page.id).toBe("abcd1234");
    expect(page.initial).toMatchObject({ url: "https://example.com" });
  });
});

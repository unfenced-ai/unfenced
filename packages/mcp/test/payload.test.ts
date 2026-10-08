import { describe, expect, it } from "vitest";
import {
  actFailure,
  failurePayload,
  fetchPayload,
  missingField,
  parseDataUri,
  remedyFor,
  rankForCrawling,
  saysSomethingNew,
} from "../src/tools.js";

describe("parseDataUri - the screenshot the see_page tool returns as an image", () => {
  it("splits a data URI into base64 and mime type", () => {
    expect(parseDataUri("data:image/jpeg;base64,/9j/abcDEF")).toEqual({
      mimeType: "image/jpeg",
      data: "/9j/abcDEF",
    });
    expect(parseDataUri("data:image/png;base64,iVBORw0KGgo=")).toEqual({
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
    });
  });

  it("returns null for anything that is not a base64 data URI", () => {
    // A plain URL, a non-base64 data URI, and an empty body must not be sent as
    // an image block - the tool reports "no frame" instead.
    expect(parseDataUri("https://example.com/x.jpg")).toBeNull();
    expect(parseDataUri("data:text/plain,hello")).toBeNull();
    expect(parseDataUri("data:image/jpeg;base64,")).toBeNull();
    expect(parseDataUri("")).toBeNull();
  });
});

/**
 * The shape an agent actually receives.
 *
 * This file had no tests at all - 681 lines deciding what a caller is told,
 * behind `"test": "node -e process.exit(0)"`. Every defect worth finding here
 * is a wording or a shape, which is exactly what a running server does not
 * complain about: a reply that says the wrong thing is still a valid reply.
 */
const doc = (over: Record<string, unknown> = {}) => ({
  markdown:
    "# A headline\n\nThe council voted on Tuesday to approve the measure after a long debate.",
  title: "A headline",
  pageType: "article",
  wordCount: 14,
  ...over,
});
const meta = (over: Record<string, unknown> = {}) => ({
  tier: 1,
  renderedJs: false,
  finalUrl: "https://ex.com/x",
  durationMs: 12,
  ...over,
});

describe("a description is not a second copy of the first paragraph", () => {
  const content = "The council voted on Tuesday to approve the measure after a long debate.";

  it("drops one that repeats the body", () => {
    expect(saysSomethingNew(content, content)).toBe(false);
  });

  it("drops a truncated lede, ellipsis and all", () => {
    expect(saysSomethingNew("The council voted on Tuesday to approve the…", content)).toBe(false);
  });

  it("drops one whose punctuation was straightened on the way out", () => {
    expect(saysSomethingNew("The council voted on Tuesday, to approve the measure!", content)).toBe(
      false,
    );
  });

  it("keeps a summary that says something the body does not", () => {
    expect(saysSomethingNew("What the vote means for local budgets next year.", content)).toBe(
      true,
    );
  });

  it("treats an absent description as nothing to say", () => {
    expect(saysSomethingNew(null, content)).toBe(false);
    expect(saysSomethingNew("   ", content)).toBe(false);
  });

  it("keeps it out of the reply when it is redundant", () => {
    const payload = fetchPayload({
      doc: doc({
        description: "The council voted on Tuesday to approve the measure after a long debate.",
      }),
      meta: meta(),
    });
    expect(payload).not.toHaveProperty("description");
  });

  it("and in when it is not", () => {
    const payload = fetchPayload({
      doc: doc({ description: "Analysis: what the vote changes for local budgets." }),
      meta: meta(),
    });
    expect(payload.description).toBe("Analysis: what the vote changes for local budgets.");
  });
});

describe("a failure tells the caller what to do about it", () => {
  it("gives a private address and an unresolvable host different answers", () => {
    // One code covering both meant anyone watching for SSRF was counting typos.
    const blocked = remedyFor("blocked-target", "10.0.0.1");
    const missing = remedyFor("dns-failed", "nope.invalid");
    expect(blocked).toBeTruthy();
    expect(missing).toBeTruthy();
    expect(blocked).not.toBe(missing);
  });

  it("explains a redirect loop as the site's problem", () => {
    expect(remedyFor("redirect-loop")).toMatch(/circle|loop/i);
  });

  it("does not send an agent to inspect a site nothing contacted", () => {
    // An egress refusal happens before a byte moves: the account leaves through
    // its own exit address and this worker cannot use it. Reported as `network`
    // it arrived as "check the host is correct and public", which is a loop with
    // no exit - the host IS correct, and every other URL fails the same way.
    const egress = remedyFor("exit-unavailable");
    const network = remedyFor("network");
    expect(egress).toBeTruthy();
    expect(egress).not.toBe(network);
    expect(egress).not.toMatch(/check the host/i);
    // It has to say the two things that end the loop: not the URL, and not
    // solvable from here.
    expect(egress).toMatch(/no other URL|different machine|configuration/i);
  });

  it("tells a caller which field to drop for an exit conflict", () => {
    // The other half, and it is the caller's to fix: only the request can
    // remove the proxy field it sent.
    const conflict = remedyFor("exit-conflict");
    expect(conflict).toMatch(/proxy/i);
    expect(conflict).not.toBe(remedyFor("exit-unavailable"));
  });

  it("carries the code, the detail and a remedy", () => {
    // No `url` here: `failurePayload` does not take one and never carried it.
    // The caller knows which URL it asked for, and `fetch_batch` labels each
    // result with its own url before spreading this in.
    const p = failurePayload({ error: "blocked", detail: "challenge page detected" });
    expect(p.error).toBe("blocked");
    expect(p.detail).toBe("challenge page detected");
    expect(p).toHaveProperty("remedy");
  });

  it("names the field an action is missing rather than saying it is malformed", () => {
    expect(missingField("navigate")).toContain("url");
    expect(missingField("type")).toContain("ref");
    expect(missingField("click")).toContain("ref");
  });

  it("keeps act failures in the same envelope as everything else", () => {
    const p = actFailure({ reason: "that element does not accept text - it is a link" });
    expect(p.error).toBeTruthy();
    expect(String(p.detail)).toContain("does not accept text");
  });

  it("surfaces a setupUrl (and never a retry) for a credential wall", () => {
    const p = actFailure({
      credentialRequired: "chatgpt.com",
      setupUrl: "https://dash/x?connect=chatgpt.com",
    });
    expect(p.error).toBe("credential-required");
    expect(p.setupUrl).toBe("https://dash/x?connect=chatgpt.com");
    expect(String(p.remedy)).toContain("https://dash/x?connect=chatgpt.com");
    // Still carries the guard that the model must NOT ask for the password.
    expect(String(p.remedy)).toMatch(/DO NOT ask the user to paste/i);
  });

  it("surfaces a setupUrl for a permission wall", () => {
    const p = actFailure({
      permissionRequired: "chatgpt.com",
      setupUrl: "https://dash/sites?grant=chatgpt.com",
    });
    expect(p.error).toBe("permission-required");
    expect(p.setupUrl).toBe("https://dash/sites?grant=chatgpt.com");
  });

  it("handles an approval wall distinctly - no retry, carries the link", () => {
    const p = actFailure({
      approvalRequired: "acme.com",
      setupUrl: "https://dash/sites?grant=acme.com",
    });
    expect(p.error).toBe("approval-required");
    expect(p.setupUrl).toBe("https://dash/sites?grant=acme.com");
    expect(String(p.remedy)).toContain("do not retry");
    expect(String(p.remedy)).toContain("approve");
  });

  it("omits setupUrl when the wall has none", () => {
    const p = actFailure({ permissionRequired: "x.com" });
    expect(p.error).toBe("permission-required");
    expect("setupUrl" in p).toBe(false);
  });
});

describe("the reply carries what a caller needs and nothing it already has", () => {
  it("reports the true word count alongside truncated content", () => {
    const p = fetchPayload({
      doc: doc({ wordCount: 4000 }),
      meta: meta({ contentTruncated: true, totalWords: 4000 }),
      content: "a short excerpt",
    });
    expect(p.totalWords).toBe(4000);
    expect(p.contentTruncated).toBe(true);
  });

  it("does not invent a total when the fetch stopped before reading the tail", () => {
    const p = fetchPayload({
      doc: doc({ wordCount: 4000 }),
      meta: meta({ contentTruncated: true, omissions: [{ kind: "byte-cap", unit: "bytes" }] }),
      content: "a short excerpt",
    });
    expect(p).not.toHaveProperty("totalWords");
    expect(p.omissions).toEqual([{ kind: "byte-cap", unit: "bytes" }]);
  });

  it("names the MCP html ceiling separately from upstream omissions", () => {
    const p = fetchPayload(
      {
        doc: doc(),
        meta: meta({ omissions: [{ kind: "hidden-text", amount: 3, unit: "words" }] }),
        content: "abcdef",
      },
      "html",
      3,
    );
    expect(p.content).toBe("abc");
    expect(p.omissions).toEqual([
      { kind: "hidden-text", amount: 3, unit: "words" },
      { kind: "character-cap", amount: 3, unit: "characters" },
    ]);
  });

  it("warns only when confidence is low", () => {
    const high = fetchPayload({
      doc: doc({ confidence: { level: "high", reasons: [] } }),
      meta: meta(),
    });
    expect(high).not.toHaveProperty("contentConfidence");

    const low = fetchPayload({
      doc: doc({ confidence: { level: "low", reasons: ["marked as subscriber-only"] } }),
      meta: meta(),
    });
    expect(low.contentConfidence).toBe("low");
    expect(low.contentWarnings).toEqual(["marked as subscriber-only"]);
  });
});

/**
 * Advice that matches the case, not the family.
 *
 * An external QA run got HTTP 401 from WSJ and was told "a 404 usually means
 * the path moved rather than that the site is down". The advice described a
 * different status, and the correct move for a 401 is close to its opposite:
 * the URL is right and a session is missing.
 *
 * A remedy is the main steering signal an agent gets from a failure. A wrong
 * one does not merely fail to help - it routes the recovery somewhere useless.
 */
describe("a remedy for a specific status", () => {
  it("does not explain a 404 to a caller who got a 401", () => {
    const r = remedyFor("blocked", "HTTP 401") ?? "";
    expect(r).not.toMatch(/404/);
    expect(r).toMatch(/signed-in|login|session/i);
  });

  it.each([
    [403, /refused|browser tier|gated/i],
    [404, /moved|no page/i],
    [410, /gone|not come back/i],
    [429, /rate-limit|wait/i],
    [500, /server failed|try again/i],
    [503, /unavailable|challenge|try again/i],
  ])("says something true about HTTP %s", (status, shape) => {
    expect(remedyFor("http-error", `HTTP ${status}`) ?? "").toMatch(shape);
  });

  it("tells a 5xx to come back and a 410 not to", () => {
    // The two ends of the same family, which the one generic string could not
    // distinguish: one is worth retrying and one never will be.
    expect(remedyFor("transient", "HTTP 500") ?? "").toMatch(/try again/i);
    expect(remedyFor("http-error", "HTTP 410") ?? "").not.toMatch(/try again/i);
  });

  it("keeps the family remedy when the status is not one it knows", () => {
    expect(remedyFor("http-error", "HTTP 418")).toBeTruthy();
  });

  it("names a bad certificate as a bad certificate", () => {
    // "check the host is correct and public" was the old advice. The host is
    // correct; the certificate is not, and that is not a retry.
    const r = remedyFor("network", "the site's certificate could not be verified") ?? "";
    expect(r).toMatch(/certificate/i);
    expect(r).not.toMatch(/check the host is correct/i);
    // And it must not suggest the one recovery nobody should take.
    expect(r).not.toMatch(/disable|ignore|insecure|--no-check/i);
  });
});

/**
 * Which links survive the cap.
 *
 * Asking for two content links from a Wikipedia article returned two `File:`
 * images with empty anchor text. `scope: "content"` had narrowed to the article
 * correctly — the mechanism worked — and then spent the whole budget on the two
 * least useful things inside it. For a caller crawling one level out, zero of
 * the returned links were usable.
 *
 * Ordering only matters because of the cap. Without one the caller sorts for
 * itself; with one, whatever the DOM happened to put first decides what the
 * caller ever sees.
 */
describe("ranking links for a caller that will truncate", () => {
  const file = { url: "https://en.wikipedia.org/wiki/File:Logo.svg", text: "" };
  const media = { url: "https://en.wikipedia.org/wiki/Media:Sound.ogg", text: "" };
  const article = { url: "https://en.wikipedia.org/wiki/Pikachu", text: "Pikachu" };
  const bare = { url: "https://en.wikipedia.org/wiki/Charizard", text: "" };

  it("puts a named article ahead of an unnamed image", () => {
    expect(rankForCrawling([file, media, article])[0]).toEqual(article);
  });

  it("prefers a named link over an unnamed one", () => {
    const ranked = rankForCrawling([bare, article]);
    expect(ranked[0]).toEqual(article);
  });

  it("prefers an article over a file even when neither is named", () => {
    const ranked = rankForCrawling([file, bare]);
    expect(ranked[0]).toEqual(bare);
  });

  it("drops nothing - a bigger maxLinks still returns everything", () => {
    // Demotion, not exclusion. A caller asking for images is entitled to them;
    // this only decides who goes first when someone has to.
    const ranked = rankForCrawling([file, article, media, bare]);
    expect(ranked).toHaveLength(4);
    expect(new Set(ranked.map((l) => l.url)).size).toBe(4);
  });

  it("keeps document order within a rank, which is the page's own priority", () => {
    const a = { url: "https://x.test/a", text: "first" };
    const b = { url: "https://x.test/b", text: "second" };
    expect(rankForCrawling([a, b]).map((l) => l.text)).toEqual(["first", "second"]);
  });

  it("catches the namespace in other language editions too", () => {
    // `/wiki/Datei:` and `/wiki/Fichier:` are the same thing as `File:`, and
    // matching only the English spelling would fix this for one wiki.
    const de = { url: "https://de.wikipedia.org/wiki/Datei:Bild.svg", text: "" };
    const fr = { url: "https://fr.wikipedia.org/wiki/Fichier:Image.svg", text: "" };
    expect(rankForCrawling([de, bare])[0]).toEqual(bare);
    expect(rankForCrawling([fr, bare])[0]).toEqual(bare);
  });

  it("leaves an ordinary site's links alone", () => {
    // Nothing here should reorder a normal page, where every link is an
    // article by this definition and ranking is a no-op.
    const links = [
      { url: "https://news.test/one", text: "One" },
      { url: "https://news.test/two", text: "Two" },
      { url: "https://news.test/three", text: "Three" },
    ];
    expect(rankForCrawling(links)).toEqual(links);
  });
});

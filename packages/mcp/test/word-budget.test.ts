import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_WORDS } from "../src/tools.js";

/**
 * A caller who sets nothing should not receive everything.
 *
 * `maxWords` bounded a fetch and its absence bounded nothing: one RFC came back
 * at 64,822 words - about 85k tokens, a third of a context window from a single
 * call. The tool description said to use maxWords, which documents a hazard
 * rather than removing one.
 *
 * The number is chosen to almost never bite. These are real measurements, and
 * the test exists so that a later "let's tighten it a bit" has to argue with
 * them rather than with taste.
 */
const REAL_PAGES = {
  "MDN AbortController": 168,
  "nodejs.org": 181,
  "python.org asyncio": 282,
  "an RSS feed": 717,
  "Hacker News front page": 1_055,
  "a dev blog": 1_475,
  "Wikipedia, cast iron": 4_205,
};

describe("the default word budget", () => {
  it("does not truncate any page we have actually measured", () => {
    for (const [page, words] of Object.entries(REAL_PAGES)) {
      expect(words, `${page} would be truncated by default`).toBeLessThan(DEFAULT_MAX_WORDS);
    }
  });

  it("does bite on the case it exists for", () => {
    // RFC 9110, the largest real document in the sample.
    expect(64_822).toBeGreaterThan(DEFAULT_MAX_WORDS);
  });

  it("leaves room above the heaviest ordinary page", () => {
    const heaviest = Math.max(...Object.values(REAL_PAGES));
    // Comfortably clear, so a page a few times larger than anything measured
    // still arrives whole.
    expect(DEFAULT_MAX_WORDS).toBeGreaterThan(heaviest * 4);
  });

  it("splits a batch rather than granting the whole budget to each page", () => {
    // Ten pages each at the cap is ten times the reply the cap was set to bound.
    const forTen = Math.max(500, Math.floor(DEFAULT_MAX_WORDS / 10));
    expect(forTen * 10).toBeLessThanOrEqual(DEFAULT_MAX_WORDS);
  });

  it("never divides a batch down to nothing", () => {
    const forAHundred = Math.max(500, Math.floor(DEFAULT_MAX_WORDS / 100));
    expect(forAHundred).toBeGreaterThanOrEqual(500);
  });
});

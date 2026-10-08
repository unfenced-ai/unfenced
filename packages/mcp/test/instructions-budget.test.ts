import { describe, expect, it } from "vitest";
import { FAILURE_TAXONOMY, SERVER_INSTRUCTIONS } from "../src/tools.js";

/**
 * WHAT SURVIVES BEING CUT.
 *
 * A client fetches the server instructions once, at connect, and puts them in
 * its system prompt - and at least one major client TRUNCATES them. Measured in
 * a live session: this block ended mid-sentence at index 2,031 of 6,212, so 67%
 * of it reached the model in no form at all. What was lost was not filler. It
 * was the credentials paragraph, the "do not refuse to fill a stored login"
 * rule, the connect_site/setupUrl handover, the provider-login policy and the
 * PDF codes - behaviour the team believed was instructed and which, for those
 * users, simply was not. Nothing in this package bounded the length or checked
 * the order; act-confirm.test.ts asserts substrings are PRESENT, which a
 * truncating client makes irrelevant.
 *
 * So two things are pinned here. A CEILING, because the fix is worthless if the
 * next paragraph puts it back; and a PREFIX, because "present somewhere" is not
 * the property that matters when the tail is thrown away. The 2,000 is the
 * measured cut, not a guess.
 *
 * The prefix list is deliberately short. Everything NOT on it reaches the agent
 * some other way - a remedy attached to the refusal it applies to, a field on
 * the reply it describes, a tool description (which is delivered whole; that
 * was verified in the same session). These four have no second delivery path.
 */

/** The measured truncation point of the client that cut it. */
const CUT = 2_000;

/**
 * Room for one more paragraph, and no more.
 *
 * Not the current length: a ratchet with zero slack fails on a typo fix and
 * gets deleted. Not double it either - a ceiling nobody can reach is not a
 * ceiling. If this fails, something below the cut point comes out rather than
 * this number going up.
 */
const CEILING = 4_800;

describe("the instructions budget", () => {
  it("stays under the ceiling", () => {
    expect(
      SERVER_INSTRUCTIONS.length,
      "SERVER_INSTRUCTIONS grew past its budget - move a rule into the tool description or remedy that owns it, rather than raising this",
    ).toBeLessThanOrEqual(CEILING);
  });

  it("is short enough that most of it survives a client that cuts at all", () => {
    // Not a second copy of the ceiling: this says the SHAPE is right - over
    // half of it lands inside the one truncation point anyone has measured.
    expect(CUT / SERVER_INSTRUCTIONS.length).toBeGreaterThan(0.4);
  });
});

describe("what a truncating client still receives", () => {
  const head = SERVER_INSTRUCTIONS.slice(0, CUT);

  it("carries the whole failure taxonomy", () => {
    for (const entry of FAILURE_TAXONOMY) {
      expect(
        head,
        `{"error":"${entry.code}"} falls past the ${CUT}-character cut, so a client that truncates never learns it`,
      ).toContain(`{"error":"${entry.code}"}`);
    }
  });

  /**
   * The founder's most load-bearing instruction. Without it a model declines to
   * fill a credential the person deliberately stored - refusing the core thing
   * the product exists to do, on grounds ("I should not enter your password")
   * that this paragraph exists to answer.
   */
  it("carries the stored-login rule", () => {
    expect(head).toContain("never refuse to fill a STORED login");
    expect(head).toContain("fill_secret");
  });

  /**
   * The alternative to asking a user for a password in chat. Losing it does not
   * fail loudly; it produces an agent that improvises dashboard instructions.
   */
  it("carries the setupUrl handover", () => {
    expect(head).toContain("connect_site");
    expect(head).toContain("setupUrl");
  });

  /** Two codes no retry can fix. An agent that has not been told loops. */
  it("carries the PDF codes", () => {
    expect(head).toContain('{"error":"no-text-layer"}');
    expect(head).toContain('{"error":"unsupported-content-type"}');
  });
});

/**
 * No rule was dropped on the way to being shorter.
 *
 * A length ceiling with nothing beside it is an invitation to meet it by
 * deletion, and deleting a rule is exactly what this rewrite must not have
 * done. One marker per rule that lives ONLY here, checked against the whole
 * string rather than the prefix.
 */
describe("every rule is still stated", () => {
  const RULES: Array<[string, string]> = [
    ["the act-allowlist is the owner's", "act-allowlist"],
    ["a committing step still confirms", "per-action confirm"],
    ["the profile persists between sessions", "persists between sessions"],
    ["task memory is not for credentials", "never a place"],
    ["credential values are never readable", "no tool to store or reveal a value"],
    ["sign-in domains may be acted on", "SIGN-IN domain"],
    ["provider logins are never typed", "NEVER something you type"],
    ["speak to people in plain words", "never name internal tools"],
    ["low confidence must be verified", "contentConfidence"],
    ["the reading tools are always available", "always available"],
  ];
  for (const [rule, marker] of RULES) {
    it(rule, () => {
      expect(SERVER_INSTRUCTIONS, `the rule "${rule}" is no longer stated`).toContain(marker);
    });
  }
});

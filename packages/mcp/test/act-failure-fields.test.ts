import { describe, expect, it } from "vitest";
import { actFailure } from "../src/tools.js";

/**
 * WHAT A REFUSAL IS ALLOWED TO THROW AWAY.
 *
 * `actFailure`'s parameter list is a WHITELIST, and that shape has already cost
 * this product once: for the whole life of `on`, the engine answered an
 * ambiguity with every candidate and a usable ref for each, and this function
 * flattened all of it into a `detail` string. Three separate agents concluded
 * the same booking site "cannot be driven". The refs were there the entire time.
 *
 * A whitelist fails silently by construction - a field simply is not there, no
 * type complains, and the only way to notice is to already know what you are
 * missing. So this test asserts the fields exist on EVERY branch rather than on
 * the one that happened to be fixed, because the defect was never one branch. It
 * was the shape.
 */

/** One argument per refusal branch, so a new branch that forgets is caught. */
const BRANCHES: Array<[string, Record<string, unknown>]> = [
  ["a one-time-code wall", { credentialRequired: "example.com", otpField: true }],
  ["a password wall", { credentialRequired: "example.com" }],
  ["an ungranted site", { permissionRequired: "example.com" }],
  ["a site awaiting approval", { approvalRequired: "example.com" }],
  ["an action that submits", { confirmationRequired: "this submits. Re-send with confirm: true." }],
  ["anything else", { reason: "the page refused that action" }],
];

describe("every refusal carries what the agent needs to answer it", () => {
  for (const [name, base] of BRANCHES) {
    it(`${name} keeps the engine's own code`, () => {
      // An agent branching on a SENTENCE breaks when the sentence is reworded,
      // and we reword them. `error` is a coarse bucket kept stable for cached
      // schemas; `code` is the precise cause.
      const out = actFailure({ ...base, code: "target-not-ready" });
      expect(out["code"], `${name} dropped the code`).toBe("target-not-ready");
    });

    it(`${name} reports a dialog the page raised`, () => {
      // THE SILENT ONE. A click opens a confirm(), the dialog is dismissed
      // before anything can see it, the act is refused for a reason that looks
      // unrelated, and nothing in the answer says the page asked a question at
      // all. An agent cannot reason about a wall it is not told exists.
      const dialogs = [{ type: "confirm", message: "Delete this?", handled: "dismissed" }];
      const out = actFailure({ ...base, dialogs });
      expect(out["dialogs"], `${name} dropped the dialogs`).toEqual(dialogs);
    });

    it(`${name} keeps a page the engine attached`, () => {
      // THE THIRD FIELD THIS WHITELIST ATE, pinned before it can be a fourth.
      // `candidates` went missing for the whole life of `on` and `dialogs` for
      // the whole life of dialog capture; both times the engine sent exactly the
      // thing that would have unblocked the agent, and both times the symptom
      // was an agent reporting that the site could not be driven.
      //
      // A stale ref now comes back WITH the current page, so the agent retargets
      // out of the refusal instead of spending a round trip on observe_page.
      // That saving exists only if this function passes it on.
      const page = { url: "https://example.com/", title: "Example" };
      const out = actFailure({ ...base, page });
      expect(out["page"], `${name} dropped the page`).toEqual(page);
    });

    it(`${name} still names its error bucket`, () => {
      const out = actFailure(base);
      expect(typeof out["error"]).toBe("string");
      expect(out["detail"] ?? out["remedy"], `${name} refused with nothing to read`).toBeTruthy();
    });
  }

  /**
   * AND THE ADVICE HAS TO MATCH WHAT WAS SENT.
   *
   * `ref-stale` used to be the one code the generic remedy was RIGHT about:
   * "observe_page for a fresh snapshot, then try the action again". Now the
   * snapshot arrives with the refusal, so that same sentence spends a round trip
   * fetching something already in hand - and a remedy is the main steering signal
   * an agent gets, so a stale one does not merely fail to help.
   */
  it("tells a stale ref to use the attached page rather than fetch it again", () => {
    const out = actFailure({
      code: "ref-stale",
      reason: "that element is gone from the page - observe again",
      page: { url: "https://example.com/", title: "Example" },
    });
    const remedy = String(out["remedy"] ?? "");
    expect(remedy, "ref-stale fell through to the generic act-failed remedy").toMatch(/`page`/);
    expect(remedy).toMatch(/do not call observe_page/i);
  });

  it("keeps every candidate, with its ref", () => {
    const candidates = [
      { ref: "k1:e1", role: "button", name: "Book now", within: "inside" },
      { ref: "k1:e2", role: "button", name: "Book now", within: "Covered balcony" },
    ];
    const out = actFailure({ reason: "2 things read that", candidates });
    expect(out["candidates"]).toEqual(candidates);
  });

  /**
   * THE ERROR VALUES ARE A PUBLISHED CONTRACT.
   *
   * An agent's connector caches the tool description at connect time, and the
   * worker and the dashboard deploy separately — so a caller branching on
   * `error` may be running against a months-old copy of this list. Renaming one
   * is not a refactor; it is a silent breaking change to every agent that has
   * already read the old name.
   */
  it("does not rename an error an agent may already be matching on", () => {
    const seen = new Set<string>();
    for (const [, base] of BRANCHES) seen.add(actFailure(base)["error"] as string);
    for (const e of [
      "otp-required",
      "credential-required",
      "permission-required",
      "approval-required",
      "confirmation-required",
      "act-failed",
    ]) {
      expect(seen, `the "${e}" bucket is no longer produced by any branch`).toContain(e);
    }
  });

  it("says nothing it was not given", () => {
    // The other direction: absent stays absent. A refusal that manufactured an
    // empty `candidates` or a null `code` would have agents branching on the
    // presence of a field that means nothing.
    const out = actFailure({ reason: "plain" });
    expect(out["code"]).toBeUndefined();
    expect(out["dialogs"]).toBeUndefined();
    expect(out["candidates"]).toBeUndefined();
    expect(out["note"]).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { plainLegend, seeLegend } from "../src/tools.js";

/**
 * WHAT A PICTURE IS ALLOWED TO ARRIVE WITHOUT.
 *
 * `seeLegend` is a hand-written projection of a richer object, which is the same
 * shape as `actFailure` - and that shape has already cost this product once. For
 * the whole life of `on`, the engine answered an ambiguity with a usable ref for
 * every candidate and the projection flattened all of it into a sentence; three
 * agents concluded a booking site could not be driven while the refs sat there.
 *
 * A projection fails silently by construction: a field simply is not there, no
 * type complains, and the only way to notice is to already know what is missing.
 * So the fields are asserted here rather than trusted to review.
 *
 * The image is useless without this text. An agent that can see a box and cannot
 * learn which ref it belongs to is exactly where it was before any of this was
 * built - looking at a page it cannot act on.
 */

const view = {
  marks: [
    { mark: 1, ref: "abc123:e0", role: "button", name: "Tel Aviv" },
    { mark: 2, ref: "abc123:e1", role: "button", name: "2 people" },
  ],
  undeclared: ["1 person", "3 people"],
  note: "1 of 6 controls have no box: scrolled out of view.",
};

describe("the text that makes a screenshot actionable", () => {
  it("carries a ref for every box it says is drawn", () => {
    // THE ONE THAT MATTERS. A number on a box is not an address.
    const out = seeLegend(view);
    for (const mark of view.marks) {
      expect(out, `mark ${mark.mark} arrived without its ref`).toContain(mark.ref);
    }
  });

  it("keeps the mark numbers, so a box can be looked up at all", () => {
    const parsed = JSON.parse(seeLegend(view).slice(seeLegend(view).indexOf("{")));
    expect(parsed.marks.map((m: { mark: number }) => m.mark)).toEqual([1, 2]);
    expect(parsed.marks[0].name).toBe("Tel Aviv");
    expect(parsed.marks[0].role).toBe("button");
  });

  it("passes on what has no box, which is the other half of the answer", () => {
    // Things the page draws as clickable and never declared cannot be marked,
    // and an agent told only about boxes would read their absence as absence.
    const out = seeLegend(view);
    expect(out).toContain("3 people");
    expect(out, "nothing told the agent how to reach an unmarked thing").toContain("on");
  });

  it("explains a gap between the boxes and the list", () => {
    expect(seeLegend(view)).toContain("scrolled out of view");
  });

  it("says how many boxes are on the image, before any JSON", () => {
    // A client that renders the text as prose and never parses it still learns
    // the useful thing. Cached connectors are all in that position.
    const out = seeLegend(view);
    expect(out.slice(0, out.indexOf("{"))).toContain("2 things");
  });

  it("stays valid when a page offered nothing to mark", () => {
    const out = seeLegend({ marks: [] });
    expect(out).toContain("0 things");
    const parsed = JSON.parse(out.slice(out.indexOf("{")));
    expect(parsed.marks).toEqual([]);
    // No empty keys for things that did not happen — an agent should not have to
    // distinguish "none" from "not applicable".
    expect(parsed.undeclared).toBeUndefined();
    expect(parsed.note).toBeUndefined();
  });

  it("omits undeclared entirely when the page declared everything", () => {
    const parsed = JSON.parse(
      seeLegend({ marks: view.marks, note: "x" }).slice(
        seeLegend({ marks: view.marks, note: "x" }).indexOf("{"),
      ),
    );
    expect(parsed.undeclared).toBeUndefined();
  });

  it("says plainly when nothing was drawn, so an unmarked look is unambiguous", () => {
    const out = plainLegend("sess_1");
    expect(out).toContain("sess_1");
    expect(out).toContain("nothing drawn");
    expect(out).not.toContain("{");
  });
});

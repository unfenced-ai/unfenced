import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// The SHIPPED extractor, not a copy of it. A guard with its own idea of what
// the surface is can pass while the real surface shrinks - the copy would be
// the thing that rotted, and it is the only thing standing here.
import { surfaceHash, toolSurface } from "../src/tools.js";

/**
 * THE TOOL SCHEMA IS A PUBLISHED CONTRACT, AND IT MAY ONLY GROW.
 *
 * An MCP client fetches tools/list ONCE, when the connector is added, and caches
 * it. The HTTP transport here is stateless on purpose - a fresh McpServer per
 * request, torn down after (src/http.ts) - so there is no persistent connection
 * to push notifications/tools/list_changed over. The server is therefore always
 * current and the client is frequently not, and we cannot tell it otherwise.
 *
 * That asymmetry decides which changes are safe:
 *
 *   ADDING a tool, a parameter, or an enum member is invisible to a connected
 *   client and breaks nothing. It simply cannot use the new thing until it
 *   reconnects. Every change shipped on 31 Aug 2026 was of this kind.
 *
 *   REMOVING or RENAMING one is a silent break in somebody else's running
 *   system. A renamed tool is "tool not found". A removed parameter is dropped
 *   by validation and the call quietly does something else. A narrowed enum
 *   rejects calls that were valid yesterday.
 *
 * So the surface is snapshotted and the snapshot may only be a SUBSET of what
 * ships. Additions pass silently, which is the point: this is not a change
 * detector, and a test that made every addition a chore would be turned off
 * within a week. It fails on exactly one thing - taking something away.
 *
 * WHEN THIS FAILS, and you meant it: you are about to break every agent already
 * connected. Deprecate instead - keep the old name working beside the new one -
 * or, if it truly must go, remove it from the baseline in the same commit, so
 * the break is a thing somebody chose and can be found in the history.
 *
 * SO WHAT IF YOU GENUINELY NEED TO REMOVE SOMETHING? Three answers, in order of
 * how often they are the right one:
 *
 *   1. DEPRECATE. Keep the old name registered and accepted, delegating to the
 *      new one, and say so in its description. Costs a few lines and breaks
 *      nobody. This is almost always the answer.
 *   2. WAIT UNTIL IT IS DEAD. The server sees every call, so "is anyone still
 *      sending this" is a question with an answer rather than a guess. Retire it
 *      when that number has been zero for a while.
 *   3. REMOVE IT DELIBERATELY. Delete the entry from the baseline in the SAME
 *      commit. The guard then passes, and the break is recorded as a decision
 *      somebody made, with their reasoning, in a place the next person will
 *      find. That is the whole point: this does not forbid removal, it forbids
 *      removing something BY ACCIDENT.
 *
 * AND WHAT IF THE SURFACE IS WRONG RATHER THAN MERELY OLD?
 *
 * Most repairs touch no surface at all. This guard watches NAMES and the closed
 * sets they admit; it says nothing about what they do. `within` resolved the
 * wrong element until 31 Aug 2026 - one level of DOM climb short - and fixing it
 * changed the contract not at all. Every caller kept sending the same call and
 * started getting the right answer. That is the ordinary case and it is free.
 *
 * When the surface itself is the defect - a value that must stop working, a
 * default that is dangerous - prefer a REFUSAL over a REMOVAL, and the reason is
 * the same asymmetry this whole file is about. Removing a value from the schema
 * is invisible to a connected client: it goes on sending the value, validation
 * strips it, and the call quietly does something the caller did not ask for.
 * Keeping the value and refusing it with a reason is SERVER-GENERATED, so it
 * reaches every stale client there is, and it tells the agent what to do
 * instead. `engineFacts()` in server/src/routes/diagnostics.ts exists for
 * exactly this: it rides on refusals precisely because a tool description
 * cannot reach the people who most need it.
 *
 * The exception is a security repair. Deprecation keeps a hole open, so there
 * the break IS the fix - narrow it, delete the entry from the baseline in the
 * same commit, and say in the message that breaking callers was the intent.
 *
 * The one removal that is always safe is surface no client could be using -
 * something that never worked. `within` was in that state until 31 Aug 2026:
 * declared nowhere, stripped at the connector, unsendable. Removing dead-on-
 * arrival surface breaks nobody, and the commit should say that is what it is.
 *
 * Run with UPDATE_MCP_SURFACE=1 to rewrite the baseline after a deliberate
 * removal.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(here, "mcp-surface.json");

type Surface = ReturnType<typeof toolSurface>;

describe("the MCP surface only ever grows", () => {
  const now = toolSurface();

  if (process.env["UPDATE_MCP_SURFACE"]) {
    writeFileSync(BASELINE, JSON.stringify(now, null, 2), "utf8");
  }
  const was = JSON.parse(readFileSync(BASELINE, "utf8")) as Surface;

  it("still offers every tool it has ever offered", () => {
    const gone = Object.keys(was).filter((t) => !now[t]);
    expect(
      gone,
      "a renamed or removed tool is 'tool not found' to every agent already connected. " +
        "To rename: register the NEW name and keep the old one registered beside it, " +
        "delegating to the same handler. To retire one for good: delete it from " +
        "mcp-surface.json in the same commit, so the break is a thing somebody chose and " +
        "can be found in the history.",
    ).toEqual([]);
  });

  it("still accepts every parameter it has ever accepted", () => {
    const lost: string[] = [];
    for (const [tool, shape] of Object.entries(was)) {
      if (!now[tool]) continue;
      for (const p of shape.params) {
        if (!now[tool]!.params.includes(p)) lost.push(`${tool}.${p}`);
      }
    }
    expect(
      lost,
      "a removed parameter is silently dropped by validation, so the call does not fail - it " +
        "quietly does something else, which is worse. To rename: keep the old name accepted and " +
        "map it onto the new one. To retire it: delete it from mcp-surface.json in the same " +
        "commit, and say in the message why nobody can still be sending it.",
    ).toEqual([]);
  });

  it("never narrows a set of values it has ever admitted", () => {
    const lost: string[] = [];
    for (const [tool, shape] of Object.entries(was)) {
      for (const [param, values] of Object.entries(shape.enums)) {
        const current = now[tool]?.enums[param];
        // The parameter may have been widened past an enum entirely - `to` went
        // from an enum to a union this week - and that is a loosening, which is
        // safe. Only a still-closed set that lost a member is a break.
        if (!current) continue;
        for (const v of values) if (!current.includes(v)) lost.push(`${tool}.${param}=${v}`);
      }
    }
    expect(
      lost,
      "narrowing an enum rejects calls that were valid yesterday, from clients that cannot " +
        "know. Keep accepting the old member and treat it as the new one; drop it from " +
        "mcp-surface.json only once nothing sends it.",
    ).toEqual([]);
  });

  it("has a baseline worth checking against", () => {
    // A guard over an empty snapshot passes for ever and proves nothing.
    expect(Object.keys(was).length).toBeGreaterThan(5);
    expect(was["act"]?.params.length ?? 0).toBeGreaterThan(10);
  });
});

/**
 * THE HASH THE DASHBOARD COMPARES AGAINST.
 *
 * A key records which surface it was last served on tools/list; the dashboard
 * calls a connector stale when that differs from what the worker ships. Both
 * halves of that comparison have to behave, and two failures would be silent:
 * a hash that changed when nothing a caller can see changed would report every
 * connector as stale on every deploy, and a hash that ignored a real change
 * would report none of them ever.
 */
describe("the surface hash", () => {
  it("is stable across calls", () => {
    expect(surfaceHash()).toBe(surfaceHash());
  });

  it("is short enough to store and long enough to mean something", () => {
    expect(surfaceHash()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does not move when only a DESCRIPTION changes", () => {
    // The thing that would make this useless. Descriptions are prose written for
    // a model, reworded constantly — a hash over them would change on almost
    // every commit and cry wolf until nobody looked at the badge.
    const captured = JSON.stringify(toolSurface());
    expect(captured).not.toContain("Perform one action on an open page");
    expect(captured).not.toContain("describe");
  });

  it("covers what a caller can actually send", () => {
    const captured = JSON.stringify(toolSurface());
    for (const name of ["within", "expect", "modifiers", "maxControls"]) {
      expect(captured, `the ${name} parameter is invisible to the hash`).toContain(name);
    }
    // AND THE MEMBERS, not just the parameter names. Dropping enum capture left
    // every one of the assertions above passing, because the parameter still
    // exists — so narrowing `kind` or `modifiers` would have moved nothing and
    // no connector would ever have been told.
    const surface = toolSurface();
    expect(surface["act"]?.enums["kind"] ?? [], "act kinds are not in the hash").toContain(
      "fill_secret",
    );
    expect(surface["act"]?.enums["modifiers"] ?? [], "modifiers are not in the hash").toContain(
      "Shift",
    );
  });
});

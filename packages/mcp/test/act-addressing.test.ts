import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Unfenced } from "@unfenced-ai/sdk";
import { registerTools } from "../src/tools.js";

/**
 * A REMEDY AN AGENT CANNOT SEND IS NOT A REMEDY.
 *
 * `act` refuses an ambiguity with, verbatim, "re-send with within: naming the
 * region you mean" (core/src/session/aim.ts), and its own tool description tells
 * the agent to act "with `within` naming the region. Never guess and never give
 * up on it." The server reads `within` and `at` off the body (`pointer` in
 * server/src/routes/session-live.ts), the SDK's Action union declares both, and
 * the engine has resolved both since they shipped.
 *
 * The MCP inputSchema declared neither. Zod strips what a schema does not name,
 * silently and by design, so both fields died at the connector - and the only
 * move left to an agent holding a tie was to observe the page again (thousands
 * of tokens) and re-send the identical, identically ambiguous call. That is a
 * loop with no exit, and it is the shape of the eighty-four-second wall in the
 * ontopo trace: the instruction was true, the agent obeyed it, and the field
 * never left the building.
 *
 * This is `act-confirm.test.ts` one layer up. That file exists because `confirm`
 * was accepted by the schema and dropped by `toAction`; this one exists because
 * `within` and `at` were read by `toAction` and never accepted by the schema.
 * Same defect, opposite end of the same wire.
 *
 * SO IT PARSES THROUGH THE DECLARED SCHEMA, and does not merely call the
 * handler. Calling `tool.handler({...within})` directly passes with the field
 * missing from the schema - the handler takes a plain object and never sees the
 * validation that would have removed it. A test written that way would have gone
 * green against the exact bug it was written for, which is worse than no test,
 * because it reads as proof.
 */

interface Registered {
  config: { inputSchema?: Record<string, unknown>; description?: string };
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

function tools(): Map<string, Registered> {
  const found = new Map<string, Registered>();
  const server = {
    registerTool(name: string, config: Registered["config"], handler: Registered["handler"]) {
      found.set(name, { config, handler });
    },
  } as unknown as McpServer;
  registerTools(server, {} as unknown as Unfenced);
  return found;
}

/** The act tool's declared shape, as the SDK will actually validate it. */
function actSchema(): z.ZodObject<z.ZodRawShape> {
  const act = tools().get("act")!;
  return z.object(act.config.inputSchema as z.ZodRawShape);
}

describe("every way of naming a target survives the connector", () => {
  it("keeps `within` - the answer to an ambiguity, and the thing the refusal asks for", () => {
    const parsed = actSchema().parse({
      sessionId: "s1",
      kind: "click",
      on: "21:15 Book now",
      within: "Covered balcony",
    }) as { within?: string };
    expect(
      parsed.within,
      "the schema dropped `within`, so the refusal that asks for it cannot be answered",
    ).toBe("Covered balcony");
  });

  it("keeps `at` - the only way to reach a slider, a canvas or a map", () => {
    const parsed = actSchema().parse({
      sessionId: "s1",
      kind: "click",
      on: "volume",
      at: { x: 0.8, y: 0.5 },
    }) as { at?: { x: number; y: number } };
    expect(parsed.at, "the schema dropped `at`").toEqual({ x: 0.8, y: 0.5 });
  });

  it("keeps every other address it already carried", () => {
    // The regression this file guards is a field being READ by the server and
    // never DECLARED here, so the whole addressing set is asserted rather than
    // the two that were broken. The next one added without a schema line is the
    // next eighty-four-second wall.
    const parsed = actSchema().parse({
      sessionId: "s1",
      kind: "drag",
      ref: "k1:e7",
      toRef: "k1:e9",
      confirm: true,
    }) as Record<string, unknown>;
    for (const field of ["ref", "toRef", "confirm"]) {
      expect(parsed[field], `the schema dropped \`${field}\``).toBeDefined();
    }
  });

  it("lets scroll name an element, not just an edge of the window", () => {
    // The engine has always been able to scroll an element into view, and the
    // HTTP wire has always accepted `{ref}` - the schema capped `to` at
    // "top" | "bottom", so the one consumer that needed it could not ask. That
    // is what made a virtualised list unreachable past its mounted rows, and it
    // is invisible from core: only a schema-level test can see it.
    const parsed = actSchema().parse({
      sessionId: "s1",
      kind: "scroll",
      to: { ref: "k1:e7" },
    }) as { to?: { ref: string } };
    expect(parsed.to, "the schema dropped the {ref} form of `to`").toEqual({ ref: "k1:e7" });
    // Both edges still parse.
    for (const edge of ["top", "bottom"]) {
      expect(
        (actSchema().parse({ sessionId: "s1", kind: "scroll", to: edge }) as { to: string }).to,
      ).toBe(edge);
    }
  });

  it("lets wait ask for something to LEAVE", () => {
    const parsed = actSchema().parse({
      sessionId: "s1",
      kind: "wait",
      gone: "Saving…",
    }) as { gone?: string };
    expect(parsed.gone, "the schema dropped `gone`").toBe("Saving…");
  });

  it("keeps the modifiers a click was told to hold", () => {
    const parsed = actSchema().parse({
      sessionId: "s1",
      kind: "click",
      ref: "k1:e1",
      modifiers: ["Shift"],
    }) as { modifiers?: string[] };
    expect(parsed.modifiers).toEqual(["Shift"]);
    // Alt is not in the enum, and that is a security line rather than an
    // oversight: alt-click on a link is the browser download gesture.
    expect(() =>
      actSchema().parse({ sessionId: "s1", kind: "click", ref: "k1:e1", modifiers: ["Alt"] }),
    ).toThrow();
  });

  it("keeps a post-condition the caller attached to the act", () => {
    const parsed = actSchema().parse({
      sessionId: "s1",
      kind: "click",
      on: "Save",
      expect: { text: "Saved" },
    }) as { expect?: { text: string } };
    expect(parsed.expect).toEqual({ text: "Saved" });
  });

  it("refuses a fraction that is not a pair of numbers", () => {
    // `at` is two numbers or it is nothing. A string sails through an untyped
    // passthrough and arrives at the hit test as NaN, which resolves to whatever
    // is at the top-left corner - a click on something nobody named.
    expect(() =>
      actSchema().parse({ sessionId: "s1", kind: "click", at: { x: "0.8", y: 0.5 } }),
    ).toThrow();
    expect(() => actSchema().parse({ sessionId: "s1", kind: "click", at: { x: 0.8 } })).toThrow();
  });
});

/**
 * THE INVARIANT BEHIND THE BUG, not the bug.
 *
 * A tool description is a contract an agent reads and believes. When it names a
 * parameter, that parameter has to exist, or the description is an instruction
 * to do something impossible - which is strictly worse than saying nothing,
 * because the agent will keep trying.
 */
describe("the act tool cannot promise a parameter it does not accept", () => {
  it("declares every parameter its own description tells an agent to send", () => {
    const act = tools().get("act")!;
    const declared = new Set(Object.keys(act.config.inputSchema ?? {}));
    const prose = act.config.description ?? "";

    // Backticked words in the description that look like parameters, checked
    // against what the schema will actually let through. Deliberately drawn FROM
    // THE PROSE rather than from a list typed here: a hand-written list is a
    // second copy of the contract and would go stale the same way the schema did.
    const named = new Set(
      [...prose.matchAll(/`([a-z][a-zA-Z_]{1,20})`/g)].map((m) => m[1] as string),
    );
    // Words that are backticked in the description but are values, kinds or
    // fields of the REPLY rather than things you send. Named explicitly, so a
    // genuinely missing parameter cannot hide behind a loose filter.
    const notParameters = new Set([
      // `effect` is carried BY the reply when an act changed nothing - the one
      // field here an agent must read and must not send.
      "effect",
      // Evidence categories are values in the successful reply, not call
      // parameters. Keep them explicit so the prose/schema contract test
      // cannot mistake the response vocabulary for accepted input.
      "evidence",
      "navigation",
      "popup",
      "dialog",
      "postcondition",
      // A KIND, sent as `kind: "print"` and not as a parameter of its own. The
      // other kinds escape this check by living inside one backticked list; this
      // one is named on its own because it needed explaining.
      "print",
      // Also a KIND, named on its own in the description for the same reason.
      "save",
      // A REPLY field: the list of windows this session holds, which is what
      // close_window's description tells an agent to read. You send `window`
      // (singular, declared); you read `windows`.
      "windows",
      "candidates",
      "resolved",
      "dialogs",
      "engine",
      "reason",
      "detail",
      "ok",
      "page",
      "controls",
      "links",
      "excerpt",
      "truncated",
      "document",
      "role",
      "name",
      "value",
      "secret",
      "filled",
      "submits",
      "expanded",
      "hasPopup",
      "checked",
      "selected",
      "multiple",
      "badge",
      "chars",
      "frame",
      "status",
      "error",
      "session",
      "sessionId",
      "observe",
      "act",
      "see",
      "true",
      "false",
      "null",
      "undefined",
    ]);

    const promised = [...named].filter((w) => !notParameters.has(w) && !declared.has(w));
    expect(
      promised,
      "the act description names these, and the schema will strip them: " + promised.join(", "),
    ).toEqual([]);
  });
});

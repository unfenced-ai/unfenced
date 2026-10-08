import { describe, expect, it, vi } from "vitest";
import { Unfenced, type AtAction, type OnAction } from "../src/index.js";

/**
 * THE ADDRESSES THIS PACKAGE COULD NOT EXPRESS.
 *
 * `OnAction` (words) and `AtAction` (a spot) are mirrors of core's unions, and
 * both were missing `type`, `select` and `wheel`. Every layer between here and
 * the page already accepted them - core declares all three on both unions
 * (`packages/core/src/session.ts`), the server's `worded()` and `pointer()`
 * parse them (`toAction` in `routes/session-live.ts`, proved kind by kind in
 * `packages/server/test/act-parser.test.ts`), and the MCP act tool advertises
 * them - so the capability was real over the wire while a caller who used this
 * package's types was told the call did not type-check.
 *
 * That is the worst shape a gap can have, and it is the same one this repo has
 * hit twice before: the feature exists, the documentation promises it, and the
 * only thing missing is a declaration.
 *
 * WHAT THIS FILE ASSERTS, IN TWO HALVES.
 *
 * The first half is the compile: the actions below are declared as `OnAction`
 * and `AtAction` rather than inferred, so `pnpm typecheck` - which covers the
 * test config too - fails if a member is dropped again. Before the fix this
 * file did not compile.
 *
 * The second half is the serialisation. A type is not a wire, and the thing a
 * caller depends on is the JSON that leaves the process. The bodies asserted
 * below are the exact shapes `act-parser.test.ts` shows the server accepting -
 * `{kind:"type", on, text}` through `worded()` and `{kind:"wheel", at, by}`
 * through `pointer()` - so a client that quietly reshaped one of them (dropping
 * `on`, flattening `at`) would turn this red rather than turning into a 400 in
 * somebody else's job.
 *
 * A stub fetch, like `contract.test.ts` next door: @unfenced-ai/sdk has no
 * dependencies and is meant to keep none, so the server cannot be stood up
 * here. The live round trip lives in `packages/server/test`.
 */
const sent = () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, code: "ok" }),
      text: async () => "{}",
    } as unknown as Response;
  });
  const client = new Unfenced({
    baseUrl: "https://api.example",
    apiKey: "ac_test",
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  return { calls, client };
};

describe("an action addressed by the words on the page", () => {
  it("sends a `type` as {kind, on, text}, which is what the wire parses", async () => {
    const { calls, client } = sent();
    // Declared, not inferred. This annotation is the regression: `type` was not
    // a member of OnAction, so this line was an error.
    const action: OnAction = { kind: "type", on: "Full name", text: "Ada", submit: true };
    await client.act("s1", action);

    expect(calls[0]?.url).toBe("https://api.example/session/s1/act");
    // `on` survives beside no ref at all. The server prefers a ref when both
    // arrive, so a client that helpfully added `ref: ""` would address nothing
    // and be told '"" is not a ref' about a field the caller never sent.
    expect(calls[0]?.body).toEqual({ kind: "type", on: "Full name", text: "Ada", submit: true });
  });

  it("sends a `select` with the plural spelling intact", async () => {
    const { calls, client } = sent();
    const action: OnAction = { kind: "select", on: "Size", values: ["S", "M"] };
    await client.act("s1", action);
    // `values` is the wire's name for a <select multiple>; the server folds it
    // onto core's single `value`, so it must arrive spelled as it was written.
    expect(calls[0]?.body).toEqual({ kind: "select", on: "Size", values: ["S", "M"] });
  });
});

describe("an action aimed at a spot", () => {
  it("sends a `wheel` as {kind, at, by}, with the spot as an object", async () => {
    const { calls, client } = sent();
    const action: AtAction = { kind: "wheel", at: { x: 0.5, y: 0.4 }, by: 600 };
    await client.act("s1", action);
    // The address a wheel exists for: a map tile and an empty part of a pane
    // have no name, so a fraction of the viewport is the only address either
    // has. `at` must stay an object - a flattened x/y is not a spot.
    expect(calls[0]?.body).toEqual({ kind: "wheel", at: { x: 0.5, y: 0.4 }, by: 600 });
  });

  it("carries the modifiers a wheel is held under, since Control+wheel zooms", async () => {
    const { calls, client } = sent();
    const action: AtAction = {
      kind: "wheel",
      at: { x: 0.5, y: 0.5 },
      by: -200,
      modifiers: ["Control"],
    };
    await client.act("s1", action);
    expect(calls[0]?.body).toEqual({
      kind: "wheel",
      at: { x: 0.5, y: 0.5 },
      by: -200,
      modifiers: ["Control"],
    });
  });

  it("keeps the call options off the action, but on the same body", async () => {
    const { calls, client } = sent();
    // `see` is an option on the CALL - the server reads it off the body and
    // hands it to the engine as a call option, not as part of what the page was
    // asked to do. One object crosses the wire, so both must be in it.
    const action: AtAction = { kind: "type", at: { x: 0.2, y: 0.8 }, text: "y=x^2" };
    await client.act("s1", action, { see: true });
    expect(calls[0]?.body).toEqual({
      kind: "type",
      at: { x: 0.2, y: 0.8 },
      text: "y=x^2",
      see: true,
    });
  });
});

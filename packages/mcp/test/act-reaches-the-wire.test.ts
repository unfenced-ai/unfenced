import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Unfenced } from "@unfenced-ai/sdk";
import { registerTools } from "../src/tools.js";

/**
 * A FIELD THE SCHEMA DECLARES AND THE HANDLER DROPS IS A PROMISE WE BREAK.
 *
 * `act-addressing.test.ts` asserts that the declared schema KEEPS a field, and
 * it is right to. But keeping a field and sending it are different facts, and
 * only the first was ever checked - so four capabilities were advertised in the
 * live tool schema, described at length in prose an agent reads, and silently
 * discarded by `toAction` before anything left the process:
 *
 *   modifiers    forwarded for `wheel`, dropped for `click`. A shift-click was
 *                sent as a plain click and answered ok - the range or
 *                multi-selection the agent asked for simply did not happen.
 *   expect       never sent at all. The server reads it off the body and the
 *                SDK types the REPLY field for it, so three layers agreed the
 *                feature existed and one line did not transmit it.
 *   wait.gone    dropped, and worse than silently: the server refused the bare
 *                wait for having no predicate, and the refusal told the agent
 *                to send `gone` - the field being discarded. A loop with no exit.
 *   on           refused as "missing ref" for select, paste and upload, while
 *                the act description says in capitals that "type, paste and
 *                select take it too". The server resolves words for all of them.
 *
 * So this test does what the other one cannot: it parses through the DECLARED
 * schema (zod strips what a schema does not name), calls the REAL handler, and
 * asserts on what arrived at `cloud.act`. A test that called `toAction` directly
 * would miss the `expect` case entirely, because `expect` is not part of the
 * action at all - it rides in the third argument.
 */

interface Registered {
  config: { inputSchema?: Record<string, unknown> };
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

interface Sent {
  sessionId: string;
  action: Record<string, unknown>;
  opts: Record<string, unknown>;
}

/** Registers the real tools against a `cloud` that records instead of calling. */
function wired(): { act: Registered; sent: () => Sent } {
  let last: Sent | null = null;
  const found = new Map<string, Registered>();
  const server = {
    registerTool(name: string, config: Registered["config"], handler: Registered["handler"]) {
      found.set(name, { config, handler });
    },
  } as unknown as McpServer;

  const cloud = {
    act(sessionId: string, action: Record<string, unknown>, opts: Record<string, unknown>) {
      last = { sessionId, action, opts: opts ?? {} };
      return Promise.resolve({ ok: true });
    },
  } as unknown as Unfenced;

  registerTools(server, cloud);
  return {
    act: found.get("act")!,
    sent: () => {
      if (!last) throw new Error("the handler never reached cloud.act");
      return last;
    },
  };
}

/** Parse through the declared schema, then run the handler, then report. */
async function send(input: Record<string, unknown>): Promise<Sent> {
  const { act, sent } = wired();
  const parsed = z.object(act.config.inputSchema as z.ZodRawShape).parse(input);
  await act.handler(parsed as Record<string, unknown>);
  return sent();
}

describe("click carries the keys held across the press", () => {
  it("forwards modifiers with a ref", async () => {
    const { action } = await send({
      sessionId: "s1",
      kind: "click",
      ref: "k1:e7",
      modifiers: ["Shift"],
    });
    expect(action["modifiers"], "a shift-click left as a plain click").toEqual(["Shift"]);
  });

  it("forwards modifiers when the target is named by words", async () => {
    const { action } = await send({
      sessionId: "s1",
      kind: "click",
      on: "Invoice 4",
      modifiers: ["Control"],
    });
    expect(action["modifiers"]).toEqual(["Control"]);
    expect(action["on"]).toBe("Invoice 4");
  });

  it("sends no modifiers key when none were asked for", async () => {
    const { action } = await send({ sessionId: "s1", kind: "click", ref: "k1:e7" });
    expect(action).not.toHaveProperty("modifiers");
  });
});

describe("the post-condition reaches the server", () => {
  it("forwards expect, which rides beside the action rather than in it", async () => {
    const { opts } = await send({
      sessionId: "s1",
      kind: "click",
      ref: "k1:e7",
      expect: { text: "Saved" },
    });
    expect(opts["expect"], "expect never left the connector").toEqual({ text: "Saved" });
  });

  it("still forwards the dialog options beside it", async () => {
    const { opts } = await send({
      sessionId: "s1",
      kind: "click",
      ref: "k1:e7",
      acceptDialog: true,
      expect: { gone: "Saving…", ms: 3000 },
    });
    expect(opts["acceptDialog"]).toBe(true);
    expect(opts["expect"]).toEqual({ gone: "Saving…", ms: 3000 });
  });
});

describe("wait can be told what should disappear", () => {
  it("forwards gone", async () => {
    const { action } = await send({ sessionId: "s1", kind: "wait", gone: "Saving…" });
    expect(action["gone"], "the refusal asks for the field the connector drops").toBe("Saving…");
  });

  it("still forwards text and ms", async () => {
    const { action } = await send({ sessionId: "s1", kind: "wait", text: "Saved", ms: 2000 });
    expect(action["text"]).toBe("Saved");
    expect(action["ms"]).toBe(2000);
  });
});

describe("the verbs the description promises take words, take words", () => {
  // "`on` IS NOT ONLY FOR CLICKING - type, paste and select take it too" is the
  // act description's own sentence, and it was false for two of the three.
  it("select by words", async () => {
    const { action } = await send({
      sessionId: "s1",
      kind: "select",
      on: "Country",
      text: "Israel",
    });
    expect(action["on"]).toBe("Country");
    expect(action["value"]).toBe("Israel");
  });

  it("select by words, multiple", async () => {
    const { action } = await send({
      sessionId: "s1",
      kind: "select",
      on: "Toppings",
      values: ["Olive", "Caper"],
    });
    expect(action["value"]).toEqual(["Olive", "Caper"]);
  });

  it("paste by words", async () => {
    const { action } = await send({ sessionId: "s1", kind: "paste", on: "Notes" });
    expect(action["on"]).toBe("Notes");
  });

  it("upload by words", async () => {
    const { action } = await send({
      sessionId: "s1",
      kind: "upload",
      on: "Choose file",
      content: "hello",
      filename: "a.txt",
    });
    expect(action["on"]).toBe("Choose file");
    expect(action["content"]).toBe("hello");
  });

  it("still takes a ref for each of them", async () => {
    for (const kind of ["paste", "upload"]) {
      const { action } = await send({ sessionId: "s1", kind, ref: "k1:e7" });
      expect(action["ref"], `${kind} lost its ref`).toBe("k1:e7");
    }
    const { action } = await send({
      sessionId: "s1",
      kind: "select",
      ref: "k1:e7",
      text: "Israel",
    });
    expect(action["ref"]).toBe("k1:e7");
  });

  it("carries `within` alongside the words, so an ambiguity can be answered", async () => {
    const { action } = await send({
      sessionId: "s1",
      kind: "select",
      on: "Size",
      within: "Delivery",
      text: "Large",
    });
    expect(action["within"]).toBe("Delivery");
  });
});

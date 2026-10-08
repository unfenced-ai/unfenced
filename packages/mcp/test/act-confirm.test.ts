import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Unfenced, Action } from "@unfenced-ai/sdk";
import {
  FAILURE_TAXONOMY,
  SERVER_INSTRUCTIONS,
  registerTools,
  taxonomySentence,
} from "../src/tools.js";

/**
 * What the act tool is told to send is what the act tool sends.
 *
 * `confirm: true` is the per-action confirmation the guard asks for before a
 * pointer verb activates a submit control (core/src/session/guards.ts). The
 * MCP schema accepted the field for every kind and `toAction` forwarded it for
 * three of the five, so `dblclick` and `rightclick` were refused with
 * "re-send with confirm: true", re-sent with exactly that, and refused again
 * on an action byte-identical to the first. An agent cannot read its way out of
 * that: it did what it was told, the instruction was true, and the field was
 * dropped between the schema that accepted it and the request that left.
 *
 * So this asserts the whole set rather than the two that were broken - the
 * defect was one verb being added without its `confirm` line, and only a test
 * over every verb the guard confirms catches the next one.
 */

interface Registered {
  config: { inputSchema?: Record<string, unknown> };
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

function actTool(record: { action?: Action }): Registered {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool(name: string, config: Registered["config"], handler: Registered["handler"]) {
      tools.set(name, { config, handler });
    },
  } as unknown as McpServer;
  const cloud = {
    async act(_id: string, action: Action) {
      record.action = action;
      return { ok: true };
    },
  } as unknown as Unfenced;
  registerTools(server, cloud);
  return tools.get("act")!;
}

/** Every kind whose refusal path asks for a confirmation, and its arguments. */
const CONFIRMABLE: Array<{ kind: string; args: Record<string, unknown> }> = [
  { kind: "click", args: { ref: "k1:e1" } },
  { kind: "dblclick", args: { ref: "k1:e1" } },
  { kind: "rightclick", args: { ref: "k1:e1" } },
  { kind: "type", args: { ref: "k1:e1", text: "hello" } },
  { kind: "press", args: { key: "Enter" } },
];

describe("act and the confirmation it was told to send", () => {
  for (const { kind, args } of CONFIRMABLE) {
    it(`forwards confirm on ${kind}`, async () => {
      const record: { action?: Action } = {};
      const tool = actTool(record);
      await tool.handler({ sessionId: "s1", kind, ...args, confirm: true });
      expect(record.action, `${kind} produced no action at all`).toBeDefined();
      expect(
        (record.action as { confirm?: boolean }).confirm,
        `${kind} dropped confirm, so the guard will ask for it again`,
      ).toBe(true);
    });

    it(`omits confirm on ${kind} when it was not asked for`, async () => {
      const record: { action?: Action } = {};
      const tool = actTool(record);
      await tool.handler({ sessionId: "s1", kind, ...args });
      // Absent, not false: a confirmation nobody gave must not travel as one
      // the guard could read either way.
      expect(record.action).toBeDefined();
      expect("confirm" in (record.action as object)).toBe(false);
    });
  }
});

/**
 * The failure paragraph an agent reads is generated, not restated.
 *
 * It promised that 401, 402 and 451 all come back as `{"error":"blocked"}`
 * long after core split them into three codes with three different next moves,
 * so the branch an agent wrote from it never fired. scripts/docs-check.ts holds
 * the table to core; this holds the SENTENCE to the table, which is the half a
 * static check cannot see.
 */
describe("the instructions an agent reads", () => {
  it("carries every code in the taxonomy, spelled as an error payload", () => {
    for (const entry of FAILURE_TAXONOMY) {
      expect(SERVER_INSTRUCTIONS).toContain(`{"error":"${entry.code}"}`);
    }
  });

  it("carries every status the taxonomy files under a code", () => {
    const sentence = taxonomySentence();
    for (const entry of FAILURE_TAXONOMY) {
      for (const status of entry.statuses) {
        expect(sentence, `${status} is in the table but not in the sentence`).toContain(
          String(status),
        );
      }
    }
    expect(SERVER_INSTRUCTIONS).toContain(sentence);
  });

  it("never promises blocked for a status core answers something else for", () => {
    // The exact defect: an agent branching on `blocked` for a 402 waits for a
    // code that cannot arrive, and retries a price quote as a hostile site.
    const blocked = FAILURE_TAXONOMY.find((f) => f.code === "blocked");
    expect(blocked).toBeDefined();
    for (const status of [401, 402, 451]) {
      expect(blocked!.statuses).not.toContain(status);
    }
  });
});

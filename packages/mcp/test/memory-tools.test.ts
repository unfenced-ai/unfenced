import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Unfenced } from "@unfenced-ai/sdk";
import { registerTools } from "../src/tools.js";

/**
 * The three memory tools, as a connector sees them.
 *
 * `registerTools` only ever calls `server.registerTool`, so a fake server that
 * records each registration is enough to inspect the copy an agent is shown and
 * to drive each handler - no live MCP transport, no browser. The stub cloud
 * stands in for the SDK client the handler forwards to.
 */
interface Registered {
  config: { description: string; annotations?: Record<string, unknown> };
  handler: (
    input: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
}

function capture(cloud: Partial<Unfenced>): Map<string, Registered> {
  const registered = new Map<string, Registered>();
  const server = {
    registerTool: (name: string, config: Registered["config"], handler: Registered["handler"]) => {
      registered.set(name, { config, handler });
      return {};
    },
  } as unknown as McpServer;
  registerTools(server, cloud as Unfenced);
  return registered;
}

const parse = (result: { content: Array<{ text?: string }> }): Record<string, unknown> =>
  JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;

describe("the memory tools", () => {
  it("registers remember, recall and forget", () => {
    const tools = capture({});
    for (const name of ["remember", "recall", "forget"]) {
      expect(tools.has(name), `${name} is not registered`).toBe(true);
    }
  });

  it("marks recall read-only and the two writers not", () => {
    const tools = capture({});
    expect(tools.get("recall")?.config.annotations?.["readOnlyHint"]).toBe(true);
    expect(tools.get("remember")?.config.annotations?.["readOnlyHint"]).toBe(false);
    expect(tools.get("forget")?.config.annotations?.["readOnlyHint"]).toBe(false);
  });

  it("warns, in the remember copy, against storing a credential", () => {
    const desc = capture({}).get("remember")?.config.description ?? "";
    expect(desc.toLowerCase()).toMatch(/password|credential|secret|token/);
    expect(desc.toLowerCase()).toMatch(/\bnot\b|never|do not/);
  });

  it("remember forwards to cloud.remember and confirms what was stored", async () => {
    const calls: Array<[string, string]> = [];
    const tools = capture({
      remember: async (key: string, value: string) => {
        calls.push([key, value]);
        return { key, value, updatedAt: "2026-01-01T00:00:00.000Z" };
      },
    });
    const out = parse(
      await tools.get("remember")!.handler({ key: "invoice-4471", value: "waiting" }),
    );
    expect(calls).toEqual([["invoice-4471", "waiting"]]);
    expect(out.remembered).toBe("invoice-4471");
    expect(out.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("recall with no key lists all notes; with a key returns the one", async () => {
    const all = [{ key: "a", value: "1", updatedAt: "t" }];
    const tools = capture({
      // Overloaded on the client; the stub answers by arity. Cast through
      // `unknown` because a single lambda cannot match an overloaded signature.
      recall: (async (key?: string) =>
        key === undefined
          ? all
          : { key, value: "one", updatedAt: "t" }) as unknown as Unfenced["recall"],
    });
    expect(parse(await tools.get("recall")!.handler({})).memories).toEqual(all);
    expect(parse(await tools.get("recall")!.handler({ key: "a" })).memory).toEqual({
      key: "a",
      value: "one",
      updatedAt: "t",
    });
  });

  it("recall reports a missing note as an error the agent can read", async () => {
    const tools = capture({ recall: (async () => undefined) as unknown as Unfenced["recall"] });
    const result = await tools.get("recall")!.handler({ key: "gone" });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toBe("no-memory");
  });

  it("recall forwards a namespace and response bound", async () => {
    const calls: unknown[] = [];
    const tools = capture({
      recall: (async (options?: unknown) => {
        calls.push(options);
        return [{ key: "job/a", value: "ready", updatedAt: "t" }];
      }) as unknown as Unfenced["recall"],
    });
    const out = parse(await tools.get("recall")!.handler({ prefix: "job/", limit: 2 }));
    expect(calls).toEqual([{ prefix: "job/", limit: 2 }]);
    expect(out.memories).toEqual([{ key: "job/a", value: "ready", updatedAt: "t" }]);
  });

  it("forget forwards to cloud.forget and reports whether a note was removed", async () => {
    const tools = capture({ forget: async (key: string) => key === "here" });
    expect(parse(await tools.get("forget")!.handler({ key: "here" })).removed).toBe(true);
    expect(parse(await tools.get("forget")!.handler({ key: "gone" })).removed).toBe(false);
  });
});

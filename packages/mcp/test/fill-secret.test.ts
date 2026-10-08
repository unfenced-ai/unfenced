import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Unfenced, Action, CredentialName } from "@unfenced-ai/sdk";
import { registerTools } from "../src/tools.js";

/**
 * The agent's credential surface is USE + LIST NAMES - and nothing else.
 *
 * The vault's whole point is that a secret value never enters the model's
 * context. That holds on the tool surface only if two things are true: there is
 * no tool that STORES a secret (which would carry the value through the model),
 * and the tool that USES one takes a NAME, never a value. This pins both against
 * the registered tool set.
 */

interface Registered {
  config: { inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> };
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

/** A fake McpServer that captures every registerTool call. */
function collectTools(cloud: Unfenced): Map<string, Registered> {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool(name: string, config: Registered["config"], handler: Registered["handler"]) {
      tools.set(name, { config, handler });
    },
  } as unknown as McpServer;
  registerTools(server, cloud);
  return tools;
}

/** A cloud that records what the tools forward to it. */
function fakeCloud(over: Partial<Record<keyof Unfenced, unknown>> = {}) {
  const calls: { act?: [string, Action]; names?: boolean } = {};
  const cloud = {
    async act(id: string, action: Action) {
      calls.act = [id, action];
      return { ok: true, page: undefined };
    },
    async credentialNames(): Promise<CredentialName[]> {
      calls.names = true;
      return [
        {
          name: "github-pw",
          username: "octocat@example.com",
          kind: "password",
          hasTotp: false,
          site: "github.com",
          provider: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];
    },
    ...over,
  } as unknown as Unfenced;
  return { cloud, calls };
}

describe("the MCP credential surface", () => {
  it("has a list_credentials tool and NO tool that stores a secret", () => {
    const { cloud } = fakeCloud();
    const names = [...collectTools(cloud).keys()];

    expect(names).toContain("list_credentials");
    // The ONLY credential-named tool is the read-only lister.
    expect(names.filter((n) => /credential/i.test(n))).toEqual(["list_credentials"]);
    // Nothing that would put a secret value into the model's context by storing,
    // saving, revealing, or vaulting it through a tool.
    for (const n of names) {
      expect(n).not.toMatch(
        /store.*secret|save.*secret|store.*credential|save.*credential|vault|reveal/i,
      );
    }
  });

  it("list_credentials is read-only and returns names only", async () => {
    const { cloud, calls } = fakeCloud();
    const tool = collectTools(cloud).get("list_credentials")!;
    expect(tool.config.annotations?.["readOnlyHint"]).toBe(true);
    const result = (await tool.handler({})) as { content: Array<{ text: string }> };
    expect(calls.names).toBe(true);
    const payload = JSON.parse(result.content[0].text) as { credentials: CredentialName[] };
    expect(payload.credentials[0].name).toBe("github-pw");
    // Names only - no value field anywhere in the reply.
    expect(result.content[0].text).not.toMatch(/"value"|"secret"/);
  });

  it("the act tool accepts fill_secret and forwards the NAME, never a value", async () => {
    const { cloud, calls } = fakeCloud();
    const act = collectTools(cloud).get("act")!;
    // kind=fill_secret carries a ref and a credential NAME - no value field.
    await act.handler({
      sessionId: "s1",
      kind: "fill_secret",
      ref: "k1:e0",
      credential: "github-pw",
    });

    expect(calls.act).toBeDefined();
    const [id, action] = calls.act!;
    expect(id).toBe("s1");
    expect(action).toEqual({ kind: "fill_secret", ref: "k1:e0", credential: "github-pw" });
    // The action the SDK sends has no value-carrying field - only kind, ref and
    // the credential NAME. (Checked on keys, since "fill_secret" itself contains
    // the substring "secret".)
    expect(Object.keys(action).sort()).toEqual(["credential", "kind", "ref"]);
    for (const k of Object.keys(action)) expect(k).not.toMatch(/^(value|text|password|secret)$/i);
  });

  it("fill_secret without a credential name is rejected as a bad action", async () => {
    const { cloud, calls } = fakeCloud();
    const act = collectTools(cloud).get("act")!;
    const result = (await act.handler({ sessionId: "s1", kind: "fill_secret", ref: "k1:e0" })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(calls.act).toBeUndefined();
    expect(result.content[0].text).toContain("credential");
  });
});

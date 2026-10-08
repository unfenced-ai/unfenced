import { describe, expect, it } from "vitest";
import { Unfenced } from "../src/index.js";

/**
 * Every request must say what sent it.
 *
 * Node's global fetch sends `user-agent: node`, so before this an SDK caller,
 * a cron script and an MCP server running under Claude Code were the same
 * string in the log. The identity has to survive two awkward cases: a caller
 * that supplies its own name, and an MCP server that only learns its peer's
 * name after the client object already exists.
 */
function capture(): { seen: Array<Record<string, string>>; fetch: typeof fetch } {
  const seen: Array<Record<string, string>> = [];
  const fake = (async (_url: string, init?: RequestInit) => {
    seen.push({ ...((init?.headers ?? {}) as Record<string, string>) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ jobId: "j1" }),
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { seen, fetch: fake };
}

describe("client attribution", () => {
  it("declares the SDK by default", async () => {
    const { seen, fetch: f } = capture();
    await new Unfenced({ baseUrl: "http://x", apiKey: "k", fetch: f })
      .permissions()
      .catch(() => []);
    expect(seen[0]?.["x-unfenced-client"]).toBe("unfenced-sdk");
  });

  it("lets a caller name itself instead", async () => {
    const { seen, fetch: f } = capture();
    await new Unfenced({
      baseUrl: "http://x",
      apiKey: "k",
      fetch: f,
      headers: { "x-unfenced-client": "claude-code 1.2.3" },
    })
      .permissions()
      .catch(() => []);
    expect(seen[0]?.["x-unfenced-client"]).toBe("claude-code 1.2.3");
  });

  it("picks up a name set AFTER construction", async () => {
    // This is the MCP case: the client is built at startup, but the peer only
    // identifies itself during `initialize`. Copying the headers at
    // construction would freeze this empty and lose the name for every call.
    const { seen, fetch: f } = capture();
    const headers: Record<string, string> = {};
    const client = new Unfenced({ baseUrl: "http://x", apiKey: "k", fetch: f, headers });

    await client.permissions().catch(() => []);
    expect(seen[0]?.["x-unfenced-client"]).toBe("unfenced-sdk");

    headers["x-unfenced-client"] = "claude-code 1.2.3";
    await client.permissions().catch(() => []);
    expect(seen[1]?.["x-unfenced-client"]).toBe("claude-code 1.2.3");
  });
});

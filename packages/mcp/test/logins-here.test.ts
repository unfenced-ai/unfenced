import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Unfenced } from "@unfenced-ai/sdk";
import { registerTools } from "../src/tools.js";

/**
 * WHAT AN AGENT IS TOLD ABOUT SIGNING IN, WHEN IT IS ALREADY SIGNED IN.
 *
 * Found by using the product. Opening the account's Canva home - signed in,
 * showing Projects, Brand and its own recent designs - produced this:
 *
 *   "THIS PAGE IS NOT CARRYING the google session ... say plainly that the
 *    owner needs to sign in to this site once"
 *
 * Both halves were true about the PROVIDER and both were beside the point. The
 * site session had been restored from the vault, the agent was already in, and
 * the advice was to go and ask the owner for a login they had already given.
 *
 * That is the expensive direction to be wrong in. The agent is usually the only
 * thing in the room with the person, so a false "you need to sign in" becomes a
 * handoff they did not need and cannot act on - and the whole point of the
 * carry-a-session work was that this stops happening.
 *
 * `loginsHere` is built from the credentials STORED for the host, not from what
 * the page shows, and it branched on `providerCarried` alone. Now the page's own
 * affordance decides, which is the same authority the server-side site-login
 * handoff already uses.
 */

interface Registered {
  handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

/** open_page, wired to a stub that returns the snapshot a test names. */
function openTool(
  controls: Array<{ name: string }>,
  extraLogins: Array<Record<string, unknown>> = [],
): Registered {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Registered["handler"]) {
      tools.set(name, { handler });
    },
  } as unknown as McpServer;

  const cloud = {
    async permissionEntries() {
      return [{ host: "canva.com", mode: "free" as const }];
    },
    // `open_page` asks the scope, not the entries: it needs `anySite` as well as
    // the list, because a key allowed everywhere has no per-host row to find.
    // This stub still answered only the older shape, so every test in this file
    // died on `cloud.permissionScope is not a function` rather than on anything
    // it was written to check.
    async permissionScope() {
      return { entries: [{ host: "canva.com", mode: "free" as const }], anySite: false };
    },
    async credentialNames() {
      // A stored provider-backed login for the site, and the provider itself -
      // the shape that makes `loginsHere` fire at all.
      return [
        { name: "canva.com", kind: "oauth", site: "canva.com", provider: "google", hasTotp: false },
        {
          name: "google",
          kind: "oauth",
          site: "accounts.google.com",
          provider: "google",
          hasTotp: false,
        },
        ...extraLogins,
      ];
    },
    async accountPrefs() {
      return { askMode: "always", sites: {} };
    },
    async open() {
      return {
        sessionId: "s1",
        // No providerSession field at all is the "carried" case; this is the
        // agent-scoped one, which is what a scoped key actually gets.
        providerSession: "agent-scoped",
        page: {
          url: "https://www.canva.com/",
          title: "Home - Canva",
          controls,
          links: [],
          excerpt: "",
        },
      };
    },
  } as unknown as Unfenced;

  registerTools(server, cloud);
  return tools.get("open_page")!;
}

const instructionFor = async (controls: Array<{ name: string }>): Promise<string> => {
  const out = await openTool(controls).handler({ url: "https://www.canva.com/", intent: "act" });
  return out.content.map((c) => c.text).join("\n");
};

describe("telling an agent to log in", () => {
  /** The signed-in Canva home, by its actual controls: no sign-in affordance. */
  const SIGNED_IN = [
    { name: "Create a design" },
    { name: "Start your free trial" },
    { name: "More account and team options" },
    { name: "Templates" },
  ];

  it("says nothing needs signing in when the page offers no way to sign in", async () => {
    const text = await instructionFor(SIGNED_IN);
    expect(text).toContain("ALREADY SIGNED IN");
    // The three things it must not do, named because each was observed.
    expect(text).not.toContain("NOT CARRYING");
    expect(text).not.toMatch(/owner needs to sign in/i);
  });

  it("still warns when the page really is showing a provider button", async () => {
    const text = await instructionFor([...SIGNED_IN, { name: "Continue with Google" }]);
    expect(text).toContain("NOT CARRYING");
    expect(text).toMatch(/owner needs to sign in/i);
  });

  /**
   * The affordance test is a word match on control names, so it has to survive
   * ordinary product copy that merely contains a fragment of "log in".
   */
  it("does not mistake unrelated copy for a sign-in control", async () => {
    const text = await instructionFor([...SIGNED_IN, { name: "Read the blog inspiration guide" }]);
    expect(text).toContain("ALREADY SIGNED IN");
  });

  it("requires the user to choose when several saved logins match the site", async () => {
    const out = await openTool(SIGNED_IN, [
      {
        name: "canva-work",
        kind: "password",
        site: "canva.com",
        username: "work@example.com",
        hasTotp: false,
      },
      {
        name: "canva-personal",
        kind: "password",
        site: "canva.com",
        username: "personal@example.com",
        hasTotp: false,
      },
    ]).handler({ url: "https://www.canva.com/", intent: "act" });
    const text = out.content.map((c) => c.text).join("\n");
    expect(text).toContain('"needsLoginChoice":true');
    expect(text).toMatch(/ASK the user which (?:saved login|one) to use/i);
    expect(text).toContain("canva-work");
    expect(text).toContain("canva-personal");
  });
});

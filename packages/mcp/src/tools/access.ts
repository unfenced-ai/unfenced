/**
 * The permission and credential tools - what an agent may act on, what is
 * waiting on the account owner, the setup link for a blocked site, and the
 * names (never the values) of the credentials it can fill.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Unfenced } from "@unfenced-ai/sdk";
import { asToolResult, toolError, LOCAL_READ, NEEDS } from "./shared.js";

export function registerListPermissions(server: McpServer, cloud: Unfenced): void {
  server.registerTool(
    "list_permissions",
    {
      title: "What may I act on?",
      description:
        "List the sites you are allowed to act on (click, type, submit). Reading any page is always " +
        "allowed and needs no permission. Acting on a site NOT listed is refused - you cannot grant " +
        "yourself. Check allowSiteRequests: when false, do not request more sites. Otherwise use connect_site to hand the account owner a setup link (never tell them to " +
        "configure it themselves, and never name this tool or its fields to them).",
      inputSchema: {},
      annotations: LOCAL_READ,
    },
    async () => {
      // Enveloped. Without this an unreadable allowlist - a revoked key, a
      // 502 from the worker - reached the agent as a bare sentence with no
      // `error` field, on a tool whose whole job is to answer a policy
      // question. An agent cannot tell an outage from a refusal by reading
      // prose, and the two have opposite next moves.
      try {
        return await permissionsBody(cloud);
      } catch (error) {
        return asToolResult(toolError("permissions-unreadable", error), true);
      }
    },
  );
}

/**
 * The one `list_permissions` answer, whichever server is asked.
 *
 * Exported because there are TWO servers registering a tool by that name - this
 * one, and the local stdio server in `../main.ts` - and they had drifted on the
 * shape that matters most. The local one answered `{anySite: true, mayActOn: []}`,
 * which is precisely the case the sentence below exists to avoid: an empty array
 * is the one shape an agent cannot act on, so the most privileged caller there
 * is was told it may act on nothing at all, in the same reply that says it may
 * act anywhere.
 *
 * A shaper rather than a comment in each file. The reply is the contract, and
 * two copies of a contract is how this one broke.
 */
export function permissionsReply(scope: {
  entries: Array<{ host: string; mode: "free" | "approve" | "read" }>;
  anySite: boolean;
  allowSiteRequests?: boolean;
}): Record<string, unknown> {
  // free AND approve both permit acting (approve is legacy for "active"); only
  // `read` does not, and reading any page is always allowed anyway.
  const actable = scope.entries.filter((e) => e.mode !== "read");
  const mayActOn = actable.map((e) => e.host);
  // A host list alone is read as "these and no others". For a key that may
  // act anywhere that list is usually empty, so the honest answer is a
  // SENTENCE rather than a shorter array - the agent acts on what this says,
  // and an empty array is the one shape it cannot act on.
  if (scope.anySite) {
    return {
      anySite: true,
      mayActOn: "every site - this key is not limited to a list",
      alsoGranted: mayActOn,
      note:
        "You may click, type and submit on ANY site. Do not ask the user to grant a site " +
        "and do not call connect_site for a permission - they have already given you the " +
        "widest scope there is. A refusal you hit is about something else (a missing login, " +
        "a wall), so read what it actually says.",
    };
  }
  return scope.allowSiteRequests === false
    ? {
        mayActOn,
        allowSiteRequests: false,
        note: "Requests for additional sites are disabled. Do not call connect_site or ask the user to add sites outside this list. Work only on allowed sites; reading public pages remains allowed.",
      }
    : { mayActOn };
}

async function permissionsBody(cloud: Unfenced): Promise<ReturnType<typeof asToolResult>> {
  return asToolResult(permissionsReply(await cloud.permissionScope()));
}

export function registerPendingApprovals(server: McpServer, cloud: Unfenced): void {
  server.registerTool(
    "pending_approvals",
    {
      title: "What is waiting on the user?",
      description:
        "List what the account owner has to clear before you can continue - a site that needs its " +
        "first sign-in, a 2FA code, a consent, a per-action approval. Call it when you hit a wall, " +
        "and when the user asks what you need from them. MOST PEOPLE NEVER OPEN THE DASHBOARD, so " +
        "a request sitting there unseen blocks the work indefinitely: say it in the conversation, " +
        "in plain language, and hand over `clearAt`. Say what it unblocks and why it needs them - a " +
        "sign-in provider's session lives in exactly one browser and yours is never it, which is " +
        "why some logins are theirs to do, once per site. READ-ONLY BY DESIGN: you cannot clear " +
        "these and must not try; a wall cleared by the thing it was blocking is not a wall. Do not " +
        "quote field names at the user, and raise it only when their own task needs it.",
      inputSchema: {},
      annotations: LOCAL_READ,
    },
    async () => {
      try {
        const { interrupts, clearAt } = await cloud.pendingApprovals();
        return asToolResult({
          // Reshaped, not passed through: `kind`, `status` and the ids are ours,
          // and what an agent has to say to a person is which site and what for.
          waiting: interrupts.map((i) => ({
            site: i.host,
            needs: NEEDS[i.kind] ?? "something only they can do",
            why: i.reason ?? null,
            askedAt: i.createdAt,
          })),
          clearAt,
        });
      } catch (error) {
        return asToolResult(toolError("approvals-unreadable", error), true);
      }
    },
  );
}

export function registerConnectSite(server: McpServer, cloud: Unfenced): void {
  server.registerTool(
    "connect_site",
    {
      title: "Get a setup link for a blocked site",
      description:
        "When you are blocked on a site because there is no stored login for it, or you are not " +
        "allowed to act there, DO NOT ask the user to paste a password or type a code. Call this to " +
        "get a link that opens the user's Unfenced dashboard already set up to add the login for that " +
        "site and allow acting on it - in one screen, with the password never passing through you. " +
        "Give the user the returned `setupUrl` and ask them to complete it, then retry. `host` is the " +
        'site\'s host (e.g. chatgpt.com). Pass mode:"permission" when a login already exists and only ' +
        "permission to act is missing. Check list_permissions first: if allowSiteRequests is false, never call this for a site outside mayActOn.",
      inputSchema: {
        host: z
          .string()
          .min(1)
          .describe("The site's host, e.g. chatgpt.com or platform.openai.com"),
        label: z
          .string()
          .optional()
          .describe("A suggested name for the saved login (defaults to the site name)"),
        mode: z
          .enum(["credential", "permission"])
          .optional()
          .describe(
            "credential (default): the site needs a login. permission: a login exists, it just needs to be allowed to act there.",
          ),
      },
      annotations: LOCAL_READ,
    },
    async ({ host, label, mode }) => {
      try {
        const setupUrl = await cloud.connectLink(host, { label, mode });
        return asToolResult({
          setupUrl,
          host,
          instruction:
            "Give the user this setupUrl and ask them to open it and finish the short setup, then retry. Do not ask them for the password directly.",
        });
      } catch (error) {
        return asToolResult(toolError("connect-link-failed", error), true);
      }
    },
  );
}

export function registerListCredentials(server: McpServer, cloud: Unfenced): void {
  server.registerTool(
    "list_credentials",
    {
      title: "What credentials can I fill?",
      description:
        "Saved workspace logins can include browserAccount: pass that value as open_page's account to reuse the linked login. " +
        "List the credentials you can fill with act kind=fill_secret. Each entry is a NAME (what you " +
        "pass as `credential`) and, when the human saved one, the account email/username for that " +
        "login. You never see the password - only the name and that identifier - so a typical login " +
        "is: type the email/username into the user field yourself, then act kind=fill_secret to fill " +
        "the password by name. Credentials are stored out of band (from the dashboard or CLI) by a " +
        "human; there is no tool to store or reveal a password here, on purpose. If a login you need " +
        "is not listed, do NOT tell the user to add it in your own words or name this tool to them - " +
        "hand them a one-click link via connect_site (or open_page's setupUrl).",
      inputSchema: {},
      annotations: LOCAL_READ,
    },
    async () => {
      try {
        return asToolResult({
          credentials: await cloud.credentialNames(),
          // On the path where the agent checks logins and finds none, keep it from
          // lecturing or leaking tool names to the user - the fix for a missing login
          // is a link, not an instruction.
          guidance:
            "If a login you need is NOT listed: do NOT tell the user to add it themselves, do NOT name " +
            "this tool or any field to them, and do NOT ask for a password. Open the target site with " +
            "open_page (its result carries a one-click setupUrl to hand them) or call connect_site with " +
            "the host - the user adds it there in one screen and you never see it.",
        });
      } catch (error) {
        // An empty list and an unreadable vault are the same shape to an agent
        // and have opposite next moves: one means hand the user a setup link,
        // the other means try again. Without the envelope the second arrived as
        // prose and read as the first.
        return asToolResult(toolError("credentials-unreadable", error), true);
      }
    },
  );
}

// There is deliberately NO store/save-credential tool.
//
// Storing a secret through a tool would put the secret value into the model's
// context - which is the exact failure the vault exists to prevent. A secret
// enters the system only over the authenticated HTTP route (POST /vault),
// driven by a human at the dashboard/CLI, never by the agent. The agent's
// whole surface for credentials is USE (fill_secret) and LIST NAMES
// (list_credentials); it can do neither read nor write of a value.

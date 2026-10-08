/**
 * Getting onto a page as the right account.
 *
 * open_page opens a live page (resolving which sign-in account to act as before
 * it hydrates the jar); switch_account flips an open page to another account;
 * whoami reads which account a page is actually signed in as. The heavy
 * account-resolution logic is open_page's own, unchanged from the old file.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Unfenced, CredentialName, AccountPrefs } from "@unfenced-ai/sdk";
import { asToolResult, toolError, WEB_READ } from "./shared.js";
import { hostOf } from "./act-fold.js";

export function registerOpenPage(server: McpServer, cloud: Unfenced): void {
  server.registerTool(
    "open_page",
    {
      title: "Open a live page",
      description:
        "Open a page and keep it open so you can act on it. Returns a session id and a snapshot: " +
        "the controls you can click or type into, each with a `ref`, plus prominent links and an " +
        "excerpt. Use `act` with the session id. To just read a page, fetch_page is cheaper. " +
        "REUSE, do not re-open: if you already have a page open on a site (you have its session id, " +
        "or close_page with no id lists it), keep using THAT session - opening the same site again " +
        "starts a FRESH login and re-triggers 2FA. The server may hand you back your existing warm " +
        "session here, and says so with `reusedExistingSession: true`; if the snapshot shows you are " +
        "already signed in (the app, not a login screen), you are done - do NOT click " +
        "'Continue with <provider>'. When that happens and you asked for a DIFFERENT page on that " +
        "site, the reused session is navigated to the URL you asked for and `navigated: true` says " +
        "so, so the snapshot is the page you wanted rather than the one you happened to be on. " +
        "And do not navigate a signed-in page " +
        "off to another site (a share/social flow) - you will lose the session and have to log in again. " +
        "Pages self-close after 5 minutes idle, or 15 once acted on, so a follow-up soon after reuses " +
        "the same signed-in page for free. " +
        "If you only want to READ a page that needs no login, this may refuse with error `use-fetch` " +
        "and tell you to use fetch_page - a browser costs ~819MB and one of the account's session " +
        "slots, so it is not spent on bytes a plain fetch returns. When you do mean to click, type " +
        'or submit, pass intent: "act" and it opens. ' +
        "`more.reason`, when present, means this reading left things out and says how to get them. " +
        "`note`, when present, is something about THIS open you would otherwise have to guess - " +
        "usually that the page was still fetching when the reading was taken, so observe_page again " +
        "before relying on a ref from it. " +
        "READ `blocked` BEFORE YOU ACT. When it is present, an anti-bot system answered instead of " +
        "the site. Read blocked.reason: an interactive verification can be completed with act " +
        "and see in this same browser; a hard denial may require another source or saved login. Do not " +
        "re-open the same URL, the answer does not change. If `needsLoginChoice` is present, ask " +
        "the user which saved login to use before calling `fill_secret` or `fill_totp`; never " +
        "guess between multiple logins for the same site. A transport timeout may mean this page already opened: list sessions and observe before retrying.",
      inputSchema: {
        url: z.string().url().describe("Absolute URL to open"),
        account: z
          .string()
          .optional()
          .describe(
            "Which sign-in account to act as, when the user has more than one for a provider " +
              "(e.g. two Google logins). Pass the account's NAME from a previous open_page's " +
              '`needsAccountChoice`/`otherAccounts` list - a short label like "google" or ' +
              '"google-2". ONLY a name from one of those lists: a `credential` name out of ' +
              "`loginsHere` is NOT one (that is a password used inside an account - " +
              '"namecheap.com", "chatgpt.com · google"), and neither is a site, domain or ' +
              "host (a login's `site` says where it is USED, not what it is CALLED). A name this " +
              "user does not have is refused (unknown-account) and nothing is opened, because it " +
              "would put the login in a browser profile and a stored session nothing else ever " +
              "reads. Omit to use the configured site login, or the default session when none is configured.",
          ),
        intent: z
          .enum(["read", "act"])
          .optional()
          .describe(
            'What you mean to do here. Pass "act" when you will click, type or submit on this ' +
              "page - it is what buys a live browser for a page a plain fetch could answer. " +
              'Omit (or "read") and a page already known to be fetchable, with no stored login ' +
              "for it, is refused with `use-fetch` pointing you at fetch_page.",
          ),
        settleMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "How long to let the page finish fetching before the snapshot is taken, in " +
              "milliseconds. Default 4000, maximum 15000. Raise it only for a page you expect " +
              "to draw itself from several slow requests - a dashboard, a report - where the " +
              "default reading comes back half-empty. It never turns a slow page into an " +
              "error: at the limit the page is read as it stands.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ url, account, intent, settleMs }) => {
      try {
        const host = hostOf(url);
        const covers = (site: string): boolean => host === site || host.endsWith(`.${site}`);
        // Learn what we can BEFORE opening: the act-allowlist, the stored logins,
        // and how this account wants multi-account choices made — so the page can be
        // opened AS the right sign-in account when the caller did not name one.
        //
        // AN OUTAGE IS NOT AN ANSWER, and all three of these used to become one.
        // Each arm swallowed its rejection into a benign-looking default, so a
        // read fault on the allowlist arrived as "you may act on nothing" — the
        // agent was then told by setupHint to inform the user they have no
        // permission, which is the exact misreport the route and the SDK were
        // written to prevent. The SDK raises `unreadableAllowlist` on purpose,
        // and its own text says "this is NOT a refusal by the owner ... treat it
        // as a transient fault and retry, not as policy"; the route omits
        // `allowed` rather than sending `[]` for the same reason. Swallowing it
        // here undid both.
        //
        // The prefs arm is the same error in the other direction: with
        // `sites: {}` the curation lookup finds nothing, `candidatesFor` returns
        // EVERY account for the provider, and the auto-resolution below opens
        // the page signed in as an identity the user deliberately curated away —
        // with no error and no mention.
        const [scopeRead, credsRead, prefsRead] = await Promise.allSettled([
          cloud.permissionScope(),
          cloud.credentialNames(),
          cloud.accountPrefs(),
        ]);
        const permissionsUnavailable = scopeRead.status === "rejected";
        const credentialsUnavailable = credsRead.status === "rejected";
        const prefsUnavailable = prefsRead.status === "rejected";
        const scope =
          scopeRead.status === "fulfilled"
            ? scopeRead.value
            : {
                entries: [] as Array<{ host: string; mode: "free" | "approve" | "read" }>,
                anySite: false,
                allowSiteRequests: true,
              };
        const creds = credsRead.status === "fulfilled" ? credsRead.value : ([] as CredentialName[]);
        const prefs =
          prefsRead.status === "fulfilled"
            ? prefsRead.value
            : ({ askMode: "always", sites: {} } as AccountPrefs);
        // A provider is USABLE only when its own sign-in SESSION is set up — a
        // session-backed account (kind "oauth" at the provider's auth host). Then
        // "Continue with <provider>" completes on its own. WITHOUT that session,
        // clicking it lands on the provider's REAL login asking for a password
        // (which must never be filled), so the agent must route the user to set the
        // provider up first, never walk into that wall.
        const PROVIDER_AUTH_HOSTS: Record<string, string> = {
          google: "accounts.google.com",
          apple: "appleid.apple.com",
          microsoft: "login.microsoftonline.com",
          github: "github.com",
        };
        // Every session-backed account, grouped by provider. A provider with more
        // than one is the whole point of multi-account: the agent must ask WHICH
        // before clicking "Continue with <provider>", then reopen as that account.
        const providerAccounts = new Map<
          string,
          Array<{ name: string; label: string; hasTotp: boolean }>
        >();
        const accountNames = new Set<string>();
        const providerOf = new Map<string, string>(); // account name -> its provider
        for (const c of creds) {
          if (c.kind === "oauth" && c.provider && c.site === PROVIDER_AUTH_HOSTS[c.provider]) {
            const name = c.browserAccount ?? c.name;
            const list = providerAccounts.get(c.provider) ?? [];
            list.push({ name, label: c.username || c.name, hasTotp: !!c.hasTotp });
            providerAccounts.set(c.provider, list);
            accountNames.add(name);
            providerOf.set(name, c.provider);
          }
        }
        const signedInProviders = new Set(providerAccounts.keys());
        // Which providers THIS page signs in with — from its per-site "Continue
        // with <provider>" markers (an oauth cred whose site is the PAGE, not a
        // provider's auth host). A choice is only ever made among accounts for a
        // provider the page actually uses.
        const siteProviders = new Set(
          creds
            .filter(
              (c) =>
                c.kind === "oauth" &&
                c.provider &&
                c.site &&
                covers(c.site) &&
                c.site !== PROVIDER_AUTH_HOSTS[c.provider],
            )
            .map((c) => c.provider as string),
        );
        // The site's CURATED accounts, if the user set them (covering-aware: a
        // config on github.com applies to gist.github.com). When a site is curated,
        // ONLY these accounts are candidates here — a third Google you have is not
        // offered unless you added it.
        // Most-specific match wins: exact host, else the longest covering parent —
        // so a curated subdomain is never shadowed by a curated parent.
        const curatedKey = Object.keys(prefs.sites)
          .filter((k) => host === k || host.endsWith(`.${k}`))
          .sort((a, b) => b.length - a.length)[0];
        const curated = curatedKey ? prefs.sites[curatedKey] : undefined;
        // The candidate accounts for a provider on THIS page: curated-filtered when
        // the site is curated, else every account the user has for the provider.
        const candidatesFor = (
          provider: string,
        ): Array<{ name: string; label: string; hasTotp: boolean; identity?: string }> => {
          const all = providerAccounts.get(provider) ?? [];
          const filtered =
            curated && curated.accounts.length
              ? all.filter((a) => curated.accounts.includes(a.name))
              : all;
          // Attach the DOWNSTREAM identity we have learned for each account on this
          // site, so the agent (and the user it asks) can see which distinct account
          // each name is — and so two names that resolve to the SAME account show it.
          return filtered.map((a) => {
            const identity = curated?.identities?.[a.name];
            return identity ? { ...a, identity } : { ...a };
          });
        };
        // Two curated accounts that resolve to the SAME downstream identity are not
        // distinct accounts — switching between them changes nothing. Surface that so
        // the agent stops treating them as a real choice (the exact trap that once
        // burned four rounds on one ChatGPT account).
        const sameAccountNote = (accts: Array<{ label: string; identity?: string }>): string => {
          const byIdentity = new Map<string, string[]>();
          for (const a of accts)
            if (a.identity)
              byIdentity.set(a.identity, [...(byIdentity.get(a.identity) ?? []), a.label]);
          const clashes = [...byIdentity.entries()].filter(([, labels]) => labels.length > 1);
          return clashes.length
            ? ` NOTE: ${clashes
                .map(([id, labels]) => `${labels.join(" and ")} both sign in as ${id}`)
                .join(
                  "; ",
                )} - those resolve to the SAME account, so switching between them changes ` +
                `nothing; treat them as one and do not keep trying the other.`
            : "";
        };
        // Which account to act as, resolved BEFORE opening so the right jar is
        // hydrated. In order:
        //   1. an explicit `account` arg - a one-off override that does NOT change
        //      the site's curation;
        //   2. the curated site's `main`, if it still EXISTS and belongs to a
        //      provider THIS page uses (a page's provider can change);
        //   3. if the page uses exactly one provider and there is exactly one
        //      candidate account for it, that one - nothing to ask.
        // Anything else stays unresolved and is asked about below.
        //
        // Nothing is auto-resolved when the prefs read FAILED. An unread map and
        // a never-curated site are indistinguishable once the failure has been
        // turned into `{}`, and the two have opposite right answers: one means
        // "open as the only candidate", the other means "you do not know which
        // account this site is curated to - ask".
        let actAs = account;
        if (
          !actAs &&
          !prefsUnavailable &&
          curated?.main &&
          accountNames.has(curated.main) &&
          siteProviders.has(providerOf.get(curated.main) ?? "")
        ) {
          actAs = curated.main;
        }
        if (!actAs && !prefsUnavailable) {
          const provs = [...siteProviders];
          if (provs.length === 1) {
            const cands = candidatesFor(provs[0] as string);
            if (cands.length === 1) actAs = cands[0]?.name;
          }
        }
        // Tell the agent up front whether it may act here AND which stored logins
        // are for this host - without this it discovers both only by attempting an
        // action and being refused, a full open -> observe -> act round trip to learn.
        const s = await cloud.open(url, {
          ...(actAs ? { account: actAs } : {}),
          ...(intent ? { intent } : {}),
          // Forwarded, not interpreted: the ceiling and the clamp live in core,
          // which is the only place that number should be written down.
          ...(settleMs !== undefined ? { settleMs } : {}),
        });
        // Did this page actually get the account's provider session? The answer
        // changes what the agent should be TOLD to do, and getting it wrong is
        // expensive: "click Continue with google, it completes on its own" sent
        // an agent into a live re-authentication wall it could not pass, and
        // repeatedly submitting into one of those is how a provider account gets
        // flagged. A provider session lives in one browser at a time, so "not
        // carried" is the ordinary case for an agent, not a fault.
        const providerCarried =
          (s as { providerSession?: string }).providerSession === undefined ||
          (s as { providerSession?: string }).providerSession === "carried";
        // IS THERE ANYTHING TO SIGN IN WITH ON THIS PAGE AT ALL?
        //
        // `loginsHere` is built from the credentials STORED for this host, not
        // from what the page shows, and it branched on `providerCarried` alone.
        // So opening a Canva home page that was fully signed in - Projects,
        // Brand, the account's own recent designs - still produced "THIS PAGE IS
        // NOT CARRYING the google session ... say plainly that the owner needs to
        // sign in to this site once". Both halves of that were true about the
        // PROVIDER and both were irrelevant: the site session came from the
        // vault, the agent was already in, and the advice was to go and ask the
        // owner for a login they had already given.
        //
        // Measured by dogfooding, and it is the expensive kind of wrong: the
        // agent is the only thing in the room with the person, so a false "you
        // need to sign in" is a handoff the user did not need and cannot action.
        //
        // The page's own affordance decides, which is the same authority the
        // site-login handoff uses server-side rather than a second opinion.
        const signInOffered = [
          ...((s as { page?: { controls?: Array<{ name?: string }> } }).page?.controls ?? []),
          ...((s as { page?: { links?: Array<{ name?: string }> } }).page?.links ?? []),
        ].some((el) =>
          /\b(continue with|continue|sign in|sign up|signin|log in|login)\b/i.test(el.name ?? ""),
        );

        // BOTH free and approve permit acting - approve just asks the human per
        // action; only `read` does not. So mayActOn is free+approve: a site granted
        // "Ask each time" is visible here. (Reading the free-only list instead hid
        // approve grants and made the agent give up on sites it was allowed to act on.)
        const actable = scope.entries.filter((e) => e.mode !== "read");
        const mayActOn = actable.map((e) => e.host);
        // A key carrying any-site is exempt from the list, and its list is
        // usually EMPTY for exactly that reason - so deriving canActHere from
        // the entries alone told the most privileged caller it could act on
        // nothing. The comment sixty lines below already describes what happens
        // next: a cautious agent reads canActHere:false and gives up before the
        // gate it would have passed.
        const canActHere = scope.anySite || actable.some((e) => covers(e.host));
        // The stored logins whose site matches this page - so the agent fills the
        // right one BY NAME (act kind=fill_secret / fill_totp) instead of guessing.
        // A `provider` login (kind "oauth") is a MARKER, not a fillable secret: it
        // means "click Continue with <provider>", and the provider account fills on
        // the sign-in page it redirects to.
        const loginsHere = creds
          .filter((c) => c.site && covers(c.site))
          .map((c) => {
            if (c.kind !== "oauth") {
              return {
                credential: c.name,
                username: c.username,
                hasTotp: c.hasTotp || c.kind === "totp",
              };
            }
            if (c.provider && signedInProviders.has(c.provider)) {
              const accts = candidatesFor(c.provider);
              // The site is curated and NONE of its accounts are for this provider -
              // the user did not add a matching account to this site. Route them to
              // add one rather than click through to a login wall.
              if (accts.length === 0) {
                return {
                  method: `continue-with-${c.provider}`,
                  needsProviderSetup: true,
                  instruction:
                    `This site signs in with ${c.provider}, but the user has not added a ${c.provider} account ` +
                    `to THIS site (it is curated to specific accounts). Do NOT click "Continue with ${c.provider}". ` +
                    `Hand them the setupUrl and say they can add a ${c.provider} account to this site under Sites.`,
                };
              }
              // Is the OPEN session actually signed in FOR THIS provider — i.e. is
              // the account it was opened as one of this provider's candidates? On a
              // multi-provider page, actAs belongs to only ONE provider; the others
              // are NOT hydrated in this session, so we must not claim they are.
              const activeHere = actAs && accts.some((a) => a.name === actAs) ? actAs : undefined;
              // 2+ candidates for this provider and none active: STOP and ask which.
              if (accts.length > 1 && !activeHere) {
                return {
                  method: `continue-with-${c.provider}`,
                  needsAccountChoice: true,
                  accounts: accts,
                  instruction:
                    `This site signs in with ${c.provider}, and it is set to use ${accts.length} ${c.provider} ` +
                    `accounts: ${accts.map((a) => a.label).join(", ")}. ASK the user which one to use - do ` +
                    `NOT guess and do NOT click "Continue with ${c.provider}" yet. Once they choose, call ` +
                    `switch_account with this sessionId and that account's name ` +
                    `(${accts.map((a) => a.name).join(" / ")}); the page reopens signed in as it.` +
                    sameAccountNote(accts),
                };
              }
              if (!activeHere) {
                // Exactly one candidate for this provider, but the session is signed
                // in as a DIFFERENT account (another provider) or none — so this
                // provider is not set up in the current jar. Switch, don't click.
                const only = accts[0] as { name: string; label: string };
                return {
                  method: `continue-with-${c.provider}`,
                  instruction:
                    `This site can sign in with ${c.provider} as ${only.name} (${only.label}), but THIS session ` +
                    `is ${actAs ? `signed in as a different account (${actAs})` : "not signed in for it"}. To use ` +
                    `it, call switch_account with this sessionId and account ${only.name} - do NOT click ` +
                    `"Continue with ${c.provider}" first, or it lands on ${c.provider}'s login wall.`,
                };
              }
              const others = accts.filter((a) => a.name !== activeHere);
              const activeAcct = accts.find((a) => a.name === activeHere);
              return {
                method: `continue-with-${c.provider}`,
                actingAsAccount: activeHere,
                // Whether this account carries a stored 2FA, so the agent fills it
                // itself instead of asking the user for a code.
                ...(activeAcct?.hasTotp ? { hasStored2fa: true } : {}),
                // Name the OTHER curated accounts so the agent can switch on request
                // ("check my other account") without disturbing the site's setting.
                ...(others.length ? { otherAccounts: others } : {}),
                instruction:
                  (!signInOffered
                    ? `This site signs in with ${c.provider}, and THIS PAGE IS ALREADY SIGNED IN - it ` +
                      `shows no sign-in control at all, so the session was restored for you. Do nothing ` +
                      `about logging in: do NOT click a provider button, do NOT tell the user to sign ` +
                      `in, and do NOT raise this with them. Just carry on with the task.`
                    : providerCarried
                      ? `This site signs in with ${c.provider}, and this page is carrying the account's ` +
                        `${c.provider} session (acting as ${activeHere}). Click its "Continue with ` +
                        `${c.provider}" button - do NOT look for an email/password form; it completes on ` +
                        `${c.provider}'s own page. IF A PASSWORD FIELD APPEARS ANYWAY, STOP: the provider ` +
                        `is asking this browser to re-authenticate, which the owner must do once. Do NOT ` +
                        `fill a stored credential into it and do NOT retry - a stored password typed ` +
                        `repeatedly into a live provider form is how an account gets locked.`
                      : `This site signs in with ${c.provider}, but THIS PAGE IS NOT CARRYING the ` +
                        `${c.provider} session - that session lives in one browser at a time and this is ` +
                        `not it. Clicking "Continue with ${c.provider}" will land on a login wall you ` +
                        `cannot pass, so do not start there. If a plain saved password login exists for ` +
                        `THIS site, use that instead - it needs no provider and is the better path anyway. ` +
                        `If there is none, say plainly that the owner needs to sign in to this site once; ` +
                        `do NOT attempt the provider hop and do NOT retry it.`) +
                  (activeAcct?.hasTotp
                    ? ` This account has a STORED 2FA: if an authenticator/2FA-code prompt appears (on this ` +
                      `site OR the provider), fill it YOURSELF with act kind=fill_totp credential=${activeHere} ` +
                      `- do NOT ask the user for a code first; only ask if that fill is then rejected.`
                    : "") +
                  (others.length
                    ? ` To act as a DIFFERENT account for this one task, call switch_account with this ` +
                      `sessionId and the account name - ${others.map((a) => `${a.label} (name ${a.name})`).join(", ")}.`
                    : ""),
              };
            }
            return {
              method: `continue-with-${c.provider}`,
              needsProviderSetup: true,
              instruction:
                `This site signs in with ${c.provider}, but there is NO ${c.provider} sign-in set up yet - so ` +
                `clicking "Continue with ${c.provider}" would land on ${c.provider}'s own login asking for a ` +
                `password, which you MUST NOT fill and MUST NOT click through. Instead: the USER sets up their ` +
                `${c.provider} sign-in ONCE themselves (they log in to ${c.provider} by hand in their dashboard's ` +
                `sign-in accounts), and only then does the button work. Hand them the setupUrl and say they can ` +
                `add their ${c.provider} sign-in there. If a plain saved password login for THIS site also exists, ` +
                `use that instead - it needs no provider.`,
            };
          });
        const passwordLoginCount = loginsHere.filter((login) => "credential" in login).length;
        // If it CANNOT act here, hand over the setup link NOW — not only after a
        // refused act. A cautious agent that reads canActHere:false otherwise gives
        // up and lectures the user instead of offering the one click. The link's mode
        // adapts: a login already exists here -> straight to the grant; none exists ->
        // add the login AND allow acting, one screen.
        // A provider that needs its session set up gets a link too, even where acting
        // is already allowed — the link is how the user adds their provider sign-in.
        const needsProviderSetup = loginsHere.some(
          (l) => "needsProviderSetup" in l && l.needsProviderSetup,
        );
        const setupUrl =
          // Not on an outage either: a setup link is an instruction to the USER
          // to grant something, and we do not know that anything needs granting.
          permissionsUnavailable ||
          (!canActHere && scope.allowSiteRequests === false) ||
          (canActHere && !needsProviderSetup)
            ? undefined
            : await cloud
                .connectLink(host, loginsHere.length ? { mode: "permission" } : {})
                .catch(() => undefined);
        // Speak to the user in PLAIN language: never quote these field names
        // (canActHere, mayActOn) at them — say "I don't have permission to act on
        // this site yet" and hand over the link.
        const setupHint =
          setupUrl &&
          // The credentials arm of the same rule the permissions arm was fixed
          // for. A vault read fault leaves `creds` empty, so `loginsHere` is
          // empty, so this said "you ... have no saved login for it" — an
          // ANSWER, and the wrong one, produced by an outage. The agent then
          // tells the user to save a login they may already have saved, and the
          // one thing that would have fixed it (retrying) is the thing the
          // sentence talks them out of.
          (credentialsUnavailable
            ? `You are not permitted to act on ${host} yet, and whether a login is saved for it is ` +
              `UNKNOWN - the saved-login store could not be read, which is a transient fault and not ` +
              `an answer. Do NOT tell the user they have no login for this site, and do NOT ask for a ` +
              `password. Say plainly you do not have permission to act on ${host} yet, give them this ` +
              `link, then retry: ${setupUrl}`
            : loginsHere.length
              ? `You have a saved login for ${host} (${loginsHere
                  .map((l) => l.credential)
                  .join(", ")}) but are not permitted to act here yet. Do NOT quote field names ` +
                `(canActHere/mayActOn) to the user and do NOT ask for a password - say plainly you do ` +
                `not have permission to act on ${host} yet, give them this link, then retry: ${setupUrl}`
              : `You are not permitted to act on ${host} and have no saved login for it. Do NOT quote ` +
                `field names (canActHere/mayActOn) to the user, do NOT ask for a password, and do NOT ` +
                `tell them to "set it up on their end" in your own words - say plainly you do not have ` +
                `permission to act on ${host} yet, and give them THIS link (it adds the login and allows ` +
                `acting, in one screen): ${setupUrl}. Once they save it, retry.`);
        return asToolResult({
          sessionId: s.id,
          page: s.initial,
          // FIRST, because it changes what the rest of this reply means: this may
          // be a page you already had open rather than a new one. It is the
          // difference between reading a snapshot of the page you asked for and
          // reading a snapshot of a page you were already on.
          ...(s.reusedExistingSession
            ? { reusedExistingSession: true, navigated: s.navigated === true }
            : {}),
          // Something about THIS open worth saying: that a reused page was
          // navigated, or that the page was still fetching when the settle
          // budget ran out and the snapshot may not be the finished page. Two
          // producers, one field, because both answer the same question and an
          // agent reads them the same way.
          ...(s.note ? { note: s.note } : {}),
          // OMITTED, not defaulted, when the allowlist could not be read. An
          // absent field is a question; `canActHere: false` is an answer, and
          // the wrong one — a cautious agent reads it as policy, tells the user
          // they have no permission, and stops. The route omits `allowed` for
          // exactly this reason and this projection used to fill it back in.
          ...(permissionsUnavailable
            ? {
                permissionsUnavailable: true,
                note:
                  `The act-allowlist could not be read, so whether you may act on ${host} is ` +
                  `UNKNOWN rather than no. This is a transient fault, not the owner refusing: ` +
                  `do not tell the user they lack permission, and do not hand them a setup link ` +
                  `for it. Try the action - if it is refused, the refusal will say so - or retry ` +
                  `this call shortly.`,
              }
            : { canActHere, mayActOn }),
          // A bare flag is a field name, and the tool text tells the agent never
          // to quote one at a person. `permissionsUnavailable` and
          // `accountPrefsUnavailable` each say in words what the agent should do
          // instead; this one said nothing at all, and everything derived from
          // the credentials — `loginsHere`, the provider guidance, `setupHint` —
          // went quiet or, worse, spoke as though the store had answered "none".
          ...(credentialsUnavailable
            ? {
                credentialsUnavailable: true,
                credentialNote:
                  `The saved logins for this account could not be read, so whether one exists for ` +
                  `${host} is UNKNOWN rather than none. This is a transient fault, not the owner ` +
                  `having saved nothing: do not tell the user they have no login here, do not ask ` +
                  `them for a password, and do not start a "Continue with <provider>" hop on the ` +
                  `strength of it. Retry this call shortly.`,
              }
            : {}),
          ...(prefsUnavailable
            ? {
                accountPrefsUnavailable: true,
                accountNote:
                  "This account's sign-in preferences could not be read, so no account was " +
                  "chosen for you. If this site needs a particular sign-in, ask the user which " +
                  "account to use and reopen with `account`, rather than assuming the default.",
              }
            : {}),
          ...(loginsHere.length ? { loginsHere } : {}),
          ...(passwordLoginCount > 1
            ? {
                needsLoginChoice: true,
                loginChoiceInstruction:
                  `There are ${passwordLoginCount} saved logins for ${host}. ASK the user which ` +
                  "one to use before filling anything. Do NOT guess, do NOT call fill_secret or " +
                  "fill_totp yet, and do NOT ask the user for a password. After they choose, use " +
                  "only that credential name.",
              }
            : {}),
          ...(setupUrl ? { setupUrl, setupHint } : {}),
          ...(!canActHere && scope.allowSiteRequests === false
            ? {
                allowSiteRequests: false,
                permissionNote:
                  "Requests for additional sites are disabled. Do not call connect_site or ask for access to this site. Work only on allowed sites.",
              }
            : {}),
        });
      } catch (error) {
        return asToolResult(toolError("open-failed", error), true);
      }
    },
  );
}

export function registerSwitchAccount(server: McpServer, cloud: Unfenced): void {
  server.registerTool(
    "switch_account",
    {
      title: "Switch a page to another sign-in account",
      description:
        "Switch an OPEN page to a DIFFERENT one of the user's sign-in accounts - for " +
        '"check my other account". You cannot flip an open page live: this saves the ' +
        "current account's session, closes the page, and reopens the SAME SITE signed in " +
        "as the chosen account, in that account's own isolated browser. Returns a NEW " +
        "sessionId - use it from now on; the old one is closed. Get the account NAME from " +
        "open_page's `otherAccounts`. A one-off: it never changes the site's default account. " +
        "IMPORTANT: this switches the PROVIDER identity (e.g. which Google), NOT necessarily the " +
        "destination account - a site's 2FA belongs to the DESTINATION account (e.g. the ChatGPT " +
        "account), not to the Google login. The result's `requestedAccount` is what you ASKED for, " +
        "not a confirmation: when `restoredSession` is false the page is logged out and a fresh " +
        "login will resolve to whatever the provider returns. Always CONFIRM the signed-in identity " +
        "on the page before asserting which account you are acting as, and if repeated switches to " +
        "different accounts land on the same login or the same 2FA challenge, they resolve to the " +
        "SAME underlying account - stop and tell the user rather than retrying.",
      inputSchema: {
        sessionId: z.string().describe("The open session to switch, from open_page"),
        account: z
          .string()
          .describe(
            "The account NAME to act as - from open_page's `otherAccounts`/`accounts` list. A " +
              'short label like "google" or "google-2", never a site/domain/host and never a ' +
              "`credential` name from `loginsHere`. A name this user does not have is refused " +
              "(unknown-account) and the open page is left untouched, so a wrong guess costs " +
              "nothing but is not a way to discover one - read the list.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ sessionId, account }) => {
      try {
        const { session, restoredSession, observedIdentity } = await cloud.switchAccount(
          sessionId,
          account,
        );
        return asToolResult({
          sessionId: session.id,
          page: session.initial,
          // The account you REQUESTED — not an observed identity. Verify on the page.
          requestedAccount: account,
          restoredSession,
          // Who the page is ACTUALLY signed in as, when the site is one whoami can read.
          ...(observedIdentity ? { observedIdentity } : {}),
          note: observedIdentity
            ? `The page is signed in as ${observedIdentity}. If a PREVIOUS switch to a DIFFERENT account ` +
              `also showed ${observedIdentity}, both resolve to the SAME underlying account - stop and tell ` +
              `the user, do not keep switching.`
            : restoredSession
              ? "Reopened with this account's stored session. Verify the signed-in identity on the page " +
                "(whoami, or read the account menu) before you assert which account you are acting as."
              : "No stored session for this account - the page is LOGGED OUT. A fresh 'Continue with " +
                "<provider>' will run and resolve to whatever identity the provider returns; do NOT assume " +
                "it is this account. If repeated switches land on the same login or 2FA challenge, they are " +
                "resolving to the SAME underlying account - stop and tell the user, don't retry.",
        });
      } catch (error) {
        return asToolResult(toolError("switch-failed", error), true);
      }
    },
  );
}

export function registerWhoami(server: McpServer, cloud: Unfenced): void {
  server.registerTool(
    "whoami",
    {
      title: "Read which account a page is signed in as",
      description:
        "Read the identity the CURRENT page is actually signed in as - the DOWNSTREAM account " +
        "(e.g. which ChatGPT account), not the provider login that reached it. Use it to CONFIRM " +
        "which account you are acting as after open_page or switch_account instead of trusting the " +
        "requested name, and to catch the trap where two DIFFERENT sign-in accounts resolve to the " +
        "SAME underlying account: if whoami returns the same identity after you switch_account, the " +
        "switch did NOT change the account - stop and tell the user, do not retry. Non-disruptive " +
        "(it does not navigate). Returns `{ identity, source }`; `identity` is null when this site is " +
        "not one the server knows how to read - then read the account menu with observe_page instead.",
      inputSchema: { sessionId: z.string().describe("From open_page") },
      annotations: WEB_READ,
    },
    async ({ sessionId }) => {
      try {
        return asToolResult(await cloud.whoami(sessionId));
      } catch (error) {
        return asToolResult(toolError("whoami-failed", error), true);
      }
    },
  );
}

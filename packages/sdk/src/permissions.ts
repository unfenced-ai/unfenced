/**
 * The act-allowlist tier: what the agent may act on, and links to change it.
 *
 * The bodies of the `Unfenced` methods under `// ---- act-allowlist`, moved out
 * with only `this.request` -> `http.request`. `unreadableAllowlist` lives here
 * because these are its only callers.
 */
import { Transport } from "./http.js";
import type { PermissionsAnswer } from "./types.js";

/** Why the list could not be read, in words a caller can hand to a person. */
function unreadableAllowlist(detail?: string): string {
  return (
    "the act-allowlist could not be read, so which sites the agent may act on is unknown" +
    (detail ? `: ${detail}` : "") +
    ". This is NOT a refusal by the owner - acting fails closed until it can be read again, " +
    "so treat it as a transient fault and retry, not as policy."
  );
}

export function permissions(http: Transport): Promise<string[]> {
  // THROWS when the list could not be read, deliberately. The route omits
  // `allowed` rather than sending [] when the store is unreachable, because an
  // empty array is indistinguishable from "you granted nothing" — and an agent
  // that reads an outage as policy stops asking for the grant it needs.
  return http.request<PermissionsAnswer>("GET", "/permissions").then((r) => {
    if (!r.allowed) throw new Error(unreadableAllowlist(r.detail));
    return r.allowed;
  });
}

export function permissionScope(http: Transport): Promise<{
  entries: Array<{ host: string; mode: "free" | "approve" | "read" }>;
  anySite: boolean;
  excludedSites: string[];
  allowSiteRequests?: boolean;
}> {
  return http
    .request<{
      allowed?: string[];
      detail?: string;
      anySite?: boolean;
      excludedSites?: string[];
      allowSiteRequests?: boolean;
      entries?: Array<{ host: string; mode: "free" | "approve" | "read" }>;
    }>("GET", "/permissions")
    .then((r) => {
      const anySite = r.anySite === true;
      const excludedSites = r.excludedSites ?? [];
      const policy = r.allowSiteRequests === false ? { allowSiteRequests: false } : {};
      if (r.entries) return { entries: r.entries, anySite, excludedSites, ...policy };
      if (!r.allowed) throw new Error(unreadableAllowlist(r.detail));
      return {
        entries: r.allowed.map((host) => ({ host, mode: "free" as const })),
        anySite,
        excludedSites,
        ...policy,
      };
    });
}

export function permissionEntries(
  http: Transport,
): Promise<Array<{ host: string; mode: "free" | "approve" | "read" }>> {
  return http
    .request<{
      allowed?: string[];
      detail?: string;
      entries?: Array<{ host: string; mode: "free" | "approve" | "read" }>;
    }>("GET", "/permissions")
    .then((r) => {
      // Same refusal as permissions(). Without it this line is `undefined.map`,
      // which is loud but tells the caller nothing it can act on.
      if (r.entries) return r.entries;
      if (!r.allowed) throw new Error(unreadableAllowlist(r.detail));
      return r.allowed.map((host) => ({ host, mode: "free" as const }));
    });
}

export function connectLink(
  http: Transport,
  host: string,
  opts: { label?: string; mode?: "credential" | "permission" } = {},
): Promise<string> {
  const q = new URLSearchParams({ host });
  if (opts.label) q.set("label", opts.label);
  if (opts.mode) q.set("mode", opts.mode);
  return http
    .request<{ setupUrl: string }>("GET", `/connect-link?${q.toString()}`)
    .then((r) => r.setupUrl);
}

export function allow(http: Transport, site: string): Promise<string> {
  return http.request<{ allowed: string }>("POST", "/permissions", { site }).then((r) => r.allowed);
}

export function deny(http: Transport, site: string): Promise<boolean> {
  return http
    .request<{ removed: boolean }>("DELETE", `/permissions/${encodeURIComponent(site)}`)
    .then((r) => r.removed);
}

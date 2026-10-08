/**
 * The credential vault and the account's sign-in preferences.
 *
 * The bodies of the `Unfenced` methods under `// ---- credential vault`, moved
 * out with only `this.request` -> `http.request`. No method here ever returns a
 * stored secret - that was true before the split and stays true after it.
 */
import { Transport } from "./http.js";
import type { AccountPrefs, CredentialName } from "./types.js";

export function storeCredential(
  http: Transport,
  name: string,
  secret: string,
  username?: string,
  kind?: "password" | "totp",
): Promise<CredentialName> {
  return http.request<CredentialName>("POST", "/vault", { name, secret, username, kind });
}

export function credentialNames(http: Transport): Promise<CredentialName[]> {
  return http
    .request<{ credentials: CredentialName[] }>("GET", "/vault")
    .then((r) => r.credentials);
}

export function deleteCredential(http: Transport, name: string): Promise<boolean> {
  return http
    .request<{ removed: boolean }>("DELETE", `/vault/${encodeURIComponent(name)}`)
    .then((r) => r.removed);
}

export function accountPrefs(http: Transport): Promise<AccountPrefs> {
  return http.request<{ prefs: AccountPrefs }>("GET", "/prefs").then((r) => r.prefs);
}

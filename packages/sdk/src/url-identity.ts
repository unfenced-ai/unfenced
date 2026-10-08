/**
 * Content identity shared by batch deduplication, worker caching and live-page
 * reuse. Ordinary anchors do not change the document; SPA route fragments do.
 * A non-root trailing slash stays significant because servers can route it to
 * a different representation. Invalid URLs have no identity.
 */
export function urlIdentity(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!/^#[/!?]/.test(url.hash)) url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The agent's task-memory scratchpad: remember, recall, forget.
 *
 * The bodies of the `Unfenced` methods under `// ---- task memory`, moved out
 * with only `this.request` -> `http.request`. `recall` is one function here; the
 * two public overloads stay declared on the `Unfenced` class.
 */
import { Transport, UnfencedError } from "./http.js";
import type { MemoryEntry, MemoryRecallOptions } from "./types.js";

export function remember(http: Transport, key: string, value: string): Promise<MemoryEntry> {
  return http
    .request<{ entry: MemoryEntry }>("POST", "/memory", { key, value })
    .then((r) => r.entry);
}

export function recall(
  http: Transport,
  keyOrOptions?: string | MemoryRecallOptions,
): Promise<MemoryEntry | MemoryEntry[] | undefined> {
  if (keyOrOptions === undefined || typeof keyOrOptions === "object") {
    const options = keyOrOptions;
    const query = new URLSearchParams();
    if (options?.prefix) query.set("prefix", options.prefix);
    if (options?.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return http
      .request<{ entries: MemoryEntry[] }>("GET", `/memory${suffix}`)
      .then((r) => r.entries);
  }
  const key = keyOrOptions;
  return http
    .request<{ entry: MemoryEntry }>("GET", `/memory/${encodeURIComponent(key)}`)
    .then((r) => r.entry)
    .catch((error) => {
      // A missing key is a 404 — an absence, not an error. Answer `undefined`
      // so a caller can ask "do I have this?" without a try/catch, the same
      // way `get` does on the store.
      if (error instanceof UnfencedError && error.status === 404) return undefined;
      throw error;
    });
}

export function forget(http: Transport, key: string): Promise<boolean> {
  return http
    .request<{ removed: boolean }>("DELETE", `/memory/${encodeURIComponent(key)}`)
    .then((r) => r.removed);
}

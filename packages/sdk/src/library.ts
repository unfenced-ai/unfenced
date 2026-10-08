/**
 * The recorded-session library and the two raw logs beside it.
 *
 * The bodies of the `Unfenced` methods under `// ---- library & memory`, moved
 * out unchanged save for `this.request` becoming `http.request`.
 */
import { Transport } from "./http.js";
import type { SessionDetail, SessionSummary } from "./types.js";

export function sessions(
  http: Transport,
  query: { kind?: string; q?: string; limit?: number } = {},
): Promise<SessionSummary[]> {
  const p = new URLSearchParams();
  if (query.kind) p.set("kind", query.kind);
  if (query.q) p.set("q", query.q);
  if (query.limit) p.set("limit", String(query.limit));
  const qs = p.toString();
  return http
    .request<{ sessions: SessionSummary[] }>("GET", `/sessions${qs ? `?${qs}` : ""}`)
    .then((r) => r.sessions);
}

export function recordedSession(http: Transport, id: string): Promise<SessionDetail> {
  return http.request<{ session: SessionDetail }>("GET", `/sessions/${id}`).then((r) => r.session);
}

export function history(http: Transport, limit = 50): Promise<unknown[]> {
  return http
    .request<{ entries: unknown[] }>("GET", `/history?limit=${limit}`)
    .then((r) => r.entries);
}

export function domains(http: Transport): Promise<unknown[]> {
  return http.request<{ domains: unknown[] }>("GET", "/domains").then((r) => r.domains);
}

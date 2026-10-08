#!/usr/bin/env node
/**
 * unfenced MCP - remote HTTP mode (Streamable HTTP transport).
 *
 * The same tools as the stdio server (tools.ts), exposed at an HTTPS URL so a
 * remote MCP client - the claude.ai "custom connector" dialog, Claude Code's
 * remote-server config, and anything else that speaks Streamable HTTP - can use
 * unfenced without installing anything.
 *
 * Stateless by design: each request builds its own MCP server + transport from
 * the caller's token, forwards to the unfenced API, and tears down. There is no
 * cross-request MCP session state - live-page state lives on the worker, keyed by
 * the sessionId the tools pass. That makes this safe to sit behind the stateless
 * /api gateway and simple to reason about.
 *
 * Auth - the token is an unfenced API key, resolved in this order:
 *   1. Authorization: Bearer <token>     (preferred - Claude Code remote config)
 *   2. ?token=<token>                     (for the web dialog, which has no header field)
 *   3. trailing path segment /mcp/<token> (same, URL-only)
 * The API validates the key; tool *calls* need a valid one, protocol handshakes
 * (initialize, tools/list, ping) do not - and a tokenless call is now refused
 * HERE, before a server carrying all 21 tools is built for it.
 *
 * WHO MAY TALK TO IT. This listens on loopback and answered every origin with
 * `access-control-allow-origin: *` while reading `Origin` nowhere, so any page
 * the operator happened to be visiting could POST JSON-RPC to it and READ THE
 * REPLY - open_page against the account's real signed-in profile, act,
 * fill_secret into a page the attacker chose, list_credentials, recall. On a
 * self-hosted worker started without UNFENCED_TOKEN there was no second gate
 * either: `apiKey: ""` resolves to the canonical local tenant, which is the
 * owner. That is the drive-by the MCP spec mandates Origin validation for on
 * local HTTP transports, and it is why both halves are checked below.
 *
 * Config:
 *   UNFENCED_URL   the API base to forward to (default http://127.0.0.1:8787,
 *                    i.e. co-located with the worker. NOT `.../api`: that prefix
 *                    exists only on the hosted origin, whose rewrite strips it
 *                    before the worker sees it, so the old default pointed every
 *                    tool at paths a local worker does not serve)
 *   MCP_PORT/PORT    listen port (default 8788)
 *   MCP_HOST         bind address (default 127.0.0.1 - put a tunnel/proxy in front)
 *   MCP_PATH         the endpoint path (default /mcp)
 *   MCP_MAX_BODY_BYTES  body ceiling (default 262144; 1024..16777216)
 *   MCP_BODY_TIMEOUT_MS complete-body deadline (default 10000; 100..60000)
 *   MCP_MAX_BODY_READS  simultaneous pre-auth body reads (default 128; 1..1024)
 *
 * stdout carries nothing MCP here (HTTP is the transport); logs go to stderr.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Unfenced } from "@unfenced-ai/sdk";
import { registerTools, SERVER_INFO, SERVER_INSTRUCTIONS } from "./tools.js";
import { attributeClient } from "./client-id.js";

const API_BASE = process.env["UNFENCED_URL"]?.replace(/\/$/, "") ?? "http://127.0.0.1:8787";
const PORT = Number(process.env["MCP_PORT"] ?? process.env["PORT"] ?? 8788);
const HOST = process.env["MCP_HOST"] ?? "127.0.0.1";
const MCP_PATH = process.env["MCP_PATH"] ?? "/mcp";
const MAX_BODY_BYTES = configuredInteger("MCP_MAX_BODY_BYTES", 256 * 1024, 1024, 16 * 1024 * 1024);
const BODY_READ_TIMEOUT_MS = configuredInteger("MCP_BODY_TIMEOUT_MS", 10_000, 100, 60_000);
const MAX_CONCURRENT_BODY_READS = configuredInteger("MCP_MAX_BODY_READS", 128, 1, 1024);

let activeBodyReads = 0;

function configuredInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a whole number between ${min} and ${max}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max}`);
  }
  return value;
}

function tokenFrom(req: IncomingMessage, url: URL): string | undefined {
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  const q = url.searchParams.get("token");
  if (q) return q.trim();
  // Trailing path segment: /mcp/<token>
  if (url.pathname.startsWith(`${MCP_PATH}/`)) {
    const rest = url.pathname.slice(MCP_PATH.length + 1).split("/")[0];
    if (rest) return decodeURIComponent(rest);
  }
  return undefined;
}

class BodyReadError extends Error {
  constructor(
    readonly status: 408 | 413,
    readonly code: "body-timeout" | "body-too-large",
    message: string,
  ) {
    super(message);
  }
}

function contentLength(req: IncomingMessage): number | undefined {
  const raw = req.headers["content-length"];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Read one JSON body under the same 256 KiB default as the main Fastify API.
 *
 * This bridge is a separate Node executable, so the worker's bodyLimit does not
 * cover it. Count bytes while they arrive (chunked bodies have no useful
 * Content-Length) and put a wall clock around the complete receive. The request
 * is paused on refusal; the response helper closes its socket after the refusal
 * is flushed, so a slow sender cannot keep occupying a read slot.
 */
function readJson(req: IncomingMessage): Promise<unknown> {
  const declared = contentLength(req);
  if (declared !== undefined && declared > MAX_BODY_BYTES) {
    throw new BodyReadError(
      413,
      "body-too-large",
      `request body exceeds the ${MAX_BODY_BYTES}-byte limit`,
    );
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    const finish = (result: { value?: unknown; error?: unknown }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      if ("error" in result) reject(result.error);
      else resolve(result.value);
    };
    const stop = (error: BodyReadError): void => {
      req.pause();
      finish({ error });
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_BODY_BYTES) {
        stop(
          new BodyReadError(
            413,
            "body-too-large",
            `request body exceeds the ${MAX_BODY_BYTES}-byte limit`,
          ),
        );
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      try {
        const raw = Buffer.concat(chunks, bytes).toString("utf8");
        finish({ value: raw ? (JSON.parse(raw) as unknown) : undefined });
      } catch (error) {
        finish({ error });
      }
    };
    const onError = (error: Error): void => finish({ error });
    const onAborted = (): void => finish({ error: new Error("request body was aborted") });
    const timer = setTimeout(
      () =>
        stop(
          new BodyReadError(
            408,
            "body-timeout",
            `request body was not received within ${BODY_READ_TIMEOUT_MS} ms`,
          ),
        ),
      BODY_READ_TIMEOUT_MS,
    );
    timer.unref();

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}

function refuseBody(
  req: IncomingMessage,
  res: ServerResponse,
  status: 408 | 413 | 503,
  code: "body-timeout" | "body-too-large" | "body-read-capacity",
  detail: string,
): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("connection", "close");
  if (status === 503) res.setHeader("retry-after", "1");
  if (!req.complete) res.once("finish", () => req.destroy());
  res.end(JSON.stringify({ error: code, detail }));
}

const httpServer = createServer(
  {
    maxHeaderSize: 16 * 1024,
    headersTimeout: Math.min(5_000, BODY_READ_TIMEOUT_MS),
    requestTimeout: BODY_READ_TIMEOUT_MS,
  },
  (req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
          id: null,
        }),
      );
    });
  },
);

/**
 * Is this a browser tab on some other site, driving us?
 *
 * A request with NO `Origin` is not from a page: native MCP clients, curl and
 * anything server-side send none, while a browser always sends one on a
 * cross-origin fetch. So "absent, or loopback" is the whole policy, and it is
 * deliberately not configurable — an allowlist here would be a documented way
 * to turn the protection off for a convenience nobody has asked for. Put a
 * proxy in front if this ever needs to answer a real origin.
 */
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * The JSON-RPC methods a caller may reach before presenting a key.
 *
 * Handshake only. The tool set is public information — the same list is in the
 * README — and a client has to read it to know what it may call. Everything
 * that TOUCHES anything is `tools/call`, and that is not on this list.
 */
const OPEN_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "notifications/cancelled",
  "ping",
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
]);

/** Every method named by a request body, single call or batch. */
function methodsIn(body: unknown): string[] {
  const frames = Array.isArray(body) ? body : [body];
  return frames
    .map((f) => (f && typeof f === "object" ? (f as { method?: unknown }).method : undefined))
    .filter((m): m is string => typeof m === "string");
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);

  const origin = req.headers.origin;
  if (!originAllowed(origin)) {
    // No CORS headers on the refusal, deliberately: a page that cannot read the
    // reply learns nothing from it, and echoing an origin we are refusing would
    // be the very grant being withheld.
    res.writeHead(403, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: "forbidden-origin",
        detail: `${origin ?? "that origin"} may not drive this bridge`,
        remedy:
          "this is a loopback bridge for a local MCP client, not a web API - a page cannot call it. Point your MCP client at it directly",
      }),
    );
    return;
  }

  // Echoed, never `*`. With `*` any page could read the reply cross-origin,
  // which is what made the missing Origin check exploitable rather than untidy.
  if (origin) res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "origin");
  res.setHeader(
    "access-control-allow-headers",
    "authorization, content-type, mcp-session-id, mcp-protocol-version, accept",
  );
  res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("access-control-expose-headers", "mcp-session-id");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const onPath = url.pathname === MCP_PATH || url.pathname.startsWith(`${MCP_PATH}/`);
  if (!onPath) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not-found", detail: `MCP is at ${MCP_PATH}` }));
    return;
  }

  const token = tokenFrom(req, url);
  // Read the body BEFORE building anything. The refusal has to happen while
  // this is still a request: once the transport owns it, all 21 tools are
  // registered against a client running as whatever `apiKey: ""` resolves to,
  // which on a token-less self-hosted worker is the owner.
  let body: unknown;
  if (req.method === "POST") {
    const declared = contentLength(req);
    if (declared !== undefined && declared > MAX_BODY_BYTES) {
      refuseBody(
        req,
        res,
        413,
        "body-too-large",
        `request body exceeds the ${MAX_BODY_BYTES}-byte limit`,
      );
      return;
    }
    // A presented Bearer string is not authenticated until the API sees it, so
    // every pre-transport read shares this admission budget. Otherwise an
    // attacker can bypass an "anonymous" limit with arbitrary header text.
    if (activeBodyReads >= MAX_CONCURRENT_BODY_READS) {
      refuseBody(
        req,
        res,
        503,
        "body-read-capacity",
        `all ${MAX_CONCURRENT_BODY_READS} request-body readers are busy`,
      );
      return;
    }
    activeBodyReads += 1;
    try {
      body = await readJson(req).catch((error: unknown) => {
        if (error instanceof BodyReadError) throw error;
        return undefined;
      });
    } catch (error) {
      if (error instanceof BodyReadError) {
        refuseBody(req, res, error.status, error.code, error.message);
        return;
      }
      throw error;
    } finally {
      activeBodyReads -= 1;
    }
  }
  const methods = methodsIn(body);
  // A body naming no method at all (a GET stream, an unparseable POST) counts
  // as needing a key: failing open on the shape we could not read is how a gate
  // becomes decorative.
  const needsKey = methods.length === 0 || methods.some((m) => !OPEN_METHODS.has(m));
  if (!token && needsKey) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: "unauthorized",
        detail: "this bridge needs an unfenced API key",
        remedy:
          "send it as `Authorization: Bearer <key>`, or as ?token=<key> if your client cannot set a header. A handshake (initialize, tools/list, ping) needs none",
      }),
    );
    return;
  }

  const clientHeaders: Record<string, string> = {};
  const cloud = new Unfenced({ baseUrl: API_BASE, apiKey: token ?? "", headers: clientHeaders });
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  attributeClient(server, clientHeaders);
  clientHeaders["x-unfenced-token-meter"] = "mcp";
  registerTools(server, cloud, (usage) => cloud.recordTokenUsage(usage));

  // Stateless: no session id, one server+transport per request, torn down after.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

/**
 * A port that is already taken is an operator's problem, not a stack trace.
 *
 * This was a bare `listen`, so EADDRINUSE reached the console as an unhandled
 * 'Error: listen EADDRINUSE' with a Node stack — on a program every other
 * failure of which answers in a sentence. The likeliest cause is the operator's
 * own second copy of this bridge, and that is worth saying.
 */
httpServer.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `unfenced mcp (http): ${HOST}:${PORT} is already in use - something else is listening ` +
        "there (another copy of this bridge?). Set MCP_PORT to a free port, or stop it.",
    );
  } else {
    console.error(`unfenced mcp (http): cannot listen on ${HOST}:${PORT} - ${error.message}`);
  }
  process.exit(1);
});

httpServer.listen(PORT, HOST, () => {
  // The ADDRESS IT GOT, not the one it was asked for. MCP_PORT=0 asks the OS
  // for a free port, which is how a test starts this without guessing at one -
  // http-bridge.test.ts used to pick a random port in a 90-wide range and treat
  // ANY answer on it as this bridge coming up, so a stranger's server on the
  // same box decided whether a security suite passed. It parses this line now,
  // which makes the port real and the identity certain in one move.
  const bound = httpServer.address();
  const port = typeof bound === "object" && bound ? bound.port : PORT;
  console.error(
    `unfenced mcp (http) listening on http://${HOST}:${port}${MCP_PATH} -> ${API_BASE}`,
  );
});

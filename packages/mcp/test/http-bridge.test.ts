import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, request as httpRequest, type ClientRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * WHO MAY DRIVE THE LOOPBACK BRIDGE.
 *
 * `unfenced-mcp-http` listens on 127.0.0.1 and used to answer every origin with
 * `access-control-allow-origin: *` while reading `Origin` nowhere, and to build
 * a server registering all 21 tools before looking for a token. Any page the
 * operator happened to have open could therefore CORS-preflight a JSON-RPC POST
 * at it and read the reply: `open_page` against the account's real signed-in
 * profile, `act`, `fill_secret` into a page the attacker chose,
 * `list_credentials`, `recall`. On a self-hosted worker with no UNFENCED_TOKEN
 * the anonymous path was not merely unauthenticated - `apiKey: ""` is the
 * canonical local tenant, which is the owner.
 *
 * Driven over real HTTP against the BUILT bundle, because the two halves being
 * asserted are header handling and a refusal that happens before the MCP SDK
 * sees the request - neither is reachable by importing a function. The bundle
 * is what `bin` points at, so a build is required; the suite skips rather than
 * fails when it is absent, the way the browser-backed suites do.
 */
const BUNDLE = fileURLToPath(new URL("../dist/http.mjs", import.meta.url));
const built = existsSync(BUNDLE);

let child: ChildProcess | undefined;
let base = "";

/**
 * START THE BRIDGE, AND KNOW IT IS THE BRIDGE.
 *
 * This picked `8900 + Math.floor(Math.random() * 90)` and then polled that
 * port until ANY answer came back. Observed: eight failures across four files
 * in one run, the last of them `expected 501 to be 200`, and two identical
 * re-runs green with no code change. A TCP scan of 8900-8989 on the same box
 * found 8911 and 8931 already listening, and 8931 answers OPTIONS with 501 and
 * text/html - so roughly one run in forty-five drove a stranger's HTTP server
 * and reported it as this file's subject.
 *
 * A security suite that can be red for a reason unrelated to the code is a
 * security suite that gets re-run until green and then stopped being read. The
 * inverse was never ruled out either: a squatter answering 401 or 403 would
 * have made the REFUSAL cases pass for entirely the wrong reason.
 *
 * So the OS picks the port (MCP_PORT=0) and the child says which one it got.
 * Liveness and identity in one line, from the process we spawned - no probe
 * can be fooled because there is no probe.
 */
beforeAll(async () => {
  if (!built) return;
  child = spawn(process.execPath, [BUNDLE], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      MCP_PORT: "0",
      // Nothing listens there. Every assertion here is about what the bridge
      // decides BEFORE it forwards, so the API being unreachable is fine and
      // keeps the test from depending on a worker.
      UNFENCED_URL: "http://127.0.0.1:9",
      // Small test-only values make the boundary cases fast. Production uses
      // 256 KiB / 10 s / 128 concurrent reads.
      MCP_MAX_BODY_BYTES: "4096",
      MCP_BODY_TIMEOUT_MS: "400",
      MCP_MAX_BODY_READS: "2",
    },
  });

  const port = await new Promise<number>((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `the bridge never printed its listen address. stderr so far: ${seen || "(nothing)"}`,
          ),
        ),
      15_000,
    );
    child?.stderr?.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)\//.exec(seen);
      if (!m) return;
      clearTimeout(timer);
      resolve(Number(m[1]));
    });
    child?.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the bridge exited with ${String(code)} before listening: ${seen}`));
    });
  });
  base = `http://127.0.0.1:${port}/mcp`;
}, 20_000);

afterAll(() => {
  child?.kill("SIGKILL");
});

const rpc = (method: string, id = 1): string =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params: {} });

it.skipIf(!built)("unexpected errors do not expose exception details", async () => {
  const response = await new Promise<{ status: number | undefined; body: string }>(
    (resolve, reject) => {
      const request = httpRequest(base, { path: "http://[" }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      request.on("error", reject);
      request.end();
    },
  );
  expect(response.status).toBe(500);
  expect(JSON.parse(response.body)).toEqual({
    jsonrpc: "2.0",
    error: { code: -32603, message: "Internal server error" },
    id: null,
  });
});

const HANDSHAKE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  },
});

describe.skipIf(!built)("the loopback MCP bridge", () => {
  it("refuses a request from a page on another site", async () => {
    const res = await fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin: "https://evil.example",
      },
      body: HANDSHAKE,
    });
    expect(res.status).toBe(403);
    // And tells that page nothing it could read cross-origin.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(((await res.json()) as { error?: string }).error).toBe("forbidden-origin");
  });

  it("refuses its preflight too, so the POST is never attempted", async () => {
    const res = await fetch(base, {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("never answers with a wildcard origin", async () => {
    const res = await fetch(base, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(res.headers.get("vary")).toContain("origin");
  });

  it("lets a client with no Origin at all through - which is every native one", async () => {
    const res = await fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: HANDSHAKE,
    });
    expect(res.status).toBe(200);
  });

  it("answers a handshake without a key, because a client must read the tool list", async () => {
    const res = await fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: rpc("ping", 7),
    });
    expect(res.status).toBe(200);
  });

  it("refuses a tokenless tools/call before any tool is registered", async () => {
    const res = await fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_credentials", arguments: {} },
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string; remedy?: string };
    expect(body.error).toBe("unauthorized");
    expect(body.remedy).toBeTruthy();
  });

  it("refuses a body it could not read rather than failing open", async () => {
    const res = await fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "not json at all",
    });
    expect(res.status).toBe(401);
  });

  it("accepts the same call once a key is presented", async () => {
    const res = await fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer some-key",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_credentials", arguments: {} },
      }),
    });
    // 200 with a tool-level error: the request got past the gate and the call
    // failed at the unreachable API, which is the whole distinction being made.
    expect(res.status).toBe(200);
  });

  it("rejects an oversized fixed-length body before buffering it", async () => {
    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(4097),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error?: string }).error).toBe("body-too-large");
  });

  it("rejects an oversized chunked body before the sender finishes it", async () => {
    const result = await unfinishedPost(Buffer.alloc(4097, "x"));
    expect(result.status).toBe(413);
    expect(JSON.parse(result.body)).toMatchObject({ error: "body-too-large" });
  });

  it("times out a body that is dribbled without completion", async () => {
    const result = await unfinishedPost("{");
    expect(result.status).toBe(408);
    expect(JSON.parse(result.body)).toMatchObject({ error: "body-timeout" });
  });

  it("bounds concurrent pre-auth body reads even when a caller presents token text", async () => {
    const holders = [heldPost(), heldPost()];
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const res = await fetch(base, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer not-yet-validated",
        },
        body: rpc("ping", 9),
      });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("1");
      expect(((await res.json()) as { error?: string }).error).toBe("body-read-capacity");
    } finally {
      for (const request of holders) request.destroy();
    }
  });
});

function unfinishedPost(initial: Buffer | string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      base,
      { method: "POST", headers: { "content-type": "application/json" } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.once("error", reject);
    request.write(initial);
  });
}

function heldPost(): ClientRequest {
  const request = httpRequest(base, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "100",
      authorization: "Bearer arbitrary-text-does-not-bypass-admission",
    },
  });
  request.on("error", () => undefined);
  request.on("response", (response) => response.resume());
  request.write("{");
  return request;
}

describe("the bridge on a port it cannot have", () => {
  /**
   * EADDRINUSE was an unhandled Node stack trace.
   *
   * `httpServer.listen(...)` carried no error handler, so the one failure an
   * operator meets by accident - a second copy of the bridge, or anything else
   * on 8788 - printed 'Error: listen EADDRINUSE' and a stack, on a program
   * every other refusal of which is a sentence. The likeliest cause is worth
   * naming, and so is the remedy.
   */
  it.runIf(built)(
    "says so in a sentence, and exits 1",
    async () => {
      const squatter = createServer((_req, res) => res.end());
      const port = await new Promise<number>((resolve) => {
        squatter.listen(0, "127.0.0.1", () => {
          const bound = squatter.address();
          resolve(typeof bound === "object" && bound ? bound.port : 0);
        });
      });
      try {
        const run = spawnSync(process.execPath, [BUNDLE], {
          env: {
            ...process.env,
            MCP_PORT: String(port),
            UNFENCED_URL: "http://127.0.0.1:9",
          },
          encoding: "utf8",
          timeout: 15_000,
        });
        expect(run.status).toBe(1);
        expect(run.stderr).toContain(`${port} is already in use`);
        // The remedy, not only the diagnosis.
        expect(run.stderr).toContain("MCP_PORT");
        expect(run.stderr, "an unhandled listen error prints a stack").not.toContain("at ");
      } finally {
        squatter.close();
      }
    },
    20_000,
  );
});

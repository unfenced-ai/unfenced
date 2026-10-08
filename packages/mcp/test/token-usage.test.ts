import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { meteredTools } from "../src/tools/usage.js";
import { asToolResult, actToolResult, toolError } from "../src/tools/shared.js";
import { toolTokenUsage } from "@unfenced-ai/sdk";

describe("tool result reporting", () => {
  it("keeps local browser startup failures actionable", () => {
    const error = Object.assign(new Error("Chrome exited during startup"), {
      name: "BrowserUnavailableError",
      fix: "repair the browser host",
    });

    expect(toolError("open-failed", error)).toEqual({
      error: "browser-unavailable",
      detail: "Chrome exited during startup",
      remedy: "repair the browser host",
    });
  });

  it("returns an action screenshot as an image block while preserving refs and outcome", () => {
    const marks = [{ mark: 1, ref: "e1", role: "button", name: "Continue" }];
    const data = "A".repeat(40000);
    const reply = actToolResult({
      ok: true,
      view: { image: `data:image/jpeg;base64,${data}`, marks, note: "One control" },
    });
    expect(reply.content[1]).toEqual({ type: "image", mimeType: "image/jpeg", data });
    const text = reply.content[0];
    if (text?.type !== "text") throw Error("missing text");
    expect(JSON.parse(text.text)).toEqual({ ok: true, view: { marks, note: "One control" } });
    expect(toolTokenUsage("act", { sessionId: "s1" }, reply)).toMatchObject({
      imageCount: 1,
      textChars: text.text.length,
    });
    expect(text.text.length).toBeLessThan(200);
  });
  it("reports the final compact response once without changing its contents", async () => {
    let handler!: (args: unknown) => Promise<unknown>;
    const server = {
      registerTool: vi.fn((_name, _schema, fn) => {
        handler = fn;
      }),
    } as unknown as McpServer;
    const report = vi.fn(async () => {});
    const payload = {
      page: {
        controls: Array.from({ length: 80 }, (_, i) => ({
          ref: `e${i}`,
          role: "button",
          name: `Button ${i}`,
        })),
      },
    };
    const result = asToolResult(payload);
    const metered = meteredTools(server, report);
    metered.registerTool("observe_page", {}, async () => result);
    expect(await handler({ sessionId: "s1" })).toBe(result);
    expect(report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        category: "session",
        sessionId: "s1",
        textChars: result.content[0]!.text.length,
      }),
    );
    expect(JSON.parse(result.content[0]!.text)).toEqual(payload);
    expect(result.content[0]!.text.length).toBeLessThan(
      JSON.stringify(payload, null, 2).length * 0.8,
    );
  });
  it("never delays an action for telemetry or fails it when reporting fails", async () => {
    let handler!: () => Promise<unknown>;
    const server = {
      registerTool: (_name: unknown, _schema: unknown, fn: typeof handler) => {
        handler = fn;
      },
    } as unknown as McpServer;
    const result = asToolResult({ ok: true });
    for (const report of [
      () => new Promise<void>(() => {}),
      async () => {
        throw new Error("offline");
      },
    ]) {
      meteredTools(server, report).registerTool("act", {}, async () => result);
      expect(await handler()).toBe(result);
    }
  });
});

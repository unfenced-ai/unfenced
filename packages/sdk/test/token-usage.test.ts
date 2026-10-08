import { describe, expect, it } from "vitest";
import { toolTokenUsage } from "../src/token-usage.js";

describe("returned tool text accounting", () => {
  it("counts text and metadata once, excludes image bytes and duplicate structured output", () => {
    const text = JSON.stringify({
      sessionId: "worker~session",
      title: "שלום 🌍",
      page: { controls: [] },
    });
    const usage = toolTokenUsage(
      "open_page",
      {},
      {
        content: [
          { type: "text", text },
          { type: "image", data: "A".repeat(10000) },
        ],
        structuredContent: JSON.parse(text),
      },
    );
    expect(usage).toEqual({
      category: "session",
      operation: "open_page",
      sessionId: "worker~session",
      textChars: text.length,
      imageCount: 1,
    });
  });
  it("attributes failed actions to their input session and counts error text", () => {
    expect(
      toolTokenUsage(
        "act",
        { sessionId: "session" },
        { isError: true, content: [{ type: "text", text: "ref stale" }] },
      ),
    ).toMatchObject({ category: "session", sessionId: "session", textChars: 9 });
  });
  it("counts a batch once and distinguishes fetches from other tools", () => {
    expect(
      toolTokenUsage(
        "fetch_batch",
        {},
        {
          content: [
            { type: "text", text: "abc" },
            { type: "text", text: "de" },
          ],
        },
      ),
    ).toMatchObject({ category: "fetch", textChars: 5 });
    expect(toolTokenUsage("list_permissions", {}, { content: [] })).toMatchObject({
      category: "other",
      textChars: 0,
    });
  });
});

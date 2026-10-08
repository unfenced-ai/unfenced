import { describe, expect, it } from "vitest";
import { Unfenced, UnfencedError } from "../src/index.js";

describe("a live-session write without a response", () => {
  it.each([
    ["open_page", (client: Unfenced) => client.open("https://example.test")],
    ["act", (client: Unfenced) => client.act("s1", { kind: "click", on: "Pay" })],
    ["fill_form", (client: Unfenced) => client.fill("s1", [])],
  ])("warns that %s may already have executed before a retry", async (_name, call) => {
    const client = new Unfenced({
      fetch: async () => {
        throw new DOMException("request expired", "TimeoutError");
      },
    });
    try {
      await call(client);
      expect.fail("the timed-out write unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(UnfencedError);
      const failure = error as UnfencedError;
      expect(failure.code).toBe("execution-uncertain");
      expect(failure.remedy).toMatch(/may have executed/i);
      expect(failure.remedy).toMatch(/observe|list sessions/i);
    }
  });
});

import { afterEach, expect, it, vi } from "vitest";
import { registerClosePage } from "../src/tools/page.js";

afterEach(() => vi.unstubAllEnvs());

it("describes the worker's configured live-page ceiling rather than a stale literal", () => {
  vi.stubEnv("UNFENCED_MAX_SESSIONS", "5");
  let description = "";
  const server = {
    registerTool: (_name: string, config: { description: string }) => {
      description = config.description;
    },
  };
  registerClosePage(server as never, {} as never);
  expect(description).toContain("machine-wide ceiling behind that is 5");
  expect(description).not.toContain("machine-wide ceiling behind that is 8");
});

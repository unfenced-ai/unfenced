/**
 * THE COMMAND ON THE NPM PAGE STILL STARTS THE PACKAGE.
 *
 * Its own file, and that is the point. This case lived inside
 * `entrypoints.test.ts`, and docs.yml reached it with
 * `vitest run test/entrypoints.test.ts -t README`. Measured: `-t ZZZNOSUCHNAME`
 * against that file prints "Test Files 1 skipped | Tests 21 skipped" and EXITS
 * 0, and still exits 0 with --passWithNoTests=false, because the FILE was
 * found and only the name filter matched nothing. So renaming one test title -
 * or rewording it out of the word README - would have left docs.yml running
 * nothing under a green tick, while the workflow's own prose two steps above
 * says a rename "turns this step into a no-op under a green tick" and that
 * scripts/workflow-gates.test.ts checks every one of them. It bound
 * `--filter` names and `working-directory` paths, and no `-t` pattern at all.
 *
 * A path is what a workflow can be held to, so this is a path. The rest of
 * entrypoints.test.ts spawns dist/ and needs a build; this reads the manifest
 * and needs none, which is what let docs.yml single it out in the first place.
 */
import { describe, expect, it } from "vitest";
import { npxResolves, published } from "./manifest.js";

describe("the published quickstart", () => {
  it("can be started by the command its own README gives", () => {
    // `npx -y @unfenced-ai/mcp` - the snippet on the npm page and in four other
    // documents - cannot start this package: npm looks for a bin named after
    // the unscoped package (`mcp`), finds two bins with different targets and
    // neither called that, and throws "could not determine executable to run"
    // before installing anything. The docs now use the `-p` form the dashboard
    // has always generated, and this is what keeps the two honest: if the bare
    // form is ever made to work, this test says so and the docs can shorten.
    expect(npxResolves(published), "npx <package> resolves a bin directly").toBe(false);
    expect(Object.keys(published.bin ?? {})).toContain("unfenced-mcp");
  });
});

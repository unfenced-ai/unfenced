/**
 * THE PUBLISHED MANIFEST, AND NPM'S OWN RULES ABOUT IT.
 *
 * A helper module rather than a second copy, because two test files need the
 * same reading of the same document.
 *
 * `readme-start.test.ts` is a separate FILE so a workflow can name it by path.
 * docs.yml used to reach the one case it cares about with
 * `vitest run test/entrypoints.test.ts -t README`, and a `-t` pattern matching
 * nothing prints "21 skipped" and EXITS 0 - even with --passWithNoTests=false,
 * because the FILE was found. So one edit to a test title would have turned
 * the gate proving the published quickstart still starts the package into a
 * no-op under a green tick: the exact failure the step above it in that
 * workflow replaced `--filter` with `working-directory` to avoid. A wrong
 * path fails loudly.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
export interface Manifest {
  name: string;
  bin?: Record<string, string>;
  files?: string[];
  exports?: Record<string, unknown>;
  publishConfig?: { exports?: Record<string, unknown> };
}

export const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as Manifest;

/**
 * The manifest as the REGISTRY will see it.
 *
 * npm applies `publishConfig` field overrides at publish time, so the workspace
 * manifest and the published one can be different documents - and the published
 * one is the contract a stranger's install is judged against.
 *
 * They are the same document again, deliberately. `publishConfig.exports` used
 * to delete the `./tools` subpath that `@unfenced/server` imports, which made
 * the server's own tarball answer ERR_PACKAGE_PATH_NOT_EXPORTED on its first
 * import while resolving perfectly through the workspace link - two copies of
 * one fact, and every test in the tree read the copy that was true. `./tools`
 * now ships: its output is in `files` and `@unfenced-ai/sdk` is a real
 * dependency, because `tools/shared.ts` imports `UnfencedError` from it at
 * runtime. This merge stays so the assertions below judge the published
 * document whatever `publishConfig` later says.
 */
export const published: Manifest = { ...pkg, ...(pkg.publishConfig ?? {}) };

/** Everything `files` will actually put in the tarball, as posix paths. */
export const packed = (m: Manifest): string[] => (m.files ?? []).map((f) => f.replace(/^\.\//, ""));

export const isPacked = (target: string): boolean => {
  const path = target.replace(/^\.\//, "");
  return packed(published).some((f) => path === f || path.startsWith(`${f}/`));
};

/** Flatten an exports map to the file paths it can resolve to. */
export const exportTargets = (
  map: Record<string, unknown> | undefined,
): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  const walk = (subpath: string, node: unknown): void => {
    if (typeof node === "string") return void out.push([subpath, node]);
    if (node && typeof node === "object") {
      for (const value of Object.values(node as Record<string, unknown>)) walk(subpath, value);
    }
  };
  for (const [subpath, node] of Object.entries(map ?? {})) walk(subpath, node);
  return out;
};

/**
 * npm's own rule for `npx <package>`, transcribed from
 * libnpmexec/lib/get-bin-from-manifest.js: one bin (or several aliasing one
 * target) is used whatever it is called; otherwise a bin named after the
 * UNSCOPED package name; otherwise npx refuses before installing anything.
 */
export const npxResolves = (m: Manifest): boolean => {
  const bin = m.bin ?? {};
  if (new Set(Object.values(bin)).size === 1) return true;
  return Boolean(bin[m.name.replace(/^@[^/]+\//, "")]);
};

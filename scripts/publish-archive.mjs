import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const name = process.argv[2];
assert.ok(["sdk", "mcp"].includes(name), "Specify sdk or mcp");
assert.equal(process.env.GITHUB_REPOSITORY, "unfenced-ai/unfenced");
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
const pkg = JSON.parse(fs.readFileSync(`packages/${name}/package.json`, "utf8"));
const archive = path.resolve(`artifacts/unfenced-ai-${name}-${pkg.version}.tgz`);
const integrity = `sha512-${createHash("sha512").update(fs.readFileSync(archive)).digest("base64")}`;
const response = await fetch(
  `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`,
);
if (response.ok) {
  const published = await response.json();
  assert.equal(
    published.dist.integrity,
    integrity,
    "Version already exists with different contents; do not overwrite or silently skip it",
  );
  console.log(`${pkg.name}@${pkg.version} already contains this verified archive; skipping.`);
} else {
  assert.equal(response.status, 404, "Could not safely check existing npm version");
  const result = spawnSync(
    "npm",
    ["publish", archive, "--access", "public", "--provenance", "--ignore-scripts"],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, "npm publish failed");
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const out = path.join(root, "artifacts");
fs.mkdirSync(out, { recursive: true });
const nodeDir = path.dirname(process.execPath);
const npm = [
  path.join(nodeDir, "node_modules/npm/bin/npm-cli.js"),
  path.join(nodeDir, "../lib/node_modules/npm/bin/npm-cli.js"),
].find(fs.existsSync);
assert.ok(npm, "Could not locate npm alongside Node.js");
assert.ok(process.env.npm_execpath, "Run this check through pnpm pack-check");
function run(script, args, cwd = root) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${path.basename(script)} ${args[0]} failed`);
}
const archives = [];
for (const name of ["sdk", "mcp"]) {
  const cwd = path.join(root, "packages", name);
  const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  run(process.env.npm_execpath, ["pack", "--pack-destination", out], cwd);
  const archive = path.join(out, `unfenced-ai-${name}-${pkg.version}.tgz`);
  assert.ok(fs.existsSync(archive));
  archives.push(archive);
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "unfenced-pack-check-"));
fs.writeFileSync(
  path.join(temp, "package.json"),
  JSON.stringify({ name: "unfenced-consumer-check", private: true, type: "module" }),
);
try {
  run(
    npm,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...archives,
      "typescript@5.9.3",
      "@types/node@22",
    ],
    temp,
  );
  for (const name of ["sdk", "mcp"]) {
    const dir = path.join(temp, "node_modules/@unfenced-ai", name);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    assert.equal(pkg.license, "MIT");
    assert.ok(fs.readFileSync(path.join(dir, "LICENSE"), "utf8").includes("MIT License"));
    assert.equal(pkg.repository.url, "git+https://github.com/unfenced-ai/unfenced.git");
    assert.ok(!JSON.stringify(pkg.dependencies ?? {}).includes("workspace:"));
    assert.ok(!Object.keys(pkg.dependencies ?? {}).some((dep) => dep.startsWith("@unfenced/")));
    const files = fs.readdirSync(dir, { recursive: true });
    assert.ok(
      !files.some((file) =>
        /(^|[/\\])(?:\.env|node_modules|core|server|extract)(?:[/\\]|$)/.test(file),
      ),
    );
  }
  fs.copyFileSync(path.join(root, "scripts/packed-client-smoke.mjs"), path.join(temp, "smoke.mjs"));
  run(path.join(temp, "smoke.mjs"), [], temp);
  const launch = spawnSync(process.execPath, [npm, "exec", "--offline", "--", "@unfenced-ai/mcp"], {
    cwd: temp,
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, UNFENCED_URL: "", UNFENCED_TOKEN: "" },
  });
  assert.equal(launch.status, 1);
  assert.ok(launch.stderr.includes("unfenced-mcp: missing configuration"), launch.stderr);
  fs.writeFileSync(
    path.join(temp, "consumer.ts"),
    'import { Unfenced, type Action } from "@unfenced-ai/sdk";\nimport { registerTools, TOOL_NAMES } from "@unfenced-ai/mcp/tools";\nconst action: Action = { kind: "click", ref: "r1" };\nvoid new Unfenced(); void action; void registerTools; void TOOL_NAMES;\n',
  );
  run(
    path.join(temp, "node_modules/typescript/bin/tsc"),
    [
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "false",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "consumer.ts",
    ],
    temp,
  );
  console.log("Both package archives passed isolated imports, type checking, and MCP startup.");
} finally {
  // This is the exact directory created by mkdtemp above, never a supplied path.
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith("unfenced-pack-check-"));
  fs.rmSync(temp, { recursive: true, force: true });
}

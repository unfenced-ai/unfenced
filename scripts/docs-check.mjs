import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = process.cwd();
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if ([".git", "node_modules", "dist"].includes(entry.name)) return [];
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
for (const file of walk(root).filter((file) => file.endsWith(".md"))) {
  const text = fs.readFileSync(file, "utf8");
  for (const match of text.matchAll(/\]\((\.[^)#]+)(?:#[^)]*)?\)/g)) {
    assert.ok(
      fs.existsSync(path.resolve(path.dirname(file), match[1])),
      `${file}: broken link ${match[1]}`,
    );
  }
}
const readme = fs.readFileSync("README.md", "utf8");
const manifest = JSON.parse(fs.readFileSync("packages/mcp/package.json", "utf8"));
assert.ok(readme.includes(manifest.name));
assert.ok(readme.includes('"UNFENCED_URL": "https://unfenced.ai/api"'));
assert.ok(readme.includes('"UNFENCED_TOKEN": "YOUR_UNFENCED_API_KEY"'));
assert.ok(readme.includes(Object.keys(manifest.bin)[0]));
for (const pkg of ["sdk", "mcp"]) {
  const p = JSON.parse(fs.readFileSync(`packages/${pkg}/package.json`, "utf8"));
  assert.equal(p.license, "MIT");
  assert.ok(
    !Object.keys({ ...p.dependencies, ...p.devDependencies }).some((name) =>
      name.startsWith("@unfenced/"),
    ),
  );
}
console.log("Documentation links, quick start, licensing, and public package boundary passed.");

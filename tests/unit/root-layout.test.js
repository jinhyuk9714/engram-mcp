import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT_DIR, relativePath), "utf8");
}

describe("root layout", () => {
  test("keeps public docs at the root while moving support files under docs and scripts", () => {
    assert.equal(fs.existsSync(path.join(ROOT_DIR, "README.md")), true);
    assert.equal(fs.existsSync(path.join(ROOT_DIR, "INSTALL.md")), true);
    assert.equal(fs.existsSync(path.join(ROOT_DIR, "SKILL.md")), false);
    assert.equal(fs.existsSync(path.join(ROOT_DIR, "docs/skills/SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(ROOT_DIR, "scripts/setup.sh")), true);
    assert.equal(fs.existsSync(path.join(ROOT_DIR, "setup.sh")), true);
  });

  test("documents scripts and docs/skills as the canonical locations", () => {
    assert.match(read("setup.sh"), /scripts\/setup\.sh/);
    assert.match(read("INSTALL.md"), /bash scripts\/setup\.sh/);
    assert.match(read("INSTALL.en.md"), /bash scripts\/setup\.sh/);
    assert.match(read("README.md"), /scripts\//);
    assert.match(read("README.md"), /docs\/skills\//);
    assert.match(read("README.en.md"), /scripts\//);
    assert.match(read("README.en.md"), /docs\/skills\//);
  });
});

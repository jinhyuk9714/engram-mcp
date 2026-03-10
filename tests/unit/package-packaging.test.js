import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");

describe("package packaging metadata", () => {
  test("uses a normalized bin path that npm publish does not need to rewrite", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));
    assert.equal(pkg.bin["engram-mcp"], "bin/engram-mcp.js");
  });

  test("includes runtime config files in the published tarball", () => {
    const raw = execFileSync("npm", ["pack", "--json", "--dry-run"], {
      cwd: ROOT_DIR,
      encoding: "utf8"
    });
    const packInfo = JSON.parse(raw)[0];
    const packagedFiles = new Set(packInfo.files.map((file) => file.path));

    assert.equal(packagedFiles.has("config/memory.js"), true);
  });
});

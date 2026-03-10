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

describe("vector schema normalization", () => {
  test("uses public pgvector types instead of nerdvana-qualified vector types", () => {
    assert.doesNotMatch(read("lib/memory/migration-008-morpheme-dict.sql"), /nerdvana\.vector/);
    assert.doesNotMatch(read("lib/memory/MorphemeIndex.js"), /nerdvana\.vector/);
  });

  test("uses a public search_path without nerdvana dependency", () => {
    assert.doesNotMatch(read("lib/tools/db.js"), /nerdvana/);
    assert.doesNotMatch(read("lib/memory/normalize-vectors.js"), /nerdvana/);
    assert.doesNotMatch(read("lib/memory/FragmentStore.js"), /nerdvana/);
  });
});

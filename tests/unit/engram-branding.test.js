import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");

function runNodeWithEnv(script, env = {}) {
  return execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        LOG_DIR: path.join(ROOT_DIR, "tmp/test-logs"),
        ...env
      },
      encoding: "utf8"
    }
  ).trim();
}

describe("engram branding", () => {
  const legacyPrefix = ["m", "e", "m", "e", "n", "t", "o"].join("");
  const legacyEnvKey = `${legacyPrefix.toUpperCase()}_ACCESS_KEY`;
  const legacyHeaderKey = `${legacyPrefix}-access-key`;

  test("uses ENGRAM_ACCESS_KEY and does not fall back to the legacy access key env var", () => {
    assert.equal(
      runNodeWithEnv(
        "const mod = await import('./lib/config.js'); process.stdout.write(JSON.stringify(mod.ACCESS_KEY));",
        { ENGRAM_ACCESS_KEY: "engram-secret", [legacyEnvKey]: "" }
      ),
      "\"engram-secret\""
    );

    assert.equal(
      runNodeWithEnv(
        "const mod = await import('./lib/config.js'); process.stdout.write(JSON.stringify(mod.ACCESS_KEY));",
        { ENGRAM_ACCESS_KEY: "", [legacyEnvKey]: "legacy-secret" }
      ),
      "\"\""
    );
  });

  test("accepts engram-access-key header and rejects the legacy custom header", () => {
    const script = `
      const auth = await import('./lib/auth.js');
      const baseReq = { headers: {}, method: 'POST' };
      const legacyHeaderKey = ${JSON.stringify(legacyHeaderKey)};
      const accepted = await auth.validateAuthentication(
        { ...baseReq, headers: { 'engram-access-key': 'engram-secret' } },
        null
      );
      const rejected = await auth.validateAuthentication(
        { ...baseReq, headers: { [legacyHeaderKey]: 'engram-secret' } },
        null
      );
      process.stdout.write(JSON.stringify({ accepted, rejected }));
    `;

    const raw = runNodeWithEnv(script, {
      ENGRAM_ACCESS_KEY: "engram-secret",
      [legacyEnvKey]: ""
    });
    const result = JSON.parse(raw.split("\n").filter(Boolean).at(-1));

    assert.equal(result.accepted.valid, true);
    assert.equal(result.rejected.valid, false);
  });

  test("uses engram runtime keys and removes legacy branding outside third-party notices", () => {
    assert.match(
      fs.readFileSync(path.join(ROOT_DIR, "config/memory.js"), "utf8"),
      /engram:embedding_queue/
    );
    assert.doesNotMatch(
      fs.readFileSync(path.join(ROOT_DIR, "assets/admin/index.html"), "utf8"),
      new RegExp(`${legacyPrefix}_admin_key`)
    );
    assert.match(
      fs.readFileSync(path.join(ROOT_DIR, "assets/admin/index.html"), "utf8"),
      /engram_admin_key/
    );

    const lower = ["m", "e", "m", "e", "n", "t", "o"].join("");
    const upper = lower.toUpperCase();
    const title = `${lower[0].toUpperCase()}${lower.slice(1)}`;
    const search = spawnSync(
      "rg",
      [
        "-n",
        "--hidden",
        "--glob", "!node_modules",
        "--glob", "!.git",
        "--glob", "!THIRD_PARTY_NOTICES.md",
        "--glob", "!tests/unit/engram-branding.test.js",
        `${lower}|${upper}|${title}`,
        "."
      ],
      {
        cwd: ROOT_DIR,
        encoding: "utf8"
      }
    );

    assert.ok(search.status === 0 || search.status === 1);
    const output = search.stdout.trim();

    assert.equal(output, "");
  });
});

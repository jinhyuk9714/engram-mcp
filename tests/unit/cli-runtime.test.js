import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_BOOTSTRAP_DEFAULTS,
  buildDockerBootstrapPlan,
  parseCliArgs,
  resolveDatabaseEnv,
  resolveStateDir
} from "../../lib/cli/runtime.js";

describe("CLI runtime", () => {
  test("defaults to stdio mode and supports serve subcommand", () => {
    assert.deepEqual(parseCliArgs([]), { mode: "stdio" });
    assert.deepEqual(parseCliArgs(["serve"]), { mode: "http" });
  });

  test("resolves state directories for macOS and Linux", () => {
    assert.equal(
      resolveStateDir({
        platform: "darwin",
        env: { ENGRAM_STATE_DIR: "/tmp/custom-engram-state" },
        homedir: "/Users/tester"
      }),
      "/tmp/custom-engram-state"
    );

    assert.equal(
      resolveStateDir({
        platform: "darwin",
        env: {},
        homedir: "/Users/tester"
      }),
      "/Users/tester/Library/Application Support/engram-mcp"
    );

    assert.equal(
      resolveStateDir({
        platform: "linux",
        env: {},
        homedir: "/home/tester"
      }),
      "/home/tester/.local/share/engram-mcp"
    );

    assert.equal(
      resolveStateDir({
        platform: "linux",
        env: { XDG_DATA_HOME: "/tmp/xdg" },
        homedir: "/home/tester"
      }),
      "/tmp/xdg/engram-mcp"
    );
  });

  test("prefers DATABASE_URL over POSTGRES_* and DB_* env values", () => {
    const resolved = resolveDatabaseEnv({
      env: {
        DATABASE_URL: "postgresql://dbuser:dbpass@db.example.com:5544/engram_prod",
        POSTGRES_HOST: "postgres.local",
        POSTGRES_PORT: "5432",
        POSTGRES_DB: "postgres_db",
        POSTGRES_USER: "postgres_user",
        POSTGRES_PASSWORD: "postgres_pw",
        DB_HOST: "legacy.local",
        DB_PORT: "6432",
        DB_NAME: "legacy_db",
        DB_USER: "legacy_user",
        DB_PASSWORD: "legacy_pw"
      }
    });

    assert.equal(resolved.connectionSource, "DATABASE_URL");
    assert.equal(resolved.databaseUrl, "postgresql://dbuser:dbpass@db.example.com:5544/engram_prod");
    assert.equal(resolved.postgres.POSTGRES_HOST, "db.example.com");
    assert.equal(resolved.postgres.POSTGRES_PORT, "5544");
    assert.equal(resolved.postgres.POSTGRES_DB, "engram_prod");
    assert.equal(resolved.postgres.POSTGRES_USER, "dbuser");
    assert.equal(resolved.postgres.POSTGRES_PASSWORD, "dbpass");
  });

  test("builds a stable Docker bootstrap plan", () => {
    const plan = buildDockerBootstrapPlan({
      hostPort: 57339,
      database: AUTO_BOOTSTRAP_DEFAULTS.database,
      user: AUTO_BOOTSTRAP_DEFAULTS.user,
      password: "secretpw"
    });

    assert.equal(plan.containerName, "engram-mcp-postgres");
    assert.equal(plan.volumeName, "engram-mcp-pgdata");
    assert.match(plan.image, /^pgvector\/pgvector:/);
    assert.equal(plan.portMapping, "57339:5432");
  });
});

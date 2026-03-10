import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import pg from "pg";

import {
  AUTO_BOOTSTRAP_DEFAULTS,
  buildDockerBootstrapPlan,
  resolveBootstrapDefaults,
  resolveDatabaseEnv
} from "./runtime.js";

const execFileAsync = promisify(execFile);
const { Pool } = pg;

const SQL_MIGRATION_FILES = [
  "lib/memory/memory-schema.sql",
  "lib/memory/migration-001-temporal.sql",
  "lib/memory/migration-002-decay.sql",
  "lib/memory/migration-003-api-keys.sql",
  "lib/memory/migration-004-key-isolation.sql",
  "lib/memory/migration-005-gc-columns.sql",
  "lib/memory/migration-006-superseded-by-constraint.sql",
  "lib/memory/migration-007-link-weight.sql",
  "lib/memory/migration-008-morpheme-dict.sql"
];

function buildStatePath(stateDir) {
  return path.join(stateDir, "bootstrap.json");
}

async function readState(stateDir) {
  try {
    const raw = await fs.readFile(buildStatePath(stateDir), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function writeState(stateDir, state) {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(buildStatePath(stateDir), JSON.stringify(state, null, 2));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((err) => {
        if (err) return reject(err);
        resolve(address.port);
      });
    });
  });
}

async function runDocker(args) {
  return execFileAsync("docker", args, { encoding: "utf8" });
}

async function ensureDockerReady() {
  try {
    await runDocker(["info"]);
  } catch (err) {
    throw new Error(
      "Docker daemon is required for automatic bootstrap. Install Docker or set DATABASE_URL / POSTGRES_* explicitly."
    );
  }
}

async function inspectContainer(name) {
  try {
    const { stdout } = await runDocker([
      "inspect",
      name,
      "--format",
      "{{json .State}}"
    ]);
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

async function ensureVolume(name) {
  try {
    await runDocker(["volume", "inspect", name]);
  } catch {
    await runDocker(["volume", "create", name]);
  }
}

async function ensureContainer(state, env) {
  const defaults = resolveBootstrapDefaults(env);
  const current = await inspectContainer(defaults.containerName);
  if (!current) {
    await ensureVolume(defaults.volumeName);
    const plan = buildDockerBootstrapPlan(state, env);
    await runDocker([
      "run",
      "-d",
      "--name",
      defaults.containerName,
      "--restart",
      "unless-stopped",
      "-e",
      `POSTGRES_DB=${plan.database}`,
      "-e",
      `POSTGRES_USER=${plan.user}`,
      "-e",
      `POSTGRES_PASSWORD=${plan.password}`,
      "-p",
      plan.portMapping,
      "-v",
      `${defaults.volumeName}:/var/lib/postgresql/data`,
      plan.image
    ]);
    return;
  }

  if (!current.Running) {
    await runDocker(["start", defaults.containerName]);
  }
}

async function waitForPostgres(state, env) {
  const deadline = Date.now() + 60_000;
  const databaseUrl = buildDockerBootstrapPlan(state, env).databaseUrl;

  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await pool.query("SELECT 1");
      await pool.end();
      return databaseUrl;
    } catch {
      await pool.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  throw new Error("Timed out waiting for bootstrap PostgreSQL to become ready.");
}

async function applySqlFile(pool, rootDir, relativePath) {
  const sql = await fs.readFile(path.join(rootDir, relativePath), "utf8");
  await pool.query(sql);
}

async function ensureSchema({ rootDir, databaseUrl, state, embeddingEnabled, embeddingDimensions }) {
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector SCHEMA public");
    await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public");

    if (state.schemaRevision !== AUTO_BOOTSTRAP_DEFAULTS.schemaRevision) {
      for (const file of SQL_MIGRATION_FILES) {
        await applySqlFile(pool, rootDir, file);
      }
      state.schemaRevision = AUTO_BOOTSTRAP_DEFAULTS.schemaRevision;
    }
  } finally {
    await pool.end();
  }

  if (embeddingEnabled && embeddingDimensions !== 1536 && state.embeddingDimensionsApplied !== embeddingDimensions) {
    const previousUrl = process.env.DATABASE_URL;
    const previousDims = process.env.EMBEDDING_DIMENSIONS;

    process.env.DATABASE_URL = databaseUrl;
    process.env.EMBEDDING_DIMENSIONS = String(embeddingDimensions);

    try {
      const modulePath = path.join(rootDir, "lib/memory/migration-007-flexible-embedding-dims.js");
      const fileUrl = new URL(`file://${modulePath}`);
      await import(`${fileUrl.href}?ts=${Date.now()}`);
      state.embeddingDimensionsApplied = embeddingDimensions;
    } finally {
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;

      if (previousDims === undefined) delete process.env.EMBEDDING_DIMENSIONS;
      else process.env.EMBEDDING_DIMENSIONS = previousDims;
    }
  }
}

function buildInjectedEnv({ env, stateDir, postgres, databaseUrl }) {
  const logDir = env.LOG_DIR || path.join(stateDir, "logs");

  return {
    LOG_DIR: logDir,
    REDIS_ENABLED: env.REDIS_ENABLED || "false",
    DATABASE_URL: databaseUrl,
    POSTGRES_HOST: postgres.POSTGRES_HOST,
    POSTGRES_PORT: postgres.POSTGRES_PORT,
    POSTGRES_DB: postgres.POSTGRES_DB,
    POSTGRES_USER: postgres.POSTGRES_USER,
    POSTGRES_PASSWORD: postgres.POSTGRES_PASSWORD
  };
}

export async function ensureRuntimeEnvironment({
  env = process.env,
  platform = process.platform,
  stateDir,
  rootDir
}) {
  const resolved = resolveDatabaseEnv({ env });
  await fs.mkdir(path.join(stateDir, "logs"), { recursive: true });

  if (resolved.connectionSource !== "auto") {
    return {
      stateDir,
      injectedEnv: buildInjectedEnv({
        env,
        stateDir,
        postgres: resolved.postgres,
        databaseUrl: resolved.databaseUrl || env.DATABASE_URL || ""
      })
    };
  }

  if (platform !== "darwin" && platform !== "linux") {
    throw new Error("Automatic bootstrap is supported on macOS/Linux only. Set DATABASE_URL manually on this platform.");
  }

  await ensureDockerReady();
  const defaults = resolveBootstrapDefaults(env);

  const state = (await readState(stateDir)) || {
    hostPort: await findFreePort(),
    database: defaults.database,
    user: defaults.user,
    password: crypto.randomBytes(24).toString("base64url"),
    schemaRevision: null,
    embeddingDimensionsApplied: 1536
  };

  await ensureContainer(state, env);
  const databaseUrl = await waitForPostgres(state, env);

  const embeddingEnabled = Boolean(env.OPENAI_API_KEY || env.EMBEDDING_API_KEY || env.EMBEDDING_BASE_URL);
  const embeddingDimensions = Number(env.EMBEDDING_DIMENSIONS || 1536);

  await ensureSchema({
    rootDir,
    databaseUrl,
    state,
    embeddingEnabled,
    embeddingDimensions
  });

  await writeState(stateDir, state);

  return {
    stateDir,
    injectedEnv: buildInjectedEnv({
      env,
      stateDir,
      postgres: {
        POSTGRES_HOST: "127.0.0.1",
        POSTGRES_PORT: String(state.hostPort),
        POSTGRES_DB: state.database,
        POSTGRES_USER: state.user,
        POSTGRES_PASSWORD: state.password
      },
      databaseUrl
    })
  };
}

export async function hasBootstrapState(stateDir) {
  return fileExists(buildStatePath(stateDir));
}

import os from "node:os";
import path from "node:path";

export const AUTO_BOOTSTRAP_DEFAULTS = {
  image         : "pgvector/pgvector:pg16",
  containerName : "engram-mcp-postgres",
  volumeName    : "engram-mcp-pgdata",
  database      : "engram_mcp",
  user          : "engram",
  schemaRevision: "public-vector-v1"
};

export function parseCliArgs(argv = []) {
  const first = argv[0];
  if (first === "serve") {
    return { mode: "http" };
  }
  return { mode: "stdio" };
}

export function resolveStateDir({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir()
} = {}) {
  if (env.ENGRAM_STATE_DIR) {
    return path.resolve(env.ENGRAM_STATE_DIR);
  }

  if (platform === "darwin") {
    return path.join(homedir, "Library", "Application Support", "engram-mcp");
  }

  const xdgDataHome = env.XDG_DATA_HOME;
  if (platform === "linux") {
    return xdgDataHome
      ? path.join(xdgDataHome, "engram-mcp")
      : path.join(homedir, ".local", "share", "engram-mcp");
  }

  return path.join(homedir, ".engram-mcp");
}

export function resolveBootstrapDefaults(env = process.env) {
  return {
    image: env.ENGRAM_BOOTSTRAP_IMAGE || AUTO_BOOTSTRAP_DEFAULTS.image,
    containerName: env.ENGRAM_BOOTSTRAP_CONTAINER_NAME || AUTO_BOOTSTRAP_DEFAULTS.containerName,
    volumeName: env.ENGRAM_BOOTSTRAP_VOLUME_NAME || AUTO_BOOTSTRAP_DEFAULTS.volumeName,
    database: env.ENGRAM_BOOTSTRAP_DATABASE || AUTO_BOOTSTRAP_DEFAULTS.database,
    user: env.ENGRAM_BOOTSTRAP_USER || AUTO_BOOTSTRAP_DEFAULTS.user,
    schemaRevision: AUTO_BOOTSTRAP_DEFAULTS.schemaRevision
  };
}

function decodeUrlComponent(value) {
  if (!value) return "";
  return decodeURIComponent(value);
}

export function resolveDatabaseEnv({ env = process.env } = {}) {
  if (env.DATABASE_URL) {
    const url = new URL(env.DATABASE_URL);
    return {
      connectionSource: "DATABASE_URL",
      databaseUrl: env.DATABASE_URL,
      postgres: {
        POSTGRES_HOST    : url.hostname,
        POSTGRES_PORT    : url.port || "5432",
        POSTGRES_DB      : decodeUrlComponent(url.pathname.replace(/^\//, "")),
        POSTGRES_USER    : decodeUrlComponent(url.username),
        POSTGRES_PASSWORD: decodeUrlComponent(url.password)
      }
    };
  }

  const postgresEnv = {
    POSTGRES_HOST    : env.POSTGRES_HOST || "",
    POSTGRES_PORT    : env.POSTGRES_PORT || "",
    POSTGRES_DB      : env.POSTGRES_DB || "",
    POSTGRES_USER    : env.POSTGRES_USER || "",
    POSTGRES_PASSWORD: env.POSTGRES_PASSWORD || ""
  };

  if (postgresEnv.POSTGRES_HOST && postgresEnv.POSTGRES_DB && postgresEnv.POSTGRES_USER) {
    return {
      connectionSource: "POSTGRES_*",
      databaseUrl: "",
      postgres: postgresEnv
    };
  }

  const legacyEnv = {
    POSTGRES_HOST    : env.DB_HOST || "",
    POSTGRES_PORT    : env.DB_PORT || "",
    POSTGRES_DB      : env.DB_NAME || "",
    POSTGRES_USER    : env.DB_USER || "",
    POSTGRES_PASSWORD: env.DB_PASSWORD || ""
  };

  if (legacyEnv.POSTGRES_HOST && legacyEnv.POSTGRES_DB && legacyEnv.POSTGRES_USER) {
    return {
      connectionSource: "DB_*",
      databaseUrl: "",
      postgres: legacyEnv
    };
  }

  return {
    connectionSource: "auto",
    databaseUrl: "",
    postgres: {
      POSTGRES_HOST: "",
      POSTGRES_PORT: "",
      POSTGRES_DB: "",
      POSTGRES_USER: "",
      POSTGRES_PASSWORD: ""
    }
  };
}

export function buildDockerBootstrapPlan({
  hostPort,
  database,
  user,
  password
}, env = process.env) {
  const defaults = resolveBootstrapDefaults(env);

  return {
    image: defaults.image,
    containerName: defaults.containerName,
    volumeName: defaults.volumeName,
    portMapping: `${hostPort}:5432`,
    database: database || defaults.database,
    user: user || defaults.user,
    password,
    databaseUrl: `postgresql://${user || defaults.user}:${encodeURIComponent(password)}@127.0.0.1:${hostPort}/${database || defaults.database}`
  };
}

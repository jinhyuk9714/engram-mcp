import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureRuntimeEnvironment } from "./bootstrap.js";
import { parseCliArgs, resolveStateDir } from "./runtime.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");

function injectEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") {
      process.env[key] = String(value);
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { mode } = parseCliArgs(argv);
  const stateDir = resolveStateDir();
  const { injectedEnv } = await ensureRuntimeEnvironment({
    env: process.env,
    platform: process.platform,
    stateDir,
    rootDir: ROOT_DIR
  });

  injectEnv(injectedEnv);

  if (mode === "http") {
    await import("../../server.js");
    return;
  }

  const { runStdioServer } = await import("../mcp/stdio-server.js");
  const { shutdownPool } = await import("../tools/db.js");
  const { transport } = await runStdioServer();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await transport.close().catch(() => {});
    await shutdownPool().catch(() => {});
    process.exit(0);
  };

  transport.onclose = shutdown;
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

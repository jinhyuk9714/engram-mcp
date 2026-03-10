import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");

function hasDocker() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("Docker bootstrap e2e", { skip: !hasDocker() }, () => {
  const uniqueId = `e2e-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const containerName = `engram-mcp-postgres-${uniqueId}`;
  const volumeName = `engram-mcp-pgdata-${uniqueId}`;

  let client;
  let tempRoot;
  let stateDir;

  before(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "engram-mcp-docker-"));
    stateDir = path.join(tempRoot, "state");

    client = new Client({
      name: "engram-mcp-docker-bootstrap-test-client",
      version: "1.0.0"
    });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT_DIR, "bin", "engram-mcp.js")],
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        ENGRAM_STATE_DIR: stateDir,
        ENGRAM_BOOTSTRAP_CONTAINER_NAME: containerName,
        ENGRAM_BOOTSTRAP_VOLUME_NAME: volumeName,
        REDIS_ENABLED: "false",
        OPENAI_API_KEY: "",
        EMBEDDING_API_KEY: "",
        GEMINI_API_KEY: "",
        LOG_DIR: path.join(tempRoot, "logs")
      },
      stderr: "pipe"
    });

    await client.connect(transport);
  });

  after(async () => {
    if (client) {
      await client.close();
    }

    try {
      execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
    } catch {
      // Ignore missing test container.
    }

    try {
      execFileSync("docker", ["volume", "rm", volumeName], { stdio: "ignore" });
    } catch {
      // Ignore missing test volume.
    }

    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("bootstraps PostgreSQL automatically and serves tools over stdio", async () => {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "context"));

    const bootstrapStatePath = path.join(stateDir, "bootstrap.json");
    assert.equal(fs.existsSync(bootstrapStatePath), true);

    const bootstrapState = JSON.parse(fs.readFileSync(bootstrapStatePath, "utf8"));
    assert.equal(typeof bootstrapState.hostPort, "number");
    assert.equal(bootstrapState.database, "engram_mcp");
    assert.equal(bootstrapState.user, "engram");

    const response = await client.callTool({
      name: "context",
      arguments: {}
    });

    assert.equal(Array.isArray(response.content), true);
    assert.equal(response.content[0]?.type, "text");
  }, 120_000);
});

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../..");

const DATABASE_URL = process.env.DATABASE_URL;

describe("stdio MCP server with explicit DATABASE_URL", { skip: !DATABASE_URL }, () => {
  let client;
  let tempRoot;

  before(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "engram-mcp-stdio-"));

    client = new Client({
      name: "engram-mcp-stdio-test-client",
      version: "1.0.0"
    });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT_DIR, "bin", "engram-mcp.js")],
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        DATABASE_URL,
        LOG_DIR: path.join(tempRoot, "logs"),
        REDIS_ENABLED: "false"
      },
      stderr: "pipe"
    });

    await client.connect(transport);
  });

  after(async () => {
    if (client) {
      await client.close();
    }
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("initializes and serves tools over stdio", async () => {
    const tools = await client.listTools();
    assert.ok(Array.isArray(tools.tools));
    assert.ok(tools.tools.some((tool) => tool.name === "context"));

    const response = await client.callTool({
      name: "context",
      arguments: {}
    });

    assert.equal(Array.isArray(response.content), true);
    assert.equal(response.content[0]?.type, "text");
  });
});

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  MCP_SERVER_CAPABILITIES,
  MCP_SERVER_INFO,
  buildServerInstructions
} from "./server-definition.js";
import { registerMcpSdkHandlers } from "./surface.js";

export function createStdioServer() {
  const server = new Server(MCP_SERVER_INFO, {
    capabilities: MCP_SERVER_CAPABILITIES,
    instructions: buildServerInstructions()
  });

  registerMcpSdkHandlers(server);

  return server;
}

export async function runStdioServer() {
  const server = createStdioServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  return { server, transport };
}

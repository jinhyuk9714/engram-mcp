import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

import { SUPPORTED_PROTOCOL_VERSIONS, DEFAULT_PROTOCOL_VERSION } from "../config.js";
import { getToolsDefinition } from "../tools/index.js";
import { TOOL_REGISTRY } from "../tool-registry.js";
import { PROMPTS, getPrompt as getPromptContent } from "../tools/prompts.js";
import { RESOURCES, readResource as readResourceContent } from "../tools/resources.js";
import {
  recordRpcMethod,
  recordToolExecution,
  recordProtocolNegotiation
} from "../metrics.js";
import {
  MCP_SERVER_CAPABILITIES,
  MCP_SERVER_INFO,
  buildServerDescription,
  buildServerInstructions
} from "./server-definition.js";

export function negotiateProtocolVersion(clientVersion) {
  if (!clientVersion) {
    console.log(`[Protocol] Client did not specify version, using default: ${DEFAULT_PROTOCOL_VERSION}`);
    return DEFAULT_PROTOCOL_VERSION;
  }

  if (SUPPORTED_PROTOCOL_VERSIONS.includes(clientVersion)) {
    console.log(`[Protocol] Client requested ${clientVersion}, supported - using requested version`);
    return clientVersion;
  }

  const latestVersion = SUPPORTED_PROTOCOL_VERSIONS[0];

  try {
    const clientDate = new Date(clientVersion);
    const latestDate = new Date(latestVersion);

    if (!isNaN(clientDate.getTime()) && !isNaN(latestDate.getTime()) && clientDate <= latestDate) {
      console.log(
        `[Protocol] Client requested ${clientVersion}, which is <= server latest (${latestVersion}) - accepting for forward compatibility`
      );
      return clientVersion;
    }
  } catch {
    // Fall back to nearest supported version.
  }

  const clientDate = new Date(clientVersion);
  let fallbackVersion = null;

  for (const supportedVersion of SUPPORTED_PROTOCOL_VERSIONS) {
    const supportedDate = new Date(supportedVersion);
    if (supportedDate <= clientDate) {
      fallbackVersion = supportedVersion;
      break;
    }
  }

  if (!fallbackVersion) {
    fallbackVersion = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];
    console.log(`[Protocol] Client requested ${clientVersion}, older than all supported - using oldest: ${fallbackVersion}`);
  } else {
    console.log(`[Protocol] Client requested ${clientVersion}, not explicitly in supported list - falling back to ${fallbackVersion}`);
  }

  return fallbackVersion;
}

export async function handleInitialize(params) {
  const startTime = process.hrtime.bigint();

  try {
    const clientVersion = params?.protocolVersion;
    const negotiatedVersion = negotiateProtocolVersion(clientVersion);

    recordProtocolNegotiation(clientVersion, negotiatedVersion);

    const result = {
      protocolVersion: negotiatedVersion,
      serverInfo: {
        ...MCP_SERVER_INFO,
        description: buildServerDescription(negotiatedVersion)
      },
      capabilities: MCP_SERVER_CAPABILITIES,
      instructions: buildServerInstructions(negotiatedVersion)
    };

    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("initialize", true, duration);

    return result;
  } catch (err) {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("initialize", false, duration);
    throw err;
  }
}

export function handleToolsList() {
  const startTime = process.hrtime.bigint();

  try {
    const result = {
      tools: getToolsDefinition()
    };

    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("tools/list", true, duration);

    return result;
  } catch (err) {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("tools/list", false, duration);
    throw err;
  }
}

export async function handleToolsCall(params) {
  const startTime = process.hrtime.bigint();

  if (!params || typeof params.name !== "string") {
    throw new Error("Tool name is required");
  }

  const name = params.name;
  const args = params.arguments || {};
  const entry = TOOL_REGISTRY.get(name);

  if (!entry) {
    const error = new Error(`Unknown tool: ${name}`);
    error.code = -32601;
    throw error;
  }

  const toolResult = await entry.handler(args);

  if (entry.post) {
    entry.post(args, toolResult);
  }

  if (entry.log) {
    const message = entry.log(args, toolResult);
    if (message) {
      console.log(`[Tool] ${message}`);
    }
  }

  const toolDuration = Number(process.hrtime.bigint() - startTime) / 1e9;
  recordToolExecution(name, true, toolDuration);

  if (entry.formatResponse) {
    const rpcDuration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("tools/call", true, rpcDuration);
    return entry.formatResponse(args, toolResult);
  }

  const rpcDuration = Number(process.hrtime.bigint() - startTime) / 1e9;
  recordRpcMethod("tools/call", true, rpcDuration);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(toolResult, null, 2)
      }
    ],
    isError: Boolean(toolResult?.isError)
  };
}

export function handlePromptsList() {
  const startTime = process.hrtime.bigint();

  try {
    const result = {
      prompts: PROMPTS
    };

    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("prompts/list", true, duration);

    return result;
  } catch (err) {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("prompts/list", false, duration);
    throw err;
  }
}

export async function handlePromptsGet(params) {
  const startTime = process.hrtime.bigint();

  if (!params || typeof params.name !== "string") {
    throw new Error("Prompt name is required");
  }

  try {
    const result = await getPromptContent(params.name, params.arguments || {});

    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("prompts/get", true, duration);

    return result;
  } catch (err) {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("prompts/get", false, duration);
    throw err;
  }
}

export function handleResourcesList() {
  const startTime = process.hrtime.bigint();

  try {
    const result = {
      resources: RESOURCES
    };

    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("resources/list", true, duration);

    return result;
  } catch (err) {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("resources/list", false, duration);
    throw err;
  }
}

export async function handleResourcesRead(params) {
  const startTime = process.hrtime.bigint();

  if (!params || typeof params.uri !== "string") {
    throw new Error("Resource URI is required");
  }

  try {
    const result = await readResourceContent(params.uri, params);

    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("resources/read", true, duration);

    return result;
  } catch (err) {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("resources/read", false, duration);
    throw err;
  }
}

export const MCP_METHOD_HANDLERS = new Map([
  ["initialize", handleInitialize],
  ["tools/list", handleToolsList],
  ["tools/call", handleToolsCall],
  ["prompts/list", handlePromptsList],
  ["prompts/get", handlePromptsGet],
  ["resources/list", handleResourcesList],
  ["resources/read", handleResourcesRead]
]);

export async function invokeMcpMethod(method, params) {
  const handler = MCP_METHOD_HANDLERS.get(method);

  if (!handler) {
    const error = new Error(`Method not found: ${method}`);
    error.code = -32601;
    throw error;
  }

  return handler(params);
}

export function registerMcpSdkHandlers(server) {
  server.setRequestHandler(ListToolsRequestSchema, async (request) => handleToolsList(request.params));
  server.setRequestHandler(CallToolRequestSchema, async (request) => handleToolsCall(request.params));
  server.setRequestHandler(ListPromptsRequestSchema, async (request) => handlePromptsList(request.params));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => handlePromptsGet(request.params));
  server.setRequestHandler(ListResourcesRequestSchema, async (request) => handleResourcesList(request.params));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => handleResourcesRead(request.params));
}

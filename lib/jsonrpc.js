/**
 * JSON-RPC 핸들러
 *
 * 작성자: 최진호
 * 작성일: 2026-01-30
 */

import { invokeMcpMethod } from "./mcp/surface.js";
import { recordError } from "./metrics.js";

export {
  handleInitialize,
  handlePromptsGet,
  handlePromptsList,
  handleResourcesList,
  handleResourcesRead,
  handleToolsCall,
  handleToolsList
} from "./mcp/surface.js";

/**
 * JSON-RPC 에러 응답 생성
 */
export function jsonRpcError(id, code, message, data) {
  const err                = { code, message };

  if (data !== undefined) {
    err.data             = data;
  }

  return {
    jsonrpc: "2.0",
    id,
    error : err
  };
}

/**
 * JSON-RPC 성공 응답 생성
 */
export function jsonRpcResult(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

/**
 * JSON-RPC 요청 디스패처
 */
export async function dispatchJsonRpc(msg) {
  if (!msg || typeof msg !== "object") {
    return { kind: "error", response: jsonRpcError(null, -32600, "Invalid Request") };
  }

  const jsonrpc             = msg.jsonrpc || "2.0";
  const id                  = Object.prototype.hasOwnProperty.call(msg, "id") ? msg.id : undefined;
  const method              = msg.method;
  const params              = msg.params;

  if (jsonrpc !== "2.0") {
    return { kind: "error", response: jsonRpcError(id ?? null, -32600, "Invalid Request", "jsonrpc must be '2.0'") };
  }

  if (typeof method !== "string") {
    return { kind: "error", response: jsonRpcError(id ?? null, -32600, "Invalid Request", "method must be string") };
  }

  const isNotification       = id === undefined;

  try {
    if (method === "notifications/initialized") {
      return { kind: "accepted" };
    }

    if (isNotification) {
      await invokeMcpMethod(method, params);
      return { kind: "accepted" };
    }

    const result = await invokeMcpMethod(method, params);
    return { kind: "ok", response: jsonRpcResult(id, result) };
  } catch (err) {
    if (isNotification) {
      return { kind: "accepted" };
    }

    console.error(`[ERROR] ${method}:`, err);
    const errorCode        = err.code || -32603;
    const errorMessage     = errorCode === -32601 ? err.message : "Internal error";

    // 에러 메트릭 기록
    recordError(method, errorCode);

    return { kind: "ok", response: jsonRpcError(id, errorCode, errorMessage) };
  }
}

import os from "node:os";
import path from "node:path";

export const ADMIN_BASE = "/v1/internal/model/nothing";

const ADMIN_KEY_ROUTE_RE = /^\/v1\/internal\/model\/nothing\/keys\/([^/]+)$/;
const IMAGE_MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml"
};

export function isAdminUiRequest(method, pathname) {
  return method === "GET" && (pathname === ADMIN_BASE || pathname === `${ADMIN_BASE}/`);
}

export function isAdminImageRequest(method, pathname) {
  return method === "GET" && pathname.startsWith(`${ADMIN_BASE}/images/`);
}

export function getAdminImageMeta(pathname, rootDir) {
  const filename = path.basename(pathname);

  return {
    filename,
    filePath: path.join(rootDir, "assets", "images", filename),
    mimeType: IMAGE_MIME_TYPES[path.extname(filename).toLowerCase()] || "application/octet-stream"
  };
}

function sendJsonResponse(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.end(JSON.stringify(payload));
}

function isPayloadTooLargeError(err) {
  return err?.statusCode === 413;
}

export async function handleAdminApiRequest({
  req,
  res,
  pathname,
  origin,
  deps = {}
}) {
  if (!pathname.startsWith(`${ADMIN_BASE}/`)) {
    return false;
  }

  const {
    validateMasterKey = () => false,
    readJsonBody = async () => null,
    getPrimaryPool = () => null,
    listApiKeys = async () => [],
    createApiKey = async () => null,
    updateApiKeyStatus = async () => null,
    deleteApiKey = async () => {},
    getSessionCounts = () => ({ total: 0 }),
    redisClient = null,
    osImpl = os,
    statfsSync = () => {
      throw new Error("statfsSync not implemented");
    }
  } = deps;

  res.setHeader("Access-Control-Allow-Origin", origin || req.headers?.origin || "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const isAuthEndpoint = req.method === "POST" && pathname === `${ADMIN_BASE}/auth`;
  if (!isAuthEndpoint && !validateMasterKey(req)) {
    sendJsonResponse(res, 401, { error: "Unauthorized" });
    return true;
  }

  if (isAuthEndpoint) {
    const authorized = validateMasterKey(req);
    sendJsonResponse(res, authorized ? 200 : 401, authorized ? { ok: true } : { error: "Invalid admin key" });
    return true;
  }

  if (req.method === "GET" && pathname === `${ADMIN_BASE}/stats`) {
    try {
      const pool = getPrimaryPool();
      const [fragR, callR, keyR] = await Promise.all([
        pool.query("SELECT COUNT(*) AS total FROM agent_memory.fragments"),
        pool.query(`SELECT COALESCE(SUM(call_count),0) AS total
                      FROM agent_memory.api_key_usage
                     WHERE usage_date = CURRENT_DATE`),
        pool.query("SELECT COUNT(*) AS total FROM agent_memory.api_keys WHERE status='active'")
      ]);

      const cpus = osImpl.cpus();
      const cpuPct = Math.min(100, Math.round((osImpl.loadavg()[0] / cpus.length) * 100));
      const memPct = Math.round(((osImpl.totalmem() - osImpl.freemem()) / osImpl.totalmem()) * 100);

      let diskPct = 0;
      try {
        const disk = statfsSync("/");
        diskPct = Math.round(((disk.blocks - disk.bfree) / disk.blocks) * 100);
      } catch {}

      let dbSizeBytes = 0;
      try {
        const { rows: [sizeRow] } = await pool.query(
          "SELECT pg_database_size(current_database()) AS bytes"
        );
        dbSizeBytes = parseInt(sizeRow.bytes, 10);
      } catch {}

      sendJsonResponse(res, 200, {
        fragments: parseInt(fragR.rows[0].total, 10),
        sessions: getSessionCounts().total,
        apiCallsToday: parseInt(callR.rows[0].total, 10),
        activeKeys: parseInt(keyR.rows[0].total, 10),
        uptime: Math.floor(process.uptime()),
        nodeVersion: process.version,
        system: {
          cpu: cpuPct,
          memory: memPct,
          disk: diskPct,
          dbSizeBytes
        },
        db: "connected",
        redis: redisClient && redisClient.status === "ready" ? "connected" : "disconnected"
      });
    } catch (err) {
      console.error("[Admin] /stats error:", err.message);
      sendJsonResponse(res, 500, { error: err.message });
    }
    return true;
  }

  if (req.method === "GET" && pathname === `${ADMIN_BASE}/activity`) {
    try {
      const pool = getPrimaryPool();
      const { rows } = await pool.query(`
        SELECT f.id, f.topic, f.type, f.agent_id, f.key_id, f.created_at,
               LEFT(f.content, 80) AS preview,
               k.name              AS key_name,
               k.key_prefix
        FROM  agent_memory.fragments f
        LEFT JOIN agent_memory.api_keys k ON k.id = f.key_id
        ORDER BY f.created_at DESC
        LIMIT 10
      `);
      sendJsonResponse(res, 200, rows);
    } catch (err) {
      console.error("[Admin] /activity error:", err.message);
      sendJsonResponse(res, 500, { error: err.message });
    }
    return true;
  }

  if (req.method === "GET" && pathname === `${ADMIN_BASE}/keys`) {
    try {
      sendJsonResponse(res, 200, await listApiKeys());
    } catch (err) {
      console.error("[Admin] listApiKeys error:", err.message);
      sendJsonResponse(res, 500, { error: err.message });
    }
    return true;
  }

  if (req.method === "POST" && pathname === `${ADMIN_BASE}/keys`) {
    try {
      const body = await readJsonBody(req);
      if (!body?.name || typeof body.name !== "string") {
        sendJsonResponse(res, 400, { error: "name is required" });
        return true;
      }

      const key = await createApiKey({
        name: body.name.trim(),
        permissions: Array.isArray(body.permissions) ? body.permissions : ["read"],
        daily_limit: Number(body.daily_limit) || 10000
      });

      sendJsonResponse(res, 201, key);
    } catch (err) {
      if (isPayloadTooLargeError(err)) {
        sendJsonResponse(res, 413, { error: "Payload too large" });
        return true;
      }
      console.error("[Admin] createApiKey error:", err.message);
      sendJsonResponse(res, err.message.includes("unique") ? 409 : 500, { error: err.message });
    }
    return true;
  }

  const keyRouteMatch = pathname.match(ADMIN_KEY_ROUTE_RE);

  if (req.method === "PUT" && keyRouteMatch) {
    try {
      const body = await readJsonBody(req);
      const result = await updateApiKeyStatus(keyRouteMatch[1], body.status);
      sendJsonResponse(res, 200, result);
    } catch (err) {
      if (isPayloadTooLargeError(err)) {
        sendJsonResponse(res, 413, { error: "Payload too large" });
        return true;
      }
      console.error("[Admin] updateApiKeyStatus error:", err.message);
      sendJsonResponse(res, err.message === "Key not found" ? 404 : 400, { error: err.message });
    }
    return true;
  }

  if (req.method === "DELETE" && keyRouteMatch) {
    try {
      await deleteApiKey(keyRouteMatch[1]);
      res.statusCode = 204;
      res.end();
    } catch (err) {
      console.error("[Admin] deleteApiKey error:", err.message);
      sendJsonResponse(res, err.message === "Key not found" ? 404 : 500, { error: err.message });
    }
    return true;
  }

  sendJsonResponse(res, 404, { error: "Not found" });
  return true;
}

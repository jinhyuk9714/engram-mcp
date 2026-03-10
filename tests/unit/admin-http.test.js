import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ADMIN_BASE,
  getAdminImageMeta,
  handleAdminApiRequest,
  isAdminImageRequest,
  isAdminUiRequest
} from "../../lib/http/admin.js";

function createRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(payload = "") {
      this.body = payload;
    }
  };
}

describe("admin route helpers", () => {
  it("matches admin UI base paths", () => {
    assert.equal(isAdminUiRequest("GET", ADMIN_BASE), true);
    assert.equal(isAdminUiRequest("GET", `${ADMIN_BASE}/`), true);
    assert.equal(isAdminUiRequest("POST", ADMIN_BASE), false);
  });

  it("matches admin image requests and sanitizes filenames", () => {
    assert.equal(isAdminImageRequest("GET", `${ADMIN_BASE}/images/logo.png`), true);
    assert.equal(isAdminImageRequest("POST", `${ADMIN_BASE}/images/logo.png`), false);

    const meta = getAdminImageMeta(`${ADMIN_BASE}/images/../../secret.svg`, "/tmp/app");
    assert.equal(meta.filename, "secret.svg");
    assert.equal(meta.mimeType, "image/svg+xml");
    assert.match(meta.filePath, /secret\.svg$/);
  });
});

describe("handleAdminApiRequest", () => {
  it("returns success for the auth endpoint with a valid master key", async () => {
    const req = { method: "POST", headers: {} };
    const res = createRes();

    const handled = await handleAdminApiRequest({
      req,
      res,
      pathname: `${ADMIN_BASE}/auth`,
      origin: "https://example.com",
      deps: {
        validateMasterKey: () => true
      }
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
  });

  it("rejects non-auth admin requests without a valid master key", async () => {
    const req = { method: "GET", headers: {} };
    const res = createRes();

    const handled = await handleAdminApiRequest({
      req,
      res,
      pathname: `${ADMIN_BASE}/stats`,
      deps: {
        validateMasterKey: () => false
      }
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(JSON.parse(res.body), { error: "Unauthorized" });
  });

  it("validates create-key input before calling storage", async () => {
    const req = { method: "POST", headers: {} };
    const res = createRes();
    let createCalled = false;

    await handleAdminApiRequest({
      req,
      res,
      pathname: `${ADMIN_BASE}/keys`,
      deps: {
        validateMasterKey: () => true,
        readJsonBody: async () => ({}),
        createApiKey: async () => {
          createCalled = true;
          return {};
        }
      }
    });

    assert.equal(createCalled, false);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(JSON.parse(res.body), { error: "name is required" });
  });

  it("maps oversized PUT payloads to 413", async () => {
    const req = { method: "PUT", headers: {} };
    const res = createRes();

    await handleAdminApiRequest({
      req,
      res,
      pathname: `${ADMIN_BASE}/keys/key-123`,
      deps: {
        validateMasterKey: () => true,
        readJsonBody: async () => {
          const error = new Error("Payload too large");
          error.statusCode = 413;
          throw error;
        }
      }
    });

    assert.equal(res.statusCode, 413);
    assert.deepEqual(JSON.parse(res.body), { error: "Payload too large" });
  });
});

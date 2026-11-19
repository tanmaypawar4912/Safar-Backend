import test from "node:test";
import assert from "node:assert/strict";
import { shouldRejectRequestOrigin } from "../middleware/requestOriginGuard.js";

const allowed = new Set([
  "https://logigo.example",
  "http://localhost:5173",
]);

test("allows a state-changing request from the configured frontend", () => {
  assert.equal(
    shouldRejectRequestOrigin({ method: "POST", origin: "https://logigo.example" }, allowed),
    false
  );
});

test("rejects a state-changing request from an untrusted browser origin", () => {
  assert.equal(
    shouldRejectRequestOrigin({ method: "PATCH", origin: "https://evil.example" }, allowed),
    true
  );
});

test("rejects cross-site Fetch Metadata when Origin is missing", () => {
  assert.equal(
    shouldRejectRequestOrigin({ method: "DELETE", secFetchSite: "cross-site" }, allowed),
    true
  );
});

test("allows same-origin browser requests when Origin is omitted", () => {
  assert.equal(
    shouldRejectRequestOrigin({ method: "POST", secFetchSite: "same-origin" }, allowed),
    false
  );
});

test("allows non-browser requests without Origin or Fetch Metadata", () => {
  assert.equal(
    shouldRejectRequestOrigin({ method: "POST" }, allowed),
    false
  );
});

test("does not restrict safe GET and HEAD requests", () => {
  assert.equal(
    shouldRejectRequestOrigin({ method: "GET", origin: "https://evil.example" }, allowed),
    false
  );
  assert.equal(
    shouldRejectRequestOrigin({ method: "HEAD", origin: "https://evil.example" }, allowed),
    false
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTrustProxy,
  validateRuntimeSecurity,
} from "../utils/runtimeSecurity.js";

test("production requires distinct strong JWT secrets", () => {
  const errors = validateRuntimeSecurity({
    nodeEnv: "production",
    accessSecret: "short-secret",
    refreshSecret: "short-secret",
    clientUrl: "https://app.example.com",
  });
  assert.equal(errors.some((item) => item.includes("JWT_ACCESS_SECRET")), true);
  assert.equal(errors.some((item) => item.includes("JWT_REFRESH_SECRET")), true);
  assert.equal(errors.some((item) => item.includes("must be different")), true);
});

test("production requires an HTTPS frontend origin", () => {
  const errors = validateRuntimeSecurity({
    nodeEnv: "production",
    accessSecret: "a".repeat(48),
    refreshSecret: "b".repeat(48),
    clientUrl: "http://app.example.com",
  });
  assert.deepEqual(errors, ["CLIENT_URL must use HTTPS in production."]);
});

test("valid production settings pass", () => {
  const errors = validateRuntimeSecurity({
    nodeEnv: "production",
    accessSecret: "a".repeat(48),
    refreshSecret: "b".repeat(48),
    clientUrl: "https://app.example.com",
  });
  assert.deepEqual(errors, []);
});

test("development settings are not broken by production-only secret rules", () => {
  const errors = validateRuntimeSecurity({
    nodeEnv: "development",
    accessSecret: "dev",
    refreshSecret: "dev",
    clientUrl: "http://localhost:5173",
  });
  assert.deepEqual(errors, []);
});

test("unknown NODE_ENV is rejected", () => {
  const errors = validateRuntimeSecurity({ nodeEnv: "prod" });
  assert.equal(errors.length, 1);
});

test("TRUST_PROXY defaults to false and accepts an explicit hop count", () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy(""), false);
  assert.equal(parseTrustProxy("1"), 1);
  assert.equal(parseTrustProxy("2"), 2);
});

test("TRUST_PROXY rejects unsafe boolean and invalid values", () => {
  assert.throws(() => parseTrustProxy("true"), /integer hop count/);
  assert.throws(() => parseTrustProxy("-1"), /integer hop count/);
  assert.throws(() => parseTrustProxy("11"), /between 0 and 10/);
});

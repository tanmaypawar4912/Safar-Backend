import test from "node:test";
import assert from "node:assert/strict";
import { consumeRefreshTokenOnce } from "../utils/refreshTokenService.js";

test("refresh token consumption uses one atomic update with revocation and expiry guards", async () => {
  const now = new Date("2026-11-17T06:00:00.000Z");
  let captured;
  const model = {
    findOneAndUpdate(filter, update, options) {
      captured = { filter, update, options };
      return Promise.resolve({ _id: "token-row" });
    },
  };

  const result = await consumeRefreshTokenOnce(model, {
    userId: "user-123",
    tokenHash: "hashed-token",
    now,
  });

  assert.equal(result._id, "token-row");
  assert.deepEqual(captured.filter, {
    userId: "user-123",
    tokenHash: "hashed-token",
    revokedAt: null,
    expiresAt: { $gt: now },
  });
  assert.deepEqual(captured.update, { $set: { revokedAt: now } });
  assert.equal(captured.options.new, true);
  assert.equal(captured.options.runValidators, true);
});

test("concurrent refresh attempts can consume the same token only once", async () => {
  const now = new Date("2026-11-17T06:00:00.000Z");
  let revokedAt = null;
  const storedExpiry = new Date(now.getTime() + 60_000);
  const model = {
    findOneAndUpdate(filter, update) {
      // Model the atomic compare-and-set behavior provided by MongoDB.
      if (
        revokedAt !== null ||
        filter.revokedAt !== null ||
        storedExpiry <= filter.expiresAt.$gt
      ) {
        return Promise.resolve(null);
      }
      revokedAt = update.$set.revokedAt;
      return Promise.resolve({ _id: "token-row", revokedAt });
    },
  };

  const results = await Promise.all([
    consumeRefreshTokenOnce(model, {
      userId: "user-123",
      tokenHash: "hashed-token",
      now,
    }),
    consumeRefreshTokenOnce(model, {
      userId: "user-123",
      tokenHash: "hashed-token",
      now,
    }),
  ]);

  assert.equal(results.filter(Boolean).length, 1);
});

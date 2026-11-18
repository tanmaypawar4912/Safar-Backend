import test from "node:test";
import assert from "node:assert/strict";
import DriverSettlement from "../models/DriverSettlement.js";

test("one pending payout per driver is enforced by a unique partial compound index", () => {
  const indexes = DriverSettlement.schema.indexes();
  const pendingPayoutIndex = indexes.find(([keys, options]) =>
    keys.driver === 1 &&
    keys.status === 1 &&
    Object.keys(keys).length === 2 &&
    options?.unique === true &&
    options?.partialFilterExpression?.status === "pending_payout" &&
    options?.name === "one_pending_payout_per_driver"
  );

  assert.ok(
    pendingPayoutIndex,
    "Expected a unique { driver: 1, status: 1 } partial index for pending payouts."
  );
});

test("the pending-payout unique index does not duplicate the driver's single-field index", () => {
  const indexes = DriverSettlement.schema.indexes();
  const duplicatePartialDriverIndex = indexes.find(([keys, options]) =>
    Object.keys(keys).length === 1 &&
    keys.driver === 1 &&
    options?.partialFilterExpression?.status === "pending_payout"
  );

  assert.equal(duplicatePartialDriverIndex, undefined);
});

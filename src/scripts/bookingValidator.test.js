import test from "node:test";
import assert from "node:assert/strict";
import { createBookingSchema } from "../validators/bookingValidator.js";

const baseBooking = {
  pickupAddress: "Pune 411048, India",
  dropAddress: "Ambegaon Bk, Pune 411021, India",
  vehicleId: "507f1f77bcf86cd799439011",
  weightKg: 500,
  packageDescription: "Home appliances",
  paymentMethod: "cash_on_delivery",
};

test("booking validation preserves signed pickup and drop location tokens", () => {
  const pickupLocationToken = `${"a".repeat(64)}.${"b".repeat(43)}`;
  const dropLocationToken = `${"c".repeat(64)}.${"d".repeat(43)}`;
  const result = createBookingSchema.safeParse({
    ...baseBooking,
    pickupLocationToken,
    dropLocationToken,
  });

  assert.equal(result.success, true);
  assert.equal(result.data.pickupLocationToken, pickupLocationToken);
  assert.equal(result.data.dropLocationToken, dropLocationToken);
});

test("booking validation remains compatible with address-only legacy requests", () => {
  const result = createBookingSchema.safeParse(baseBooking);
  assert.equal(result.success, true);
  assert.equal(result.data.pickupLocationToken, undefined);
  assert.equal(result.data.dropLocationToken, undefined);
});

test("booking validation rejects oversized signed location tokens", () => {
  const result = createBookingSchema.safeParse({
    ...baseBooking,
    pickupLocationToken: "x".repeat(4097),
  });
  assert.equal(result.success, false);
});

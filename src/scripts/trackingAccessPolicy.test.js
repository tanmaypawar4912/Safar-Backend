import test from "node:test";
import assert from "node:assert/strict";
import {
  canAccessBookingTracking,
  isBookingTrackable,
} from "../services/trackingAccessPolicy.js";

const booking = {
  customer: "111111111111111111111111",
  driver: "222222222222222222222222",
  status: "in_transit",
};

test("booking owner can subscribe to their booking tracking room", () => {
  assert.equal(
    canAccessBookingTracking({ userId: booking.customer, role: "customer" }, booking),
    true
  );
});

test("another customer cannot subscribe to the booking tracking room", () => {
  assert.equal(
    canAccessBookingTracking({ userId: "333333333333333333333333", role: "customer" }, booking),
    false
  );
});

test("only the assigned driver can subscribe as a driver", () => {
  assert.equal(
    canAccessBookingTracking({ userId: booking.driver, role: "driver" }, booking),
    true
  );
  assert.equal(
    canAccessBookingTracking({ userId: "444444444444444444444444", role: "driver" }, booking),
    false
  );
});

test("admin can subscribe to an authorized tracking room", () => {
  assert.equal(
    canAccessBookingTracking({ userId: "555555555555555555555555", role: "admin" }, booking),
    true
  );
});

test("unknown roles cannot subscribe", () => {
  assert.equal(
    canAccessBookingTracking({ userId: booking.customer, role: "staff" }, booking),
    false
  );
});

test("only active assigned deliveries can stream locations", () => {
  assert.equal(isBookingTrackable(booking), true);
  assert.equal(isBookingTrackable({ ...booking, status: "pending", driver: null }), false);
  assert.equal(isBookingTrackable({ ...booking, status: "delivered" }), false);
  assert.equal(isBookingTrackable({ ...booking, status: "cancelled" }), false);
});

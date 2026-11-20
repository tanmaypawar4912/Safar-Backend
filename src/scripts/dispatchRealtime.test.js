import test from "node:test";
import assert from "node:assert/strict";
import {
  emitDriverDispatchOfferClosed,
  emitDriverDispatchJobUpdated,
  emitDriverDispatchOffers,
  registerDispatchSocketServer,
} from "../services/dispatchRealtime.js";

const driverA = "111111111111111111111111";
const driverB = "222222222222222222222222";
const booking = {
  _id: "aaaaaaaaaaaaaaaaaaaaaaaa",
  bookingCode: "LG-TEST-123",
  expiresAt: new Date("2026-11-20T09:00:00.000Z"),
};

test("dispatch offer emits a minimal event to every unique eligible driver room", () => {
  const emitted = [];
  registerDispatchSocketServer({
    to(room) {
      return { emit(event, payload) { emitted.push({ room, event, payload }); } };
    },
  });

  const count = emitDriverDispatchOffers([driverA, driverB, driverA, "bad-id"], booking);
  assert.equal(count, 2);
  assert.deepEqual(emitted.map((item) => item.room), [`driver:${driverA}`, `driver:${driverB}`]);
  assert.equal(emitted[0].event, "dispatch:offer");
  assert.deepEqual(emitted[0].payload, {
    bookingId: booking._id,
    bookingCode: booking.bookingCode,
    expiresAt: booking.expiresAt.toISOString(),
  });
  assert.equal("pickup" in emitted[0].payload, false);
  registerDispatchSocketServer(null);
});

test("offer-closed event refreshes every relevant driver room", () => {
  const emitted = [];
  registerDispatchSocketServer({
    to(room) {
      return { emit(event, payload) { emitted.push({ room, event, payload }); } };
    },
  });

  const count = emitDriverDispatchOfferClosed([driverA, driverB], booking, "accepted_by_another_driver");
  assert.equal(count, 2);
  assert.equal(emitted[0].event, "dispatch:offer-closed");
  assert.equal(emitted[0].payload.reason, "accepted_by_another_driver");
  registerDispatchSocketServer(null);
});


test("manual admin assignment triggers an immediate private jobs refresh", () => {
  const emitted = [];
  registerDispatchSocketServer({
    to(room) {
      return { emit(event, payload) { emitted.push({ room, event, payload }); } };
    },
  });

  const count = emitDriverDispatchJobUpdated([driverA], booking, "assigned_by_admin");
  assert.equal(count, 1);
  assert.equal(emitted[0].room, `driver:${driverA}`);
  assert.equal(emitted[0].event, "dispatch:job-updated");
  assert.equal(emitted[0].payload.reason, "assigned_by_admin");
  registerDispatchSocketServer(null);
});

test("dispatch notifications safely no-op when the socket server is unavailable", () => {
  registerDispatchSocketServer(null);
  assert.equal(emitDriverDispatchOffers([driverA], booking), 0);
  assert.equal(emitDriverDispatchOfferClosed([driverA], booking), 0);
});

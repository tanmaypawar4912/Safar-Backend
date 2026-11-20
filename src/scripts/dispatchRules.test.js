import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDispatchCandidateFilter,
  canReceiveDispatchOfferAgain,
  isActiveDriverAccount,
} from "../services/dispatchRules.js";

const now = new Date("2026-11-20T08:00:00.000Z");

test("dispatch candidate query requires approved online active matching driver and capacity", () => {
  assert.deepEqual(
    buildDispatchCandidateFilter({ vehicleSlug: "pickup-truck", weightKg: 950, now }),
    {
      approvalStatus: "approved",
      availability: "online",
      isActive: true,
      licenseExpiry: { $gt: now },
      vehicleType: "pickup-truck",
      vehicleCapacityKg: { $gte: 950 },
    }
  );
});

test("dispatch candidate query rejects missing or invalid input", () => {
  assert.throws(() => buildDispatchCandidateFilter({ vehicleSlug: "", weightKg: 20, now }));
  assert.throws(() => buildDispatchCandidateFilter({ vehicleSlug: "pickup-truck", weightKg: 0, now }));
  assert.throws(() => buildDispatchCandidateFilter({ vehicleSlug: "pickup-truck", weightKg: NaN, now }));
});

test("a driver account must be an active driver role", () => {
  assert.equal(isActiveDriverAccount({ user: { role: "driver", isActive: true } }), true);
  assert.equal(isActiveDriverAccount({ user: { role: "customer", isActive: true } }), false);
  assert.equal(isActiveDriverAccount({ user: { role: "driver", isActive: false } }), false);
  assert.equal(isActiveDriverAccount({ user: null }), false);
});

test("new drivers and drivers past the cooldown can receive an offer", () => {
  assert.equal(canReceiveDispatchOfferAgain(null, now, 300_000), true);
  assert.equal(
    canReceiveDispatchOfferAgain(
      { status: "rejected", respondedAt: new Date(now.getTime() - 300_000) },
      now,
      300_000
    ),
    true
  );
});

test("active, accepted and losing offers cannot be reissued", () => {
  for (const status of ["offered", "accepted", "lost"]) {
    assert.equal(canReceiveDispatchOfferAgain({ status }, now, 300_000), false);
  }
});

test("rejected offers respect the longer cooldown while expired offers retry quickly", () => {
  assert.equal(
    canReceiveDispatchOfferAgain(
      { status: "rejected", respondedAt: new Date(now.getTime() - 299_999) },
      now,
      300_000
    ),
    false
  );
  assert.equal(
    canReceiveDispatchOfferAgain(
      { status: "expired", expiresAt: new Date(now.getTime() - 29_999) },
      now,
      300_000,
      30_000
    ),
    false
  );
  assert.equal(
    canReceiveDispatchOfferAgain(
      { status: "expired", expiresAt: new Date(now.getTime() - 30_000) },
      now,
      300_000,
      30_000
    ),
    true
  );
});

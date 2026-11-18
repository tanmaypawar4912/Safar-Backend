import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBookingLedgerEntries,
  buildCodCollectionLedgerEntries,
  buildDeliveryLedgerEntries,
  buildOnlinePaymentLedgerEntry,
} from "../services/financialLedgerLogic.js";

function booking(overrides = {}) {
  return {
    _id: "booking-123",
    bookingCode: "LG-TEST-123",
    customer: "customer-123",
    driver: "driver-123",
    vehicle: "vehicle-123",
    vehicleName: "Mini Truck",
    status: "delivered",
    paymentMethod: "online",
    paymentStatus: "unpaid",
    payment: {},
    commissionSnapshot: {
      vehicleName: "Mini Truck",
      commissionRateBps: 1000,
    },
    financialSnapshot: {
      calculationStatus: "finalized",
      currency: "INR",
      commissionBasePaise: 100000,
      commissionRateBps: 1000,
      platformCommissionPaise: 10000,
      driverEarningPaise: 90000,
      calculatedAt: new Date("2026-11-16T08:00:00.000Z"),
    },
    ...overrides,
  };
}

test("online delivery creates commission-earned and driver-payable entries", () => {
  const entries = buildDeliveryLedgerEntries(booking(), "driver-123");
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => [entry.entryType, entry.amountPaise]),
    [
      ["platform_commission_earned", 10000],
      ["driver_earning_payable", 90000],
    ]
  );
  assert.equal(new Set(entries.map((entry) => entry.idempotencyKey)).size, 2);
});

test("COD delivery records driver cash-retained earning, not an online payable", () => {
  const codBooking = booking({ paymentMethod: "cash_on_delivery" });
  const entries = buildDeliveryLedgerEntries(codBooking, "driver-123");
  assert.equal(entries.length, 2);
  assert.equal(entries.some((entry) => entry.entryType === "driver_earning_payable"), false);
  assert.equal(
    entries.find((entry) => entry.entryType === "driver_earning_retained_cod")?.amountPaise,
    90000
  );
});

test("captured online payment creates one gross customer-receipt entry", () => {
  const paidBooking = booking({
    paymentStatus: "paid",
    payment: { gatewayPaymentId: "pay_test_123", paidAt: new Date("2026-11-16T09:00:00.000Z") },
  });
  const entries = buildOnlinePaymentLedgerEntry(paidBooking, {
    paymentId: "pay_test_123",
    performedBy: "customer-123",
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].entryType, "online_payment_received");
  assert.equal(entries[0].amountPaise, 100000);
  assert.equal(entries[0].sourceReference, "pay_test_123");
});

test("COD collection creates gross cash-collected and commission-receivable entries", () => {
  const paidCodBooking = booking({
    paymentMethod: "cash_on_delivery",
    paymentStatus: "paid",
    payment: {
      cashCollectedBy: "driver-123",
      paidAt: new Date("2026-11-16T09:00:00.000Z"),
    },
  });
  const entries = buildCodCollectionLedgerEntries(paidCodBooking, {
    performedBy: "driver-123",
  });
  assert.deepEqual(
    entries.map((entry) => [entry.entryType, entry.amountPaise]),
    [
      ["cod_cash_collected_by_driver", 100000],
      ["cod_commission_receivable", 10000],
    ]
  );
});

test("legacy and review-required bookings do not create automatic ledger entries", () => {
  const legacy = booking({
    financialSnapshot: {
      calculationStatus: "legacy",
      currency: "INR",
      calculatedAt: new Date(),
    },
  });
  assert.deepEqual(buildBookingLedgerEntries(legacy), []);

  const review = booking({
    financialSnapshot: {
      calculationStatus: "review_required",
      currency: "INR",
      calculatedAt: new Date(),
    },
  });
  assert.deepEqual(buildBookingLedgerEntries(review), []);
});

test("non-delivered bookings cannot create delivery ledger entries", () => {
  assert.throws(
    () => buildDeliveryLedgerEntries(booking({ status: "in_transit" })),
    /only be created for delivered bookings/i
  );
});

test("COD collection cannot be recorded before payment is marked paid", () => {
  const unpaidCodBooking = booking({
    paymentMethod: "cash_on_delivery",
    paymentStatus: "unpaid",
    payment: {},
  });
  assert.throws(
    () => buildCodCollectionLedgerEntries(unpaidCodBooking),
    /must be confirmed/i
  );
});

test("financial snapshot must reconcile exactly to commission base", () => {
  const invalid = booking({
    financialSnapshot: {
      ...booking().financialSnapshot,
      driverEarningPaise: 89999,
    },
  });
  assert.throws(
    () => buildDeliveryLedgerEntries(invalid),
    /does not reconcile/i
  );
});

test("reconciliation builder returns all expected entries for a captured online booking", () => {
  const paidOnlineBooking = booking({
    paymentStatus: "paid",
    payment: {
      gatewayPaymentId: "pay_test_456",
      paidAt: new Date("2026-11-16T10:00:00.000Z"),
    },
  });
  const entries = buildBookingLedgerEntries(paidOnlineBooking, {
    performedBy: "customer-123",
  });
  assert.deepEqual(
    entries.map((entry) => entry.entryType).sort(),
    ["driver_earning_payable", "online_payment_received", "platform_commission_earned"].sort()
  );
  assert.equal(entries.length, 3);
});

test("reconciliation builder returns all expected entries for paid COD", () => {
  const paidCodBooking = booking({
    paymentMethod: "cash_on_delivery",
    paymentStatus: "paid",
    payment: {
      cashCollectedBy: "driver-123",
      paidAt: new Date("2026-11-16T10:00:00.000Z"),
    },
  });
  const entries = buildBookingLedgerEntries(paidCodBooking, {
    performedBy: "driver-123",
  });
  assert.deepEqual(
    entries.map((entry) => entry.entryType).sort(),
    [
      "cod_cash_collected_by_driver",
      "cod_commission_receivable",
      "driver_earning_retained_cod",
      "platform_commission_earned",
    ].sort()
  );
  assert.equal(entries.length, 4);
});

test("idempotency keys remain stable across repeated ledger builds", () => {
  const first = buildDeliveryLedgerEntries(booking());
  const second = buildDeliveryLedgerEntries(booking());
  assert.deepEqual(
    first.map((entry) => entry.idempotencyKey),
    second.map((entry) => entry.idempotencyKey)
  );
});

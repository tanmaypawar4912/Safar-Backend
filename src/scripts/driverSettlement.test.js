import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateDailySettlement,
  getIstDateKey,
  getPreviousIstDateKey,
  resolveIstSettlementPeriod,
} from "../services/driverSettlementLogic.js";

function receipt(booking, amountPaise = 100000, id = `receipt-${booking}`) {
  return { _id: id, booking, amountPaise };
}
function earning(booking, amountPaise = 90000, id = `earning-${booking}`) {
  return { _id: id, booking, amountPaise };
}
function cod(amountPaise = 10000, id = "cod-1") {
  return { _id: id, amountPaise };
}

test("online earnings are offset by COD commission before daily payout", () => {
  const result = calculateDailySettlement({
    onlinePaymentReceipts: [receipt("booking-1")],
    driverEarningEntries: [earning("booking-1")],
    codCommissionEntries: [cod(10000)],
    codCommissionAddedInPeriodPaise: 10000,
  });
  assert.equal(result.onlinePaymentGrossPaise, 100000);
  assert.equal(result.driverEarningsGrossPaise, 90000);
  assert.equal(result.codCommissionDueBeforePaise, 10000);
  assert.equal(result.codCommissionOffsetPaise, 10000);
  assert.equal(result.netPayoutPaise, 80000);
  assert.equal(result.codCommissionOutstandingPaise, 0);
});

test("COD-only activity produces no driver payout and carries commission due", () => {
  const result = calculateDailySettlement({
    codCommissionEntries: [cod(10000)],
    codCommissionAddedInPeriodPaise: 10000,
  });
  assert.equal(result.driverEarningsGrossPaise, 0);
  assert.equal(result.netPayoutPaise, 0);
  assert.equal(result.codCommissionOffsetPaise, 0);
  assert.equal(result.codCommissionOutstandingPaise, 10000);
});

test("COD commission larger than online earnings carries the unpaid balance forward", () => {
  const result = calculateDailySettlement({
    onlinePaymentReceipts: [receipt("booking-2", 60000)],
    driverEarningEntries: [earning("booking-2", 50000)],
    codCommissionEntries: [cod(80000)],
    codCommissionAddedInPeriodPaise: 80000,
  });
  assert.equal(result.codCommissionOffsetPaise, 50000);
  assert.equal(result.netPayoutPaise, 0);
  assert.equal(result.codCommissionOutstandingPaise, 30000);
});

test("previously applied COD offsets are not deducted twice", () => {
  const result = calculateDailySettlement({
    onlinePaymentReceipts: [receipt("booking-3")],
    driverEarningEntries: [earning("booking-3")],
    codCommissionEntries: [cod(10000)],
    previouslyAppliedCodCommissionPaise: 4000,
  });
  assert.equal(result.codCommissionDueBeforePaise, 6000);
  assert.equal(result.codCommissionOffsetPaise, 6000);
  assert.equal(result.netPayoutPaise, 84000);
  assert.equal(result.codCommissionOutstandingPaise, 0);
});

test("captured payment without its driver payable entry is rejected", () => {
  assert.throws(
    () => calculateDailySettlement({ onlinePaymentReceipts: [receipt("missing-payable")] }),
    /no driver payable entry/i
  );
});

test("duplicate receipt for one booking is rejected", () => {
  assert.throws(
    () => calculateDailySettlement({
      onlinePaymentReceipts: [receipt("booking-4", 100000, "r1"), receipt("booking-4", 100000, "r2")],
      driverEarningEntries: [earning("booking-4")],
    }),
    /duplicate online payment receipt/i
  );
});

test("IST settlement range spans midnight to midnight in Asia/Kolkata", () => {
  const period = resolveIstSettlementPeriod("2026-11-16", new Date("2026-11-17T06:00:00.000Z"));
  assert.equal(period.periodStart.toISOString(), "2026-11-15T18:30:00.000Z");
  assert.equal(period.periodEnd.toISOString(), "2026-11-16T18:30:00.000Z");
});

test("default settlement date is the previous completed IST day", () => {
  const now = new Date("2026-11-17T06:00:00.000Z");
  assert.equal(getIstDateKey(now), "2026-11-17");
  assert.equal(getPreviousIstDateKey(now), "2026-11-16");
  assert.equal(resolveIstSettlementPeriod(undefined, now).settlementDate, "2026-11-16");
});

test("today, future, malformed and impossible dates are rejected", () => {
  const now = new Date("2026-11-17T06:00:00.000Z");
  assert.throws(() => resolveIstSettlementPeriod("2026-11-17", now), /completed date/i);
  assert.throws(() => resolveIstSettlementPeriod("2026-11-18", now), /completed date/i);
  assert.throws(() => resolveIstSettlementPeriod("16-11-2026", now), /YYYY-MM-DD/i);
  assert.throws(() => resolveIstSettlementPeriod("2026-02-30", now), /valid calendar date/i);
});

test("unsafe or negative paise values are rejected", () => {
  assert.throws(
    () => calculateDailySettlement({
      onlinePaymentReceipts: [receipt("booking-5", -100)],
      driverEarningEntries: [earning("booking-5")],
    }),
    /non-negative safe integer paise/i
  );
});

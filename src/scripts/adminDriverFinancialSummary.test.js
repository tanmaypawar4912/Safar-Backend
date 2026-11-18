import test from "node:test";
import assert from "node:assert/strict";
import { buildAdminDriverFinancialRows } from "../services/adminDriverFinancialSummary.js";

const drivers = [
  { _id: "driver-a", name: "Auto Man", email: "auto@example.test" },
  { _id: "driver-b", name: "Driver B", email: "b@example.test" },
  { _id: "driver-c", name: "Driver C", email: "c@example.test" },
];

test("returns every registered driver, including drivers without ledger entries", () => {
  const rows = buildAdminDriverFinancialRows({ drivers });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row._id), ["driver-a", "driver-b", "driver-c"]);
  assert.equal(rows[1].driverEarningsAccruedPaise, 0);
  assert.equal(rows[1].financialStatus, "no_activity");
});

test("aggregates payable and COD-retained earnings separately for each driver", () => {
  const rows = buildAdminDriverFinancialRows({
    drivers,
    ledgerRows: [
      {
        _id: "driver-a",
        platformCommissionEarnedPaise: 5570,
        driverEarningsRetainedCodPaise: 50132,
        codCashCollectedByDriversPaise: 55702,
        codCommissionReceivablePaise: 5570,
        entryCount: 4,
      },
      {
        _id: "driver-b",
        platformCommissionEarnedPaise: 10000,
        driverEarningsPayablePaise: 90000,
        onlinePaymentsReceivedPaise: 100000,
        entryCount: 3,
      },
    ],
    eligibleRows: [{ _id: "driver-b", eligiblePaise: 90000 }],
  });

  assert.equal(rows[0].driverEarningsAccruedPaise, 50132);
  assert.equal(rows[0].codCommissionOutstandingPaise, 5570);
  assert.equal(rows[1].driverEarningsAccruedPaise, 90000);
  assert.equal(rows[1].driverEarningsEligibleForSettlementPaise, 90000);
  assert.equal(rows[1].driverEarningsAwaitingCustomerPaymentPaise, 0);
});

test("does not show unpaid online driver earnings as payout eligible", () => {
  const [row] = buildAdminDriverFinancialRows({
    drivers: [drivers[1]],
    ledgerRows: [{ _id: "driver-b", driverEarningsPayablePaise: 90000, entryCount: 2 }],
    eligibleRows: [],
  });
  assert.equal(row.driverEarningsPayablePaise, 90000);
  assert.equal(row.driverEarningsEligibleForSettlementPaise, 0);
  assert.equal(row.driverEarningsAwaitingCustomerPaymentPaise, 90000);
});

test("identifies legacy-only drivers without retroactively applying commission", () => {
  const [row] = buildAdminDriverFinancialRows({
    drivers: [drivers[2]],
    bookingRows: [{ _id: "driver-c", completedBookingCount: 4, legacyCompletedBookingCount: 4 }],
  });
  assert.equal(row.legacyCompletedBookingCount, 4);
  assert.equal(row.driverEarningsAccruedPaise, 0);
  assert.equal(row.financialStatus, "legacy_only");
  assert.match(row.financialStatusMessage, /predate commission snapshots/);
});

test("flags finalized delivered bookings whose delivery ledger entries are incomplete", () => {
  const [row] = buildAdminDriverFinancialRows({
    drivers: [drivers[1]],
    bookingRows: [{ _id: "driver-b", completedBookingCount: 2, finalizedCompletedBookingCount: 2 }],
    deliveryLedgerRows: [{ _id: "driver-b", fullyRecordedDeliveryLedgerBookingCount: 1 }],
  });
  assert.equal(row.fullyRecordedDeliveryLedgerBookingCount, 1);
  assert.equal(row.ledgerReconciliationNeededBookingCount, 1);
  assert.equal(row.financialStatus, "reconciliation_required");
});

test("does not flag a fully recorded finalized booking as needing reconciliation", () => {
  const [row] = buildAdminDriverFinancialRows({
    drivers: [drivers[0]],
    ledgerRows: [{ _id: "driver-a", entryCount: 4, platformCommissionEarnedPaise: 5570 }],
    bookingRows: [{ _id: "driver-a", completedBookingCount: 3, legacyCompletedBookingCount: 2, finalizedCompletedBookingCount: 1 }],
    deliveryLedgerRows: [{ _id: "driver-a", fullyRecordedDeliveryLedgerBookingCount: 1 }],
  });

  assert.equal(row.finalizedCompletedBookingCount, 1);
  assert.equal(row.fullyRecordedDeliveryLedgerBookingCount, 1);
  assert.equal(row.ledgerReconciliationNeededBookingCount, 0);
  assert.equal(row.financialStatus, "active");
});

test("applies only paid/no-payout settlement COD offsets to the outstanding balance", () => {
  const [row] = buildAdminDriverFinancialRows({
    drivers: [drivers[0]],
    ledgerRows: [{ _id: "driver-a", codCommissionReceivablePaise: 10000, entryCount: 2 }],
    settlementRows: [{ _id: "driver-a", appliedCodCommissionPaise: 3000 }],
  });
  assert.equal(row.codCommissionOutstandingPaise, 7000);
});

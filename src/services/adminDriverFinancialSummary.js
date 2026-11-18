function idKey(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value._id) return String(value._id);
  return String(value);
}

function amount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function rupees(paise) {
  return Number((amount(paise) / 100).toFixed(2));
}

/**
 * Merge the User, ledger, eligible-online, settlement and delivered-booking
 * aggregates into one row per driver. Drivers without ledger activity are
 * intentionally retained so the Admin UI never silently hides them.
 */
export function buildAdminDriverFinancialRows({
  drivers = [],
  ledgerRows = [],
  eligibleRows = [],
  settlementRows = [],
  bookingRows = [],
  deliveryLedgerRows = [],
} = {}) {
  const byId = (rows) => new Map(rows.map((row) => [idKey(row._id), row]));
  const ledgerByDriver = byId(ledgerRows);
  const eligibleByDriver = byId(eligibleRows);
  const settlementByDriver = byId(settlementRows);
  const bookingsByDriver = byId(bookingRows);
  const deliveryLedgerByDriver = byId(deliveryLedgerRows);

  return drivers.map((driver) => {
    const driverId = idKey(driver._id);
    const ledger = ledgerByDriver.get(driverId) || {};
    const eligible = eligibleByDriver.get(driverId) || {};
    const settlement = settlementByDriver.get(driverId) || {};
    const bookings = bookingsByDriver.get(driverId) || {};
    const deliveryLedger = deliveryLedgerByDriver.get(driverId) || {};

    const driverEarningsPayablePaise = amount(ledger.driverEarningsPayablePaise);
    const driverEarningsRetainedCodPaise = amount(ledger.driverEarningsRetainedCodPaise);
    const driverEarningsAccruedPaise =
      driverEarningsPayablePaise + driverEarningsRetainedCodPaise;
    const driverEarningsEligibleForSettlementPaise = Math.min(
      driverEarningsPayablePaise,
      amount(eligible.eligiblePaise)
    );
    const driverEarningsAwaitingCustomerPaymentPaise =
      driverEarningsPayablePaise - driverEarningsEligibleForSettlementPaise;
    const codCommissionReceivablePaise = amount(ledger.codCommissionReceivablePaise);
    const codCommissionAppliedPaise = amount(settlement.appliedCodCommissionPaise);
    const codCommissionOutstandingPaise = Math.max(
      0,
      codCommissionReceivablePaise - codCommissionAppliedPaise
    );

    const completedBookingCount = amount(bookings.completedBookingCount);
    const legacyCompletedBookingCount = amount(bookings.legacyCompletedBookingCount);
    const finalizedCompletedBookingCount = amount(bookings.finalizedCompletedBookingCount);
    // Keep the field name aligned with the aggregation in
    // financialLedgerController.js. The fallback supports older callers/tests
    // that may still pass the shorter legacy property name.
    const fullyRecordedDeliveryLedgerBookingCount = amount(
      deliveryLedger.fullyRecordedDeliveryLedgerBookingCount ??
        deliveryLedger.fullyRecordedDeliveryBookingCount
    );
    const ledgerReconciliationNeededBookingCount = Math.max(
      0,
      finalizedCompletedBookingCount - fullyRecordedDeliveryLedgerBookingCount
    );
    const entryCount = amount(ledger.entryCount);

    let financialStatus = "no_activity";
    let financialStatusMessage = "No completed deliveries or financial ledger activity yet.";
    if (ledgerReconciliationNeededBookingCount > 0) {
      financialStatus = "reconciliation_required";
      financialStatusMessage = `${ledgerReconciliationNeededBookingCount} delivered booking(s) have a finalized commission snapshot but incomplete ledger entries. Admin reconciliation is required.`;
    } else if (entryCount > 0) {
      financialStatus = "active";
      financialStatusMessage = "Financial entries are available for this driver.";
    } else if (legacyCompletedBookingCount > 0 && finalizedCompletedBookingCount === 0) {
      financialStatus = "legacy_only";
      financialStatusMessage = `${legacyCompletedBookingCount} older completed booking(s) predate commission snapshots. They are excluded from automatic earnings to avoid retroactive commission.`;
    } else if (completedBookingCount > 0) {
      financialStatus = "no_ledger_activity";
      financialStatusMessage = "Completed bookings exist, but no eligible financial ledger entries were found.";
    }

    const row = {
      _id: driverId,
      name: driver.name || "Unknown driver",
      email: driver.email || "",
      phone: driver.phone || "",
      isActive: driver.isActive !== false,
      createdAt: driver.createdAt || null,
      completedBookingCount,
      legacyCompletedBookingCount,
      finalizedCompletedBookingCount,
      fullyRecordedDeliveryLedgerBookingCount,
      ledgerReconciliationNeededBookingCount,
      financialStatus,
      financialStatusMessage,
      platformCommissionEarnedPaise: amount(ledger.platformCommissionEarnedPaise),
      driverEarningsPayablePaise,
      driverEarningsRetainedCodPaise,
      driverEarningsAccruedPaise,
      driverEarningsEligibleForSettlementPaise,
      driverEarningsAwaitingCustomerPaymentPaise,
      onlinePaymentsReceivedPaise: amount(ledger.onlinePaymentsReceivedPaise),
      codCashCollectedByDriversPaise: amount(ledger.codCashCollectedByDriversPaise),
      codCommissionReceivablePaise,
      codCommissionAppliedPaise,
      codCommissionOutstandingPaise,
      pendingPayoutCount: amount(settlement.pendingPayoutCount),
      pendingPayoutPaise: amount(settlement.pendingPayoutPaise),
      paidPayoutCount: amount(settlement.paidPayoutCount),
      paidPayoutPaise: amount(settlement.paidPayoutPaise),
      noPayoutCount: amount(settlement.noPayoutCount),
      ledgerEntryCount: entryCount,
    };

    return {
      ...row,
      platformCommissionEarnedRupees: rupees(row.platformCommissionEarnedPaise),
      driverEarningsPayableRupees: rupees(row.driverEarningsPayablePaise),
      driverEarningsRetainedCodRupees: rupees(row.driverEarningsRetainedCodPaise),
      driverEarningsAccruedRupees: rupees(row.driverEarningsAccruedPaise),
      driverEarningsEligibleForSettlementRupees: rupees(
        row.driverEarningsEligibleForSettlementPaise
      ),
      driverEarningsAwaitingCustomerPaymentRupees: rupees(
        row.driverEarningsAwaitingCustomerPaymentPaise
      ),
      onlinePaymentsReceivedRupees: rupees(row.onlinePaymentsReceivedPaise),
      codCashCollectedByDriversRupees: rupees(row.codCashCollectedByDriversPaise),
      codCommissionReceivableRupees: rupees(row.codCommissionReceivablePaise),
      codCommissionAppliedRupees: rupees(row.codCommissionAppliedPaise),
      codCommissionOutstandingRupees: rupees(row.codCommissionOutstandingPaise),
      pendingPayoutRupees: rupees(row.pendingPayoutPaise),
      paidPayoutRupees: rupees(row.paidPayoutPaise),
    };
  });
}

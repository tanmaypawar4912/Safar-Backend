import mongoose from "mongoose";
import DriverSettlement from "../models/DriverSettlement.js";
import FinancialLedgerEntry from "../models/FinancialLedgerEntry.js";
import {
  calculateDailySettlement,
  resolveIstSettlementPeriod,
} from "./driverSettlementLogic.js";

function sumPaise(entries) {
  const total = entries.reduce((sum, entry) => sum + Number(entry.amountPaise || 0), 0);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new TypeError("Ledger aggregate must be a non-negative safe integer paise amount.");
  }
  return total;
}

async function generateForDriver(driverId, period, generatedBy) {
  const existing = await DriverSettlement.findOne({
    driver: driverId,
    settlementDate: period.settlementDate,
  }).lean();
  if (existing) return { status: "existing", settlement: existing };

  const laterSettlement = await DriverSettlement.findOne({
    driver: driverId,
    settlementDate: { $gt: period.settlementDate },
  }).sort({ settlementDate: 1 }).lean();
  if (laterSettlement) {
    return {
      status: "blocked",
      message: `A later settlement (${laterSettlement.settlementDate}) already exists. Generate daily settlements in chronological order to avoid reusing COD offsets.`,
    };
  }

  const previousPending = await DriverSettlement.findOne({
    driver: driverId,
    settlementDate: { $lt: period.settlementDate },
    status: "pending_payout",
  }).sort({ settlementDate: 1 }).lean();
  if (previousPending) {
    return {
      status: "blocked",
      message: `Previous settlement ${previousPending.settlementDate} is still pending payout. Confirm it before generating another day.`,
    };
  }

  const claimedReceiptIds = await DriverSettlement.distinct("onlinePaymentEntryIds", { driver: driverId });
  const onlinePaymentReceipts = await FinancialLedgerEntry.find({
    driver: driverId,
    entryType: "online_payment_received",
    occurredAt: { $gte: period.periodStart, $lt: period.periodEnd },
    ...(claimedReceiptIds.length ? { _id: { $nin: claimedReceiptIds } } : {}),
  }).select("_id booking amountPaise occurredAt").lean();

  const bookingIds = onlinePaymentReceipts.map((entry) => entry.booking);
  const driverEarningEntries = bookingIds.length
    ? await FinancialLedgerEntry.find({
        driver: driverId,
        booking: { $in: bookingIds },
        entryType: "driver_earning_payable",
      }).select("_id booking amountPaise occurredAt").lean()
    : [];

  const allCodCommissionEntries = await FinancialLedgerEntry.find({
    driver: driverId,
    entryType: "cod_commission_receivable",
    occurredAt: { $lt: period.periodEnd },
  }).select("_id amountPaise occurredAt").lean();

  const codCommissionEntriesInPeriod = allCodCommissionEntries.filter(
    (entry) => entry.occurredAt >= period.periodStart && entry.occurredAt < period.periodEnd
  );

  const previousApplied = await DriverSettlement.aggregate([
    {
      $match: {
        driver: new mongoose.Types.ObjectId(String(driverId)),
        settlementDate: { $lt: period.settlementDate },
        status: { $in: ["paid", "no_payout"] },
      },
    },
    { $group: { _id: null, total: { $sum: "$codCommissionOffsetPaise" } } },
  ]);
  const previouslyAppliedCodCommissionPaise = previousApplied[0]?.total || 0;
  const totalCodReceivablePaise = sumPaise(allCodCommissionEntries);
  if (previouslyAppliedCodCommissionPaise > totalCodReceivablePaise) {
    throw new Error("Previously applied COD commission exceeds the driver's recorded COD receivable balance.");
  }

  if (!onlinePaymentReceipts.length && !codCommissionEntriesInPeriod.length) {
    return { status: "skipped", message: "No newly eligible online receipts or COD commission collections for this date." };
  }

  const calculation = calculateDailySettlement({
    onlinePaymentReceipts,
    driverEarningEntries,
    codCommissionEntries: allCodCommissionEntries,
    codCommissionAddedInPeriodPaise: sumPaise(codCommissionEntriesInPeriod),
    previouslyAppliedCodCommissionPaise,
  });
  const {
    codCommissionDueBeforePaise,
    codCommissionOffsetPaise,
    netPayoutPaise,
    codCommissionOutstandingPaise,
  } = calculation;

  const document = {
    driver: driverId,
    settlementDate: period.settlementDate,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    currency: "INR",
    onlinePaymentGrossPaise: calculation.onlinePaymentGrossPaise,
    driverEarningsGrossPaise: calculation.driverEarningsGrossPaise,
    codCommissionAddedPaise: sumPaise(codCommissionEntriesInPeriod),
    codCommissionDueBeforePaise,
    codCommissionOffsetPaise,
    netPayoutPaise,
    codCommissionOutstandingPaise,
    onlinePaymentEntryIds: calculation.onlinePaymentEntryIds,
    driverEarningEntryIds: calculation.driverEarningEntryIds,
    codCommissionEntryIds: allCodCommissionEntries.map((entry) => entry._id),
    status: netPayoutPaise > 0 ? "pending_payout" : "no_payout",
    generatedBy,
  };

  try {
    const settlement = await DriverSettlement.create(document);
    return { status: "created", settlement: settlement.toObject() };
  } catch (error) {
    if (error?.code === 11000) {
      const duplicate = await DriverSettlement.findOne({
        driver: driverId,
        settlementDate: period.settlementDate,
      }).lean();
      if (duplicate) return { status: "existing", settlement: duplicate };
      const pending = await DriverSettlement.findOne({ driver: driverId, status: "pending_payout" }).lean();
      if (pending) {
        return {
          status: "blocked",
          message: `A payout for ${pending.settlementDate} is still pending confirmation.`,
        };
      }
    }
    throw error;
  }
}

export async function generateDailyDriverSettlements(requestedDate, generatedBy, now = new Date()) {
  const period = resolveIstSettlementPeriod(requestedDate, now);
  const activeDriverIds = await FinancialLedgerEntry.distinct("driver", {
    entryType: { $in: ["online_payment_received", "cod_commission_receivable"] },
    occurredAt: { $gte: period.periodStart, $lt: period.periodEnd },
  });

  const results = [];
  for (const driverId of activeDriverIds) {
    try {
      results.push({
        driverId: String(driverId),
        ...(await generateForDriver(driverId, period, generatedBy)),
      });
    } catch (error) {
      results.push({ driverId: String(driverId), status: "failed", message: error.message });
    }
  }

  return {
    settlementDate: period.settlementDate,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    scannedDrivers: activeDriverIds.length,
    created: results.filter((item) => item.status === "created").length,
    existing: results.filter((item) => item.status === "existing").length,
    blocked: results.filter((item) => item.status === "blocked").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    failed: results.filter((item) => item.status === "failed").length,
    results,
  };
}

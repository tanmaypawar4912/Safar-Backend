import mongoose from "mongoose";
import FinancialLedgerEntry, {
  FINANCIAL_LEDGER_ENTRY_TYPES,
} from "../models/FinancialLedgerEntry.js";
import Booking from "../models/Booking.js";
import User from "../models/User.js";
import DriverSettlement from "../models/DriverSettlement.js";
import { buildAdminDriverFinancialRows } from "../services/adminDriverFinancialSummary.js";
import { reconcileBookingLedger } from "../services/financialLedgerService.js";

function parseDateFilter(query) {
  const occurredAt = {};
  if (query.from) {
    const from = new Date(query.from);
    if (Number.isNaN(from.getTime())) {
      return { error: "The from date is invalid." };
    }
    occurredAt.$gte = from;
  }
  if (query.to) {
    const to = new Date(query.to);
    if (Number.isNaN(to.getTime())) {
      return { error: "The to date is invalid." };
    }
    occurredAt.$lte = to;
  }
  if (occurredAt.$gte && occurredAt.$lte && occurredAt.$gte > occurredAt.$lte) {
    return { error: "The from date must be before the to date." };
  }
  return { filter: Object.keys(occurredAt).length ? { occurredAt } : {} };
}

function parseEntryFilters(query, { includeDriver = false } = {}) {
  const dateResult = parseDateFilter(query);
  if (dateResult.error) return dateResult;

  const filter = { ...dateResult.filter };
  if (query.entryType) {
    if (!FINANCIAL_LEDGER_ENTRY_TYPES.includes(query.entryType)) {
      return { error: "The requested ledger entry type is invalid." };
    }
    filter.entryType = query.entryType;
  }

  if (includeDriver && query.driverId) {
    if (!mongoose.isValidObjectId(query.driverId)) {
      return { error: "A valid driver ID is required." };
    }
    filter.driver = query.driverId;
  }

  return { filter };
}

function pagination(query) {
  const pageRaw = Number.parseInt(query.page || "1", 10);
  const limitRaw = Number.parseInt(query.limit || "50", 10);
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const limit = Number.isInteger(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), 100)
    : 50;
  return { page, limit, skip: (page - 1) * limit };
}

function addRupees(entry) {
  return {
    ...entry,
    amountRupees: Number((entry.amountPaise / 100).toFixed(2)),
  };
}

async function aggregateSummary(match) {
  const rows = await FinancialLedgerEntry.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$entryType",
        amountPaise: { $sum: "$amountPaise" },
        count: { $sum: 1 },
      },
    },
  ]);
  const byType = Object.fromEntries(
    rows.map((row) => [row._id, { amountPaise: row.amountPaise, count: row.count }])
  );
  const amount = (type) => byType[type]?.amountPaise || 0;
  const count = (type) => byType[type]?.count || 0;

  const summary = {
    platformCommissionEarnedPaise: amount("platform_commission_earned"),
    driverEarningsPayablePaise: amount("driver_earning_payable"),
    driverEarningsRetainedCodPaise: amount("driver_earning_retained_cod"),
    onlinePaymentsReceivedPaise: amount("online_payment_received"),
    codCashCollectedByDriversPaise: amount("cod_cash_collected_by_driver"),
    codCommissionReceivablePaise: amount("cod_commission_receivable"),
    entryCount: rows.reduce((total, row) => total + row.count, 0),
    countsByType: Object.fromEntries(rows.map((row) => [row._id, row.count])),
  };

  return {
    ...summary,
    platformCommissionEarnedRupees: summary.platformCommissionEarnedPaise / 100,
    driverEarningsPayableRupees: summary.driverEarningsPayablePaise / 100,
    driverEarningsRetainedCodRupees: summary.driverEarningsRetainedCodPaise / 100,
    onlinePaymentsReceivedRupees: summary.onlinePaymentsReceivedPaise / 100,
    codCashCollectedByDriversRupees: summary.codCashCollectedByDriversPaise / 100,
    codCommissionReceivableRupees: summary.codCommissionReceivablePaise / 100,
  };
}

export const getAdminFinancialLedgerEntries = async (req, res) => {
  try {
    const parsed = parseEntryFilters(req.query, { includeDriver: true });
    if (parsed.error) {
      return res.status(400).json({ success: false, message: parsed.error });
    }
    const { page, limit, skip } = pagination(req.query);
    const [entries, total] = await Promise.all([
      FinancialLedgerEntry.find(parsed.filter)
        .sort({ occurredAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .populate("driver", "name email phone")
        .populate("customer", "name email phone")
        .populate("vehicle", "name slug")
        .lean(),
      FinancialLedgerEntry.countDocuments(parsed.filter),
    ]);

    return res.json({
      success: true,
      entries: entries.map(addRupees),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Admin financial ledger query failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load financial ledger entries.",
    });
  }
};

export const getAdminFinancialLedgerSummary = async (req, res) => {
  try {
    const parsed = parseEntryFilters(req.query, { includeDriver: true });
    if (parsed.error) {
      return res.status(400).json({ success: false, message: parsed.error });
    }
    const summary = await aggregateSummary(parsed.filter);
    return res.json({ success: true, summary });
  } catch (error) {
    console.error("Admin financial ledger summary failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load financial ledger summary.",
    });
  }
};

export const getDriverFinancialLedgerEntries = async (req, res) => {
  try {
    const parsed = parseEntryFilters(req.query);
    if (parsed.error) {
      return res.status(400).json({ success: false, message: parsed.error });
    }
    const filter = { ...parsed.filter, driver: req.user.userId };
    const { page, limit, skip } = pagination(req.query);
    const [entries, total] = await Promise.all([
      FinancialLedgerEntry.find(filter)
        .sort({ occurredAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .populate("vehicle", "name slug")
        .lean(),
      FinancialLedgerEntry.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      entries: entries.map(addRupees),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Driver financial ledger query failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load your financial ledger.",
    });
  }
};

export const getDriverFinancialLedgerSummary = async (req, res) => {
  try {
    const driverId = new mongoose.Types.ObjectId(req.user.userId);
    const [summary, payableRows] = await Promise.all([
      aggregateSummary({ driver: driverId }),
      FinancialLedgerEntry.aggregate([
        { $match: { driver: driverId, entryType: "driver_earning_payable" } },
        {
          $lookup: {
            from: FinancialLedgerEntry.collection.name,
            let: { bookingId: "$booking" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$booking", "$$bookingId"] },
                      { $eq: ["$entryType", "online_payment_received"] },
                    ],
                  },
                },
              },
              { $limit: 1 },
            ],
            as: "capturedPayment",
          },
        },
        {
          $group: {
            _id: null,
            accruedPaise: { $sum: "$amountPaise" },
            eligiblePaise: {
              $sum: {
                $cond: [
                  { $gt: [{ $size: "$capturedPayment" }, 0] },
                  "$amountPaise",
                  0,
                ],
              },
            },
          },
        },
      ]),
    ]);

    const accruedPaise = payableRows[0]?.accruedPaise || 0;
    const eligibleForSettlementPaise = payableRows[0]?.eligiblePaise || 0;
    const awaitingCustomerPaymentPaise = accruedPaise - eligibleForSettlementPaise;
    const estimatedNetSettlementPaise =
      eligibleForSettlementPaise - summary.codCommissionReceivablePaise;

    return res.json({
      success: true,
      summary: {
        ...summary,
        driverEarningsAccruedPaise: accruedPaise,
        driverEarningsAccruedRupees: accruedPaise / 100,
        driverEarningsEligibleForSettlementPaise: eligibleForSettlementPaise,
        driverEarningsEligibleForSettlementRupees: eligibleForSettlementPaise / 100,
        driverEarningsAwaitingCustomerPaymentPaise: awaitingCustomerPaymentPaise,
        driverEarningsAwaitingCustomerPaymentRupees: awaitingCustomerPaymentPaise / 100,
        estimatedNetSettlementPaise,
        estimatedNetSettlementRupees: estimatedNetSettlementPaise / 100,
        note: "Only online bookings with a captured customer payment are included as payout-eligible. Daily settlement batches and payout confirmations are implemented in the next sprint.",
      },
    });
  } catch (error) {
    console.error("Driver financial ledger summary failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load your financial summary.",
    });
  }
};

export const reconcileAdminBookingLedger = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.bookingId)) {
      return res.status(400).json({ success: false, message: "A valid booking ID is required." });
    }
    const booking = await Booking.findById(req.params.bookingId).lean();
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found." });
    }
    if (booking.status !== "delivered") {
      return res.status(409).json({ success: false, message: "Only delivered bookings can be reconciled." });
    }

    const result = await reconcileBookingLedger(booking, req.user.userId);
    return res.json({
      success: true,
      message: result.skipped
        ? "No automatic ledger entries were created because this booking is legacy or requires financial review."
        : "Booking financial ledger reconciled successfully.",
      reconciliation: result,
    });
  } catch (error) {
    console.error("Admin booking ledger reconciliation failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to reconcile this booking's financial ledger.",
    });
  }
};


/**
 * Admin-only, driver-wise financial view.
 * It starts from every User with role=driver and LEFT-merges ledger,
 * settlement and delivered-booking aggregates so drivers with zero/legacy
 * activity remain visible instead of disappearing from the Admin UI.
 */
export const getAdminDriverFinancialSummaries = async (req, res) => {
  try {
    const { page, limit, skip } = pagination(req.query);
    const [drivers, total] = await Promise.all([
      User.find({ role: "driver" })
        .select("name email phone isActive createdAt")
        .sort({ name: 1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments({ role: "driver" }),
    ]);

    if (!drivers.length) {
      return res.json({
        success: true,
        drivers: [],
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    }

    const driverIds = drivers.map((driver) => driver._id);
    const [ledgerRows, eligibleRows, settlementRows, bookingRows, deliveryLedgerRows] =
      await Promise.all([
        FinancialLedgerEntry.aggregate([
          { $match: { driver: { $in: driverIds } } },
          {
            $group: {
              _id: "$driver",
              platformCommissionEarnedPaise: {
                $sum: { $cond: [{ $eq: ["$entryType", "platform_commission_earned"] }, "$amountPaise", 0] },
              },
              driverEarningsPayablePaise: {
                $sum: { $cond: [{ $eq: ["$entryType", "driver_earning_payable"] }, "$amountPaise", 0] },
              },
              driverEarningsRetainedCodPaise: {
                $sum: { $cond: [{ $eq: ["$entryType", "driver_earning_retained_cod"] }, "$amountPaise", 0] },
              },
              onlinePaymentsReceivedPaise: {
                $sum: { $cond: [{ $eq: ["$entryType", "online_payment_received"] }, "$amountPaise", 0] },
              },
              codCashCollectedByDriversPaise: {
                $sum: { $cond: [{ $eq: ["$entryType", "cod_cash_collected_by_driver"] }, "$amountPaise", 0] },
              },
              codCommissionReceivablePaise: {
                $sum: { $cond: [{ $eq: ["$entryType", "cod_commission_receivable"] }, "$amountPaise", 0] },
              },
              entryCount: { $sum: 1 },
            },
          },
        ]),
        FinancialLedgerEntry.aggregate([
          {
            $match: {
              driver: { $in: driverIds },
              entryType: "driver_earning_payable",
            },
          },
          {
            $lookup: {
              from: FinancialLedgerEntry.collection.name,
              let: { bookingId: "$booking", driverId: "$driver" },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ["$booking", "$$bookingId"] },
                        { $eq: ["$driver", "$$driverId"] },
                        { $eq: ["$entryType", "online_payment_received"] },
                      ],
                    },
                  },
                },
                { $limit: 1 },
              ],
              as: "capturedPayment",
            },
          },
          { $match: { $expr: { $gt: [{ $size: "$capturedPayment" }, 0] } } },
          {
            $group: {
              _id: "$driver",
              eligiblePaise: { $sum: "$amountPaise" },
            },
          },
        ]),
        DriverSettlement.aggregate([
          { $match: { driver: { $in: driverIds } } },
          {
            $group: {
              _id: "$driver",
              pendingPayoutCount: {
                $sum: { $cond: [{ $eq: ["$status", "pending_payout"] }, 1, 0] },
              },
              pendingPayoutPaise: {
                $sum: { $cond: [{ $eq: ["$status", "pending_payout"] }, "$netPayoutPaise", 0] },
              },
              paidPayoutCount: {
                $sum: { $cond: [{ $eq: ["$status", "paid"] }, 1, 0] },
              },
              paidPayoutPaise: {
                $sum: {
                  $cond: [
                    { $eq: ["$status", "paid"] },
                    { $ifNull: ["$paidAmountPaise", "$netPayoutPaise"] },
                    0,
                  ],
                },
              },
              noPayoutCount: {
                $sum: { $cond: [{ $eq: ["$status", "no_payout"] }, 1, 0] },
              },
              appliedCodCommissionPaise: {
                $sum: {
                  $cond: [
                    { $in: ["$status", ["paid", "no_payout"]] },
                    "$codCommissionOffsetPaise",
                    0,
                  ],
                },
              },
            },
          },
        ]),
        Booking.aggregate([
          { $match: { driver: { $in: driverIds }, status: "delivered" } },
          {
            $group: {
              _id: "$driver",
              completedBookingCount: { $sum: 1 },
              legacyCompletedBookingCount: {
                $sum: {
                  $cond: [
                    { $ne: ["$financialSnapshot.calculationStatus", "finalized"] },
                    1,
                    0,
                  ],
                },
              },
              finalizedCompletedBookingCount: {
                $sum: {
                  $cond: [
                    { $eq: ["$financialSnapshot.calculationStatus", "finalized"] },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ]),
        FinancialLedgerEntry.aggregate([
          {
            $match: {
              driver: { $in: driverIds },
              entryType: {
                $in: [
                  "platform_commission_earned",
                  "driver_earning_payable",
                  "driver_earning_retained_cod",
                ],
              },
            },
          },
          {
            $group: {
              _id: { driver: "$driver", booking: "$booking" },
              commissionEntries: {
                $sum: { $cond: [{ $eq: ["$entryType", "platform_commission_earned"] }, 1, 0] },
              },
              driverEarningEntries: {
                $sum: {
                  $cond: [
                    { $in: ["$entryType", ["driver_earning_payable", "driver_earning_retained_cod"]] },
                    1,
                    0,
                  ],
                },
              },
            },
          },
          {
            $group: {
              _id: "$_id.driver",
              fullyRecordedDeliveryLedgerBookingCount: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $gt: ["$commissionEntries", 0] },
                        { $gt: ["$driverEarningEntries", 0] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ]),
      ]);

    const driverSummaries = buildAdminDriverFinancialRows({
      drivers,
      ledgerRows,
      eligibleRows,
      settlementRows,
      bookingRows,
      deliveryLedgerRows,
    });

    return res.json({
      success: true,
      drivers: driverSummaries,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
      note: "All registered driver accounts are listed. Legacy completed bookings without a finalized commission snapshot are shown separately and are not retroactively charged.",
    });
  } catch (error) {
    console.error("Admin driver-wise financial summary failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load driver-wise financial summaries.",
    });
  }
};

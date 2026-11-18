import mongoose from "mongoose";
import DriverSettlement from "../models/DriverSettlement.js";
import FinancialLedgerEntry from "../models/FinancialLedgerEntry.js";
import { generateDailyDriverSettlements } from "../services/driverSettlementService.js";

function pagination(query) {
  const pageValue = Number.parseInt(query.page || "1", 10);
  const limitValue = Number.parseInt(query.limit || "25", 10);
  const page = Number.isInteger(pageValue) && pageValue > 0 ? pageValue : 1;
  const limit = Number.isInteger(limitValue) ? Math.min(Math.max(limitValue, 1), 100) : 25;
  return { page, limit, skip: (page - 1) * limit };
}

function parseFilters(query, { driverId = null } = {}) {
  const filter = driverId ? { driver: driverId } : {};
  if (query.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query.date)) {
      return { error: "Date must use YYYY-MM-DD format." };
    }
    filter.settlementDate = query.date;
  }
  if (query.status) {
    if (!["pending_payout", "paid", "no_payout"].includes(query.status)) {
      return { error: "Settlement status is invalid." };
    }
    filter.status = query.status;
  }
  if (!driverId && query.driverId) {
    if (!mongoose.isValidObjectId(query.driverId)) return { error: "A valid driver ID is required." };
    filter.driver = query.driverId;
  }
  return { filter };
}

function serializeSettlement(settlement) {
  const fields = [
    "onlinePaymentGrossPaise",
    "driverEarningsGrossPaise",
    "codCommissionAddedPaise",
    "codCommissionDueBeforePaise",
    "codCommissionOffsetPaise",
    "netPayoutPaise",
    "codCommissionOutstandingPaise",
    "paidAmountPaise",
  ];
  const result = { ...settlement };
  for (const field of fields) {
    if (Number.isSafeInteger(result[field])) result[field.replace("Paise", "Rupees")] = Number((result[field] / 100).toFixed(2));
  }
  return result;
}

export const generateAdminDailySettlements = async (req, res) => {
  try {
    const result = await generateDailyDriverSettlements(req.body?.date, req.user.userId);
    return res.status(result.failed > 0 || result.blocked > 0 ? 207 : 200).json({
      success: result.failed === 0,
      message: "Daily settlement generation completed. Review each driver's result before confirming payouts.",
      result,
    });
  } catch (error) {
    const status = error instanceof TypeError || error instanceof RangeError ? 400 : 500;
    return res.status(status).json({ success: false, message: error.message || "Unable to generate daily settlements." });
  }
};

export const getAdminDriverSettlements = async (req, res) => {
  try {
    const parsed = parseFilters(req.query);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    const { page, limit, skip } = pagination(req.query);
    const [settlements, total] = await Promise.all([
      DriverSettlement.find(parsed.filter)
        .sort({ settlementDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("driver", "name email phone")
        .populate("paidBy", "name email")
        .populate("generatedBy", "name email")
        .lean(),
      DriverSettlement.countDocuments(parsed.filter),
    ]);
    return res.json({
      success: true,
      settlements: settlements.map(serializeSettlement),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("Admin driver settlements query failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to load driver settlements." });
  }
};

export const getAdminDriverSettlementSummary = async (_req, res) => {
  try {
    const [rows, codRows] = await Promise.all([
      DriverSettlement.aggregate([
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
            netPayoutPaise: { $sum: "$netPayoutPaise" },
            codOffsetPaise: { $sum: "$codCommissionOffsetPaise" },
          },
        },
      ]),
      FinancialLedgerEntry.aggregate([
        { $match: { entryType: "cod_commission_receivable" } },
        { $group: { _id: null, total: { $sum: "$amountPaise" } } },
      ]),
    ]);
    const byStatus = Object.fromEntries(rows.map((row) => [row._id, row]));
    const appliedOffsets = ["paid", "no_payout"].reduce(
      (sum, status) => sum + (byStatus[status]?.codOffsetPaise || 0),
      0
    );
    const totalCodReceivablePaise = codRows[0]?.total || 0;
    const codCommissionOutstandingPaise = Math.max(0, totalCodReceivablePaise - appliedOffsets);
    const summary = {
      pendingPayoutCount: byStatus.pending_payout?.count || 0,
      pendingPayoutPaise: byStatus.pending_payout?.netPayoutPaise || 0,
      paidPayoutCount: byStatus.paid?.count || 0,
      paidPayoutPaise: byStatus.paid?.netPayoutPaise || 0,
      noPayoutCount: byStatus.no_payout?.count || 0,
      codCommissionOutstandingPaise,
    };
    return res.json({
      success: true,
      summary: {
        ...summary,
        ...Object.fromEntries(
          Object.entries(summary)
            .filter(([key]) => key.endsWith("Paise"))
            .map(([key, value]) => [key.replace("Paise", "Rupees"), Number((value / 100).toFixed(2))])
        ),
      },
    });
  } catch (error) {
    console.error("Admin driver settlement summary failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to load settlement summary." });
  }
};

export const getDriverSettlements = async (req, res) => {
  try {
    const parsed = parseFilters(req.query, { driverId: req.user.userId });
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    const { page, limit, skip } = pagination(req.query);
    const [settlements, total] = await Promise.all([
      DriverSettlement.find(parsed.filter)
        .sort({ settlementDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      DriverSettlement.countDocuments(parsed.filter),
    ]);
    return res.json({ success: true, settlements: settlements.map(serializeSettlement), pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    console.error("Driver settlements query failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to load your settlements." });
  }
};

export const getDriverSettlementSummary = async (req, res) => {
  try {
    const driverId = new mongoose.Types.ObjectId(String(req.user.userId));
    const [rows, codRows] = await Promise.all([
      DriverSettlement.aggregate([
        { $match: { driver: driverId } },
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
            netPayoutPaise: { $sum: "$netPayoutPaise" },
            codOffsetPaise: { $sum: "$codCommissionOffsetPaise" },
          },
        },
      ]),
      FinancialLedgerEntry.aggregate([
        { $match: { driver: driverId, entryType: "cod_commission_receivable" } },
        { $group: { _id: null, total: { $sum: "$amountPaise" } } },
      ]),
    ]);
    const byStatus = Object.fromEntries(rows.map((row) => [row._id, row]));
    const appliedOffsets = ["paid", "no_payout"].reduce(
      (sum, status) => sum + (byStatus[status]?.codOffsetPaise || 0),
      0
    );
    const totalCodReceivablePaise = codRows[0]?.total || 0;
    const summary = {
      pendingPayoutCount: byStatus.pending_payout?.count || 0,
      pendingPayoutPaise: byStatus.pending_payout?.netPayoutPaise || 0,
      paidPayoutCount: byStatus.paid?.count || 0,
      paidPayoutPaise: byStatus.paid?.netPayoutPaise || 0,
      noPayoutCount: byStatus.no_payout?.count || 0,
      codCommissionOutstandingPaise: Math.max(0, totalCodReceivablePaise - appliedOffsets),
    };
    return res.json({ success: true, summary: { ...summary, ...Object.fromEntries(Object.entries(summary).filter(([key]) => key.endsWith("Paise")).map(([key, value]) => [key.replace("Paise", "Rupees"), Number((value / 100).toFixed(2))])) } });
  } catch (error) {
    console.error("Driver settlement summary failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to load your settlement summary." });
  }
};

export const confirmAdminDriverSettlement = async (req, res) => {
  try {
    const { settlementId } = req.params;
    if (!mongoose.isValidObjectId(settlementId)) return res.status(400).json({ success: false, message: "A valid settlement ID is required." });
    const payoutReference = String(req.body?.payoutReference || "").trim();
    const payoutMethod = String(req.body?.payoutMethod || "").trim();
    const payoutNote = String(req.body?.payoutNote || "").trim();
    if (payoutReference.length < 4 || payoutReference.length > 100) {
      return res.status(400).json({ success: false, message: "Enter a valid bank UTR or UPI transaction reference (4–100 characters)." });
    }
    if (!["bank_transfer", "upi", "manual"].includes(payoutMethod)) {
      return res.status(400).json({ success: false, message: "Payout method must be bank_transfer, upi, or manual." });
    }
    if (payoutNote.length > 500) return res.status(400).json({ success: false, message: "Payout note cannot exceed 500 characters." });

    const current = await DriverSettlement.findById(settlementId).select("status netPayoutPaise").lean();
    if (!current) return res.status(404).json({ success: false, message: "Settlement not found." });
    if (current.status !== "pending_payout" || !Number.isSafeInteger(current.netPayoutPaise) || current.netPayoutPaise <= 0) {
      return res.status(409).json({ success: false, message: `Settlement cannot be confirmed from its current status (${current.status}).` });
    }

    const settlement = await DriverSettlement.findOneAndUpdate(
      { _id: settlementId, status: "pending_payout", netPayoutPaise: current.netPayoutPaise },
      {
        $set: {
          status: "paid",
          payoutMethod,
          payoutReference,
          payoutNote,
          paidAmountPaise: current.netPayoutPaise,
          paidAt: new Date(),
          paidBy: req.user.userId,
        },
      },
      { new: true, runValidators: true }
    ).populate("driver", "name email phone").lean();

    if (!settlement) {
      return res.status(409).json({ success: false, message: "This settlement was already updated. Refresh the settlement list." });
    }

    return res.json({ success: true, message: "Driver payout confirmation recorded.", settlement: serializeSettlement(settlement) });
  } catch (error) {
    console.error("Confirm driver settlement payout failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to confirm this driver payout." });
  }
};

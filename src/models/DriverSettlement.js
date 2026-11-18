import mongoose from "mongoose";

const paiseValidator = {
  validator: Number.isSafeInteger,
  message: "Settlement amounts must be safe integer paise values.",
};
const optionalPaiseValidator = {
  validator: (value) => value == null || Number.isSafeInteger(value),
  message: "Paid amount must be a safe integer paise value.",
};

const driverSettlementSchema = new mongoose.Schema(
  {
    driver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
      index: true,
    },
    settlementDate: {
      type: String,
      required: true,
      immutable: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    periodStart: { type: Date, required: true, immutable: true },
    periodEnd: { type: Date, required: true, immutable: true },
    currency: { type: String, enum: ["INR"], default: "INR", immutable: true },

    onlinePaymentGrossPaise: { type: Number, required: true, min: 0, validate: paiseValidator, immutable: true },
    driverEarningsGrossPaise: { type: Number, required: true, min: 0, validate: paiseValidator, immutable: true },
    codCommissionAddedPaise: { type: Number, required: true, min: 0, validate: paiseValidator, immutable: true },
    codCommissionDueBeforePaise: { type: Number, required: true, min: 0, validate: paiseValidator, immutable: true },
    codCommissionOffsetPaise: { type: Number, required: true, min: 0, validate: paiseValidator, immutable: true },
    netPayoutPaise: { type: Number, required: true, min: 0, validate: paiseValidator, immutable: true },
    codCommissionOutstandingPaise: { type: Number, required: true, min: 0, validate: paiseValidator, immutable: true },

    onlinePaymentEntryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "FinancialLedgerEntry", immutable: true }],
    driverEarningEntryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "FinancialLedgerEntry", immutable: true }],
    codCommissionEntryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "FinancialLedgerEntry", immutable: true }],

    status: {
      type: String,
      enum: ["pending_payout", "paid", "no_payout"],
      required: true,
      index: true,
    },
    payoutMethod: { type: String, enum: ["bank_transfer", "upi", "manual"], default: null },
    payoutReference: { type: String, trim: true, maxlength: 100, default: "" },
    payoutNote: { type: String, trim: true, maxlength: 500, default: "" },
    paidAmountPaise: { type: Number, min: 0, validate: optionalPaiseValidator, default: null },
    paidAt: { type: Date, default: null },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, immutable: true },
    generatedAt: { type: Date, default: Date.now, immutable: true },
  },
  { timestamps: true, versionKey: false }
);

driverSettlementSchema.index({ driver: 1, settlementDate: 1 }, { unique: true });
// A driver can have only one unsettled cash payout at a time. This prevents
// concurrent daily generation from creating overlapping pending payouts.
driverSettlementSchema.index(
  { driver: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "pending_payout" },
    name: "one_pending_payout_per_driver",
  }
);
driverSettlementSchema.index({ settlementDate: -1, status: 1 });

const DriverSettlement = mongoose.model("DriverSettlement", driverSettlementSchema);
export default DriverSettlement;

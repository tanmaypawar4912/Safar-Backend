import mongoose from "mongoose";

export const FINANCIAL_LEDGER_ENTRY_TYPES = Object.freeze([
  "platform_commission_earned",
  "driver_earning_payable",
  "driver_earning_retained_cod",
  "online_payment_received",
  "cod_cash_collected_by_driver",
  "cod_commission_receivable",
]);

const financialLedgerEntrySchema = new mongoose.Schema(
  {
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      trim: true,
      maxlength: 180,
    },
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      immutable: true,
      index: true,
    },
    bookingCode: {
      type: String,
      required: true,
      immutable: true,
      trim: true,
      maxlength: 50,
    },
    driver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
      index: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    vehicle: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vehicle",
      required: true,
      immutable: true,
    },
    vehicleName: {
      type: String,
      default: "",
      immutable: true,
      maxlength: 80,
    },
    entryType: {
      type: String,
      required: true,
      enum: FINANCIAL_LEDGER_ENTRY_TYPES,
      immutable: true,
      index: true,
    },
    amountPaise: {
      type: Number,
      required: true,
      min: 0,
      immutable: true,
      validate: {
        validator: Number.isSafeInteger,
        message: "Ledger amounts must be safe integer paise values.",
      },
    },
    currency: {
      type: String,
      enum: ["INR"],
      default: "INR",
      immutable: true,
    },
    paymentMethod: {
      type: String,
      enum: ["online", "cash_on_delivery"],
      required: true,
      immutable: true,
    },
    source: {
      type: String,
      enum: ["delivery_completion", "razorpay_capture", "cod_collection"],
      required: true,
      immutable: true,
    },
    sourceReference: {
      type: String,
      default: "",
      immutable: true,
      maxlength: 120,
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      immutable: true,
    },
    occurredAt: {
      type: Date,
      required: true,
      immutable: true,
      index: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      immutable: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

financialLedgerEntrySchema.index({ driver: 1, occurredAt: -1 });
financialLedgerEntrySchema.index({ entryType: 1, occurredAt: -1 });
financialLedgerEntrySchema.index({ booking: 1, occurredAt: 1 });

const FinancialLedgerEntry = mongoose.model(
  "FinancialLedgerEntry",
  financialLedgerEntrySchema
);

export default FinancialLedgerEntry;

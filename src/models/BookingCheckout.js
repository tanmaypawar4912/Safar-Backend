import mongoose from "mongoose";

const bookingCheckoutSchema = new mongoose.Schema({
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  idempotencyKey: { type: String, required: true, trim: true, maxlength: 100 },
  requestHash: { type: String, required: true, minlength: 64, maxlength: 64 },
  bookingDraft: { type: mongoose.Schema.Types.Mixed, required: true },
  quoteSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  commissionSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  amountPaise: { type: Number, required: true, min: 1 },
  currency: { type: String, enum: ["INR"], default: "INR" },
  razorpayOrderId: { type: String, default: null },
  razorpayPaymentId: { type: String, default: null },
  signatureVerified: { type: Boolean, default: false },
  status: { type: String, enum: ["pending", "paid", "consumed", "failed", "expired"], default: "pending", index: true },
  expiresAt: { type: Date, required: true, index: true },
  paidAt: { type: Date, default: null },
  booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null },
}, { timestamps: true });

bookingCheckoutSchema.index({ customer: 1, idempotencyKey: 1 }, { unique: true });
bookingCheckoutSchema.index({ razorpayOrderId: 1 }, { unique: true, sparse: true });

export default mongoose.model("BookingCheckout", bookingCheckoutSchema);

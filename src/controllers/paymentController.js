import crypto from "node:crypto";
import Booking from "../models/Booking.js";
import OperationalSetting from "../models/OperationalSetting.js";
import { reconcileBookingLedger } from "../services/financialLedgerService.js";

const SETTINGS_KEY = "default";
async function settingsDoc() { return (await OperationalSetting.findOne({ key: SETTINGS_KEY })) || await OperationalSetting.create({ key: SETTINGS_KEY, codMaxDistanceKm: Number(process.env.COD_MAX_DISTANCE_KM || 25) }); }
function razorpayConfigured() { return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET); }

export const getPaymentSettings = async (_req, res) => {
  try {
    const settings = await settingsDoc();
    res.json({ success: true, settings: { codMaxDistanceKm: settings.codMaxDistanceKm, onlinePaymentsEnabled: razorpayConfigured(), razorpayKeyId: process.env.RAZORPAY_KEY_ID || "" } });
  } catch { res.status(500).json({ success: false, message: "Unable to load payment settings." }); }
};

export const updatePaymentSettings = async (req, res) => {
  const value = Number(req.body.codMaxDistanceKm);
  if (!Number.isFinite(value) || value < 0 || value > 1000) return res.status(400).json({ success: false, message: "COD distance must be between 0 and 1000 km." });
  try {
    const settings = await OperationalSetting.findOneAndUpdate({ key: SETTINGS_KEY }, { $set: { codMaxDistanceKm: value, updatedBy: req.user.userId } }, { upsert: true, returnDocument: "after", runValidators: true });
    res.json({ success: true, message: "Payment policy updated.", settings: { codMaxDistanceKm: settings.codMaxDistanceKm, onlinePaymentsEnabled: razorpayConfigured(), razorpayKeyId: process.env.RAZORPAY_KEY_ID || "" } });
  } catch { res.status(500).json({ success: false, message: "Unable to save payment settings." }); }
};

export const createPaymentOrder = async (req, res) => {
  try {
    if (!razorpayConfigured()) return res.status(503).json({ success: false, message: "Online payment is not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to backend/.env." });
    const booking = await Booking.findOne({ _id: req.params.bookingId, customer: req.user.userId });
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found." });
    if (booking.status !== "delivered") return res.status(409).json({ success: false, message: "Payment is available after the delivery is completed." });
    if (booking.paymentMethod !== "online") return res.status(409).json({ success: false, message: "This booking was selected for cash on delivery." });
    if (booking.paymentStatus === "paid") return res.status(409).json({ success: false, message: "This booking is already paid." });
    const amount = Math.round(Number(booking.fare.finalFare ?? booking.fare.estimatedFare) * 100);
    if (!Number.isSafeInteger(amount) || amount <= 0) return res.status(409).json({ success: false, message: "The final booking amount is invalid. Contact support before making a payment." });
    const authorization = `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64")}`;

    // Reuse an unpaid Razorpay order on retry. Orders support multiple payment
    // attempts, and reusing the stored order prevents abandoned checkout retries
    // from creating several payable gateway orders for one LogiGo booking.
    if (booking.paymentStatus === "pending" && booking.payment?.gatewayOrderId) {
      const existingOrderResponse = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(booking.payment.gatewayOrderId)}`, {
        method: "GET",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
      });
      const existingOrder = await existingOrderResponse.json().catch(() => ({}));
      if (!existingOrderResponse.ok) {
        console.error("Razorpay existing-order lookup failed:", existingOrder?.error?.description || existingOrderResponse.status);
        return res.status(502).json({ success: false, message: "Unable to check the existing payment attempt. Please retry shortly." });
      }
      if (existingOrder.amount !== amount || existingOrder.currency !== "INR") {
        return res.status(409).json({ success: false, message: "The existing payment order does not match this booking amount. Contact support before retrying." });
      }
      if (["created", "attempted"].includes(existingOrder.status)) {
        return res.json({ success: true, order: { id: existingOrder.id, amount: existingOrder.amount, currency: existingOrder.currency }, keyId: process.env.RAZORPAY_KEY_ID, bookingCode: booking.bookingCode, customerName: req.user.name || "LogiGo Customer" });
      }
      if (existingOrder.status === "paid") {
        const paymentsResponse = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(existingOrder.id)}/payments`, {
          method: "GET",
          headers: { Authorization: authorization, "Content-Type": "application/json" },
        });
        const paymentsResult = await paymentsResponse.json().catch(() => ({}));
        if (!paymentsResponse.ok) {
          console.error("Razorpay order-payment lookup failed:", paymentsResult?.error?.description || paymentsResponse.status);
          return res.status(502).json({ success: false, message: "The gateway reports a completed order, but payment details could not be retrieved. Please refresh shortly." });
        }
        const capturedPayment = (paymentsResult.items || []).find((item) => item.status === "captured" && item.amount === amount && item.currency === "INR");
        if (capturedPayment) {
          booking.paymentStatus = "paid";
          booking.payment = { ...(booking.payment?.toObject?.() || booking.payment || {}), gatewayPaymentId: capturedPayment.id, amount: amount / 100, currency: "INR", paidAt: new Date() };
          await booking.save();
          await reconcileBookingLedger(booking, req.user.userId);
          return res.json({ success: true, alreadyPaid: true, message: "This booking has already been paid.", paymentStatus: "paid" });
        }
        return res.status(409).json({ success: false, message: "The payment order is complete but no captured payment was found. Contact support before retrying." });
      }
      return res.status(409).json({ success: false, message: "The existing payment order cannot be reused. Contact support before retrying." });
    }

    const response = await fetch("https://api.razorpay.com/v1/orders", { method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: JSON.stringify({ amount, currency: "INR", receipt: String(booking.bookingCode).slice(0, 40), notes: { bookingId: String(booking._id), bookingCode: booking.bookingCode } }) });
    const order = await response.json().catch(() => ({}));
    if (!response.ok) { console.error("Razorpay order error:", order?.error?.description || response.status); return res.status(502).json({ success: false, message: "Payment gateway could not create an order. Try again later." }); }
    booking.paymentStatus = "pending";
    booking.payment = { ...(booking.payment?.toObject?.() || booking.payment || {}), gatewayOrderId: order.id, amount: amount / 100, currency: "INR", initiatedAt: new Date() };
    await booking.save();
    res.json({ success: true, order: { id: order.id, amount: order.amount, currency: order.currency }, keyId: process.env.RAZORPAY_KEY_ID, bookingCode: booking.bookingCode, customerName: req.user.name || "LogiGo Customer" });
  } catch (error) { console.error("Create payment order error:", error.message); res.status(500).json({ success: false, message: "Unable to start payment." }); }
};

export const verifyPayment = async (req, res) => {
  try {
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body;
    if (!orderId || !paymentId || !signature) return res.status(400).json({ success: false, message: "Payment verification fields are missing." });
    const booking = await Booking.findOne({ _id: req.params.bookingId, customer: req.user.userId });
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found." });
    if (booking.status !== "delivered" || booking.paymentMethod !== "online") return res.status(409).json({ success: false, message: "This booking is not eligible for online payment." });
    if (booking.payment?.gatewayOrderId !== orderId) return res.status(400).json({ success: false, message: "Payment order does not match this booking." });
    if (!razorpayConfigured()) return res.status(503).json({ success: false, message: "Online payment verification is not configured." });

    // Make verification idempotent for a checkout callback that is retried
    // after the database write succeeded but the browser missed the response.
    if (booking.paymentStatus === "paid" && booking.payment?.gatewayPaymentId === paymentId) {
      await reconcileBookingLedger(booking, req.user.userId);
      return res.json({ success: true, message: "Payment was already verified.", bookingId: booking._id, paymentStatus: booking.paymentStatus });
    }
    if (booking.paymentStatus === "paid") return res.status(409).json({ success: false, message: "This booking has already been paid." });

    const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(400).json({ success: false, message: "Payment signature verification failed." });

    // A valid checkout signature proves the callback is authentic, but it does
    // not by itself prove that the payment has been captured. Confirm the
    // payment status, order, amount and currency directly with Razorpay.
    const gatewayResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
    });
    const gatewayPayment = await gatewayResponse.json().catch(() => ({}));
    if (!gatewayResponse.ok) {
      console.error("Razorpay payment lookup failed:", gatewayPayment?.error?.description || gatewayResponse.status);
      return res.status(502).json({ success: false, message: "Unable to confirm payment status with the payment gateway. Please refresh and try again." });
    }

    const expectedAmount = Math.round(Number(booking.fare.finalFare ?? booking.fare.estimatedFare) * 100);
    if (gatewayPayment.order_id !== orderId || gatewayPayment.order_id !== booking.payment?.gatewayOrderId) {
      return res.status(400).json({ success: false, message: "Payment does not belong to this booking order." });
    }
    if (gatewayPayment.amount !== expectedAmount || gatewayPayment.currency !== "INR") {
      return res.status(400).json({ success: false, message: "Payment amount or currency does not match this booking." });
    }
    if (gatewayPayment.status !== "captured") {
      return res.status(409).json({ success: false, message: gatewayPayment.status === "authorized" ? "Payment is authorised but not yet captured. Please wait for confirmation or contact support." : "Payment has not been captured. Please retry the payment." });
    }

    booking.paymentStatus = "paid";
    booking.payment = { ...(booking.payment?.toObject?.() || booking.payment || {}), gatewayPaymentId: paymentId, signatureVerified: true, paidAt: new Date() };
    await booking.save();
    await reconcileBookingLedger(booking, req.user.userId);
    res.json({ success: true, message: "Payment captured, verified and recorded.", bookingId: booking._id, paymentStatus: booking.paymentStatus });
  } catch (error) { console.error("Verify payment error:", error.message); res.status(500).json({ success: false, message: "Unable to verify payment." }); }
};

export const markCashCollected = async (req, res) => {
  try {
    const booking = await Booking.findOne({ _id: req.params.bookingId, driver: req.user.userId });
    if (!booking) return res.status(404).json({ success: false, message: "Assigned booking not found." });
    if (booking.status !== "delivered" || booking.paymentMethod !== "cash_on_delivery") {
      return res.status(409).json({ success: false, message: "Only completed cash-on-delivery bookings can be settled." });
    }

    if (booking.paymentStatus === "paid") {
      await reconcileBookingLedger(booking, req.user.userId);
      return res.json({ success: true, alreadyRecorded: true, message: "Cash collection was already recorded.", paymentStatus: "paid" });
    }

    booking.paymentStatus = "paid";
    booking.payment = {
      ...(booking.payment?.toObject?.() || booking.payment || {}),
      cashCollectedBy: req.user.userId,
      paidAt: new Date(),
    };
    await booking.save();
    await reconcileBookingLedger(booking, req.user.userId);
    res.json({ success: true, message: "Cash collection recorded.", paymentStatus: booking.paymentStatus });
  } catch (error) {
    console.error("Record COD collection error:", error.message);
    res.status(500).json({ success: false, message: "Unable to record cash collection." });
  }
};

export const getAdminPayments = async (_req, res) => {
  try {
    const bookings = await Booking.find({ status: "delivered" }).sort({ updatedAt: -1 }).limit(200).populate("customer", "name email phone").populate("driver", "name phone").populate("vehicle", "name").lean();
    res.json({ success: true, bookings: bookings.map((b) => ({ ...b, payableAmount: b.fare?.finalFare ?? b.fare?.estimatedFare })) });
  } catch { res.status(500).json({ success: false, message: "Unable to load payment records." }); }
};

export const adminSettleCash = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.bookingId);
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found." });
    if (booking.status !== "delivered" || booking.paymentMethod !== "cash_on_delivery") {
      return res.status(409).json({ success: false, message: "Only delivered COD bookings can be settled." });
    }

    const alreadyRecorded = booking.paymentStatus === "paid";
    if (!alreadyRecorded) {
      booking.paymentStatus = "paid";
      booking.payment = {
        ...(booking.payment?.toObject?.() || booking.payment || {}),
        cashCollectedBy: req.user.userId,
        paidAt: new Date(),
      };
      await booking.save();
    }

    await reconcileBookingLedger(booking, req.user.userId);
    res.json({ success: true, message: "COD payment marked as collected.", alreadyRecorded });
  } catch (error) {
    console.error("Admin COD settlement error:", error.message);
    res.status(500).json({ success: false, message: "Unable to settle COD payment." });
  }
};

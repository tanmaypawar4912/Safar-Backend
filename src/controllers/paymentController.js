import crypto from "node:crypto";
import Booking from "../models/Booking.js";
import BookingCheckout from "../models/BookingCheckout.js";
import OperationalSetting from "../models/OperationalSetting.js";
import VehicleCommissionRule from "../models/VehicleCommissionRule.js";
import DriverActivity from "../models/DriverActivity.js";
import { calculateFareEstimate } from "../services/fareService.js";
import { createBookingSchema } from "../validators/bookingValidator.js";
import { createBookingFromPaidCheckout } from "./bookingController.js";
import { reconcileBookingLedger } from "../services/financialLedgerService.js";
import { isCapturedRazorpayPayment, verifyRazorpayWebhookSignature } from "../utils/razorpayWebhookSecurity.js";

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

export const createBookingCheckoutOrder = async (req, res) => {
  try {
    if (!razorpayConfigured()) {
      return res.status(503).json({ success: false, message: "Online payment is not configured. Please contact support or choose COD." });
    }

    const parsed = createBookingSchema.safeParse({ ...req.body, paymentMethod: "online" });
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || "Booking details are invalid." });
    }

    const idempotencyKey = String(req.body.idempotencyKey || "").trim();
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(idempotencyKey)) {
      return res.status(400).json({ success: false, message: "A valid checkout request key is required. Please retry checkout." });
    }

    const draft = parsed.data;
    const requestHash = crypto.createHash("sha256").update(JSON.stringify(draft)).digest("hex");
    const existing = await BookingCheckout.findOne({ customer: req.user.userId, idempotencyKey });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return res.status(409).json({ success: false, message: "This checkout key was already used for different booking details. Start checkout again." });
      }
      if (existing.status === "consumed" && existing.booking) {
        const booking = await Booking.findOne({ _id: existing.booking, customer: req.user.userId }).select("_id bookingCode status").lean();
        if (booking) return res.json({ success: true, alreadyCompleted: true, booking });
      }
      if (existing.status === "pending" && existing.razorpayOrderId && existing.expiresAt > new Date()) {
        return res.json({ success: true, checkoutIntentId: existing._id, keyId: process.env.RAZORPAY_KEY_ID, order: { id: existing.razorpayOrderId, amount: existing.amountPaise, currency: existing.currency }, amountRupees: existing.amountPaise / 100 });
      }
      if (existing.status === "paid") {
        return res.status(409).json({ success: false, message: "Payment has already been captured and booking confirmation is being completed. Refresh your orders shortly." });
      }
      return res.status(409).json({ success: false, message: "This checkout has expired or failed. Start a new checkout attempt." });
    }

    // A customer may retry after dismissing a failed Razorpay modal or after a
    // successful capture whose browser callback was lost. Recover the same
    // checkout for an identical server-validated draft instead of creating a
    // second payable order.
    const matchingCheckout = await BookingCheckout.findOne({
      customer: req.user.userId,
      requestHash,
      status: { $in: ["pending", "paid", "consumed"] },
    }).sort({ createdAt: -1 });
    if (matchingCheckout?.status === "consumed" && matchingCheckout.booking) {
      const booking = await Booking.findOne({ _id: matchingCheckout.booking, customer: req.user.userId }).select("_id bookingCode status").lean();
      if (booking) return res.json({ success: true, alreadyCompleted: true, booking });
    }
    if (matchingCheckout?.status === "paid") {
      const recovered = await createBookingFromPaidCheckout(matchingCheckout, {
        paymentId: matchingCheckout.razorpayPaymentId,
        paidAt: matchingCheckout.paidAt || new Date(),
      });
      await BookingCheckout.updateOne(
        { _id: matchingCheckout._id, status: { $in: ["paid", "consumed"] } },
        { $set: { status: "consumed", booking: recovered.booking._id } }
      );
      return res.json({ success: true, alreadyCompleted: true, booking: { _id: recovered.booking._id, bookingCode: recovered.booking.bookingCode, status: recovered.booking.status } });
    }
    if (matchingCheckout?.status === "pending" && matchingCheckout.razorpayOrderId && matchingCheckout.expiresAt > new Date()) {
      return res.json({
        success: true,
        checkoutIntentId: matchingCheckout._id,
        keyId: process.env.RAZORPAY_KEY_ID,
        order: { id: matchingCheckout.razorpayOrderId, amount: matchingCheckout.amountPaise, currency: matchingCheckout.currency },
        amountRupees: matchingCheckout.amountPaise / 100,
        reusedPendingCheckout: true,
      });
    }

    const estimate = await calculateFareEstimate(draft);
    const commissionRule = await VehicleCommissionRule.findOne({ vehicle: estimate.vehicle.id })
      .select("_id commissionRateBps updatedAt")
      .lean();
    if (!commissionRule || !Number.isInteger(commissionRule.commissionRateBps) || commissionRule.commissionRateBps < 0 || commissionRule.commissionRateBps > 5000) {
      return res.status(503).json({ success: false, message: "Commission settings are not configured for this vehicle. Please contact support." });
    }

    const amountPaise = Math.round(Number(estimate.fare.estimatedFare) * 100);
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
      return res.status(409).json({ success: false, message: "The calculated booking amount is invalid. Please contact support." });
    }

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    let checkoutIntent;
    try {
      checkoutIntent = await BookingCheckout.create({
        customer: req.user.userId,
        idempotencyKey,
        requestHash,
        bookingDraft: {
          pickupAddress: draft.pickupAddress,
          dropAddress: draft.dropAddress,
          vehicleId: draft.vehicleId,
          weightKg: draft.weightKg,
          packageDescription: draft.packageDescription,
          specialInstructions: draft.specialInstructions || "",
        },
        quoteSnapshot: estimate,
        commissionSnapshot: {
          ruleId: commissionRule._id,
          vehicleName: estimate.vehicle.name,
          commissionRateBps: commissionRule.commissionRateBps,
          ruleUpdatedAt: commissionRule.updatedAt || null,
          capturedAt: new Date(),
        },
        amountPaise,
        currency: "INR",
        status: "pending",
        expiresAt,
      });
    } catch (error) {
      if (error?.code === 11000) {
        return res.status(409).json({ success: false, message: "This checkout request is already being processed. Please refresh and retry." });
      }
      throw error;
    }

    const authorization = `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64")}`;
    const gatewayResponse = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: amountPaise,
        currency: "INR",
        receipt: `lg-${String(checkoutIntent._id).slice(-24)}`.slice(0, 40),
        notes: { checkoutIntentId: String(checkoutIntent._id), customerId: String(req.user.userId) },
      }),
    });
    const gatewayOrder = await gatewayResponse.json().catch(() => ({}));
    if (!gatewayResponse.ok || !gatewayOrder.id || gatewayOrder.amount !== amountPaise || gatewayOrder.currency !== "INR") {
      await BookingCheckout.updateOne({ _id: checkoutIntent._id, status: "pending" }, { $set: { status: "failed" } });
      console.error("Razorpay upfront checkout order failed:", gatewayOrder?.error?.description || gatewayResponse.status);
      return res.status(502).json({ success: false, message: "The payment gateway could not start checkout. No booking has been placed. Please try again." });
    }

    await BookingCheckout.updateOne(
      { _id: checkoutIntent._id, status: "pending" },
      { $set: { razorpayOrderId: gatewayOrder.id } }
    );

    return res.status(201).json({
      success: true,
      checkoutIntentId: checkoutIntent._id,
      keyId: process.env.RAZORPAY_KEY_ID,
      order: { id: gatewayOrder.id, amount: gatewayOrder.amount, currency: gatewayOrder.currency },
      amountRupees: amountPaise / 100,
    });
  } catch (error) {
    console.error("Create upfront booking checkout error:", error.message);
    return res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : "Unable to start secure checkout. No booking has been placed." });
  }
};

export const verifyBookingCheckoutPayment = async (req, res) => {
  try {
    const { checkoutIntentId, razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body;
    if (!checkoutIntentId || !orderId || !paymentId || !signature) {
      return res.status(400).json({ success: false, message: "Checkout verification details are incomplete." });
    }
    if (!razorpayConfigured()) return res.status(503).json({ success: false, message: "Online payment verification is not configured." });

    let checkout = await BookingCheckout.findOne({ _id: checkoutIntentId, customer: req.user.userId });
    if (!checkout) return res.status(404).json({ success: false, message: "Checkout session not found." });
    if (checkout.razorpayOrderId !== orderId) return res.status(400).json({ success: false, message: "Payment order does not match this checkout session." });

    if (checkout.status === "consumed" && checkout.booking) {
      if (checkout.razorpayPaymentId !== paymentId) return res.status(409).json({ success: false, message: "This checkout was already completed with a different payment." });
      const existingBooking = await Booking.findOne({ _id: checkout.booking, customer: req.user.userId }).select("_id bookingCode status").lean();
      if (existingBooking) return res.json({ success: true, alreadyCompleted: true, booking: existingBooking });
    }

    if (checkout.status !== "paid" && checkout.status !== "pending") {
      return res.status(409).json({ success: false, message: "This checkout is no longer payable. Start a new booking checkout." });
    }
    if (checkout.status === "pending" && checkout.expiresAt <= new Date()) {
      await BookingCheckout.updateOne({ _id: checkout._id, status: "pending" }, { $set: { status: "expired" } });
      return res.status(410).json({ success: false, message: "Checkout expired. No booking was placed; please start again." });
    }

    if (checkout.status === "pending") {
      const expectedSignature = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(`${orderId}|${paymentId}`).digest("hex");
      const expectedBuffer = Buffer.from(expectedSignature);
      const suppliedBuffer = Buffer.from(String(signature));
      if (expectedBuffer.length !== suppliedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
        return res.status(400).json({ success: false, message: "Payment signature verification failed." });
      }
    } else if (checkout.razorpayPaymentId !== paymentId) {
      return res.status(409).json({ success: false, message: "A different payment was already verified for this checkout." });
    }

    if (checkout.status === "pending") {
      const gatewayResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
        method: "GET",
        headers: { Authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64")}`, "Content-Type": "application/json" },
      });
      const gatewayPayment = await gatewayResponse.json().catch(() => ({}));
      if (!gatewayResponse.ok) {
        console.error("Razorpay upfront payment lookup failed:", gatewayPayment?.error?.description || gatewayResponse.status);
        return res.status(502).json({ success: false, message: "Unable to confirm payment with Razorpay. Retry verification; no booking is placed until confirmation succeeds." });
      }
      if (gatewayPayment.order_id !== orderId || gatewayPayment.amount !== checkout.amountPaise || gatewayPayment.currency !== "INR") {
        return res.status(400).json({ success: false, message: "Payment order, amount or currency does not match this checkout." });
      }
      if (gatewayPayment.status !== "captured") {
        return res.status(409).json({ success: false, message: gatewayPayment.status === "authorized" ? "Payment is authorised but not yet captured. The booking has not been placed yet." : "Payment has not been captured. Retry payment; the booking has not been placed." });
      }

      const paidAt = gatewayPayment.created_at ? new Date(gatewayPayment.created_at * 1000) : new Date();
      const updated = await BookingCheckout.findOneAndUpdate(
        { _id: checkout._id, status: "pending", razorpayOrderId: orderId },
        { $set: { status: "paid", razorpayPaymentId: paymentId, signatureVerified: true, paidAt } },
        { new: true }
      );
      checkout = updated || await BookingCheckout.findById(checkout._id);
      if (!checkout || !["paid", "consumed"].includes(checkout.status) || checkout.razorpayPaymentId !== paymentId) {
        return res.status(409).json({ success: false, message: "Checkout state changed during verification. Refresh and retry." });
      }
    }

    const result = await createBookingFromPaidCheckout(checkout, {
      paymentId,
      paidAt: checkout.paidAt || new Date(),
    });
    await BookingCheckout.updateOne(
      { _id: checkout._id, status: { $in: ["paid", "consumed"] } },
      { $set: { status: "consumed", booking: result.booking._id } }
    );

    return res.json({ success: true, message: "Payment verified. Your booking has now been placed.", booking: result.booking });
  } catch (error) {
    console.error("Verify upfront booking payment error:", error.message);
    return res.status(500).json({ success: false, message: "Payment could not be finalized into a booking yet. Retry verification or contact support with your Razorpay payment ID." });
  }
};


export const handleRazorpayWebhook = async (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.get("x-razorpay-signature");
  if (!webhookSecret) {
    return res.status(503).json({ success: false, message: "Razorpay webhook verification is not configured." });
  }
  if (!verifyRazorpayWebhookSignature(req.body, signature, webhookSecret)) {
    return res.status(401).json({ success: false, message: "Invalid Razorpay webhook signature." });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).json({ success: false, message: "Invalid webhook JSON payload." });
  }

  // Other Razorpay events are acknowledged but do not change payment state.
  if (event.event !== "payment.captured") {
    return res.status(200).json({ success: true, received: true, ignored: true });
  }

  const payment = event.payload?.payment?.entity;
  if (!payment?.id || !payment?.order_id) {
    return res.status(400).json({ success: false, message: "Captured payment details are missing." });
  }

  try {
    const checkout = await BookingCheckout.findOne({ razorpayOrderId: payment.order_id });
    if (checkout) {
      if (!isCapturedRazorpayPayment(payment, { orderId: checkout.razorpayOrderId, amountPaise: checkout.amountPaise, currency: checkout.currency })) {
        console.error("Razorpay webhook payment mismatch for checkout:", String(checkout._id));
        return res.status(400).json({ success: false, message: "Captured payment does not match the checkout amount or currency." });
      }

      if (checkout.status === "consumed" && checkout.booking && checkout.razorpayPaymentId === payment.id) {
        return res.status(200).json({ success: true, received: true, alreadyProcessed: true });
      }
      if (["paid", "consumed"].includes(checkout.status) && checkout.razorpayPaymentId && checkout.razorpayPaymentId !== payment.id) {
        console.error("Razorpay webhook reported a second captured payment for checkout:", String(checkout._id));
        return res.status(200).json({ success: true, received: true, manualReviewRequired: true });
      }
      if (!["pending", "expired", "paid", "consumed"].includes(checkout.status)) {
        return res.status(200).json({ success: true, received: true, ignored: true });
      }

      const paidAt = payment.created_at ? new Date(payment.created_at * 1000) : new Date();
      if (checkout.status === "pending" || checkout.status === "expired") {
        await BookingCheckout.updateOne(
          { _id: checkout._id, status: { $in: ["pending", "expired"] } },
          { $set: { status: "paid", razorpayPaymentId: payment.id, signatureVerified: true, paidAt } }
        );
      }

      const paidCheckout = await BookingCheckout.findById(checkout._id);
      if (!paidCheckout || paidCheckout.razorpayPaymentId !== payment.id) {
        return res.status(200).json({ success: true, received: true, manualReviewRequired: true });
      }
      const result = await createBookingFromPaidCheckout(paidCheckout, { paymentId: payment.id, paidAt: paidCheckout.paidAt || paidAt });
      await BookingCheckout.updateOne(
        { _id: paidCheckout._id, status: { $in: ["paid", "consumed"] } },
        { $set: { status: "consumed", booking: result.booking._id } }
      );
      return res.status(200).json({ success: true, received: true, bookingCreated: true });
    }

    // Backward-compatible support for legacy delivered bookings that already
    // had a booking before the customer paid through the older payment flow.
    const legacyBooking = await Booking.findOne({ paymentMethod: "online", "payment.gatewayOrderId": payment.order_id });
    if (!legacyBooking) return res.status(200).json({ success: true, received: true, ignored: true });
    const legacyAmountPaise = Math.round(Number(legacyBooking.fare?.finalFare ?? legacyBooking.fare?.estimatedFare) * 100);
    if (!isCapturedRazorpayPayment(payment, { orderId: legacyBooking.payment.gatewayOrderId, amountPaise: legacyAmountPaise, currency: "INR" })) {
      return res.status(400).json({ success: false, message: "Captured payment does not match the legacy booking amount or currency." });
    }
    if (legacyBooking.paymentStatus !== "paid") {
      legacyBooking.paymentStatus = "paid";
      legacyBooking.payment = { ...(legacyBooking.payment?.toObject?.() || legacyBooking.payment || {}), gatewayPaymentId: payment.id, amount: payment.amount / 100, currency: "INR", signatureVerified: true, paidAt: payment.created_at ? new Date(payment.created_at * 1000) : new Date() };
      await legacyBooking.save();
      if (legacyBooking.status === "delivered") await reconcileBookingLedger(legacyBooking, legacyBooking.customer);
    }
    return res.status(200).json({ success: true, received: true, legacyBookingUpdated: true });
  } catch (error) {
    console.error("Razorpay webhook processing error:", error.message);
    return res.status(500).json({ success: false, message: "Webhook processing failed. Razorpay can retry this event." });
  }
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
    const now = new Date();
    const booking = await Booking.findOneAndUpdate(
      {
        _id: req.params.bookingId,
        driver: req.user.userId,
        status: "delivered",
        paymentMethod: "cash_on_delivery",
        paymentStatus: { $ne: "paid" },
      },
      {
        $set: {
          paymentStatus: "paid",
          "payment.cashCollectedBy": req.user.userId,
          "payment.cashCollectedAt": now,
          "payment.paidAt": now,
        },
      },
      { new: true, runValidators: true }
    );

    if (!booking) {
      const current = await Booking.findOne({ _id: req.params.bookingId, driver: req.user.userId });
      if (!current) return res.status(404).json({ success: false, message: "Assigned booking not found." });
      if (current.status !== "delivered" || current.paymentMethod !== "cash_on_delivery") {
        return res.status(409).json({ success: false, message: "Only delivered cash-on-delivery bookings can be marked as collected." });
      }
      if (current.paymentStatus === "paid" && String(current.payment?.cashCollectedBy || "") === String(req.user.userId)) {
        const financialLedger = await reconcileBookingLedger(current, req.user.userId);
        return res.json({ success: true, alreadyRecorded: true, message: "Your COD collection was already recorded.", paymentStatus: "paid", cashCollectedAt: current.payment?.cashCollectedAt || current.payment?.paidAt, financialLedger });
      }
      return res.status(409).json({ success: false, message: "This COD payment has already been recorded by another authorized action. Contact admin before changing it." });
    }

    try {
      await DriverActivity.create({
        driver: req.user.userId,
        actor: req.user.userId,
        action: "cod_cash_collected",
        message: `Driver confirmed COD cash collection for ${booking.bookingCode}`,
        metadata: { bookingId: booking._id, bookingCode: booking.bookingCode, amount: booking.fare?.finalFare ?? booking.fare?.estimatedFare, cashCollectedAt: now },
      });
    } catch (activityError) {
      console.error("COD collection activity log failed:", activityError.message);
    }

    const financialLedger = await reconcileBookingLedger(booking, req.user.userId);
    res.json({ success: true, message: "Cash collection recorded. Admin can now verify this COD record.", paymentStatus: "paid", cashCollectedAt: now, financialLedger });
  } catch (error) {
    console.error("Record COD collection error:", error.message);
    res.status(500).json({ success: false, message: "Unable to record cash collection. Refresh the delivery history and retry." });
  }
};

export const getAdminPayments = async (_req, res) => {
  try {
    const bookings = await Booking.find({
      $or: [
        { status: "delivered" },
        { paymentMethod: "online", paymentStatus: "paid" },
      ],
    }).sort({ updatedAt: -1 }).limit(200).populate("customer", "name email phone").populate("driver", "name phone").populate("vehicle", "name").populate("payment.cashCollectedBy", "name email").populate("payment.cashCollectionVerifiedBy", "name email").lean();
    res.json({ success: true, bookings: bookings.map((b) => ({ ...b, payableAmount: b.fare?.finalFare ?? b.fare?.estimatedFare })) });
  } catch { res.status(500).json({ success: false, message: "Unable to load payment records." }); }
};

export const adminSettleCash = async (req, res) => {
  try {
    const booking = await Booking.findOne({
      _id: req.params.bookingId,
      status: "delivered",
      paymentMethod: "cash_on_delivery",
    });
    if (!booking) return res.status(404).json({ success: false, message: "Delivered COD booking not found." });
    if (booking.paymentStatus !== "paid" || !booking.payment?.cashCollectedBy || !booking.payment?.cashCollectedAt) {
      return res.status(409).json({ success: false, message: "The driver has not confirmed cash collection yet. Admin cannot mark uncollected COD as received." });
    }
    if (booking.payment.cashCollectionVerifiedAt) {
      return res.json({ success: true, alreadyVerified: true, message: "Driver-reported COD collection was already verified." });
    }

    const now = new Date();
    const updated = await Booking.findOneAndUpdate(
      {
        _id: booking._id,
        status: "delivered",
        paymentMethod: "cash_on_delivery",
        paymentStatus: "paid",
        "payment.cashCollectedBy": booking.payment.cashCollectedBy,
        "payment.cashCollectionVerifiedAt": null,
      },
      {
        $set: {
          "payment.cashCollectionVerifiedBy": req.user.userId,
          "payment.cashCollectionVerifiedAt": now,
          "payment.cashCollectionVerificationNote": String(req.body?.verificationNote || "").trim().slice(0, 500),
        },
      },
      { new: true, runValidators: true }
    );

    if (!updated) {
      const latest = await Booking.findById(booking._id).lean();
      if (latest?.payment?.cashCollectionVerifiedAt) {
        return res.json({ success: true, alreadyVerified: true, message: "COD collection was already verified by another admin." });
      }
      return res.status(409).json({ success: false, message: "COD collection changed while being verified. Refresh the payment records." });
    }

    try {
      await DriverActivity.create({
        driver: booking.payment.cashCollectedBy,
        actor: req.user.userId,
        action: "cod_collection_verified",
        message: `Admin verified COD cash collection for ${booking.bookingCode}`,
        metadata: { bookingId: booking._id, bookingCode: booking.bookingCode, verifiedAt: now, verificationNote: updated.payment.cashCollectionVerificationNote },
      });
    } catch (activityError) {
      console.error("COD verification activity log failed:", activityError.message);
    }

    const financialLedger = await reconcileBookingLedger(updated, req.user.userId);
    res.json({ success: true, message: "Driver-reported COD collection verified by admin.", verifiedAt: now, financialLedger });
  } catch (error) {
    console.error("Admin COD verification error:", error.message);
    res.status(500).json({ success: false, message: "Unable to verify COD collection." });
  }
};

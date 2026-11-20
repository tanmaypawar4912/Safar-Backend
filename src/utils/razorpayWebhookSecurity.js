import crypto from "node:crypto";

/** Verify Razorpay webhook HMAC against the exact raw request body. */
export function verifyRazorpayWebhookSignature(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || !rawBody.length) return false;
  if (typeof signature !== "string" || !signature.trim()) return false;
  if (typeof secret !== "string" || !secret) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const suppliedBuffer = Buffer.from(signature.trim(), "utf8");
  return expectedBuffer.length === suppliedBuffer.length && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

/** Only captured INR payments for the exact expected Razorpay order/amount qualify. */
export function isCapturedRazorpayPayment(payment, expected) {
  return Boolean(
    payment &&
    expected &&
    payment.status === "captured" &&
    typeof payment.id === "string" &&
    typeof payment.order_id === "string" &&
    payment.order_id === expected.orderId &&
    Number.isSafeInteger(payment.amount) &&
    payment.amount === expected.amountPaise &&
    payment.currency === "INR" &&
    expected.currency === "INR"
  );
}

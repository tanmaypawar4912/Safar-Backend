import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  isCapturedRazorpayPayment,
  verifyRazorpayWebhookSignature,
} from "../utils/razorpayWebhookSecurity.js";

const secret = "test-webhook-secret-do-not-use-in-production";
const body = Buffer.from(JSON.stringify({ event: "payment.captured", payload: {} }));
const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");

test("accepts a valid HMAC signature over the exact raw webhook body", () => {
  assert.equal(verifyRazorpayWebhookSignature(body, signature, secret), true);
});

test("rejects altered body, incorrect signature, and missing secret", () => {
  assert.equal(verifyRazorpayWebhookSignature(Buffer.from(`${body.toString()} `), signature, secret), false);
  assert.equal(verifyRazorpayWebhookSignature(body, "0".repeat(64), secret), false);
  assert.equal(verifyRazorpayWebhookSignature(body, signature, ""), false);
  assert.equal(verifyRazorpayWebhookSignature(body.toString(), signature, secret), false);
});

test("accepts only a captured INR payment for the exact order and amount", () => {
  const expected = { orderId: "order_123", amountPaise: 125000, currency: "INR" };
  const payment = { id: "pay_123", order_id: "order_123", amount: 125000, currency: "INR", status: "captured" };
  assert.equal(isCapturedRazorpayPayment(payment, expected), true);
  assert.equal(isCapturedRazorpayPayment({ ...payment, status: "authorized" }, expected), false);
  assert.equal(isCapturedRazorpayPayment({ ...payment, order_id: "order_other" }, expected), false);
  assert.equal(isCapturedRazorpayPayment({ ...payment, amount: 124999 }, expected), false);
  assert.equal(isCapturedRazorpayPayment({ ...payment, currency: "USD" }, expected), false);
});

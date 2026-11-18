const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MINUTES = 330;

function safePaise(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer paise amount.`);
  }
  return value;
}

function objectIdOf(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value._id) return String(value._id);
  return String(value);
}

function dateKeyFromParts(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function getIstDateKey(date = new Date()) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  return dateKeyFromParts(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

export function getPreviousIstDateKey(date = new Date()) {
  const currentKey = getIstDateKey(date);
  const [year, month, day] = currentKey.split("-").map(Number);
  const previous = new Date(Date.UTC(year, month - 1, day - 1));
  return dateKeyFromParts(previous.getUTCFullYear(), previous.getUTCMonth() + 1, previous.getUTCDate());
}

export function resolveIstSettlementPeriod(requestedDate, now = new Date()) {
  const settlementDate = requestedDate || getPreviousIstDateKey(now);
  if (typeof settlementDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(settlementDate)) {
    throw new TypeError("Settlement date must use YYYY-MM-DD format.");
  }

  const [year, month, day] = settlementDate.split("-").map(Number);
  const validation = new Date(Date.UTC(year, month - 1, day));
  const normalized = dateKeyFromParts(validation.getUTCFullYear(), validation.getUTCMonth() + 1, validation.getUTCDate());
  if (normalized !== settlementDate) {
    throw new TypeError("Settlement date is not a valid calendar date.");
  }
  if (settlementDate >= getIstDateKey(now)) {
    throw new RangeError("Daily settlements can only be generated for a completed date in Asia/Kolkata.");
  }

  const periodStart = new Date(`${settlementDate}T00:00:00.000+05:30`);
  const periodEnd = new Date(periodStart.getTime() + DAY_MS);
  return { settlementDate, periodStart, periodEnd };
}

/**
 * Calculate a daily net payout from captured online receipts and COD commission
 * receivables. Online driver earnings are eligible only when the corresponding
 * captured-payment receipt exists for the same booking and driver.
 */
export function calculateDailySettlement({
  onlinePaymentReceipts = [],
  driverEarningEntries = [],
  codCommissionEntries = [],
  codCommissionAddedInPeriodPaise = null,
  previouslyAppliedCodCommissionPaise = 0,
} = {}) {
  safePaise(previouslyAppliedCodCommissionPaise, "Previously applied COD commission");

  const receiptsByBooking = new Map();
  for (const receipt of onlinePaymentReceipts) {
    const bookingId = objectIdOf(receipt.booking);
    const amount = safePaise(receipt.amountPaise, "Online payment receipt");
    if (!bookingId) throw new TypeError("Every online payment receipt must reference a booking.");
    if (receiptsByBooking.has(bookingId)) throw new Error(`Duplicate online payment receipt for booking ${bookingId}.`);
    receiptsByBooking.set(bookingId, { entry: receipt, amount });
  }

  const earningsByBooking = new Map();
  for (const earning of driverEarningEntries) {
    const bookingId = objectIdOf(earning.booking);
    const amount = safePaise(earning.amountPaise, "Driver earning");
    if (!bookingId) throw new TypeError("Every driver earning must reference a booking.");
    if (earningsByBooking.has(bookingId)) throw new Error(`Duplicate driver earning entry for booking ${bookingId}.`);
    earningsByBooking.set(bookingId, { entry: earning, amount });
  }

  const matchedEarnings = [];
  for (const [bookingId, receipt] of receiptsByBooking.entries()) {
    const earning = earningsByBooking.get(bookingId);
    if (!earning) throw new Error(`Captured online payment for booking ${bookingId} has no driver payable entry.`);
    matchedEarnings.push(earning);
  }

  const onlinePaymentGrossPaise = safePaise(
    [...receiptsByBooking.values()].reduce((sum, item) => sum + item.amount, 0),
    "Total online payment receipts"
  );
  const driverEarningsGrossPaise = safePaise(
    matchedEarnings.reduce((sum, item) => sum + item.amount, 0),
    "Total driver earnings"
  );
  const totalCodReceivablePaise = codCommissionEntries.reduce(
    (sum, entry) => sum + safePaise(entry.amountPaise, "COD commission receivable"),
    0
  );
  if (previouslyAppliedCodCommissionPaise > totalCodReceivablePaise) {
    throw new RangeError("Previously applied COD commission exceeds the recorded receivable balance.");
  }
  const codCommissionAddedPaise = codCommissionAddedInPeriodPaise == null
    ? 0
    : safePaise(codCommissionAddedInPeriodPaise, "COD commission added in period");
  const codCommissionDueBeforePaise = totalCodReceivablePaise - previouslyAppliedCodCommissionPaise;
  const codCommissionOffsetPaise = Math.min(driverEarningsGrossPaise, codCommissionDueBeforePaise);
  const netPayoutPaise = driverEarningsGrossPaise - codCommissionOffsetPaise;
  const codCommissionOutstandingPaise = codCommissionDueBeforePaise - codCommissionOffsetPaise;

  return {
    onlinePaymentGrossPaise,
    driverEarningsGrossPaise,
    codCommissionAddedPaise,
    codCommissionDueBeforePaise,
    codCommissionOffsetPaise,
    netPayoutPaise,
    codCommissionOutstandingPaise,
    onlinePaymentEntryIds: [...receiptsByBooking.values()].map(({ entry }) => entry._id).filter(Boolean),
    driverEarningEntryIds: matchedEarnings.map(({ entry }) => entry._id).filter(Boolean),
    codCommissionEntryIds: codCommissionEntries.map((entry) => entry._id).filter(Boolean),
  };
}

export function rupeesFromPaise(value) {
  return Number((safePaise(value, "Amount") / 100).toFixed(2));
}

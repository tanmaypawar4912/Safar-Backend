import FinancialLedgerEntry from "../models/FinancialLedgerEntry.js";
import {
  buildBookingLedgerEntries,
  buildCodCollectionLedgerEntries,
  buildDeliveryLedgerEntries,
  buildOnlinePaymentLedgerEntry,
} from "./financialLedgerLogic.js";

function sameFinancialEntry(existing, proposed) {
  return (
    String(existing.booking) === String(proposed.booking) &&
    String(existing.bookingCode) === String(proposed.bookingCode) &&
    existing.entryType === proposed.entryType &&
    existing.amountPaise === proposed.amountPaise &&
    String(existing.driver) === String(proposed.driver) &&
    String(existing.customer) === String(proposed.customer) &&
    String(existing.vehicle) === String(proposed.vehicle) &&
    existing.paymentMethod === proposed.paymentMethod &&
    existing.source === proposed.source
  );
}

async function ensureOneEntry(entry) {
  const existing = await FinancialLedgerEntry.findOne({
    idempotencyKey: entry.idempotencyKey,
  }).lean();

  if (existing) {
    if (!sameFinancialEntry(existing, entry)) {
      throw new Error(`Financial ledger idempotency conflict for ${entry.idempotencyKey}.`);
    }
    return { idempotencyKey: entry.idempotencyKey, created: false };
  }

  try {
    await FinancialLedgerEntry.create(entry);
    return { idempotencyKey: entry.idempotencyKey, created: true };
  } catch (error) {
    // Concurrent retries can race on the unique idempotency key. Treat the
    // winner's matching document as success, but never hide amount conflicts.
    if (error?.code === 11000) {
      const duplicate = await FinancialLedgerEntry.findOne({
        idempotencyKey: entry.idempotencyKey,
      }).lean();
      if (duplicate && sameFinancialEntry(duplicate, entry)) {
        return { idempotencyKey: entry.idempotencyKey, created: false };
      }
    }
    throw error;
  }
}

async function persistEntries(entries) {
  const results = [];
  // Sequential writes make partial failures easy to retry: every entry is
  // independently idempotent and already-created rows are safely reused.
  for (const entry of entries) {
    results.push(await ensureOneEntry(entry));
  }
  return {
    requested: entries.length,
    created: results.filter((item) => item.created).length,
    existing: results.filter((item) => !item.created).length,
    entries: results,
  };
}

export async function recordDeliveryLedgerEntries(booking, performedBy = null) {
  const entries = buildDeliveryLedgerEntries(booking, performedBy);
  if (!entries.length) {
    return {
      requested: 0,
      created: 0,
      existing: 0,
      skipped: booking?.financialSnapshot?.calculationStatus !== "finalized",
    };
  }
  return persistEntries(entries);
}

export async function recordOnlinePaymentReceipt(booking, options = {}) {
  const entries = buildOnlinePaymentLedgerEntry(booking, options);
  if (!entries.length) {
    return { requested: 0, created: 0, existing: 0, skipped: true };
  }
  return persistEntries(entries);
}

export async function recordCodCollection(booking, options = {}) {
  const entries = buildCodCollectionLedgerEntries(booking, options);
  if (!entries.length) {
    return { requested: 0, created: 0, existing: 0, skipped: true };
  }
  return persistEntries(entries);
}

export async function reconcileBookingLedger(booking, performedBy = null) {
  const entries = buildBookingLedgerEntries(booking, { performedBy });
  if (!entries.length) {
    return { requested: 0, created: 0, existing: 0, skipped: true };
  }
  return persistEntries(entries);
}

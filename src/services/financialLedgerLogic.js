const FINALIZED = "finalized";
const ONLINE = "online";
const COD = "cash_on_delivery";

function idOf(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value._id) return String(value._id);
  return String(value);
}

function requireBookingContext(booking) {
  const bookingId = idOf(booking?._id);
  const driverId = idOf(booking?.driver);
  const customerId = idOf(booking?.customer);
  const vehicleId = idOf(booking?.vehicle);

  if (!bookingId || !driverId || !customerId || !vehicleId || !booking?.bookingCode) {
    throw new TypeError("A ledger entry requires a saved booking, driver, customer, vehicle, and booking code.");
  }

  const financial = booking.financialSnapshot;
  if (financial?.calculationStatus !== FINALIZED) {
    return null;
  }

  for (const field of [
    "commissionBasePaise",
    "platformCommissionPaise",
    "driverEarningPaise",
    "commissionRateBps",
  ]) {
    if (!Number.isSafeInteger(financial[field]) || financial[field] < 0) {
      throw new TypeError(`Booking financial snapshot has an invalid ${field}.`);
    }
  }

  if (financial.platformCommissionPaise + financial.driverEarningPaise !== financial.commissionBasePaise) {
    throw new RangeError("Booking financial snapshot does not reconcile to the commission base.");
  }

  if (![ONLINE, COD].includes(booking.paymentMethod)) {
    throw new TypeError("Booking has an unsupported payment method for the financial ledger.");
  }

  return {
    bookingId,
    bookingCode: String(booking.bookingCode),
    driverId,
    customerId,
    vehicleId,
    vehicleName: booking.commissionSnapshot?.vehicleName || "",
    paymentMethod: booking.paymentMethod,
    financial,
  };
}

function commonEntry(context, { entryType, amountPaise, source, suffix, performedBy, occurredAt, sourceReference = "", metadata = {} }) {
  return {
    idempotencyKey: `booking:${context.bookingId}:${suffix}`,
    booking: context.bookingId,
    bookingCode: context.bookingCode,
    driver: context.driverId,
    customer: context.customerId,
    vehicle: context.vehicleId,
    vehicleName: context.vehicleName,
    entryType,
    amountPaise,
    currency: "INR",
    paymentMethod: context.paymentMethod,
    source,
    sourceReference,
    performedBy: idOf(performedBy) || null,
    occurredAt: occurredAt ? new Date(occurredAt) : new Date(),
    metadata: {
      commissionRateBps: context.financial.commissionRateBps,
      commissionBasePaise: context.financial.commissionBasePaise,
      platformCommissionPaise: context.financial.platformCommissionPaise,
      driverEarningPaise: context.financial.driverEarningPaise,
      ...metadata,
    },
  };
}

/**
 * Creates the financial allocation records after delivery.
 * Online bookings create an amount payable to the driver. COD bookings create
 * an earning already retained in cash by the driver; COD commission receivable
 * is recorded only after cash collection is confirmed.
 */
export function buildDeliveryLedgerEntries(booking, performedBy = null) {
  if (booking?.status !== "delivered") {
    throw new TypeError("Delivery ledger entries can only be created for delivered bookings.");
  }

  const context = requireBookingContext(booking);
  if (!context) return [];

  const occurredAt = booking.financialSnapshot.calculatedAt || booking.updatedAt || new Date();
  const commonMetadata = {
    snapshotVersion: 1,
    paymentStatusAtDelivery: booking.paymentStatus || "unpaid",
  };

  const entries = [
    commonEntry(context, {
      entryType: "platform_commission_earned",
      amountPaise: context.financial.platformCommissionPaise,
      source: "delivery_completion",
      suffix: "delivery:platform-commission",
      performedBy,
      occurredAt,
      metadata: commonMetadata,
    }),
  ];

  if (context.paymentMethod === ONLINE) {
    entries.push(
      commonEntry(context, {
        entryType: "driver_earning_payable",
        amountPaise: context.financial.driverEarningPaise,
        source: "delivery_completion",
        suffix: "delivery:driver-earning",
        performedBy,
        occurredAt,
        metadata: commonMetadata,
      })
    );
  } else {
    entries.push(
      commonEntry(context, {
        entryType: "driver_earning_retained_cod",
        amountPaise: context.financial.driverEarningPaise,
        source: "delivery_completion",
        suffix: "delivery:driver-cod-earning",
        performedBy,
        occurredAt,
        metadata: commonMetadata,
      })
    );
  }

  return entries;
}

export function buildOnlinePaymentLedgerEntry(booking, { paymentId, performedBy = null, occurredAt = null } = {}) {
  const context = requireBookingContext(booking);
  if (!context) return [];
  if (context.paymentMethod !== ONLINE) {
    throw new TypeError("Online payment ledger entries require an online-payment booking.");
  }
  if (booking.paymentStatus !== "paid") {
    throw new TypeError("Online payment must be marked paid after gateway verification before recording the receipt.");
  }
  if (!paymentId || typeof paymentId !== "string") {
    throw new TypeError("A verified Razorpay payment ID is required for the online receipt ledger entry.");
  }

  return [
    commonEntry(context, {
      entryType: "online_payment_received",
      amountPaise: context.financial.commissionBasePaise,
      source: "razorpay_capture",
      suffix: "payment:online-received",
      performedBy,
      occurredAt: occurredAt || booking.payment?.paidAt || new Date(),
      sourceReference: paymentId,
      metadata: { gateway: "razorpay", gatewayPaymentId: paymentId },
    }),
  ];
}

export function buildCodCollectionLedgerEntries(booking, { performedBy = null, occurredAt = null } = {}) {
  const context = requireBookingContext(booking);
  if (!context) return [];
  if (context.paymentMethod !== COD) {
    throw new TypeError("COD collection ledger entries require a cash-on-delivery booking.");
  }
  if (booking.paymentStatus !== "paid") {
    throw new TypeError("COD collection must be confirmed before recording COD ledger entries.");
  }

  const happenedAt = occurredAt || booking.payment?.paidAt || booking.updatedAt || booking.createdAt || new Date();
  return [
    commonEntry(context, {
      entryType: "cod_cash_collected_by_driver",
      amountPaise: context.financial.commissionBasePaise,
      source: "cod_collection",
      suffix: "payment:cod-collected",
      performedBy,
      occurredAt: happenedAt,
      metadata: {
        collectedBy: idOf(booking.payment.cashCollectedBy) || idOf(performedBy),
      },
    }),
    commonEntry(context, {
      entryType: "cod_commission_receivable",
      amountPaise: context.financial.platformCommissionPaise,
      source: "cod_collection",
      suffix: "payment:cod-commission-due",
      performedBy,
      occurredAt: happenedAt,
      metadata: {
        collectedBy: idOf(booking.payment.cashCollectedBy) || idOf(performedBy),
      },
    }),
  ];
}

export function buildBookingLedgerEntries(booking, options = {}) {
  if (!booking || booking.status !== "delivered") return [];
  const entries = buildDeliveryLedgerEntries(booking, options.performedBy);
  if (booking.paymentMethod === ONLINE && booking.paymentStatus === "paid") {
    entries.push(...buildOnlinePaymentLedgerEntry(booking, {
      paymentId: booking.payment?.gatewayPaymentId,
      performedBy: options.performedBy,
      occurredAt: booking.payment?.paidAt,
    }));
  }
  if (booking.paymentMethod === COD && booking.paymentStatus === "paid") {
    entries.push(...buildCodCollectionLedgerEntries(booking, options));
  }
  return entries;
}

let dispatchIo = null;

export function registerDispatchSocketServer(io) {
  dispatchIo = io || null;
}

function uniqueDriverIds(driverIds) {
  if (!Array.isArray(driverIds)) return [];
  return [...new Set(driverIds.map((id) => String(id || "").trim()).filter((id) => /^[a-f\d]{24}$/i.test(id)))];
}

/**
 * Notify each authenticated driver's private Socket.IO room that a new offer
 * is available. The event deliberately contains identifiers only; the client
 * must load the offer through the authenticated REST endpoint.
 */
export function emitDriverDispatchOffers(driverIds, booking) {
  if (!dispatchIo || !booking?._id) return 0;

  const recipients = uniqueDriverIds(driverIds);
  if (!recipients.length) return 0;

  const expiryDate = booking.expiresAt instanceof Date
    ? booking.expiresAt
    : new Date(booking.expiresAt);
  if (!Number.isFinite(expiryDate.getTime())) return 0;

  const payload = {
    bookingId: String(booking._id),
    bookingCode: String(booking.bookingCode || ""),
    expiresAt: expiryDate.toISOString(),
  };

  let delivered = 0;
  for (const driverId of recipients) {
    try {
      dispatchIo.to(`driver:${driverId}`).emit("dispatch:offer", payload);
      delivered += 1;
    } catch (error) {
      // Persisted offers and authenticated REST polling remain the fallback.
      console.error("Could not emit driver dispatch offer:", error.message);
    }
  }

  return delivered;
}

/** Immediately tell drivers to refresh when an offer is no longer actionable. */
export function emitDriverDispatchOfferClosed(driverIds, booking, reason = "unavailable") {
  if (!dispatchIo || !booking?._id) return 0;

  const recipients = uniqueDriverIds(driverIds);
  if (!recipients.length) return 0;

  const payload = {
    bookingId: String(booking._id),
    bookingCode: String(booking.bookingCode || ""),
    reason: String(reason || "unavailable").slice(0, 40),
  };

  let delivered = 0;
  for (const driverId of recipients) {
    try {
      dispatchIo.to(`driver:${driverId}`).emit("dispatch:offer-closed", payload);
      delivered += 1;
    } catch (error) {
      console.error("Could not emit driver dispatch offer closure:", error.message);
    }
  }

  return delivered;
}


/** Refresh the assigned driver's jobs after a manual admin assignment. */
export function emitDriverDispatchJobUpdated(driverIds, booking, reason = "assigned") {
  if (!dispatchIo || !booking?._id) return 0;

  const recipients = uniqueDriverIds(driverIds);
  if (!recipients.length) return 0;

  const payload = {
    bookingId: String(booking._id),
    bookingCode: String(booking.bookingCode || ""),
    reason: String(reason || "assigned").slice(0, 40),
  };

  let delivered = 0;
  for (const driverId of recipients) {
    try {
      dispatchIo.to(`driver:${driverId}`).emit("dispatch:job-updated", payload);
      delivered += 1;
    } catch (error) {
      console.error("Could not emit driver job update:", error.message);
    }
  }
  return delivered;
}

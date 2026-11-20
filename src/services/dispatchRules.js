/** Build the database filter for drivers who can serve a specific booking. */
export function buildDispatchCandidateFilter({ vehicleSlug, weightKg, now = new Date() }) {
  if (typeof vehicleSlug !== "string" || !vehicleSlug.trim()) {
    throw new TypeError("A valid vehicle slug is required for dispatch.");
  }
  if (!Number.isFinite(Number(weightKg)) || Number(weightKg) <= 0) {
    throw new TypeError("A valid package weight is required for dispatch.");
  }

  return {
    approvalStatus: "approved",
    availability: "online",
    isActive: true,
    licenseExpiry: { $gt: now },
    vehicleType: vehicleSlug,
    vehicleCapacityKg: { $gte: Number(weightKg) },
  };
}

/** A driver receives an offer again only after the decline/expiry cooldown. */
export function canReceiveDispatchOfferAgain(
  lastOffer,
  now = new Date(),
  rejectedCooldownMs = 5 * 60 * 1000,
  expiredCooldownMs = 30 * 1000
) {
  if (!lastOffer) return true;
  if (["offered", "accepted", "lost"].includes(lastOffer.status)) return false;

  const lastResponseAt = new Date(
    lastOffer.respondedAt || lastOffer.expiresAt || lastOffer.offeredAt || 0
  ).getTime();
  if (!Number.isFinite(lastResponseAt)) return true;

  // An unanswered offer should become visible again quickly after expiry;
  // a deliberate rejection keeps the longer cooldown to avoid repeated spam.
  const cooldownMs = lastOffer.status === "expired"
    ? expiredCooldownMs
    : rejectedCooldownMs;
  return now.getTime() - lastResponseAt >= cooldownMs;
}

/** Extra checks for the populated account document (role/isActive). */
export function isActiveDriverAccount(profile) {
  return Boolean(
    profile?.user &&
    profile.user.role === "driver" &&
    profile.user.isActive === true
  );
}

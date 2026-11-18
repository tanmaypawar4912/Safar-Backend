export const TRACKABLE_STATUSES = new Set([
  "accepted",
  "arriving_at_pickup",
  "arrived_at_pickup",
  "picked_up",
  "in_transit",
  "arrived_at_drop",
]);

export const TERMINAL_TRACKING_STATUSES = new Set([
  "delivered",
  "cancelled",
]);

export function normalizeReferenceId(value) {
  if (value == null) return "";
  if (typeof value === "object") {
    return String(value._id ?? value.id ?? value);
  }
  return String(value);
}

export function canAccessBookingTracking(user, booking) {
  if (!user || !booking) return false;

  const userId = normalizeReferenceId(user.userId ?? user.id ?? user._id);
  if (!userId) return false;

  const role = String(user.role ?? "").trim().toLowerCase();
  if (role === "admin") return true;

  if (role === "customer") {
    return normalizeReferenceId(booking.customer) === userId;
  }

  if (role === "driver") {
    return normalizeReferenceId(booking.driver) === userId;
  }

  return false;
}

export function isBookingTrackable(booking) {
  return Boolean(
    booking &&
      booking.driver &&
      TRACKABLE_STATUSES.has(String(booking.status ?? "")) &&
      !TERMINAL_TRACKING_STATUSES.has(String(booking.status ?? ""))
  );
}

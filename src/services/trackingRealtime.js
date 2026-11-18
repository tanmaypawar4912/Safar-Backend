let trackingIO = null;

export function registerTrackingSocketServer(io) {
  trackingIO = io;
}

export function emitBookingLocationUpdate(bookingId, location) {
  if (!trackingIO || !bookingId || !location) return false;

  try {
    trackingIO.to(`booking:${String(bookingId)}`).emit("tracking:location", {
      bookingId: String(bookingId),
      location: {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracyMeters: location.accuracyMeters ?? null,
        headingDegrees: location.headingDegrees ?? null,
        speedMetersPerSecond: location.speedMetersPerSecond ?? null,
        capturedAt:
          location.capturedAt instanceof Date
            ? location.capturedAt.toISOString()
            : String(location.capturedAt),
      },
    });
    return true;
  } catch (error) {
    // A real-time transport failure must never fail the already-saved GPS REST update.
    console.error("Broadcast booking location error:", error.message);
    return false;
  }
}

export function emitBookingTrackingStopped(bookingId, reason = "sharing_stopped") {
  if (!trackingIO || !bookingId) return false;

  try {
    trackingIO.to(`booking:${String(bookingId)}`).emit("tracking:stopped", {
      bookingId: String(bookingId),
      reason,
    });
    return true;
  } catch (error) {
    console.error("Broadcast tracking stopped error:", error.message);
    return false;
  }
}

const MIN_PRODUCTION_SECRET_LENGTH = 32;

/**
 * Validate deployment-only security requirements without restricting local
 * development credentials. Secrets are never included in error messages.
 */
export function validateRuntimeSecurity({
  nodeEnv = "development",
  accessSecret = "",
  refreshSecret = "",
  clientUrl = "",
} = {}) {
  const errors = [];
  const allowedEnvironments = new Set([
    "development",
    "test",
    "production",
  ]);

  if (!allowedEnvironments.has(nodeEnv)) {
    errors.push("NODE_ENV must be development, test, or production.");
    return errors;
  }

  if (nodeEnv !== "production") return errors;

  if (typeof accessSecret !== "string" || accessSecret.length < MIN_PRODUCTION_SECRET_LENGTH) {
    errors.push("JWT_ACCESS_SECRET must contain at least 32 characters in production.");
  }

  if (typeof refreshSecret !== "string" || refreshSecret.length < MIN_PRODUCTION_SECRET_LENGTH) {
    errors.push("JWT_REFRESH_SECRET must contain at least 32 characters in production.");
  }

  if (
    typeof accessSecret === "string" &&
    typeof refreshSecret === "string" &&
    accessSecret.length > 0 &&
    accessSecret === refreshSecret
  ) {
    errors.push("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values.");
  }

  let parsedClientUrl;
  try {
    parsedClientUrl = new URL(clientUrl);
  } catch {
    errors.push("CLIENT_URL must be a valid absolute URL in production.");
  }

  if (parsedClientUrl && parsedClientUrl.protocol !== "https:") {
    errors.push("CLIENT_URL must use HTTPS in production.");
  }

  return errors;
}

/**
 * Accept an explicit reverse-proxy hop count. Avoid `true`, which would trust
 * arbitrary X-Forwarded-* values from untrusted clients.
 */
export function parseTrustProxy(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return false;
  }

  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error("TRUST_PROXY must be a non-negative integer hop count (for example, 1).");
  }

  const hops = Number(raw);
  if (!Number.isSafeInteger(hops) || hops < 0 || hops > 10) {
    throw new Error("TRUST_PROXY must be between 0 and 10.");
  }

  return hops;
}

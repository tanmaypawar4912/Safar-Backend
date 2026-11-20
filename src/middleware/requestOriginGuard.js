const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Decide whether a cookie-authenticated state-changing request should be
 * rejected. Browser requests carry an Origin header; non-browser clients such
 * as Postman and server-to-server jobs may omit it. Sec-Fetch-Site protects
 * browsers that send Fetch Metadata even when Origin is absent.
 */
export function shouldRejectRequestOrigin(
  { method = "GET", origin = "", secFetchSite = "" } = {},
  allowedOrigins = new Set()
) {
  const normalizedMethod = String(method).toUpperCase();
  if (!STATE_CHANGING_METHODS.has(normalizedMethod)) return false;

  const requestOrigin = String(origin || "").trim();
  if (requestOrigin) return !allowedOrigins.has(requestOrigin);

  return String(secFetchSite || "").toLowerCase() === "cross-site";
}

export function createRequestOriginGuard(allowedOrigins) {
  return function requestOriginGuard(req, res, next) {
    if (
      shouldRejectRequestOrigin(
        {
          method: req.method,
          origin: req.get("origin"),
          secFetchSite: req.get("sec-fetch-site"),
        },
        allowedOrigins
      )
    ) {
      return res.status(403).json({
        success: false,
        code: "UNTRUSTED_REQUEST_ORIGIN",
        message: "This state-changing request did not come from an approved LogiGo origin.",
      });
    }

    return next();
  };
}

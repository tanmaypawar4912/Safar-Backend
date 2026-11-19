const baseUrl = (process.env.SMOKE_BASE_URL || `http://127.0.0.1:${process.env.PORT || 5000}`).replace(/\/+$/, "");
const url = `${baseUrl}/api/health`;

try {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success !== true) {
    console.error(`FAIL health check ${url}: HTTP ${response.status}`, payload);
    process.exit(1);
  }
  console.log(`PASS ${url} – ${payload.message || "API healthy"}`);
} catch (error) {
  console.error(`FAIL health check ${url}: ${error.message}`);
  console.error("Start the API first, or set SMOKE_BASE_URL to the deployed API origin.");
  process.exit(1);
}


import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import { env } from "./config/env.js";

import authRoutes from "./routes/authRoutes.js";
import vehicleRoutes from "./routes/vehicleRoutes.js";
import pricingRoutes from "./routes/pricingRoutes.js";
import bookingRoutes from "./routes/bookingRoutes.js";
import driverRoutes from "./routes/driverRoutes.js";
import reviewRoutes from "./routes/reviewRoutes.js";
import complaintRoutes from "./routes/complaintRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import commissionRoutes from "./routes/commissionRoutes.js";
import financialLedgerRoutes from "./routes/financialLedgerRoutes.js";
import driverSettlementRoutes from "./routes/driverSettlementRoutes.js";
import enterpriseRoutes from "./routes/enterpriseRoutes.js";
import { createRequestOriginGuard } from "./middleware/requestOriginGuard.js";

const app = express();

const extraClientOrigins = (process.env.CLIENT_URLS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedOrigins = new Set(
  [
    env.CLIENT_URL,
    ...extraClientOrigins,
    ...(env.NODE_ENV !== "production"
      ? [
          "http://localhost:5173",
          "http://127.0.0.1:5173",
        ]
      : []),
  ].filter(Boolean)
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        return callback(null, true);
      }

      return callback(
        new Error(`CORS blocked origin: ${origin}`)
      );
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Cookie-authenticated mutation endpoints reject untrusted browser origins.
// Requests from Postman/server jobs without Origin remain supported unless
// Fetch Metadata explicitly identifies them as cross-site browser requests.
app.use(createRequestOriginGuard(allowedOrigins));

app.use(helmet());

// Razorpay signs the exact webhook bytes. Mount the raw parser before the
// global JSON parser so the webhook controller can verify the original body.
app.use("/api/payments/webhook", express.raw({ type: "application/json", limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));

app.use(
  express.urlencoded({
    extended: true,
    limit: "100kb",
    parameterLimit: 100,
  })
);

app.use(cookieParser());

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.NODE_ENV === "production" ? 1000 : 5000,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    code: "API_RATE_LIMITED",
    message: "Too many API requests. Please wait briefly and retry.",
  },
});

app.use("/api", apiLimiter);

app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "LogiGo API is running",
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/vehicles", vehicleRoutes);
app.use("/api/pricing", pricingRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/drivers", driverRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/complaints", complaintRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/commission-rules", commissionRoutes);
app.use("/api/financial-ledger", financialLedgerRoutes);
app.use("/api/settlements", driverSettlementRoutes);
app.use("/api/enterprise", enterpriseRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found",
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  if (error.message?.startsWith("CORS blocked origin:")) {
    console.warn(error.message);

    return res.status(403).json({
      success: false,
      message:
        "Origin is not allowed. Add this frontend URL to CLIENT_URLS in backend/.env.",
    });
  }

  console.error("API error:", error.message);

  return res.status(500).json({
    success: false,
    message: "Internal server error",
  });
});

export default app;

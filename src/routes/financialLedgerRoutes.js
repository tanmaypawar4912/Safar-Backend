import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { authorizeRoles } from "../middleware/roleMiddleware.js";
import {
  getAdminFinancialLedgerEntries,
  getAdminFinancialLedgerSummary,
  getAdminDriverFinancialSummaries,
  getDriverFinancialLedgerEntries,
  getDriverFinancialLedgerSummary,
  reconcileAdminBookingLedger,
} from "../controllers/financialLedgerController.js";

const router = express.Router();

router.get(
  "/driver/entries",
  protect,
  authorizeRoles("driver"),
  getDriverFinancialLedgerEntries
);
router.get(
  "/driver/summary",
  protect,
  authorizeRoles("driver"),
  getDriverFinancialLedgerSummary
);
router.get(
  "/admin/drivers/summary",
  protect,
  authorizeRoles("admin"),
  getAdminDriverFinancialSummaries
);
router.get(
  "/admin/entries",
  protect,
  authorizeRoles("admin"),
  getAdminFinancialLedgerEntries
);
router.get(
  "/admin/summary",
  protect,
  authorizeRoles("admin"),
  getAdminFinancialLedgerSummary
);
router.post(
  "/admin/bookings/:bookingId/reconcile",
  protect,
  authorizeRoles("admin"),
  reconcileAdminBookingLedger
);

export default router;

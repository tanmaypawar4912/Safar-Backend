import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { authorizeRoles } from "../middleware/roleMiddleware.js";
import {
  confirmAdminDriverSettlement,
  generateAdminDailySettlements,
  getAdminDriverSettlementSummary,
  getAdminDriverSettlements,
  getDriverSettlementSummary,
  getDriverSettlements,
} from "../controllers/driverSettlementController.js";

const router = express.Router();

router.get("/driver", protect, authorizeRoles("driver"), getDriverSettlements);
router.get("/driver/summary", protect, authorizeRoles("driver"), getDriverSettlementSummary);
router.get("/admin", protect, authorizeRoles("admin"), getAdminDriverSettlements);
router.get("/admin/summary", protect, authorizeRoles("admin"), getAdminDriverSettlementSummary);
router.post("/admin/generate", protect, authorizeRoles("admin"), generateAdminDailySettlements);
router.patch("/admin/:settlementId/confirm", protect, authorizeRoles("admin"), confirmAdminDriverSettlement);

export default router;

import express from "express";
import {
  getAdminCommissionRules,
  updateVehicleCommissionRule,
} from "../controllers/commissionController.js";
import { protect } from "../middleware/authMiddleware.js";
import { authorizeRoles } from "../middleware/roleMiddleware.js";

const router = express.Router();

router.use(protect, authorizeRoles("admin"));
router.get("/admin", getAdminCommissionRules);
router.patch("/admin/:vehicleId", updateVehicleCommissionRule);

export default router;

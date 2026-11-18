import mongoose from "mongoose";

export const DEFAULT_COMMISSION_RATE_BPS = 1000;

const vehicleCommissionRuleSchema = new mongoose.Schema(
  {
    vehicle: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vehicle",
      required: true,
      unique: true,
    },
    // Basis points avoid floating-point percentage calculations.
    // 1000 basis points = 10.00%.
    commissionRateBps: {
      type: Number,
      required: true,
      default: DEFAULT_COMMISSION_RATE_BPS,
      min: 0,
      max: 5000,
      validate: {
        validator: Number.isInteger,
        message: "Commission rate must use whole basis points.",
      },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

const VehicleCommissionRule = mongoose.model(
  "VehicleCommissionRule",
  vehicleCommissionRuleSchema
);

export default VehicleCommissionRule;

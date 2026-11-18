import mongoose from "mongoose";
import Vehicle from "../models/Vehicle.js";
import VehicleCommissionRule, {
  DEFAULT_COMMISSION_RATE_BPS,
} from "../models/VehicleCommissionRule.js";

const MAX_COMMISSION_RATE_BPS = 5000;

function serializeRule(rule) {
  const rateBps = Number(rule.commissionRateBps);
  return {
    _id: String(rule._id),
    vehicle: rule.vehicle,
    commissionRateBps: rateBps,
    commissionRatePercent: Number((rateBps / 100).toFixed(2)),
    updatedAt: rule.updatedAt,
  };
}

export const getAdminCommissionRules = async (_req, res) => {
  try {
    const vehicles = await Vehicle.find({})
      .select("name slug isActive sortOrder")
      .sort({ sortOrder: 1, name: 1 })
      .lean();

    if (vehicles.length === 0) {
      return res.json({ success: true, count: 0, commissionRules: [] });
    }

    const rules = await VehicleCommissionRule.find({
      vehicle: { $in: vehicles.map((vehicle) => vehicle._id) },
    })
      .populate("vehicle", "name slug isActive sortOrder")
      .lean();

    const rulesByVehicle = new Map(
      rules.map((rule) => [String(rule.vehicle?._id || rule.vehicle), rule])
    );

    const commissionRules = vehicles.map((vehicle) => {
      const rule = rulesByVehicle.get(String(vehicle._id));
      return {
        _id: rule?._id ? String(rule._id) : null,
        vehicle: {
          _id: String(vehicle._id),
          name: vehicle.name,
          slug: vehicle.slug,
          isActive: vehicle.isActive,
          sortOrder: vehicle.sortOrder,
        },
        commissionRateBps: rule?.commissionRateBps ?? null,
        commissionRatePercent:
          rule?.commissionRateBps == null
            ? null
            : Number((rule.commissionRateBps / 100).toFixed(2)),
        configured: Boolean(rule),
        updatedAt: rule?.updatedAt || null,
      };
    });

    return res.json({
      success: true,
      count: commissionRules.length,
      commissionRules,
    });
  } catch (error) {
    console.error("Get vehicle commission rules error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load vehicle commission settings.",
    });
  }
};

export const updateVehicleCommissionRule = async (req, res) => {
  try {
    const { vehicleId } = req.params;
    if (!mongoose.isValidObjectId(vehicleId)) {
      return res.status(400).json({
        success: false,
        message: "A valid vehicle ID is required.",
      });
    }

    const rawRate = req.body?.commissionRatePercent;
    if (rawRate === undefined || rawRate === null || String(rawRate).trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Commission rate is required.",
      });
    }

    const ratePercent = Number(rawRate);
    const rateBps = Math.round(ratePercent * 100);
    if (
      !Number.isFinite(ratePercent) ||
      ratePercent < 0 ||
      ratePercent > MAX_COMMISSION_RATE_BPS / 100 ||
      Math.abs(ratePercent * 100 - rateBps) > 1e-8
    ) {
      return res.status(400).json({
        success: false,
        message: "Commission must be between 0% and 50%, with up to 2 decimal places.",
      });
    }

    const vehicle = await Vehicle.findById(vehicleId)
      .select("_id name slug isActive")
      .lean();

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found.",
      });
    }

    const rule = await VehicleCommissionRule.findOneAndUpdate(
      { vehicle: vehicle._id },
      {
        $set: {
          commissionRateBps: rateBps,
          updatedBy: req.user.userId,
        },
        $setOnInsert: {
          vehicle: vehicle._id,
          createdBy: req.user.userId,
        },
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      }
    ).populate("vehicle", "name slug isActive");

    return res.json({
      success: true,
      message: `Commission for ${vehicle.name} saved. This rate is configured for the upcoming commission-calculation phase; no booking or payment amounts are changed yet.`,
      commissionRule: serializeRule(rule),
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "This vehicle already has a commission rule. Refresh and try again.",
      });
    }
    console.error("Update vehicle commission rule error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to save vehicle commission settings.",
    });
  }
};

export { DEFAULT_COMMISSION_RATE_BPS };

import Vehicle from "../models/Vehicle.js";
import PricingRule from "../models/PricingRule.js";
import DriverProfile from "../models/DriverProfile.js";
import { profilesAreDispatchEligible } from "../services/dispatchService.js";

const number = (value, label, min = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) throw new Error(`${label} must be a number greater than or equal to ${min}.`);
  return n;
};
const slugify = (value) => String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function safeImageUrl(value) {
  if (!value) return null;
  let url;
  try { url = new URL(String(value)); } catch { throw new Error("Image URL must be a valid HTTPS URL."); }
  if (url.protocol !== "https:") throw new Error("Vehicle image URL must use HTTPS.");
  return url.toString();
}

async function withPricing(vehicles, includeInactive = false) {
  const ids = vehicles.map((v) => v._id);
  const rules = await PricingRule.find({ vehicle: { $in: ids }, ...(includeInactive ? {} : { isActive: true }) }).lean();
  const map = new Map(rules.map(({ vehicle, ...pricing }) => [String(vehicle), pricing]));
  return vehicles.map((v) => ({ ...v, pricing: map.get(String(v._id)) || null }));
}

export const getVehicles = async (_req, res) => {
  try {
    const vehicles = await Vehicle.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean();
    return res.json({ success: true, count: vehicles.length, vehicles: await withPricing(vehicles) });
  } catch (error) {
    console.error("Get vehicles error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to fetch vehicles" });
  }
};

export const getAdminVehicles = async (_req, res) => {
  try {
    const vehicles = await Vehicle.find({}).sort({ sortOrder: 1, name: 1 }).lean();
    return res.json({ success: true, vehicles: await withPricing(vehicles, true) });
  } catch (error) { return res.status(500).json({ success: false, message: "Failed to fetch vehicle catalogue" }); }
};

export const createVehicle = async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (name.length < 2 || name.length > 80) return res.status(400).json({ success: false, message: "Vehicle name must contain 2–80 characters." });
    const slug = slugify(req.body.slug || name);
    if (!slug) return res.status(400).json({ success: false, message: "A valid vehicle slug is required." });
    const vehicle = await Vehicle.create({ name, slug, description: String(req.body.description || "").trim().slice(0, 500), capacityKg: number(req.body.capacityKg, "Capacity", 1), imageUrl: safeImageUrl(req.body.imageUrl), features: Array.isArray(req.body.features) ? req.body.features.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 20) : [], isActive: req.body.isActive !== false, sortOrder: number(req.body.sortOrder ?? 0, "Sort order") });
    const pricing = await PricingRule.create({ vehicle: vehicle._id, baseFare: number(req.body.pricing?.baseFare, "Base fare"), perKmRate: number(req.body.pricing?.perKmRate, "Per-km rate"), perKgRate: number(req.body.pricing?.perKgRate, "Per-kg rate"), minimumFare: number(req.body.pricing?.minimumFare, "Minimum fare"), serviceFee: number(req.body.pricing?.serviceFee ?? 0, "Service fee"), isActive: vehicle.isActive });
    return res.status(201).json({ success: true, message: "Vehicle and pricing created.", vehicle: { ...vehicle.toObject(), pricing: pricing.toObject() } });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, message: "A vehicle with this name/slug already exists." });
    return res.status(400).json({ success: false, message: error.message || "Unable to create vehicle." });
  }
};

export const updateVehicle = async (req, res) => {
  try {
    const vehicle = await Vehicle.findById(req.params.id);
    if (!vehicle) return res.status(404).json({ success: false, message: "Vehicle not found." });
    const b = req.body;
    if (b.name !== undefined) vehicle.name = String(b.name).trim();
    if (b.slug !== undefined || b.name !== undefined) vehicle.slug = slugify(b.slug || b.name || vehicle.name);
    if (b.description !== undefined) vehicle.description = String(b.description).trim().slice(0, 500);
    if (b.capacityKg !== undefined) vehicle.capacityKg = number(b.capacityKg, "Capacity", 1);
    if (b.imageUrl !== undefined) vehicle.imageUrl = safeImageUrl(b.imageUrl);
    if (b.features !== undefined) vehicle.features = Array.isArray(b.features) ? b.features.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 20) : [];
    if (b.isActive !== undefined) vehicle.isActive = Boolean(b.isActive);
    if (b.sortOrder !== undefined) vehicle.sortOrder = number(b.sortOrder, "Sort order");
    await vehicle.save();
    let pricing = await PricingRule.findOne({ vehicle: vehicle._id });
    if (b.pricing) {
      const p = b.pricing;
      const values = { baseFare: number(p.baseFare, "Base fare"), perKmRate: number(p.perKmRate, "Per-km rate"), perKgRate: number(p.perKgRate, "Per-kg rate"), minimumFare: number(p.minimumFare, "Minimum fare"), serviceFee: number(p.serviceFee ?? 0, "Service fee"), isActive: vehicle.isActive };
      pricing = pricing ? Object.assign(pricing, values) : new PricingRule({ vehicle: vehicle._id, ...values });
      await pricing.save();
    } else if (pricing) { pricing.isActive = vehicle.isActive; await pricing.save(); }
    return res.json({ success: true, message: "Vehicle updated.", vehicle: { ...vehicle.toObject(), pricing: pricing?.toObject() || null } });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, message: "Vehicle slug already exists." });
    return res.status(400).json({ success: false, message: error.message || "Unable to update vehicle." });
  }
};


export const getVehicleAvailability = async (req, res) => {
  try {
    const { vehicleId } = req.query;
    const weightKg = Number(req.query.weightKg);

    if (typeof vehicleId !== "string" || !/^[a-f\d]{24}$/i.test(vehicleId)) {
      return res.status(400).json({
        success: false,
        message: "A valid vehicle ID is required.",
      });
    }

    if (!Number.isFinite(weightKg) || weightKg <= 0 || weightKg > 5000) {
      return res.status(400).json({
        success: false,
        message: "Weight must be between 0.1 and 5000 kg.",
      });
    }

    const vehicle = await Vehicle.findOne({
      _id: vehicleId,
      isActive: true,
    })
      .select("name slug capacityKg")
      .lean();

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found or unavailable.",
      });
    }

    if (weightKg > vehicle.capacityKg) {
      return res.status(422).json({
        success: false,
        message: `This vehicle supports up to ${vehicle.capacityKg} kg.`,
      });
    }

    const profiles = await DriverProfile.find({
      approvalStatus: "approved",
      availability: "online",
      isActive: true,
      licenseExpiry: { $gt: new Date() },
      vehicleType: vehicle.slug,
      vehicleCapacityKg: { $gte: weightKg },
    })
      .populate({ path: "user", select: "role isActive" })
      .sort({ updatedAt: 1 })
      .limit(200)
      .lean();

    const candidates = profiles.filter(
      (profile) =>
        profile.user &&
        profile.user.role === "driver" &&
        profile.user.isActive
    );

    const eligibility = await profilesAreDispatchEligible(candidates);
    const eligibleDriverCount = candidates.filter(
      (_profile, index) => eligibility[index]
    ).length;
    const available = eligibleDriverCount > 0;

    return res.status(200).json({
      success: true,
      vehicle: {
        id: String(vehicle._id),
        name: vehicle.name,
        slug: vehicle.slug,
        capacityKg: vehicle.capacityKg,
      },
      availability: {
        status: available ? "available" : "unavailable",
        eligibleDriverCount,
        checkedAt: new Date().toISOString(),
        routeSpecific: false,
        message: available
          ? "Eligible drivers are currently online for this vehicle category and load size. Availability may change before dispatch."
          : "No approved, online, document-eligible driver currently matches this vehicle category and load size. Retry, choose another vehicle, or place the booking to let automatic dispatch retry.",
      },
    });
  } catch (error) {
    console.error("Vehicle availability error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to check vehicle availability right now.",
    });
  }
};

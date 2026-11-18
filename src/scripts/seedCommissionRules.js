import mongoose from "mongoose";
import connectDB from "../config/db.js";
import Vehicle from "../models/Vehicle.js";
import VehicleCommissionRule, {
  DEFAULT_COMMISSION_RATE_BPS,
} from "../models/VehicleCommissionRule.js";

async function seedCommissionRules() {
  try {
    await connectDB();

    const activeVehicles = await Vehicle.find({ isActive: true })
      .select("_id name")
      .sort({ name: 1 })
      .lean();

    if (activeVehicles.length === 0) {
      console.log("No active vehicle types found. No commission rules were created.");
      return;
    }

    const operations = activeVehicles.map((vehicle) => ({
      updateOne: {
        filter: { vehicle: vehicle._id },
        update: {
          $setOnInsert: {
            vehicle: vehicle._id,
            commissionRateBps: DEFAULT_COMMISSION_RATE_BPS,
          },
        },
        upsert: true,
      },
    }));

    const result = await VehicleCommissionRule.bulkWrite(operations, {
      ordered: false,
    });

    console.log(`Active vehicle types checked: ${activeVehicles.length}`);
    console.log(`New 10% commission rules created: ${result.upsertedCount || 0}`);
    console.log(
      `Existing commission rules preserved: ${activeVehicles.length - (result.upsertedCount || 0)}`
    );
    console.log("Vehicle commission rule seeding completed.");
  } catch (error) {
    console.error("Vehicle commission rule seeding failed:", error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

seedCommissionRules();

import mongoose from "mongoose";

const operationalSettingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  codMaxDistanceKm: { type: Number, default: 25, min: 0, max: 1000 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true });

export default mongoose.model("OperationalSetting", operationalSettingSchema);

import mongoose from "mongoose";

const OfficerSchema = new mongoose.Schema(
  {
    mobile:      { type: String, required: true, unique: true },
    password:    { type: String, required: true },
    name:        { type: String, required: true },
    badgeNumber: { type: String, required: true, unique: true },
    username:    { type: String }, // Optional fallback so socket token payloads remain backward compatible
    department:  { type: String, default: "Night Patrol" },
    station:     { type: String, default: "Main Station" },
    role:        { type: String, default: "officer" },
    active:      { type: Boolean, default: true },
  },
  { timestamps: true }
);

const Officer = mongoose.models.Officer || mongoose.model("Officer", OfficerSchema);
export default Officer;

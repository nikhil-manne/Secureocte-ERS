import mongoose from "mongoose";

const walkSessionSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    username: { type: String, required: true },

    startLocation: {
      latitude: Number,
      longitude: Number,
    },

    currentLocation: {
      latitude: Number,
      longitude: Number,
    },

    status: {
      type: String,
      enum: ["ACTIVE", "STOPPED"],
      default: "ACTIVE",
    },

    startedAt: { type: Date, default: Date.now },
    stoppedAt: { type: Date },
  },
  { timestamps: true }
);

export default mongoose.model("WalkSession", walkSessionSchema);

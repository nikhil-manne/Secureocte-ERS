import mongoose from "mongoose";

const userLocationSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
    },
    username: {
      type: String,
      default: null,          // populated on panic trigger — used by dashboard for display
    },
    latitude: {
      type: Number,
      required: true,
    },
    longitude: {
      type: Number,
      required: true,
    },
    alertId: {
      type: String,
      required: true,
    },
    alertReason: {
      type: String,
      enum: [
        "MANUAL_PANIC",
        "SAFETY_CHECK_NO_RESPONSE",
        "SAFETY_CHECK_NO",
        "OTHER",
      ],
      default: "MANUAL_PANIC",
    },
  },
  { timestamps: true }
);

export default mongoose.model("UserLocation", userLocationSchema);

import mongoose from "mongoose";

const CabEscortTripSchema = new mongoose.Schema(
  {
    /* ---------------------------
       ✅ USER DETAILS
    --------------------------- */

    userId: {
      type: String,
      required: true,
    },

    // ✅ Added: Store username directly
    username: {
      type: String,
      default: "",
    },

    /* ---------------------------
       ✅ DESTINATION DETAILS
    --------------------------- */

    destination: {
      latitude: {
        type: Number,
        required: true,
      },
      longitude: {
        type: Number,
        required: true,
      },

      // ✅ Optional: Address name from Google Places
      address: {
        type: String,
        default: "",
      },
    },

    /* ---------------------------
       ✅ VEHICLE DETAILS
    --------------------------- */

    vehicleNumber: {
      type: String,
      default: "",
    },

    vehicleType: {
      type: String,
      default: "",
    },

    /* ---------------------------
       ✅ LIVE LOCATION UPDATES
    --------------------------- */

    currentLocation: {
      latitude: {
        type: Number,
        default: null,
      },
      longitude: {
        type: Number,
        default: null,
      },
    },

    /* ---------------------------
       🚨 POLICE SUPPORT TRIGGER
    --------------------------- */

    policeSupportRequested: {
      type: Boolean,
      default: false,
    },

    /* ---------------------------
       ✅ TRIP STATUS
    --------------------------- */

    status: {
      type: String,
      enum: ["active", "completed"],
      default: "active",
    },
  },

  /* ---------------------------
     ✅ AUTO TIMESTAMPS
     createdAt + updatedAt
  --------------------------- */
  { timestamps: true }
);

export default mongoose.model("CabEscortTrip", CabEscortTripSchema);

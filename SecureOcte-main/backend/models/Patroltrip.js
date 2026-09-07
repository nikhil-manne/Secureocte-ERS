import mongoose from "mongoose";

const PatrolTripSchema = new mongoose.Schema(
  {
    /* ---------------------------
       OFFICER DETAILS
    --------------------------- */
    officerId: {
      type: String,
      required: true,
    },
    officerName: {
      type: String,
      default: "",
    },
    badgeNumber: {
      type: String,
      default: "",
    },

    /* ---------------------------
       VEHICLE DETAILS
    --------------------------- */
    vehicleNumber: {
      type: String,
      default: "",
    },
    vehicleType: {
      type: String,
      default: "patrol_car", // patrol_car | motorcycle | van
    },

    /* ---------------------------
       PATROL ZONE
    --------------------------- */
    patrolZone: {
      type: String,
      default: "",
    },

    /* ---------------------------
       LIVE LOCATION
       Overwritten every 5 seconds — no history stored
    --------------------------- */
    currentLocation: {
      latitude:  { type: Number, default: null },
      longitude: { type: Number, default: null },
    },

    /* ---------------------------
       EXPO PUSH TOKEN
       Registered on patrol start so backend can push dispatch alerts
    --------------------------- */
    expoPushToken: {
      type: String,
      default: null,
    },

    /* ---------------------------
       DISPATCHED ALERT
       Set by ground station when forwarding a victim to this patrol unit.
       The officer app polls /pending-dispatch/:tripId and shows a banner.
    --------------------------- */
    dispatchedAlert: {
      latitude:     { type: Number, default: null },
      longitude:    { type: Number, default: null },
      userName:     { type: String, default: null },
      alertType:    { type: String, default: null },
      dispatchedAt: { type: Date,   default: null },
      acknowledged: { type: Boolean, default: false },
    },

    /* ---------------------------
       TRIP STATUS
    --------------------------- */
    status: {
      type: String,
      enum: ["active", "completed"],
      default: "active",
    },
  },
  { timestamps: true }
);

export default mongoose.model("PatrolTrip", PatrolTripSchema);

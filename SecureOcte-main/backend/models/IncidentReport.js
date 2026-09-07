import mongoose from "mongoose";

const IncidentReportSchema = new mongoose.Schema(
  {
    /* ---------------------------
       REPORTER DETAILS
    --------------------------- */
    userId: {
      type: String,
      required: true,
      index: true,
    },
    username: {
      type: String,
      default: "",
    },

    /* ---------------------------
       INCIDENT DETAILS
    --------------------------- */
    category: {
      type: String,
      enum: ["Public Disturbance", "Suspicious Gathering", "Risky Behavior"],
      required: true,
    },
    crowdSize: {
      type: String,
      enum: ["Single person", "Small group (2–5)", "Medium group (6–10)", "Large group (10+)"],
      required: true,
    },
    behaviorIndicators: {
      type: [String],
      default: [],
    },
    note: {
      type: String,
      maxlength: 500,
      default: "",
    },

    /* ---------------------------
       LOCATION
    --------------------------- */
    location: {
      latitude:  { type: Number, required: true },
      longitude: { type: Number, required: true },
    },

    /* ---------------------------
       ASSIGNED PATROL
    --------------------------- */
    assignedPatrolTripId: {
      type: String,
      default: null,
    },
    assignedOfficerName: {
      type: String,
      default: null,
    },

    /* ---------------------------
       STATUS
    --------------------------- */
    status: {
      type: String,
      enum: ["pending", "acknowledged", "resolved"],
      default: "pending",
    },

    /* ---------------------------
       TTL — auto-delete after 7 days
    --------------------------- */
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true }
);

// Auto-delete after 7 days
IncidentReportSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

export default mongoose.model("IncidentReport", IncidentReportSchema);

"use strict";

const mongoose = require("mongoose");

const NetworkAlertSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, index: true },
    state: { type: String, required: true, index: true },
    reason: { type: String, default: "" },
    batteryPct: { type: Number, default: null },
    mode: { type: String, default: "secureme" },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    lastSeen: { type: Date, default: null },
    source: { type: String, default: "secureme" },
    metadata: { type: Object, default: {} },
  },
  {
    timestamps: true,
    collection: "network_alerts",
  }
);

module.exports = mongoose.models.NetworkAlert || mongoose.model("NetworkAlert", NetworkAlertSchema);

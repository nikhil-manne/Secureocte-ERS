import express from "express";
import { createRequire } from "module";

import adminAuth from "../middlewares/adminAuth.js";
import verifyToken from "../middlewares/verifyToken.js";
import replayProtection from "../middlewares/replayProtection.js";

const require = createRequire(import.meta.url);
const NetworkAlert = require("../models/NetworkAlert.cjs");

const router = express.Router();

router.get("/", adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    const [alerts, total] = await Promise.all([
      NetworkAlert.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      NetworkAlert.countDocuments(),
    ]);

    res.json({
      alerts,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load network alerts" });
  }
});

router.post("/", verifyToken, replayProtection, async (req, res) => {
  try {
    const alert = await NetworkAlert.create({
      username: req.body?.username || req.body?.user || req.user?.username || req.user?.userId || "unknown",
      state: req.body?.state || req.body?.status || "UNKNOWN",
      reason: req.body?.reason || "",
      batteryPct: req.body?.batteryPct ?? null,
      mode: req.body?.mode || "secureme",
      lat: req.body?.lat ?? null,
      lng: req.body?.lng ?? null,
      lastSeen: req.body?.lastSeen ? new Date(req.body.lastSeen) : null,
      source: req.body?.source || "api",
      metadata: req.body?.metadata || {},
    });

    res.status(201).json({ ok: true, alert });
  } catch (err) {
    res.status(500).json({ error: "Failed to create network alert" });
  }
});

export default router;

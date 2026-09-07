/**
 * routes/panicRoutes.js  (HARDENED)
 * ─────────────────────────────────────────────────────────────
 * H2 — Multi-window panic limiter (10s / 1m / 10m)
 * H3 — 503 if queue at capacity
 * H4 — Standardized error responses
 * H7 — Admin action logging
 * ─────────────────────────────────────────────────────────────
 */

import express from "express";
import { v4 as uuidv4 } from "uuid";

import verifyToken      from "../middlewares/verifyToken.js";
import replayProtection from "../middlewares/replayProtection.js";
import { panicLimiter } from "../middlewares/panicLimiter.js";
import { trackingLimiter } from "../middlewares/distributedRateLimit.js";
import { panicGpsGuard } from "../middlewares/gpsGuard.js";
import { validate }     from "../middlewares/validate.js";
import { panicSchema, locationUpdateSchema } from "../middlewares/validationSchemas.js";
import { triggerAlert } from "../services/alertService.js";
import { triggerAlertMode, resolveAlertMode } from "../socket/socketManager.js";
import logger           from "../config/logger.js";
import redisClient      from "../config/redisCluster.js";
import { RedisStore }   from "rate-limit-redis";
import rateLimit        from "express-rate-limit";

import UserLocation from "../models/userLocation.js";
import Panic        from "../models/panic.js";
import User         from "../models/User.js";

const router = express.Router();

/* ── H2: Live-location update limiter — 60 / min (tracking spec) ── */
const locationUpdateLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  keyGenerator: (req) => req.user?.userId || req.ip,
  handler: (req, res) =>
    res.status(429).json({ error: "Too many location updates." }),
  store: redisClient
    ? new RedisStore({ sendCommand: (...a) => redisClient.call(...a), prefix: "rl:loc:" })
    : undefined,
  standardHeaders: false,   // H4
  legacyHeaders:   false,
});

/* ─────────────────────────────────────────────────────────────
   GET /api/panic  — all alerts (admin only)
───────────────────────────────────────────────────────────── */
router.get("/", verifyToken, async (req, res, next) => {
  try {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Unauthorized" });
    const panics = await Panic.find().sort({ createdAt: -1 });
    // H7 — log admin data access
    logger.info({ msg: "[Admin] Panic list accessed", adminUser: req.user.username });
    res.status(200).json(panics);
  } catch (err) {
    next(err);
  }
});

/* ─────────────────────────────────────────────────────────────
   GET /api/panic/locations  — dashboard map feed (admin only)
───────────────────────────────────────────────────────────── */
router.get("/locations", verifyToken, async (req, res, next) => {
  try {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Unauthorized" });
    const locations = await UserLocation.find().sort({ updatedAt: -1 });

    // Populate username for any records where it was not saved at alert time
    // (e.g. old JWT tokens that didn't carry username, or mobile app omitted it)
    const missingIds = locations
      .filter(l => !l.username)
      .map(l => l.userId);

    if (missingIds.length) {
      const dbUsers = await User.find({ _id: { $in: missingIds } }).select("_id username");
      const userMap = Object.fromEntries(dbUsers.map(u => [u._id.toString(), u.username]));
      locations.forEach(l => {
        if (!l.username) l.username = userMap[l.userId] || null;
      });
    }

    logger.info({ msg: "[Admin] Location map accessed", adminUser: req.user.username });
    res.json(locations);
  } catch (err) {
    next(err);
  }
});

/* ── Test endpoint ── */
router.get("/test", verifyToken, (req, res) => {
  res.json({ message: "✅ Panic routes working (hardened)" });
});

/* ─────────────────────────────────────────────────────────────
   POST /api/panic  — TRIGGER PANIC
   H2 — 3-window rate limits
   H3 — 503 if queue at capacity
   H7 — Panic trigger logged
───────────────────────────────────────────────────────────── */
router.post(
  "/",
  verifyToken,
  replayProtection,
  ...panicLimiter,          // H2 — [10s, 1m, 10m] windows
  validate(panicSchema),
  panicGpsGuard,
  async (req, res, next) => {
    try {
      const alertId = uuidv4();

      // H7 — log every panic trigger with full context
      logger.info({
        msg:      "[PANIC] Trigger received",
        alertId,
        userId:   req.user.userId,
        username: req.user.username,
        lat:      req.body.latitude,
        lng:      req.body.longitude,
        reason:   req.body.alertReason || "MANUAL_PANIC",
        deviceId: req.user.deviceId,
        ip:       req.ip,
      });

      await triggerAlert(
        {
          alertId,
          latitude:    req.body.latitude,
          longitude:   req.body.longitude,
          alertReason: req.body.alertReason || "MANUAL_PANIC",
          accuracy:    req.body.accuracy,
        },
        req.user
      );

      // WebSocket: switch user to alert mode (5 s location interval)
      await triggerAlertMode(req.user.userId);

      return res.status(201).json({ message: "Panic received", alertId });
    } catch (err) {
      // H3 — queue at capacity → 503
      if (err.message === "QUEUE_UNAVAILABLE") {
        logger.error({ msg: "[PANIC] Queue unavailable", userId: req.user.userId });
        return res.status(503).json({ error: "Service temporarily unavailable. Please call emergency services." });
      }
      next(err);
    }
  }
);

/* ─────────────────────────────────────────────────────────────
   PUT /api/panic/location  — live location updates
   H2 — tracking limiter (60/min)
───────────────────────────────────────────────────────────── */
router.put(
  "/location",
  verifyToken,
  replayProtection,
  panicGpsGuard,
  ...trackingLimiter,       // H2 — 60/min tracking spec
  locationUpdateLimiter,
  validate(locationUpdateSchema),
  async (req, res, next) => {
    try {
      const { alertId, latitude, longitude } = req.body;
      const userId = req.user.userId;

      const location = await UserLocation.findOne({ alertId, userId });
      if (!location) {
        return res.status(404).json({ error: "Active panic session not found" });
      }

      location.latitude  = latitude;
      location.longitude = longitude;
      location.updatedAt = new Date();
      await location.save();

      await Panic.findOneAndUpdate(
        { userId },
        { "location.lat": latitude, "location.lng": longitude }
      );

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

/* ─────────────────────────────────────────────────────────────
   DELETE /api/panic  — user clears own session
   H7 — log clearance
───────────────────────────────────────────────────────────── */
router.delete("/", verifyToken, async (req, res, next) => {
  try {
    const userId = req.user.userId;
    await Promise.all([
      UserLocation.deleteMany({ userId }),
      Panic.deleteMany({ userId }),
    ]);
    // WebSocket: restore normal mode (15 s interval)
    await resolveAlertMode(userId);
    logger.info({ msg: "[PANIC] Cleared by user", userId });
    res.json({ message: "Panic cleared" });
  } catch (err) {
    next(err);
  }
});

export default router;

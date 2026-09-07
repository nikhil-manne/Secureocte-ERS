/**
 * routes/stream.js  (v3 — hardened)
 * ─────────────────────────────────────────────────────────────
 * FIX 6: stream GET now checks existence (404) AND expiry (410).
 *        streamLimiter + verifyToken enforced on create.
 * ─────────────────────────────────────────────────────────────
 */

import express from "express";
import { v4 as uuidv4 } from "uuid";

import verifyToken from "../middlewares/verifyToken.js";
import streamLimiter from "../middlewares/streamLimiter.js";
import { validate } from "../middlewares/validate.js";
import { streamCreateSchema } from "../middlewares/validationSchemas.js";
import logger from "../config/logger.js";

import LiveStream from "../models/LiveStream.js";
import UserLocation from "../models/userLocation.js";
import CabEscortTrip from "../models/CabEscortTrip.js";

const router = express.Router();

async function resolveUser(userId) {
  let loc = await UserLocation.findOne({ userId }).sort({ updatedAt: -1 });
  if (loc) return { canonicalUserId: loc.userId, source: "panic" };

  loc = await UserLocation.findOne({ username: userId }).sort({ updatedAt: -1 });
  if (loc) return { canonicalUserId: loc.userId, source: "panic" };

  const cabTrip = await CabEscortTrip.findOne({ userId, status: "active" }).sort({ updatedAt: -1 });
  if (cabTrip) return { canonicalUserId: cabTrip.userId, source: "cab" };

  const cabTripByName = await CabEscortTrip.findOne({ username: userId, status: "active" }).sort({ updatedAt: -1 });
  if (cabTripByName) return { canonicalUserId: cabTripByName.userId, source: "cab" };

  return null;
}

/* ─────────────────────────────────────────────
   POST /api/stream/create
   Stack: streamLimiter → verifyToken → validate
───────────────────────────────────────────── */
router.post(
  "/create",
  streamLimiter,
  verifyToken,
  validate(streamCreateSchema),
  async (req, res, next) => {
    try {
      const { userId } = req.body;
      const resolved = await resolveUser(userId);

      if (!resolved) {
        return res.status(404).json({
          error: "No active session found for this user.",
        });
      }

      const streamId = uuidv4();
      await LiveStream.create({ streamId, userId: resolved.canonicalUserId });

      logger.info({ msg: "[Stream] Created", streamId, userId: resolved.canonicalUserId });

      res.json({
        streamId,
        streamUrl: `${process.env.PUBLIC_BASE_URL || "https://server-r9k4.onrender.com"}/stream/${streamId}`,
      });
    } catch (err) {
      next(err);
    }
  }
);

/* ─────────────────────────────────────────────
   GET /api/stream/:streamId
   Public — rate-limited per IP.
   FIX 6: 404 if not found, 410 if expired.
───────────────────────────────────────────── */
router.get("/:streamId", streamLimiter, async (req, res, next) => {
  try {
    const stream = await LiveStream.findOne({ streamId: req.params.streamId });

    /* FIX 6 — existence check */
    if (!stream) {
      return res.status(404).json({ error: "Stream not found" });
    }

    /* FIX 6 — expiry check */
    if (stream.expiresAt && new Date() > stream.expiresAt) {
      return res.status(410).json({ error: "Stream has expired" });
    }

    /* Panic location */
    const panicLocation = await UserLocation
      .findOne({ userId: stream.userId })
      .sort({ updatedAt: -1 });

    if (panicLocation) {
      return res.json({
        userId: panicLocation.userId,
        username: panicLocation.username,
        latitude: panicLocation.latitude,
        longitude: panicLocation.longitude,
        alertId: panicLocation.alertId,
        updatedAt: panicLocation.updatedAt,
        source: "panic",
      });
    }

    /* Cab trip fallback */
    const cabTrip = await CabEscortTrip
      .findOne({ userId: stream.userId, status: "active" })
      .sort({ updatedAt: -1 });

    if (cabTrip?.currentLocation?.latitude != null) {
      return res.json({
        userId: cabTrip.userId,
        username: cabTrip.username,
        latitude: cabTrip.currentLocation.latitude,
        longitude: cabTrip.currentLocation.longitude,
        updatedAt: cabTrip.updatedAt,
        source: "cab",
      });
    }

    return res.status(404).json({
      error: "No location data available yet.",
    });
  } catch (err) {
    next(err);
  }
});

export default router;

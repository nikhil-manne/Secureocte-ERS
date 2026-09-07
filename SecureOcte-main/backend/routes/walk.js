import verifyToken from "../middlewares/verifyToken.js";
import logger from "../config/logger.js";
import express from "express";
import rateLimit from "express-rate-limit";
import WalkSession from "../models/WalkSession.js";
import User from "../models/User.js";
import { triggerAlertMode, resolveAlertMode } from "../socket/socketManager.js";

const router = express.Router();

/* ── Per-route rate limits ──────────────────────────────────── */
const trackingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.user?.userId || req.ip,
  handler: (req, res) => res.status(429).json({ error: "Too many location updates. Slow down." }),
  standardHeaders: true, legacyHeaders: false,
});

/* ── Coord validation helper ────────────────────────────────── */
function validCoords(lat, lng) {
  return (
    lat != null && lng != null &&
    typeof lat === "number" && typeof lng === "number" &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180
  );
}

/* =========================================
   START WALK MONITORING SESSION
   POST /api/walk/start
========================================= */
router.post("/start", verifyToken, async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    const userId = req.user.userId;

    /* ── Resolve username ──────────────────────────────────────
       Priority:
         1. req.body.username  — mobile app always sends this
         2. req.user.username  — present in tokens after auth.js update
         3. DB lookup          — guaranteed fallback for any edge case
    ─────────────────────────────────────────────────────────── */
    let username = req.body.username        // sent explicitly by mobile app
                || req.user.username        // embedded in JWT (new tokens)
                || "";

    if (!username) {
      try {
        const dbUser = await User.findById(userId).select("username");
        if (dbUser?.username) username = dbUser.username;
      } catch { /* non-fatal */ }
    }
    if (!username) username = "Unknown";

    if (!validCoords(latitude, longitude)) {
      return res.status(400).json({ error: "Valid latitude and longitude required" });
    }

    const session = await WalkSession.create({
      userId,
      username,
      startLocation: { latitude, longitude },
      status: "ACTIVE",
    });

    res.json({ message: "✅ Walk Monitoring Started", session });
  } catch (err) {
    logger.error("Walk Start Error:", err);
    res.status(500).json({ error: "Failed to start walk session" });
  }
});

/* =========================================
   STOP WALK MONITORING SESSION
   POST /api/walk/stop/:id
========================================= */
router.post("/stop/:id", verifyToken, async (req, res) => {
  try {
    const session = await WalkSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    if (req.user.role !== "admin" && session.userId.toString() !== req.user.userId.toString()) {
      return res.status(403).json({ error: "Not authorised to stop this session" });
    }

    session.status    = "STOPPED";
    session.stoppedAt = new Date();
    await session.save();

    // WebSocket: restore normal mode when walk ends safely
    await resolveAlertMode(session.userId);

    res.json({ message: "⏹ Walk Monitoring Stopped", session });
  } catch (err) {
    logger.error("Walk Stop Error:", err);
    res.status(500).json({ error: "Failed to stop walk session" });
  }
});

/* =========================================
   GET ACTIVE WALK MONITORING SESSIONS
   GET /api/walk/active
========================================= */
router.get("/active", verifyToken, async (req, res) => {
  try {
    const sessions = await WalkSession.find({ status: "ACTIVE" }).sort({ startedAt: -1 });
    res.json(sessions);
  } catch (err) {
    logger.error("Active Walk Fetch Error:", err);
    res.status(500).json({ error: "Failed to fetch active sessions" });
  }
});

/* =========================================
   GET STOPPED WALK MONITORING SESSIONS
   GET /api/walk/stopped
========================================= */
router.get("/stopped", verifyToken, async (req, res) => {
  try {
    const sessions = await WalkSession.find({ status: "STOPPED" }).sort({ stoppedAt: -1 });
    res.json(sessions);
  } catch (err) {
    logger.error("Stopped Walk Fetch Error:", err);
    res.status(500).json({ error: "Failed to fetch stopped sessions" });
  }
});

/* =========================================
   GET WALK HISTORY
   GET /api/walk/history
========================================= */
router.get("/history", verifyToken, async (req, res) => {
  try {
    const sessions = await WalkSession.find({ status: "STOPPED" })
      .sort({ stoppedAt: -1 })
      .limit(500);

    const normalised = sessions.map((s) => ({
      ...s.toObject(),
      status:  "completed",
      endedAt: s.stoppedAt,
    }));

    res.json(normalised);
  } catch (err) {
    logger.error("Walk History Error:", err);
    res.status(500).json({ error: "Failed to fetch walk history" });
  }
});

/* =========================================
   RESTART WALK SESSION
   POST /api/walk/restart/:id
========================================= */
router.post("/restart/:id", verifyToken, async (req, res) => {
  try {
    const session = await WalkSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    if (session.userId.toString() !== req.user.userId.toString()) {
      return res.status(403).json({ error: "Not authorised to restart this session" });
    }

    if (session.status !== "STOPPED") {
      return res.status(400).json({ error: "Only STOPPED sessions can be restarted" });
    }

    session.status    = "ACTIVE";
    session.startedAt = new Date();
    session.stoppedAt = null;
    await session.save();

    res.json({ message: "✅ Walk Monitoring Restarted Successfully", session });
  } catch (err) {
    logger.error("Walk Restart Error:", err);
    res.status(500).json({ error: "Failed to restart walk session" });
  }
});

export default router;

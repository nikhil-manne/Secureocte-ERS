/**
 * routes/incidentRoutes.js
 * ─────────────────────────────────────────────────────────────
 * Citizen incident reporting → nearest patrol vehicle.
 *
 * POST /api/incident/report
 *   - Validates & saves the report
 *   - Finds the nearest active patrol trip (by Haversine distance)
 *   - Dispatches a push notification to that patrol unit
 *   - Returns the incident id + assigned patrol info
 *
 * GET /api/incident/my-reports
 *   - Returns all reports submitted by the authenticated citizen
 *
 * GET /api/incident/pending  (admin only)
 *   - Returns all pending incident reports
 *
 * POST /api/incident/acknowledge/:id  (patrol officer / admin)
 *   - Officer marks a report acknowledged / resolved
 */

import express        from "express";
import rateLimit      from "express-rate-limit";
import verifyToken    from "../middlewares/verifyToken.js";
import logger         from "../config/logger.js";
import IncidentReport from "../models/IncidentReport.js";
import PatrolTrip     from "../models/Patroltrip.js";

const router = express.Router();

/* ── Rate limiter: max 5 reports per 10 minutes per user ── */
const reportLimiter = rateLimit({
  windowMs:     10 * 60 * 1000,
  max:          5,
  keyGenerator: (req) => req.user?.userId || req.ip,
  handler:      (req, res) =>
    res.status(429).json({ error: "Too many reports submitted. Please wait before reporting again." }),
  standardHeaders: true,
  legacyHeaders:   false,
});

/* ── Constants ── */
const VALID_CATEGORIES = ["Public Disturbance", "Suspicious Gathering", "Risky Behavior"];

const VALID_CROWD_SIZES = [
  "Single person",
  "Small group (2–5)",
  "Medium group (6–10)",
  "Large group (10+)",
];

const BEHAVIOR_MAP = {
  "Public Disturbance":  ["loud shouting", "drinking visible", "smoking visible", "blocking pathway"],
  "Suspicious Gathering":["loitering", "watching passersby", "blocking entry", "staying long duration"],
  "Risky Behavior":      ["aggressive tone", "harassment signs", "chasing", "threatening gestures"],
};

/* ── Helpers ── */
function validCoords(lat, lng) {
  return (
    lat != null && lng != null &&
    typeof lat === "number" && typeof lng === "number" &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180
  );
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function sendExpoPush(token, title, body, data = {}) {
  if (!token || !token.startsWith("ExponentPushToken")) return false;
  try {
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method:  "POST",
      headers: {
        "Content-Type":    "application/json",
        Accept:            "application/json",
        "Accept-Encoding": "gzip, deflate",
      },
      body: JSON.stringify({ to: token, sound: "default", priority: "high", title, body, data }),
    });
    const json = await res.json();
    return json?.data?.status === "ok";
  } catch (err) {
    logger.error("[Incident] Push error:", err);
    return false;
  }
}

/* ────────────────────────────────────────────────
   POST /api/incident/report
─────────────────────────────────────────────────*/
router.post("/report", verifyToken, reportLimiter, async (req, res) => {
  try {
    const {
      category,
      crowdSize,
      behaviorIndicators = [],
      note = "",
      latitude,
      longitude,
    } = req.body;

    /* ── Validation ── */
    if (!VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: "Invalid incident category." });
    }
    if (!VALID_CROWD_SIZES.includes(crowdSize)) {
      return res.status(400).json({ error: "Invalid crowd size selection." });
    }
    if (!validCoords(latitude, longitude)) {
      return res.status(400).json({ error: "Valid latitude and longitude required." });
    }
    if (!Array.isArray(behaviorIndicators)) {
      return res.status(400).json({ error: "behaviorIndicators must be an array." });
    }

    // Validate each indicator belongs to this category
    const allowedIndicators = BEHAVIOR_MAP[category] || [];
    const invalidIndicators = behaviorIndicators.filter(
      (b) => typeof b !== "string" || !allowedIndicators.includes(b)
    );
    if (invalidIndicators.length > 0) {
      return res.status(400).json({
        error: `Invalid behavior indicators for "${category}": ${invalidIndicators.join(", ")}`,
      });
    }

    if (note && typeof note !== "string") {
      return res.status(400).json({ error: "Note must be a string." });
    }
    if (note && note.length > 500) {
      return res.status(400).json({ error: "Note must be 500 characters or fewer." });
    }

    /* ── Find nearest active patrol vehicle ── */
    const activeTrips = await PatrolTrip.find({ status: "active" });

    let nearestTrip    = null;
    let nearestDistKm  = Infinity;

    for (const trip of activeTrips) {
      const { latitude: pLat, longitude: pLng } = trip.currentLocation || {};
      if (pLat == null || pLng == null) continue;
      const dist = haversineKm(latitude, longitude, pLat, pLng);
      if (dist < nearestDistKm) {
        nearestDistKm = dist;
        nearestTrip   = trip;
      }
    }

    /* ── Save the report ── */
    const report = new IncidentReport({
      userId:               req.user.userId,
      username:             req.user.username || "",
      category,
      crowdSize,
      behaviorIndicators,
      note:                 note.trim(),
      location:             { latitude, longitude },
      assignedPatrolTripId: nearestTrip ? String(nearestTrip._id) : null,
      assignedOfficerName:  nearestTrip ? nearestTrip.officerName : null,
      status:               "pending",
    });

    await report.save();

    /* ── Push notification to patrol officer ── */
    let pushSent = false;
    if (nearestTrip?.expoPushToken) {
      pushSent = await sendExpoPush(
        nearestTrip.expoPushToken,
        `🚨 Incident Report — ${category}`,
        `${crowdSize} · ${(behaviorIndicators[0] || "reported")} · ${
          nearestDistKm < 1
            ? `${Math.round(nearestDistKm * 1000)} m away`
            : `${nearestDistKm.toFixed(1)} km away`
        }`,
        {
          type:       "INCIDENT_REPORT",
          reportId:   String(report._id),
          latitude,
          longitude,
          category,
          crowdSize,
          behaviorIndicators,
          note:       note.trim(),
          userName:   req.user.username || "Citizen",
          distanceKm: nearestDistKm,
        }
      );
    }

    logger.info({
      msg:       "[Incident] Report submitted",
      reportId:  report._id,
      category,
      nearestPatrol: nearestTrip?._id || null,
      distKm:   nearestDistKm === Infinity ? null : nearestDistKm,
      pushSent,
    });

    res.json({
      success:    true,
      message:    "Incident report submitted. Authorities will review shortly.",
      reportId:   report._id,
      assignedPatrol: nearestTrip
        ? {
            officerName:  nearestTrip.officerName,
            vehicleNumber: nearestTrip.vehicleNumber,
            distanceKm:   parseFloat(nearestDistKm.toFixed(2)),
          }
        : null,
      pushSent,
    });
  } catch (err) {
    logger.error("[Incident] Report error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ────────────────────────────────────────────────
   GET /api/incident/my-reports
─────────────────────────────────────────────────*/
router.get("/my-reports", verifyToken, async (req, res) => {
  try {
    const reports = await IncidentReport.find({ userId: req.user.userId })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ success: true, reports });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ────────────────────────────────────────────────
   GET /api/incident/assigned/:tripId
   ─────────────────────────────────────────────────
   Called by patrol officer app every 5 s.
   Returns all non-resolved incident reports that
   were assigned to this patrol trip, newest first.
   The officer's own tripId is used — no admin role
   required, just a valid token.
─────────────────────────────────────────────────*/
router.get("/assigned/:tripId", verifyToken, async (req, res) => {
  try {
    const { tripId } = req.params;

    // Confirm this trip belongs to the requesting officer (or admin)
    const trip = await PatrolTrip.findById(tripId);
    if (!trip) return res.status(404).json({ error: "Patrol trip not found" });

    if (
      req.user.role !== "admin" &&
      trip.officerId.toString() !== req.user.userId.toString()
    ) {
      return res.status(403).json({ error: "Not authorised to view incidents for this trip" });
    }

    const reports = await IncidentReport.find({
      assignedPatrolTripId: tripId,
      status: { $in: ["pending", "acknowledged"] },   // exclude resolved
    }).sort({ createdAt: -1 });

    res.json({ success: true, reports });
  } catch (err) {
    logger.error("[Incident] assigned fetch error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ────────────────────────────────────────────────
   GET /api/incident/all  (admin only)
   Returns every incident report — pending, acknowledged,
   AND resolved — newest first. Used by the dashboard so
   resolved reports are never hidden.
─────────────────────────────────────────────────*/
router.get("/all", verifyToken, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin access only" });
    }
    const reports = await IncidentReport.find({})
      .sort({ createdAt: -1 })
      .limit(500);
    res.json({ success: true, reports });
  } catch (err) {
    logger.error("[Incident] all fetch error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ────────────────────────────────────────────────
   GET /api/incident/pending  (admin only)
─────────────────────────────────────────────────*/
router.get("/pending", verifyToken, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin access only" });
    }
    const reports = await IncidentReport.find({ status: "pending" })
      .sort({ createdAt: -1 })
      .limit(200);
    res.json({ success: true, reports });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ────────────────────────────────────────────────
   POST /api/incident/acknowledge/:id
─────────────────────────────────────────────────*/
router.post("/acknowledge/:id", verifyToken, async (req, res) => {
  try {
    const { status } = req.body; // "acknowledged" | "resolved"
    const allowed = ["acknowledged", "resolved"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(", ")}` });
    }

    const report = await IncidentReport.findById(req.params.id);
    if (!report) return res.status(404).json({ error: "Report not found" });

    // Only the assigned officer or admin may update status
    const isAdmin    = req.user.role === "admin";
    const isOfficer  = report.assignedPatrolTripId
      ? await PatrolTrip.findOne({
          _id:       report.assignedPatrolTripId,
          officerId: req.user.userId,
        })
      : false;

    if (!isAdmin && !isOfficer) {
      return res.status(403).json({ error: "Not authorised to update this report" });
    }

    report.status = status;
    await report.save();

    res.json({ success: true, message: `Report marked as ${status}`, reportId: report._id });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

import verifyToken from "../middlewares/verifyToken.js";
import logger from "../config/logger.js";
import replayProtection from "../middlewares/replayProtection.js";
import { makeGpsGuard } from "../middlewares/gpsAnomalyGuard.js";
import express from "express";
import rateLimit from "express-rate-limit";
import PatrolTrip from "../models/Patroltrip.js";

const router = express.Router();

// GPS guard — keyed by tripId so each patrol vehicle has its own stream
const patrolGpsGuard = makeGpsGuard((req) => `patrol:${req.body?.tripId}`);

/* ── Per-route rate limits ──────────────────────────────────── */
const trackingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.user?.userId || req.ip,
  handler: (req, res) => res.status(429).json({ error: "Too many location updates." }),
  standardHeaders: true, legacyHeaders: false,
});

/* ── Coord validation ───────────────────────────────────────── */
function validCoords(lat, lng) {
  return (
    lat != null && lng != null &&
    typeof lat === "number" && typeof lng === "number" &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180
  );
}

/* -----------------------------------
   GET METHODS
----------------------------------- */

router.get("/", (req, res) => {
  res.json({ success: true, message: "Patrol API is working ✅" });
});

router.get("/active", verifyToken, async (req, res) => {
  try {
    const trips = await PatrolTrip.find({ status: "active" }).sort({ updatedAt: -1 });
    res.json({ success: true, trips });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ── Ownership: officers can only view their own trips ── */
router.get("/officer/:officerId", verifyToken, async (req, res) => {
  try {
    if (req.user.role !== "admin" && req.user.userId.toString() !== req.params.officerId) {
      return res.status(403).json({ error: "Not authorised to view another officer's trips" });
    }
    const trips = await PatrolTrip.find({ officerId: req.params.officerId }).sort({ createdAt: -1 });
    res.json({ success: true, trips });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/live/:tripId", verifyToken, async (req, res) => {
  try {
    const trip = await PatrolTrip.findById(req.params.tripId);
    if (!trip) return res.status(404).json({ success: false, message: "Patrol trip not found" });
    res.json({ success: true, tripId: trip._id, currentLocation: trip.currentLocation, updatedAt: trip.updatedAt });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/pending-dispatch/:tripId", verifyToken, async (req, res) => {
  try {
    const trip = await PatrolTrip.findById(req.params.tripId);
    if (!trip) return res.status(404).json({ success: false, message: "Patrol trip not found" });

    const d = trip.dispatchedAlert;
    const hasDispatch = d && d.latitude != null && d.longitude != null && d.dispatchedAt != null;

    if (!hasDispatch) return res.json({ success: true, dispatch: null });

    res.json({
      success: true,
      dispatch: {
        latitude:     d.latitude,
        longitude:    d.longitude,
        userName:     d.userName,
        alertType:    d.alertType,
        dispatchedAt: d.dispatchedAt,
        acknowledged: d.acknowledged,
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/history", verifyToken, async (req, res) => {
  try {
    const trips = await PatrolTrip.find({ status: "completed" }).sort({ updatedAt: -1 }).limit(500);
    res.json({ success: true, trips });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* -----------------------------------
   POST METHODS
----------------------------------- */

/* ── Start patrol — ownership from token ── */
router.post("/start", verifyToken, async (req, res) => {
  try {
    const { badgeNumber, vehicleNumber, vehicleType, patrolZone, currentLocation, expoPushToken } = req.body;

    /* ── Ownership: officerId from token ── */
    const officerId   = req.user.userId;
    const officerName = req.user.username || req.body.officerName || "";

    if (!badgeNumber || typeof badgeNumber !== "string" || badgeNumber.trim().length < 2) {
      return res.status(400).json({ error: "Valid badge number required" });
    }
    if (!vehicleNumber || typeof vehicleNumber !== "string" || vehicleNumber.trim().length < 3) {
      return res.status(400).json({ error: "Valid vehicle number required" });
    }
    if (currentLocation && !validCoords(currentLocation.latitude, currentLocation.longitude)) {
      return res.status(400).json({ error: "Valid coordinates required" });
    }

    const trip = new PatrolTrip({
      officerId,
      officerName,
      badgeNumber:   badgeNumber.trim(),
      vehicleNumber: vehicleNumber.trim().toUpperCase(),
      vehicleType:   vehicleType   || "patrol_car",
      patrolZone:    patrolZone    || "",
      currentLocation,
      expoPushToken: expoPushToken || null,
      status: "active",
    });

    await trip.save();
    res.json({ success: true, message: "Patrol trip started ✅", trip });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ── Update location — ownership check ── */
router.post("/update-location", verifyToken, replayProtection, patrolGpsGuard, trackingLimiter, async (req, res) => {
  try {
    const { tripId, latitude, longitude } = req.body;

    if (!tripId) return res.status(400).json({ error: "tripId required" });
    if (!validCoords(latitude, longitude)) {
      return res.status(400).json({ error: "Valid latitude and longitude required" });
    }

    const trip = await PatrolTrip.findById(tripId);
    if (!trip) return res.status(404).json({ success: false, message: "Patrol trip not found" });

    if (req.user.role !== "admin" && trip.officerId.toString() !== req.user.userId.toString()) {
      return res.status(403).json({ error: "Not authorised to update this patrol trip" });
    }

    await PatrolTrip.findByIdAndUpdate(tripId, {
      currentLocation: { latitude, longitude },
      updatedAt: new Date(),
    });

    res.json({ success: true, message: "Location updated ✅" });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ── Dispatch (admin only) ── */
router.post("/dispatch", verifyToken, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin access only" });
    }

    const { tripId, alertLat, alertLng, userName, alertType } = req.body;

    if (!tripId || alertLat == null || alertLng == null) {
      return res.status(400).json({ success: false, error: "tripId, alertLat and alertLng are required" });
    }
    if (!validCoords(alertLat, alertLng)) {
      return res.status(400).json({ error: "Valid alert coordinates required" });
    }

    const trip = await PatrolTrip.findById(tripId);
    if (!trip) return res.status(404).json({ success: false, message: "Patrol trip not found" });

    trip.dispatchedAlert = {
      latitude:     alertLat,
      longitude:    alertLng,
      userName:     userName  || "Unknown",
      alertType:    alertType || "alert",
      dispatchedAt: new Date(),
      acknowledged: false,
    };
    trip.markModified("dispatchedAlert");
    await trip.save();

    let pushSent = false;
    const pushToken = trip.expoPushToken;

    if (pushToken && pushToken.startsWith("ExponentPushToken")) {
      try {
        const typeLabel =
          alertType === "cab"      ? "🚖 Cab Alert"       :
          alertType === "walk"     ? "🚶 Walk Panic"      :
          alertType === "highrisk" ? "🚨 High Risk Alert" : "🆘 Alert";

        const payload = {
          to:       pushToken,
          sound:    "default",
          priority: "high",
          title:    `📨 Mission Dispatched — ${typeLabel}`,
          body:     `Victim: ${userName || "Unknown"} · Open app to navigate`,
          data: { type: "DISPATCH_ALERT", lat: alertLat, lng: alertLng, userName: userName || "Unknown", alertType: alertType || "alert", tripId },
        };

        const expoRes  = await fetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", "Accept-Encoding": "gzip, deflate" },
          body: JSON.stringify(payload),
        });
        const expoData = await expoRes.json();
        pushSent = expoData?.data?.status === "ok";
      } catch (pushErr) {
        logger.error("[Dispatch] Push notification error:", pushErr);
      }
    }

    res.json({ success: true, message: `Alert dispatched ✅ (push ${pushSent ? "sent" : "skipped"})`, tripId, pushSent });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ── Acknowledge dispatch ── */
router.post("/dispatch/acknowledge/:tripId", verifyToken, async (req, res) => {
  try {
    const trip = await PatrolTrip.findById(req.params.tripId);
    if (!trip) return res.status(404).json({ success: false, message: "Patrol trip not found" });

    if (req.user.role !== "admin" && trip.officerId.toString() !== req.user.userId.toString()) {
      return res.status(403).json({ error: "Not authorised to acknowledge this dispatch" });
    }

    await PatrolTrip.findByIdAndUpdate(req.params.tripId, { "dispatchedAlert.acknowledged": true });
    res.json({ success: true, message: "Dispatch acknowledged ✅" });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ── Complete patrol ── */
router.post("/complete/:tripId", verifyToken, async (req, res) => {
  try {
    const trip = await PatrolTrip.findById(req.params.tripId);
    if (!trip) return res.status(404).json({ success: false, message: "Patrol trip not found" });

    if (req.user.role !== "admin" && trip.officerId.toString() !== req.user.userId.toString()) {
      return res.status(403).json({ error: "Not authorised to complete this patrol trip" });
    }

    trip.status = "completed";
    await trip.save();
    res.json({ success: true, message: "Patrol trip completed ✅", trip });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ── Dynamic route MUST be last ── */
router.get("/:tripId", verifyToken, async (req, res) => {
  try {
    const trip = await PatrolTrip.findById(req.params.tripId);
    if (!trip) return res.status(404).json({ success: false, message: "Patrol trip not found" });
    res.json({ success: true, trip });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

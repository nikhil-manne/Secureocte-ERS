import verifyToken from "../middlewares/verifyToken.js";
import logger from "../config/logger.js";
import replayProtection from "../middlewares/replayProtection.js";
import { makeGpsGuard } from "../middlewares/gpsAnomalyGuard.js";
import express from "express";
import rateLimit from "express-rate-limit";
import CabEscortTrip from "../models/CabEscortTrip.js";
import User from "../models/User.js";
import { triggerAlertMode, resolveAlertMode } from "../socket/socketManager.js";

const router = express.Router();

// GPS guard — keyed by userId (each passenger has one cab location stream)
const cabGpsGuard = makeGpsGuard((req) => `cab:${req.user?.userId}`);

/* ── Per-route rate limits ──────────────────────────────────── */
const trackingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.user?.userId || req.ip,
  handler: (req, res) => res.status(429).json({ error: "Too many location updates." }),
  standardHeaders: true, legacyHeaders: false,
});

/* ── Trip start: 5 per minute per userId ─────────────────────── */
const tripStartLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.userId || req.ip,
  handler: (req, res) =>
    res.status(429).json({ error: "Too many trip starts. Please wait before trying again." }),
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

/* ── Vehicle number validation ──────────────────────────────── */
function validVehicleNumber(vn) {
  return typeof vn === "string" && vn.trim().length >= 3 && vn.trim().length <= 20;
}

/* -----------------------------------
   GET METHODS
----------------------------------- */

router.get("/", (req, res) => {
  res.json({ success: true, message: "Cab Escort API is working ✅" });
});

router.get("/active", verifyToken, async (req, res) => {
  try {
    const trips = await CabEscortTrip.find({ status: "active" }).sort({ createdAt: -1 });
    res.json({ success: true, trips });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ── Ownership: users can only view their own trips ── */
router.get("/user/:userId", verifyToken, async (req, res) => {
  try {
    const requestedId = req.params.userId;
    if (req.user.role !== "admin" && req.user.userId.toString() !== requestedId) {
      return res.status(403).json({ error: "Not authorised to view another user's trips" });
    }
    const trips = await CabEscortTrip.find({ userId: requestedId }).sort({ createdAt: -1 });
    res.json({ success: true, trips });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/police-support", verifyToken, async (req, res) => {
  try {
    const alerts = await CabEscortTrip.find({
      policeSupportRequested: true,
      status: "active",
    }).sort({ updatedAt: -1 });
    res.json({ success: true, alerts });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/live/:tripId", verifyToken, async (req, res) => {
  try {
    const trip = await CabEscortTrip.findById(req.params.tripId);
    if (!trip) return res.status(404).json({ success: false, message: "Trip not found" });
    res.json({ success: true, tripId: trip._id, currentLocation: trip.currentLocation, updatedAt: trip.updatedAt });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/history", verifyToken, async (req, res) => {
  try {
    const trips = await CabEscortTrip.find({ status: "completed" }).sort({ updatedAt: -1 }).limit(500);
    res.json({ success: true, trips });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* -----------------------------------
   POST METHODS
----------------------------------- */

/* ── Start Trip — upsert: update existing active trip instead of creating a new one ── */
router.post("/start", verifyToken, tripStartLimiter, async (req, res) => {
  try {
    const { destination, vehicleNumber, vehicleType, currentLocation } = req.body;

    /* ── Ownership: userId and username from token ── */
    const userId = req.user.userId;

    /* Prefer username from JWT, then req.body, fall back to DB lookup */
    let username = req.user.username || req.body.username || "";
    if (!username || username.toLowerCase() === "unknown") {
      try {
        const userDoc = await User.findById(userId).select("username");
        if (userDoc?.username) username = userDoc.username;
      } catch (_) {}
    }
    if (username.toLowerCase() === "unknown") username = "";

    /* destination is an object { latitude, longitude, address? } from the frontend */
    if (
      !destination ||
      typeof destination !== "object" ||
      !validCoords(destination.latitude, destination.longitude)
    ) {
      return res.status(400).json({ error: "Valid destination with latitude and longitude is required" });
    }
    /* vehicleNumber is optional — skip validation if not provided */
    if (vehicleNumber && !validVehicleNumber(vehicleNumber)) {
      return res.status(400).json({ error: "Vehicle number must be 3-20 characters" });
    }
    if (currentLocation && !validCoords(currentLocation.latitude, currentLocation.longitude)) {
      return res.status(400).json({ error: "Valid coordinates required" });
    }

    /* ── Always CREATE a new trip on each start ──
          Every start call is a new trip event, even if the user already
          has an active trip. The previous trip stays in the DB and remains
          visible on the dashboard as a separate alert card. ── */

    /* ── CREATE new trip ── */
    const trip = new CabEscortTrip({
      userId,
      username,
      destination: {
        latitude:  destination.latitude,
        longitude: destination.longitude,
        address:   destination.address || "",
      },
      vehicleNumber:   vehicleNumber ? vehicleNumber.trim().toUpperCase() : "",
      vehicleType:     vehicleType || "cab",
      currentLocation,
      status: "active",
    });

    await trip.save();
    logger.info("[CAB START]", { tripId: trip._id, userId, username });
    res.json({ success: true, message: "Trip started successfully ✅", trip });
  } catch (err) {
    logger.error("Cab start error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ── Update location — ownership check on tripId ── */
router.post("/update-location", verifyToken, replayProtection, cabGpsGuard, trackingLimiter, async (req, res) => {
  try {
    const { tripId, latitude, longitude } = req.body;

    if (!tripId) return res.status(400).json({ error: "tripId required" });
    if (!validCoords(latitude, longitude)) {
      return res.status(400).json({ error: "Valid latitude and longitude required" });
    }

    const trip = await CabEscortTrip.findById(tripId);
    if (!trip) return res.status(404).json({ success: false, message: "Trip not found" });

    if (req.user.role !== "admin" && trip.userId.toString() !== req.user.userId.toString()) {
      return res.status(403).json({ error: "Not authorised to update this trip" });
    }

    const locationUpdate = { currentLocation: { latitude, longitude }, updatedAt: new Date() };

    // Update the primary trip document
    await CabEscortTrip.findByIdAndUpdate(tripId, locationUpdate);

    // Bug 2 fix: also propagate the live coordinate to any active alert-trip
    // documents for this user (created by police-support). Their _id differs
    // from tripId so they would otherwise freeze at the location they were
    // created with and never receive further updates.
    await CabEscortTrip.updateMany(
      {
        userId: trip.userId,
        _id: { $ne: tripId },           // exclude the primary trip (already updated above)
        policeSupportRequested: true,
        status: "active",
      },
      locationUpdate
    );

    res.json({ success: true, message: "Location updated ✅" });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});


/* ── Police support — creates a NEW alert document every time it is triggered ── */
router.post("/police-support", verifyToken, async (req, res) => {
  try {
    const { tripId, currentLocation: clientLocation } = req.body;
    if (!tripId) return res.status(400).json({ error: "tripId required" });

    const trip = await CabEscortTrip.findById(tripId);
    if (!trip) return res.status(404).json({ success: false, msg: "Trip not found" });

    if (req.user.role !== "admin" && trip.userId.toString() !== req.user.userId.toString()) {
      return res.status(403).json({ error: "Not authorised to modify this trip" });
    }

    // Bug 1 fix: prefer the live GPS coordinate sent by the client (currentLocationRef)
    // over the DB's stored value, which may lag by up to one poll interval.
    const resolvedLocation =
      clientLocation && validCoords(clientLocation.latitude, clientLocation.longitude)
        ? { latitude: clientLocation.latitude, longitude: clientLocation.longitude }
        : trip.currentLocation;

    /* ── Create a brand-new alert document for each police support request.
          This ensures the dashboard shows a fresh card for every trigger
          instead of updating the same existing trip. ── */
    const alertTrip = new CabEscortTrip({
      userId:                 trip.userId,
      username:               trip.username,
      destination:            trip.destination,
      vehicleNumber:          trip.vehicleNumber,
      vehicleType:            trip.vehicleType,
      currentLocation:        resolvedLocation,
      status:                 "active",
      policeSupportRequested: true,
    });

    await alertTrip.save();

    // WebSocket: switch user to alert mode (5 s interval)
    await triggerAlertMode(trip.userId);

    logger.info("🚨 Police Support Triggered — new alert doc:", alertTrip._id, "from trip:", tripId);
    res.json({ success: true, message: "Police support request received 🚔", trip: alertTrip });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ── Complete trip — ownership check ── */
router.post("/complete/:tripId", verifyToken, async (req, res) => {
  try {
    const trip = await CabEscortTrip.findById(req.params.tripId);
    if (!trip) return res.status(404).json({ success: false, message: "Trip not found" });

    if (req.user.role !== "admin" && trip.userId.toString() !== req.user.userId.toString()) {
      return res.status(403).json({ error: "Not authorised to complete this trip" });
    }

    trip.status = "completed";
    await trip.save();

    // WebSocket: restore normal mode when trip ends safely
    await resolveAlertMode(trip.userId);

    res.json({ success: true, message: "Trip marked as completed ✅", trip });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ── Dynamic route MUST be last ── */
router.get("/:tripId", verifyToken, async (req, res) => {
  try {
    const trip = await CabEscortTrip.findById(req.params.tripId);
    if (!trip) return res.status(404).json({ success: false, message: "Trip not found" });
    res.json({ success: true, trip });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});
export default router;

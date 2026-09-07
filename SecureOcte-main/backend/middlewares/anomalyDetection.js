/**
 * middlewares/anomalyDetection.js  (NEW — HARDENED)
 * ─────────────────────────────────────────────────────────────
 * H6 — Detect abnormal behavior patterns:
 *   1. Rapid location jumps      (>50 km in <30 s — already in gpsAnomalyGuard,
 *                                  this adds a Redis counter for sustained abuse)
 *   2. Excessive SOS attempts    (>5 panics in 10 min — tracks across windows)
 *   3. Unusual activity times    (03:00–04:00 local UTC — flag only, don't block)
 *
 * All anomalies are logged for forensic review (H7).
 * Detection is non-blocking (logs + annotates req) except where
 * the spec explicitly says to reject (excessive SOS).
 * ─────────────────────────────────────────────────────────────
 */

import redisClient from "../config/redisCluster.js";
import logger      from "../config/logger.js";

const SOS_WINDOW_SEC   = 600;   // 10 minutes
const SOS_MAX_ATTEMPTS = 5;     // block above this

/* ─────────────────────────────────────────────────────────────
   Excessive SOS detection — blocks if sustained abuse detected
───────────────────────────────────────────────────────────── */
export async function sosAbuseGuard(req, res, next) {
  if (!redisClient) return next(); // fail open if Redis down

  const userId = req.user?.userId;
  if (!userId) return next();

  const key = `anomaly:sos:${userId}`;

  try {
    const count = await redisClient.incr(key);
    if (count === 1) {
      // First hit — set TTL window
      await redisClient.expire(key, SOS_WINDOW_SEC);
    }

    if (count > SOS_MAX_ATTEMPTS) {
      logger.warn({
        msg:    "[Anomaly] Excessive SOS attempts",
        userId,
        count,
        ip: req.ip,
      });
      return res.status(429).json({
        error: "Excessive panic alerts detected. If this is a real emergency, call 112.",
      });
    }

    if (count >= Math.ceil(SOS_MAX_ATTEMPTS * 0.7)) {
      // Warn at 70% threshold
      logger.warn({
        msg:    "[Anomaly] High SOS frequency",
        userId,
        count,
        ip: req.ip,
      });
    }
  } catch (err) {
    logger.error({ msg: "[Anomaly] sosAbuseGuard Redis error", err: err.message });
    // fail open — don't block legit emergencies
  }

  next();
}

/* ─────────────────────────────────────────────────────────────
   Unusual activity time detection — non-blocking, log only
   Flags requests between 01:00–04:00 UTC as anomalous
───────────────────────────────────────────────────────────── */
export function unusualTimeGuard(req, res, next) {
  const hour = new Date().getUTCHours();
  if (hour >= 1 && hour < 4) {
    logger.info({
      msg:    "[Anomaly] Unusual activity time",
      userId: req.user?.userId,
      hourUTC: hour,
      path:   req.path,
      ip:     req.ip,
    });
    // H6 — annotate for downstream handlers; do not block
    req.anomaly = req.anomaly || {};
    req.anomaly.unusualTime = true;
  }
  next();
}

/* ─────────────────────────────────────────────────────────────
   Rapid location jump counter — tracks across requests
   (complements gpsAnomalyGuard which checks per-request)
───────────────────────────────────────────────────────────── */
export async function locationJumpCounter(req, res, next) {
  if (!redisClient) return next();

  const userId = req.user?.userId;
  if (!userId) return next();

  // Count how many GPS anomaly events were flagged for this user
  // gpsAnomalyGuard sets req.gpsAnomaly = true on detection
  if (req.gpsAnomaly) {
    const key = `anomaly:gps:${userId}`;
    try {
      const count = await redisClient.incr(key);
      if (count === 1) await redisClient.expire(key, 3600); // 1-hour window

      logger.warn({
        msg:    "[Anomaly] Rapid location jump recorded",
        userId,
        jumpCount: count,
        ip: req.ip,
      });
    } catch (err) {
      logger.error({ msg: "[Anomaly] locationJumpCounter Redis error", err: err.message });
    }
  }

  next();
}

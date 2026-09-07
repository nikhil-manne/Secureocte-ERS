/**
 * gpsAnomalyGuard.js
 * ─────────────────────────────────────────────────────────────
 * Detects physically impossible GPS movements on location-update routes.
 *
 * Two checks per update:
 *   1. SPEED — implied km/h between last and current point > 200 → reject
 *   2. TELEPORT — distance > 50 km AND elapsed < 30 s → reject
 *
 * Last position stored in Redis:
 *   gps:<entityKey>  →  JSON { lat, lng, ts }   TTL 60 s — FIX 10
 *
 * Usage:
 *   import { makeGpsGuard } from "../middlewares/gpsAnomalyGuard.js";
 *
 *   const cabGpsGuard    = makeGpsGuard(req => `cab:${req.user?.userId}`);
 *   const patrolGpsGuard = makeGpsGuard(req => `patrol:${req.body?.tripId}`);
 *   const panicGpsGuard  = makeGpsGuard(req => `panic:${req.user?.userId}`);
 *
 *   router.post("/update-location", verifyToken, replayProtection, cabGpsGuard, handler);
 * ─────────────────────────────────────────────────────────────
 */

import redisClient from "../config/redisCluster.js";
import logger from "../config/logger.js";

const MAX_SPEED_KMH    = 200;  // reject if implied speed exceeds this
const MAX_JUMP_KM      = 50;   // reject teleport larger than this…
const MIN_TELEPORT_SEC = 30;   // …when time elapsed is less than this
const LOCATION_TTL_SEC = 60;  // FIX 10 — aligned to spec (60s TTL)

function haversineKm(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a    =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * makeGpsGuard(keyFn)
 * @param {(req) => string} keyFn  Returns a unique entity key, e.g. "cab:userId"
 */
export function makeGpsGuard(keyFn) {
  return async function gpsAnomalyGuard(req, res, next) {
    const r = redisClient;
    if (!r) return next();

    const { latitude, longitude } = req.body;
    if (typeof latitude !== "number" || typeof longitude !== "number") return next();

    const entityKey = keyFn(req);
    if (!entityKey) return next();

    const redisKey = `gps:${entityKey}`;
    const nowMs    = Date.now();

    try {
      const raw = await r.get(redisKey).catch(() => null);

      if (raw) {
        const prev = JSON.parse(raw);
        const distKm   = haversineKm(prev.lat, prev.lng, latitude, longitude);
        const elapsedS = (nowMs - prev.ts) / 1000;

        if (elapsedS > 0) {
          // ── Speed check ──────────────────────────────────────
          const speedKmh = (distKm / elapsedS) * 3600;
          if (speedKmh > MAX_SPEED_KMH) {
            logger.warn(`[GpsAnomalyGuard] 🚨 Speed anomaly — key=${entityKey} dist=${distKm.toFixed(2)}km elapsed=${elapsedS.toFixed(1)}s speed=${speedKmh.toFixed(0)}km/h`);
            return res.status(400).json({
              error: `GPS anomaly: implied speed ${Math.round(speedKmh)} km/h exceeds maximum (${MAX_SPEED_KMH} km/h)`,
            });
          }

          // ── Teleport check ───────────────────────────────────
          if (distKm > MAX_JUMP_KM && elapsedS < MIN_TELEPORT_SEC) {
            logger.warn(`[GpsAnomalyGuard] 🚨 Teleport anomaly — key=${entityKey} dist=${distKm.toFixed(2)}km in ${elapsedS.toFixed(1)}s`);
            return res.status(400).json({
              error: `GPS anomaly: location jumped ${Math.round(distKm)} km in ${Math.round(elapsedS)} s`,
            });
          }
        }
      }

      // Store current position for the next check
      await r.set(redisKey, JSON.stringify({ lat: latitude, lng: longitude, ts: nowMs }), "EX", LOCATION_TTL_SEC);
    } catch (err) {
      logger.error("[GpsAnomalyGuard] Redis error:", err.message);
      // fail open
    }

    next();
  };
}

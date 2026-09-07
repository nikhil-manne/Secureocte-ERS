/**
 * middlewares/gpsGuard.js
 * ─────────────────────────────────────────────────────────────
 * Enhanced GPS anomaly guard that honours X-Mobility-Mode header.
 *
 * Speed limits per mode:
 *   walk   →  20 km/h
 *   car    → 160 km/h
 *   drone  → 250 km/h
 *   (any)  → 120 km/h  (default)
 *
 * Also checks teleport: dist > 50 km AND elapsed < 30 s → reject.
 *
 * Last position cached in Redis: gps:<userId>  TTL 60 s
 * ─────────────────────────────────────────────────────────────
 */

import redisClient from "../config/redisCluster.js";
import logger from "../config/logger.js";

const SPEED_LIMITS = {
  walk:  20,
  car:   160,
  drone: 250,
};
const DEFAULT_SPEED_LIMIT = 120;
const MAX_JUMP_KM         = 50;
const MIN_TELEPORT_SEC    = 30;
const LOCATION_TTL_SEC    = 60;

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

/**
 * makeGpsGuard(keyFn)
 * @param {(req) => string} keyFn  Returns a unique entity key, e.g. "panic:userId"
 */
export function makeGpsGuard(keyFn) {
  return async function panicGpsGuard(req, res, next) {
    const r = redisClient;
    if (!r) return next();  // Redis unavailable — fail open

    const { latitude, longitude } = req.body;
    if (typeof latitude !== "number" || typeof longitude !== "number") {
      return next();
    }

    const entityKey = keyFn(req);
    if (!entityKey) return next();

    const redisKey = `gps:${entityKey}`;
    const nowMs    = Date.now();

    /* Determine speed limit from mobility mode header */
    const mode       = (req.headers["x-mobility-mode"] || "").toLowerCase();
    const speedLimit = SPEED_LIMITS[mode] ?? DEFAULT_SPEED_LIMIT;

    try {
      const raw = await r.get(redisKey);

      if (raw) {
        const prev      = JSON.parse(raw);
        const distKm    = haversineKm(prev.lat, prev.lng, latitude, longitude);
        const elapsedS  = (nowMs - prev.ts) / 1000;

        if (elapsedS > 0) {
          const speedKmh = (distKm / elapsedS) * 3600;

          if (speedKmh > speedLimit) {
            logger.warn(
              `[GpsGuard] Speed anomaly — key=${entityKey} mode=${mode || "default"} ` +
              `speed=${speedKmh.toFixed(0)}km/h limit=${speedLimit}km/h`
            );
            return res.status(400).json({
              error: `GPS anomaly: implied speed ${Math.round(speedKmh)} km/h exceeds limit (${speedLimit} km/h for mode "${mode || "default"}")`,
            });
          }

          if (distKm > MAX_JUMP_KM && elapsedS < MIN_TELEPORT_SEC) {
            logger.warn(
              `[GpsGuard] Teleport anomaly — key=${entityKey} dist=${distKm.toFixed(2)}km in ${elapsedS.toFixed(1)}s`
            );
            return res.status(400).json({
              error: `GPS anomaly: location jumped ${Math.round(distKm)} km in ${Math.round(elapsedS)} s`,
            });
          }
        }
      }

      await r.set(
        redisKey,
        JSON.stringify({ lat: latitude, lng: longitude, ts: nowMs }),
        "EX",
        LOCATION_TTL_SEC
      );
    } catch (err) {
      logger.error(`[GpsGuard] Redis error: ${err.message}`);
      // fail open — don't block the request on a Redis blip
    }

    next();
  };
}

/* Pre-built instance for panic routes */
export const panicGpsGuard = makeGpsGuard((req) => `panic:${req.user?.userId}`);

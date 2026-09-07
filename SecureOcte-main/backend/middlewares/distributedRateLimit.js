/**
 * middlewares/distributedRateLimit.js  (HARDENED)
 * ─────────────────────────────────────────────────────────────
 * H2 — Correct limits per spec:
 *   Global:    120 req / min per IP
 *   Tracking:   60 req / min (applied per-route — exported separately)
 *   Stream:     10 req / min (applied per-route — exported separately)
 *
 * H3 — No memory fallback. Fail CLOSED if Redis unavailable.
 * H4 — Rate-limit response headers suppressed.
 * ─────────────────────────────────────────────────────────────
 */

import rateLimit     from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import jwt           from "jsonwebtoken";
import redisClient   from "../config/redisCluster.js";
import logger        from "../config/logger.js";

/* ── H3: Fail closed guard ────────────────────────────────────── */
if (!redisClient) {
  logger.error(
    "[RateLimit] ⛔ Redis unavailable — rate limiting will FAIL CLOSED. Fix REDIS_URL immediately."
  );
}

function requireRedisStore(prefix) {
  if (!redisClient) return null; // signals fail-closed below
  return new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix: `rl:${prefix}:`,
  });
}

function decodeToken(req) {
  try {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) return null;
    return jwt.verify(h.split(" ")[1], process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

/* ── H3: Fail-closed skip/handler pattern ────────────────────── */
function failClosedMiddleware(req, res, next) {
  if (!redisClient) {
    logger.error({ msg: "[RateLimit] Redis unavailable — blocking request (fail closed)", path: req.path });
    return res.status(503).json({ error: "Service unavailable" });
  }
  next();
}

/* ── Global: 120 req / min per IP ────────────────────────────── */
const globalStore = requireRedisStore("global");

const _globalLimit = rateLimit({
  windowMs: 60_000,
  max: 120,            // H2 spec: 120/min global

  skip: (req) => {
    const decoded = decodeToken(req);
    return decoded?.role === "admin"; // admin exempt
  },

  keyGenerator: (req) => req.ip,

  handler: (req, res) => {
    logger.warn({ msg: "[RateLimit] Global 429", ip: req.ip, path: req.path });
    res.status(429).json({ error: "Too many requests. Please slow down." });
  },

  store: globalStore || undefined,

  standardHeaders: false,   // H4
  legacyHeaders:   false,
});

/* Export combined: fail-closed guard → limiter */
export const distributedRateLimit = [failClosedMiddleware, _globalLimit];
export default distributedRateLimit;

/* ── Tracking endpoints: 60 req / min ────────────────────────── */
const trackingStore = requireRedisStore("tracking");
export const trackingLimiter = [
  failClosedMiddleware,
  rateLimit({
    windowMs: 60_000,
    max: 60,
    keyGenerator: (req) => req.user?.userId || req.ip,
    handler: (req, res) => res.status(429).json({ error: "Too many requests." }),
    store: trackingStore || undefined,
    standardHeaders: false,
    legacyHeaders:   false,
  }),
];

/* ── Stream endpoints: 10 req / min ──────────────────────────── */
const streamStore = requireRedisStore("stream");
export const streamLimiter = [
  failClosedMiddleware,
  rateLimit({
    windowMs: 60_000,
    max: 10,
    keyGenerator: (req) => req.user?.userId || req.ip,
    handler: (req, res) => res.status(429).json({ error: "Too many requests." }),
    store: streamStore || undefined,
    standardHeaders: false,
    legacyHeaders:   false,
  }),
];

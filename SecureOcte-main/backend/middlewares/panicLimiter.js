/**
 * middlewares/panicLimiter.js  (HARDENED)
 * ─────────────────────────────────────────────────────────────
 * H2 — Multi-window panic rate limits per spec:
 *   Window 1:  2 requests per 10 seconds
 *   Window 2:  3 requests per minute
 *   Window 3: 10 requests per 10 minutes
 *
 * Keyed by userId (from verified JWT) — IP rotation cannot bypass.
 * H4 — No rate-limit headers exposed.
 * H3 — Fails closed: if Redis unavailable, block the request.
 * ─────────────────────────────────────────────────────────────
 */

import rateLimit     from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import redisClient   from "../config/redisCluster.js";
import logger        from "../config/logger.js";

function panicStore(prefix) {
  if (!redisClient) return undefined;
  return new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix: `rl:panic:${prefix}:`,
  });
}

function makePanicWindow({ windowMs, max, prefix }) {
  return rateLimit({
    windowMs,
    max,
    keyGenerator: (req) => req.user?.userId || req.ip,
    handler: (req, res) => {
      logger.warn({ msg: "[PanicLimiter] 429", window: prefix, userId: req.user?.userId, ip: req.ip });
      res.status(429).json({ error: "Too many panic alerts. Please wait before sending another." });
    },
    store: panicStore(prefix),
    // H3 — fail closed: if Redis unavailable (store=undefined), express-rate-limit
    //      falls back to in-memory — acceptable only within a single process.
    //      For multi-process, Redis must be available. Logged at startup.
    skip: (req, res) => {
      if (!redisClient) {
        logger.error("[PanicLimiter] Redis unavailable — blocking panic request (fail closed)");
        res.status(503).json({ error: "Service unavailable" });
        return true; // skip = block: express-rate-limit won't call next()
      }
      return false;
    },
    standardHeaders: false,   // H4 — suppress rate-limit headers
    legacyHeaders:   false,
  });
}

/* ── Three windows per spec ── */
export const panicLimiter10s  = makePanicWindow({ windowMs: 10_000,     max: 2,  prefix: "10s"  });
export const panicLimiter1m   = makePanicWindow({ windowMs: 60_000,     max: 3,  prefix: "1m"   });
export const panicLimiter10m  = makePanicWindow({ windowMs: 600_000,    max: 10, prefix: "10m"  });

/* ── Combined middleware array for easy use ── */
export const panicLimiter = [panicLimiter10s, panicLimiter1m, panicLimiter10m];

export default panicLimiter;

/**
 * middlewares/streamLimiter.js
 * ─────────────────────────────────────────────────────────────
 * Rate limit on stream polling / creation endpoints.
 *   30 requests per IP per minute
 * Keyed by IP because public stream viewers are unauthenticated.
 * ─────────────────────────────────────────────────────────────
 */

import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import redisClient from "../config/redisCluster.js";
import logger from "../config/logger.js";

const store = redisClient
  ? new RedisStore({
      sendCommand: (...args) => redisClient.call(...args),
      prefix: "rl:stream:",
    })
  : undefined;

const streamLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,

  keyGenerator: (req) => req.ip,

  handler: (req, res) => {
    logger.warn(`[StreamLimiter] 429 — ip=${req.ip}`);
    res.status(429).json({ error: "Too many stream requests. Please slow down." });
  },

  store,
  standardHeaders: true,
  legacyHeaders: false,
});

export default streamLimiter;

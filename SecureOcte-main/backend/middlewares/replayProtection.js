/**
 * middlewares/replayProtection.js
 * ─────────────────────────────────────────────────────────────
 * Prevents replay attacks on all sensitive endpoints.
 *
 * CLIENT must send two headers on every protected request:
 *   X-Timestamp : Date.now() in milliseconds  (e.g. "1720000000000")
 *   X-Nonce     : A one-time UUID or 32-char hex string
 *
 * SERVER checks:
 *   1. Timestamp within ±30 s of server clock  → stops stale replays
 *   2. Nonce not seen before                    → stops exact replays
 *      Nonces stored in Redis with key  replay:<nonce>  TTL 60 s
 *
 * FAIL CLOSED — Redis error → 503 (security unavailable).
 * Never lets a request through when the nonce store is unreachable.
 * ─────────────────────────────────────────────────────────────
 */

import redisClient from "../config/redisCluster.js";
import logger from "../config/logger.js";

const TIMESTAMP_WINDOW_MS = 30_000;
const NONCE_TTL_SEC       = 60;

export default async function replayProtection(req, res, next) {
  const r = redisClient;

  if (!r) {
    logger.warn("[ReplayProtection] No Redis — replay protection DISABLED, rejecting request");
    return res.status(503).json({ error: "Security service unavailable" });
  }

  const tsRaw    = req.headers["x-timestamp"];
  const nonceRaw = req.headers["x-nonce"];

  if (!tsRaw || !nonceRaw) {
    return res.status(400).json({
      error: "Missing security headers: X-Timestamp and X-Nonce are required",
    });
  }

  const clientTs = parseInt(tsRaw, 10);
  if (isNaN(clientTs)) {
    return res.status(400).json({
      error: "X-Timestamp must be a numeric Unix timestamp in milliseconds",
    });
  }

  const drift = Math.abs(Date.now() - clientTs);
  if (drift > TIMESTAMP_WINDOW_MS) {
    return res.status(400).json({
      error: `Request expired or clock skew too large (drift ${drift} ms, max ${TIMESTAMP_WINDOW_MS} ms)`,
    });
  }

  const nonce = String(nonceRaw).trim();
  if (!nonce || nonce.length < 8 || nonce.length > 128) {
    return res.status(400).json({ error: "X-Nonce must be 8–128 characters" });
  }

  /* ── FIX 2: FAIL CLOSED — Redis error → 503, never next() ── */
  try {
    const result = await r.set(`replay:${nonce}`, "1", "EX", NONCE_TTL_SEC, "NX");
    if (result === null) {
      return res.status(400).json({ error: "Duplicate request detected (nonce already used)" });
    }
  } catch (err) {
    logger.error({ msg: "Replay Redis failure", err });
    return res.status(503).json({ error: "Security service unavailable" });
    // NO next() — fail closed
  }

  next();
}

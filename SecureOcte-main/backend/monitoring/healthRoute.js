/**
 * monitoring/healthRoute.js  (HARDENED)
 * ─────────────────────────────────────────────────────────────
 * H8 — Health endpoint secured:
 *   • Only accessible from localhost (127.0.0.1) or with a
 *     valid HEALTH_TOKEN in Authorization header
 *   • Returns generic { status } to unauthorized callers
 *     (no infra details leaked — H4)
 * ─────────────────────────────────────────────────────────────
 */

import express    from "express";
import mongoose   from "mongoose";
import redisClient from "../config/redisCluster.js";
import logger      from "../config/logger.js";

const router = express.Router();

/* ── H8: health access guard ── */
function healthGuard(req, res, next) {
  const ip       = req.ip || "";
  const isLocal  = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  const token    = (req.headers.authorization || "").replace("Bearer ", "").trim();
  const expected = process.env.HEALTH_TOKEN;

  if (isLocal) return next();
  if (expected && token === expected) return next();

  // H4 — no infra details to unauthenticated callers
  return res.status(200).json({ status: "ok" });
}

router.get("/", healthGuard, async (req, res) => {
  const checks = {};
  let overall = "ok";

  /* ── db ── */
  try {
    const t0 = Date.now();
    await mongoose.connection.db.admin().ping();
    checks.db = { status: "ok", latencyMs: Date.now() - t0 };
  } catch (err) {
    checks.db = { status: "error", error: err.message };
    overall   = "degraded";
  }

  /* ── redis ── */
  if (!redisClient) {
    checks.redis = { status: "disabled" };
    overall      = "degraded";  // H3 — Redis required; disabled = degraded
  } else {
    try {
      await redisClient.ping();
      checks.redis = { status: "ok" };
    } catch (err) {
      checks.redis = { status: "error", error: err.message };
      overall      = "degraded";
    }
  }

  /* ── queue ── */
  try {
    const { getAlertQueue } = await import("../queues/alertQueue.js");
    const q = getAlertQueue();
    if (!q) {
      checks.queue = { status: "disabled" };
    } else {
      const counts = await q.getJobCounts("waiting", "active", "failed");
      checks.queue = { status: "ok", counts };
    }
  } catch (err) {
    checks.queue = { status: "error", error: err.message };
    overall      = "degraded";
  }

  const httpStatus = overall === "ok" ? 200 : 503;

  logger.info({
    msg:   "[Health]",
    overall,
    db:    checks.db?.status,
    redis: checks.redis?.status,
    queue: checks.queue?.status,
  });

  return res.status(httpStatus).json({
    status:    overall,
    uptime:    Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    checks,
  });
});

export default router;

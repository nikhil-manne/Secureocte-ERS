/**
 * socket/socketBridge.cjs
 * ─────────────────────────────────────────────────────────────
 * CommonJS-safe shim that exposes triggerAlertMode,
 * resolveAlertMode, and sendUserNotification to CJS modules
 * (e.g. routes/secureme.cjs).
 *
 * Because the actual socketManager is ESM-only, we talk to Redis
 * directly here using the same key conventions and pub/sub
 * channels defined in socketManager.js.
 *
 * Key conventions (must stay in sync with socketManager.js):
 *   user:{userId}:mode  — "alert" | "normal"
 *   pub channel         — "mode_change"
 *   payload             — { userId, mode }
 *   notification channel — "user_notification"
 *   payload              — { userId, type, ...extra }
 * ─────────────────────────────────────────────────────────────
 */

"use strict";

const Redis  = require("ioredis");
const logger = {
  info:  (...a) => process.stdout.write("[INFO]  " + a.map(String).join(" ") + "\n"),
  warn:  (...a) => process.stderr.write("[WARN]  " + a.map(String).join(" ") + "\n"),
  error: (...a) => process.stderr.write("[ERROR] " + a.map(String).join(" ") + "\n"),
};

const ALERT_MODE_TTL = 20 * 60; // seconds

let redisClient = null;

function getRedis() {
  if (redisClient) return redisClient;
  if (!process.env.REDIS_URL) {
    logger.warn("[SocketBridge] REDIS_URL not set — mode change will be skipped");
    return null;
  }
  redisClient = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableReadyCheck:     false,
    lazyConnect:          true,
    password:             process.env.REDIS_PASSWORD || undefined,
    tls:                  process.env.REDIS_TLS === "true" ? {} : undefined,
  });
  redisClient.on("error", (e) => logger.error("[SocketBridge] Redis error:", e.message));
  return redisClient;
}

/**
 * triggerAlertMode(userId)
 * Sets mode=alert and publishes mode_change to Redis.
 * No-op if already in alert mode.
 */
async function triggerAlertMode(userId) {
  const id = String(userId);
  const rc = getRedis();
  if (!rc) return;
  try {
    const current = await rc.get(`user:${id}:mode`);
    if (current === "alert") return;
    await rc.set(`user:${id}:mode`, "alert", "EX", ALERT_MODE_TTL);
    await rc.publish("mode_change", JSON.stringify({ userId: id, mode: "alert" }));
    logger.info(`[SocketBridge] 🚨 Alert mode SET for user ${id}`);
  } catch (err) {
    logger.error(`[SocketBridge] triggerAlertMode error for ${id}: ${err.message}`);
  }
}

/**
 * resolveAlertMode(userId)
 * Sets mode=normal and publishes mode_change to Redis.
 */
async function resolveAlertMode(userId) {
  const id = String(userId);
  const rc = getRedis();
  if (!rc) return;
  try {
    await rc.set(`user:${id}:mode`, "normal");
    await rc.publish("mode_change", JSON.stringify({ userId: id, mode: "normal" }));
    logger.info(`[SocketBridge] ✅ Alert mode RESOLVED for user ${id}`);
  } catch (err) {
    logger.error(`[SocketBridge] resolveAlertMode error for ${id}: ${err.message}`);
  }
}

/**
 * sendUserNotification(userId, type, extra)
 * Publishes a lightweight socket event for a specific user.
 */
async function sendUserNotification(userId, type, extra = {}) {
  const id = String(userId);
  const rc = getRedis();
  if (!rc) return;
  try {
    await rc.publish(
      "user_notification",
      JSON.stringify({
        userId: id,
        type: String(type || "GENERIC"),
        ...extra,
      })
    );
    logger.info(`[SocketBridge] Notification sent to user ${id}: ${type}`);
  } catch (err) {
    logger.error(`[SocketBridge] sendUserNotification error for ${id}: ${err.message}`);
  }
}

module.exports = { triggerAlertMode, resolveAlertMode, sendUserNotification };

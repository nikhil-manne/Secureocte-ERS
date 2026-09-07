/**
 * services/networkMonitor.js
 * ─────────────────────────────────────────────────────────────
 * Network Monitor System — WebSocket Heartbeat + Redis Watchdog
 *
 * Flow:
 *   Frontend → sends HEARTBEAT via socket every 15 s
 *   Backend  → stores hb:{userId}, resets timer:{userId} TTL=120 s
 *   If heartbeat stops → Redis key expires → expiry event fires
 *                      → backend verifies lastSeen gap
 *                      → creates NetworkAlert + broadcasts to dashboard
 *
 * Two Redis clients are required:
 *   • redisWrite  — shared write client (from socketManager)
 *   • redisSub    — dedicated PSUBSCRIBE client (created here)
 *     (Redis does not allow commands on a subscribed connection)
 * ─────────────────────────────────────────────────────────────
 */

import Redis from "ioredis";
import { createRequire } from "module";
import logger from "../config/logger.js";

const require = createRequire(import.meta.url);
const NetworkAlert = require("../models/NetworkAlert.cjs");

// ─────────────────────────────────────────────
// CONFIG  (mirrors pseudo constants)
// ─────────────────────────────────────────────
const HEARTBEAT_INTERVAL_MS = 15_000;   // expected frontend send rate
const RETRY_WINDOW_SEC      = 120;       // Redis TTL for watchdog timer key
const ALERT_LOCK_TTL_SEC    = 300;       // dedup window — one alert per user per 5 min
const GRACE_PERIOD_MS       = 120_000;  // must be >= RETRY_WINDOW_SEC * 1000

// Redis key prefixes
const KEY_HB    = (uid) => `hb:${uid}`;
const KEY_TIMER = (uid) => `timer:${uid}`;
const KEY_ALERT = (uid) => `alert:${uid}`;

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let _redisWrite = null;   // injected write client
let _redisSub   = null;   // dedicated subscriber client
let _io         = null;   // socket.io server instance
let _started    = false;

// ─────────────────────────────────────────────
// SUBSCRIBER CLIENT FACTORY
// ─────────────────────────────────────────────
function makeSubClient() {
  if (!process.env.REDIS_URL) {
    logger.warn("[NetworkMonitor] REDIS_URL not set — subscriber client disabled");
    return null;
  }

  const client = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableReadyCheck:     false,
    lazyConnect:          true,
    password:  process.env.REDIS_PASSWORD || undefined,
    tls:       process.env.REDIS_TLS === "true" ? {} : undefined,
    retryStrategy: (times) => {
      if (times > 10) return null;
      return Math.min(100 * 2 ** times, 10_000);
    },
  });

  client.on("connect", () => logger.info("[NetworkMonitor] Subscriber client connected"));
  client.on("error",   (e) => logger.error(`[NetworkMonitor] Subscriber error: ${e.message}`));
  return client;
}

// ─────────────────────────────────────────────
// HEARTBEAT HANDLER
// Called by socketManager when it receives a HEARTBEAT message
// ─────────────────────────────────────────────
export async function handleHeartbeat(userId) {
  if (!_redisWrite) {
    logger.warn(`[NetworkMonitor] handleHeartbeat called but Redis unavailable (user: ${userId})`);
    return;
  }

  const uid = String(userId);
  const now = Date.now();

  try {
    // 1. Store last-seen timestamp
    await _redisWrite.set(KEY_HB(uid), now);

    // 2. Reset 2-min watchdog timer (SETEX resets TTL on every heartbeat)
    await _redisWrite.set(KEY_TIMER(uid), "1", "EX", RETRY_WINDOW_SEC);

    // 3. Clear any existing alert-dedup lock so a recovered user
    //    gets a fresh alert if they go missing again later
    await _redisWrite.del(KEY_ALERT(uid));

    logger.debug(`[NetworkMonitor] Heartbeat stored for user ${uid}`);
  } catch (err) {
    logger.error(`[NetworkMonitor] handleHeartbeat error for ${uid}: ${err.message}`);
  }
}

// ─────────────────────────────────────────────
// CORE ALERT TRIGGER
// ─────────────────────────────────────────────
async function triggerNetworkAlert(userId, elapsedMs) {
  logger.warn(`[NetworkMonitor] 🚨 NETWORK ALERT — user: ${userId}, elapsed: ${elapsedMs} ms`);

  try {
    // Persist to DB via the existing NetworkAlert model
    await NetworkAlert.create({
      username:  userId,
      state:     "NO_HEARTBEAT",
      reason:    "NO_HEARTBEAT_2_MIN",
      lastSeen:  new Date(Date.now() - elapsedMs),
      source:    "network_monitor",
      metadata:  { elapsedMs },
    });

    logger.info(`[NetworkMonitor] NetworkAlert saved for user ${userId}`);
  } catch (err) {
    logger.error(`[NetworkMonitor] DB insert failed for ${userId}: ${err.message}`);
  }

  // Broadcast to all dashboard sockets
  if (_io) {
    _io.emit("NETWORK_ALERT", {
      type:    "NETWORK_ALERT",
      userId,
      reason:  "NO_HEARTBEAT_2_MIN",
      elapsed: elapsedMs,
      ts:      Date.now(),
    });
    logger.info(`[NetworkMonitor] Dashboard broadcast sent for user ${userId}`);
  } else {
    logger.warn("[NetworkMonitor] io not set — dashboard broadcast skipped");
  }
}

// ─────────────────────────────────────────────
// REDIS EXPIRY LISTENER (CORE ENGINE)
// ─────────────────────────────────────────────
async function onKeyExpired(key) {
  // Only care about watchdog timer keys
  if (!key.startsWith("timer:")) return;

  const userId = key.slice("timer:".length);
  logger.info(`[NetworkMonitor] Timer expired for user ${userId}`);

  if (!_redisWrite) return;

  try {
    // 1. Fetch last heartbeat timestamp
    const lastSeenRaw = await _redisWrite.get(KEY_HB(userId));

    if (lastSeenRaw === null) {
      // No heartbeat record at all — user never connected or data was flushed
      logger.warn(`[NetworkMonitor] No hb record for ${userId} — skipping alert`);
      return;
    }

    const now     = Date.now();
    const elapsed = now - Number(lastSeenRaw);

    // 2. Double-check: guard against Redis expiry jitter / false fires
    if (elapsed < GRACE_PERIOD_MS) {
      logger.info(`[NetworkMonitor] False expiry ignored for ${userId} (elapsed: ${elapsed} ms)`);
      return;
    }

    // 3. Dedup lock — NX ensures only one alert fires per ALERT_LOCK_TTL window
    const lock = await _redisWrite.set(
      KEY_ALERT(userId),
      "1",
      "NX",
      "EX",
      ALERT_LOCK_TTL_SEC
    );

    if (lock === null) {
      logger.info(`[NetworkMonitor] Duplicate alert prevented for ${userId}`);
      return;
    }

    // 4. Fire the alert
    await triggerNetworkAlert(userId, elapsed);

  } catch (err) {
    logger.error(`[NetworkMonitor] onKeyExpired error for ${userId}: ${err.message}`);
  }
}

// ─────────────────────────────────────────────
// PUBLIC INIT — call once after Redis + io are ready
// ─────────────────────────────────────────────
/**
 * @param {Redis}  redisWrite  Shared ioredis write client
 * @param {Server} io          Socket.IO server instance
 */
export function startNetworkMonitor(redisWrite, io) {
  if (_started) {
    logger.warn("[NetworkMonitor] Already started — ignoring duplicate call");
    return;
  }

  _redisWrite = redisWrite;
  _io         = io;

  if (!redisWrite) {
    logger.warn("[NetworkMonitor] Redis unavailable — network monitor disabled");
    return;
  }

  // Create a dedicated subscriber client (cannot share the write client
  // because Redis disallows regular commands on a subscribed connection)
  _redisSub = makeSubClient();

  if (!_redisSub) {
    logger.warn("[NetworkMonitor] Subscriber client not created — network monitor disabled");
    return;
  }

  // Enable keyspace expiry notifications on DB 0
  // notify-keyspace-events "Ex" = Keyevent events for expired keys
  // We do this programmatically so no redis.conf change is required.
  // CONFIG SET is a best-effort call; managed Redis may disallow it.
  _redisWrite.config("SET", "notify-keyspace-events", "Ex").catch((err) => {
    logger.warn(`[NetworkMonitor] Could not set notify-keyspace-events (may already be set): ${err.message}`);
  });

  // PSUBSCRIBE to keyevent expiry channel for DB 0
  _redisSub.psubscribe("__keyevent@0__:expired", (err, count) => {
    if (err) {
      logger.error(`[NetworkMonitor] PSUBSCRIBE failed: ${err.message}`);
      return;
    }
    logger.info(`[NetworkMonitor] ✅ Subscribed to keyevent expiry channel (${count} pattern(s))`);
  });

  _redisSub.on("pmessage", (_pattern, _channel, key) => {
    onKeyExpired(key).catch((err) =>
      logger.error(`[NetworkMonitor] Unhandled pmessage error: ${err.message}`)
    );
  });

  _started = true;
  logger.info(
    `[NetworkMonitor] ✅ Started — watchdog TTL: ${RETRY_WINDOW_SEC}s, lock TTL: ${ALERT_LOCK_TTL_SEC}s, grace: ${GRACE_PERIOD_MS}ms`
  );
}

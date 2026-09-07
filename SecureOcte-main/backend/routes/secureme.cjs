// Logger shim - writes directly to stdout/stderr (no recursion)
const logger = {
  info: (...a) => process.stdout.write("[INFO]  " + a.map(String).join(" ") + "\n"),
  warn: (...a) => process.stderr.write("[WARN]  " + a.map(String).join(" ") + "\n"),
  error: (...a) => process.stderr.write("[ERROR] " + a.map(String).join(" ") + "\n"),
};

const express = require("express");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");
const Redis = require("ioredis");
const socketBridge = require("../socket/socketBridge.cjs");
const NetworkAlert = require("../models/NetworkAlert.cjs");

function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    logger.warn("[SecureMe verifyToken] JWT verify failed name=" + err.name + " ip=" + (req.ip || "unknown"));
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (decoded.role !== "admin") {
    const sent = req.headers["x-device-id"];
    if (!sent || !decoded.deviceId) {
      logger.warn("[SecureMe verifyToken] Device header/token missing userId=" + decoded.userId + " ip=" + (req.ip || "unknown"));
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (sent !== decoded.deviceId) {
      logger.warn(
        "[SecureMe verifyToken] Device mismatch userId=" +
          decoded.userId +
          " tokenDevice=" +
          decoded.deviceId +
          " headerDevice=" +
          sent +
          " ip=" +
          (req.ip || "unknown")
      );
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  req.user = decoded;
  next();
}

const router = express.Router();

const alertLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.userId || req.ip,
  handler: (req, res) =>
    res.status(429).json({ error: "Too many alerts. Please wait before sending another." }),
  standardHeaders: true,
  legacyHeaders: false,
});

if (!process.env.REDIS_URL) {
  logger.error("[SecureMe] REDIS_URL environment variable is not set");
  process.exit(1);
}
const redis = new Redis(process.env.REDIS_URL);

redis.on("connect", () => logger.info("[SecureMe] Redis connected"));
redis.on("error", (e) => logger.error("[SecureMe] Redis error:", e.message));

const REPLAY_WINDOW_MS = 30_000;
const NONCE_TTL_SEC = 60;
async function replayProtection(req, res, next) {
  const tsRaw = req.headers["x-timestamp"];
  const nonceRaw = req.headers["x-nonce"];
  if (!tsRaw || !nonceRaw) {
    return res.status(400).json({ error: "Missing security headers: X-Timestamp and X-Nonce are required" });
  }

  const clientTs = parseInt(tsRaw, 10);
  if (isNaN(clientTs) || Math.abs(Date.now() - clientTs) > REPLAY_WINDOW_MS) {
    return res.status(400).json({ error: "Request expired or clock skew too large" });
  }

  const nonce = String(nonceRaw).trim();
  if (!nonce || nonce.length < 8 || nonce.length > 128) {
    return res.status(400).json({ error: "X-Nonce must be 8-128 characters" });
  }

  try {
    const result = await redis.set("nonce:" + nonce, "1", "EX", NONCE_TTL_SEC, "NX");
    if (result === null) {
      return res.status(400).json({ error: "Duplicate request detected (nonce already used)" });
    }
  } catch (e) {
    logger.error("[SecureMe] replay protection Redis error:", e.message);
  }
  next();
}

const HEARTBEAT_TTL_SEC = 25;
const POLL_INTERVAL_MS = 5000;
const RECHECK_DELAY_MS = 10000;
const STALE_THRESHOLD_MS = 30000;
const MONGO_POLL_MS = 15000;

const ZoneSchema = new mongoose.Schema({
  zone: [{ lat: Number, lng: Number }],
});
const Zone = mongoose.models.SecureMeZone || mongoose.model("SecureMeZone", ZoneSchema);

const AlertSchema = new mongoose.Schema({
  username: String,
  trigger: String,
  reason: String,
  batteryPct: Number,
  mode: String,
  lat: Number,
  lng: Number,
  time: Date,
});
const Alert = mongoose.models.SecureMeAlert || mongoose.model("SecureMeAlert", AlertSchema);

const HeartbeatSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  batteryPct: Number,
  mode: String,
  lat: Number,
  lng: Number,
  lastSeen: Date,
  active: { type: Boolean, default: true },
  appState: { type: String, default: "unknown" },
  networkStatus: { type: Boolean, default: true },
  retryCount: { type: Number, default: 0 },
  networkUnstable: { type: Boolean, default: false },
});
const Heartbeat = mongoose.models.SecureMeHeartbeat || mongoose.model("SecureMeHeartbeat", HeartbeatSchema);

async function pushNetworkAlert({
  username,
  state,
  reason = "",
  batteryPct = null,
  mode = "secureme",
  lat = null,
  lng = null,
  lastSeen = null,
  metadata = {},
}) {
  await NetworkAlert.create({
    username,
    state,
    reason,
    batteryPct,
    mode,
    lat,
    lng,
    lastSeen,
    source: "secureme",
    metadata,
  });
}

async function fireShutdownAlert(username, batteryPct, mode, lat, lng) {
  logger.info(`[SecureMe] Shutdown: user=${username} battery=${batteryPct}% mode=${mode}`);

  const dupeKey = `shutdown_alerted:${username}`;
  const already = await redis.get(dupeKey);
  if (already) {
    logger.info(`[SecureMe] Duplicate suppressed for ${username}`);
    return;
  }
  await redis.set(dupeKey, "1", "EX", 60);

  const modeLabel = { walk: "Walk Monitoring", cab: "Cab Escort", secureme: "SecureMe" }[mode] || mode;
  const message = `user disconnected from server, please verify`;
  const shutdownReason = typeof batteryPct === "number" && batteryPct <= 5
    ? "BATTERY_SHUTDOWN"
    : "SHUTDOWN_DETECTED";

  await pushNetworkAlert({
    username,
    state: "OFFLINE",
    reason: shutdownReason,
    batteryPct,
    mode,
    lat: lat || null,
    lng: lng || null,
    lastSeen: new Date(),
    metadata: {
      trigger: "battery_shutdown",
      message,
    },
  });

  await socketBridge.triggerAlertMode(username).catch(() => {});
  logger.info(`[SecureMe] Network alert saved - ${username} | ${modeLabel} | ${batteryPct}%`);
}

async function detectShutdown(username) {
  const rawHistory = await redis.lrange(`hb_history:${username}`, 0, 2);
  if (!rawHistory || rawHistory.length === 0) {
    logger.info(`[SecureMe][AI] No history for ${username} - skipping`);
    return;
  }

  const history = rawHistory
    .map((entry) => {
      try {
        return JSON.parse(entry);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (history.length === 0) return;

  const last = history[0];
  const prev = history[1];

  if (last.networkUnstable === true) {
    logger.info(`[SecureMe][AI] ${username} skipped (network unstable)`);
    return;
  }

  if (last.battery <= 5) {
    logger.info(`[SecureMe][AI] ${username} battery <= 5% - low-battery shutdown, skipping`);
    return;
  }

  let stableIntervals = false;
  if (prev) {
    const gap = new Date(last.time) - new Date(prev.time);
    if (gap >= 10_000 && gap <= 18_000) {
      stableIntervals = true;
    }
  }

  let score = 0;
  if (last.battery > 20) score += 2;
  if (last.retryCount > 0) score -= 2;
  if (last.networkStatus === false) score -= 3;
  if (stableIntervals) score += 2;
  if (last.appState === "active") score += 1;
  if (last.appState === "background") score -= 1;

  logger.info(
    `[SecureMe][AI] ${username} score=${score} ` +
      `battery=${last.battery}% retry=${last.retryCount} ` +
      `network=${last.networkStatus} stable=${stableIntervals} appState=${last.appState}`
  );

  if (score >= 3) {
    await fireAlert(username, last.battery, last.lat, last.lng);
  } else {
    logger.info(`[SecureMe][AI] ${username} ignored (likely network issue, score=${score})`);
  }
}

async function fireAlert(username, batteryPct, lat, lng) {
  const dupeKey = `alerted:${username}`;
  const already = await redis.get(dupeKey);
  if (already) {
    logger.info(`[SecureMe][AI] Alert already fired for ${username} - suppressing`);
    return;
  }
  await redis.set(dupeKey, "1", "EX", 60);

  const hb = await Heartbeat.findOne({ username }).lean();
  const mode = hb?.mode || "unknown";

  logger.info(`[SecureMe][AI] ALERT TRIGGERED - ${username} battery=${batteryPct}% mode=${mode}`);
  await fireShutdownAlert(username, batteryPct, mode, lat, lng);
}

async function scheduleRecheck(username) {
  const recheckKey = `recheck:${username}`;
  const exists = await redis.get(recheckKey);
  if (exists) {
    logger.info(`[SecureMe] Recheck already scheduled for ${username}`);
    return;
  }
  await redis.set(recheckKey, "1", "EX", 15);

  logger.info(`[SecureMe] Recheck scheduled for ${username} in ${RECHECK_DELAY_MS / 1000}s`);

  setTimeout(async () => {
    try {
      const existsAgain = await redis.exists(`hb:${username}`);
      if (existsAgain) {
        logger.info(`[SecureMe] ${username} recovered - transient network issue, no alert`);
        return;
      }

      const rawHistory = await redis.lrange(`hb_history:${username}`, 0, 0);
      if (rawHistory && rawHistory.length > 0) {
        const last = JSON.parse(rawHistory[0]);
        if (last.networkUnstable === true) {
          logger.info(`[SecureMe] ${username} skip recheck (unstable)`);
          return;
        }
      }

      await detectShutdown(username);
    } catch (e) {
      logger.error(`[SecureMe] scheduleRecheck error for ${username}:`, e.message);
    }
  }, RECHECK_DELAY_MS);
}

async function runActiveUserPoll() {
  try {
    const users = await redis.smembers("active_users");
    if (users.length === 0) return;

    for (const username of users) {
      const exists = await redis.exists(`hb:${username}`);
      if (!exists) {
        logger.info(`[SecureMe] Liveness key gone for ${username} - scheduling recheck`);
        await scheduleRecheck(username);
        await redis.srem("active_users", username);
      }
    }
  } catch (e) {
    logger.error("[SecureMe] active-user poll error:", e.message);
  }
}

setTimeout(() => {
  logger.info(`[SecureMe] Redis active-user poll started (every ${POLL_INTERVAL_MS / 1000}s)`);
  setInterval(runActiveUserPoll, POLL_INTERVAL_MS);
}, 5000);

async function pollForDeadHeartbeats() {
  try {
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

    const stale = await Heartbeat.find({
      active: true,
      lastSeen: { $lt: cutoff },
    });

    for (const hb of stale) {
      const rawHistory = await redis.lrange(`hb_history:${hb.username}`, 0, 0);
      if (rawHistory && rawHistory.length > 0) {
        const last = JSON.parse(rawHistory[0]);
        if (last.networkUnstable === true) {
          logger.info(`[SecureMe] ${hb.username} skip Mongo alert (unstable)`);
          continue;
        }
      }

      logger.info(`[SecureMe] Stale heartbeat: ${hb.username} lastSeen=${hb.lastSeen} battery=${hb.batteryPct}%`);

      if (hb.batteryPct > 5) {
        await fireShutdownAlert(hb.username, hb.batteryPct, hb.mode, hb.lat, hb.lng);
      } else {
        logger.info(`[SecureMe] ${hb.username} battery <= 5% - normal low-battery shutdown, skipping`);
      }

      await Heartbeat.findOneAndUpdate(
        { username: hb.username },
        { active: false }
      );
    }
  } catch (e) {
    logger.error("[SecureMe] Mongo poll error:", e.message);
  }
}

setTimeout(() => {
  logger.info("[SecureMe] MongoDB heartbeat fallback poll started (every 15s)");
  setInterval(pollForDeadHeartbeats, MONGO_POLL_MS);
}, 5000);

router.post("/heartbeat", verifyToken, replayProtection, async (req, res) => {
  const {
    username,
    batteryPct,
    mode,
    lat,
    lng,
    appState = "unknown",
    networkStatus = true,
    retryCount = 0,
    networkUnstable = false,
  } = req.body;

  if (!username) return res.status(400).json({ error: "username required" });
  if (!mode) return res.status(400).json({ error: "mode required" });

  try {
    const now = new Date().toISOString();

    await redis.set(`hb:${username}`, batteryPct ?? -1, "EX", HEARTBEAT_TTL_SEC);

    const snapshot = JSON.stringify({
      time: now,
      battery: batteryPct ?? null,
      lat: lat ?? null,
      lng: lng ?? null,
      appState,
      networkStatus,
      retryCount,
      networkUnstable,
    });

    const histKey = `hb_history:${username}`;
    await redis.lpush(histKey, snapshot);
    await redis.ltrim(histKey, 0, 2);
    await redis.expire(histKey, 60);

    await redis.sadd("active_users", username);
    await redis.expire("active_users", 60);

    await Heartbeat.findOneAndUpdate(
      { username },
      {
        batteryPct: batteryPct ?? null,
        mode,
        lat: lat ?? null,
        lng: lng ?? null,
        lastSeen: new Date(),
        active: true,
        appState,
        networkStatus,
        retryCount,
        networkUnstable,
      },
      { upsert: true, new: true }
    );

    res.json({ ok: true, ttl: HEARTBEAT_TTL_SEC });
  } catch (e) {
    logger.error("[SecureMe] heartbeat error:", e.message);
    res.status(500).json({ error: "heartbeat failed" });
  }
});

router.delete("/heartbeat", verifyToken, async (req, res) => {
  const { username, mode } = req.body;
  if (!username) return res.status(400).json({ error: "username required" });

  try {
    await redis.del(`hb:${username}`);
    await redis.del(`hb_history:${username}`);
    await redis.srem("active_users", username);

    await Heartbeat.findOneAndUpdate(
      { username },
      { active: false }
    );

    await socketBridge.resolveAlertMode(username).catch(() => {});

    logger.info(`[SecureMe] Clean stop - user=${username} mode=${mode}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "clear failed" });
  }
});

router.post("/save-zone", verifyToken, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin access only" });
    }
    if (!Array.isArray(req.body.zone) || req.body.zone.length < 3) {
      return res.status(400).json({ error: "zone must be an array of at least 3 coordinates" });
    }
    const z = new Zone({ zone: req.body.zone });
    await z.save();
    res.json({ msg: "SecureMe Zone Updated", _id: z._id });
  } catch (e) {
    logger.error("[SecureMe] save-zone error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get("/get-zone", verifyToken, async (req, res) => {
  try {
    const zones = await Zone.find();
    if (!zones || zones.length === 0) return res.json([]);
    res.json(zones);
  } catch (e) {
    logger.error("[SecureMe] get-zone error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

router.delete("/zone/:id", verifyToken, async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin access only" });
    }
    const deleted = await Zone.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Zone not found" });
    res.json({ msg: "Zone deleted" });
  } catch (e) {
    logger.error("[SecureMe] zone delete error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post("/alert", verifyToken, replayProtection, alertLimiter, async (req, res) => {
  try {
    const a = new Alert({
      username: req.body.userId || req.body.username || req.user?.userId || "SECUREME_AUTO",
      trigger: req.body.trigger || "manual",
      reason: req.body.reason || "",
      batteryPct: req.body.batteryPct || null,
      mode: req.body.mode || null,
      lat: req.body.lat || null,
      lng: req.body.lng || null,
      time: new Date(),
    });
    await a.save();
    await socketBridge.triggerAlertMode(a.username).catch(() => {});
    logger.info("[SECUREME ALERT]", { username: a.username, reason: a.reason });
    res.json({ msg: "SecureMe Alert Stored" });
  } catch (e) {
    logger.error("[SecureMe] alert error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get("/alerts", verifyToken, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 500));
    const skip = (page - 1) * limit;

    const [alerts, total] = await Promise.all([
      Alert.find().sort({ time: -1 }).skip(skip).limit(limit),
      Alert.countDocuments(),
    ]);

    res.json({ alerts, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

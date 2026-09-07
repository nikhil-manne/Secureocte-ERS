/**
 * socket/socketManager.js
 * WebSocket + Redis Unified System
 */

import { Server } from "socket.io";
import Redis from "ioredis";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import logger from "../config/logger.js";
import { handleHeartbeat } from "../services/networkMonitor.js";
import CabEscortTrip from "../models/CabEscortTrip.js";
import WalkSession from "../models/WalkSession.js";
import UserLocation from "../models/userLocation.js";

const ALERT_INTERVAL = 5_000;
const NORMAL_INTERVAL = 15_000;
const LOCATION_TTL = 60;
const ALERT_MODE_TTL = 20 * 60;

const SOCKET_TS_WINDOW_MS = 30_000;
const SOCKET_NONCE_TTL_SEC = 60;
const SOCKET_RATE_WINDOW_SEC = 60;
const SOCKET_RATE_LIMITS = {
  location_update: 180,
  subscribe_location_updates: 60,
  unsubscribe_location_updates: 60,
  subscribe_patrol_count: 60,
  unsubscribe_patrol_count: 60,
  subscribe_patrol_dispatch: 60,
  unsubscribe_patrol_dispatch: 60,
  subscribe_incident_reports: 60,
  unsubscribe_incident_reports: 60,
  default: 120,
};

function parseAllowedSocketOrigins() {
  return [
    "https://server-r9k4.onrender.com",
    ...(process.env.EXTRA_CORS_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ];
}

function makeRedisClient(name) {
  if (!process.env.REDIS_URL) {
    logger.warn(`[Socket][Redis] REDIS_URL not set - ${name} client disabled`);
    return null;
  }

  const client = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    lazyConnect: true,
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === "true" ? {} : undefined,
    retryStrategy: (times) => {
      if (times > 10) return null;
      return Math.min(100 * 2 ** times, 10_000);
    },
  });

  client.on("connect", () => logger.info(`[Socket][Redis] ${name} connected`));
  client.on("error", (e) => logger.error(`[Socket][Redis] ${name}: ${e.message}`));
  return client;
}

const redisWrite = makeRedisClient("write");
const redisSubscriber = makeRedisClient("subscriber");

const dashboardSockets = new Set();
const liveLocationSubscribers = new Set();
const localReplayCache = new Map();
const localRateCache = new Map();

let ioInstance = null;

function intervalForMode(mode) {
  return mode === "alert" ? ALERT_INTERVAL : NORMAL_INTERVAL;
}

function nonceValid(nonce) {
  return typeof nonce === "string" && nonce.length >= 8 && nonce.length <= 128;
}

function parseTs(tsRaw) {
  const ts = Number(tsRaw);
  return Number.isFinite(ts) ? ts : NaN;
}

function validRoomId(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 64;
}

function pruneExpiringMap(cache) {
  const now = Date.now();
  for (const [key, expiresAt] of cache) {
    if (expiresAt <= now) cache.delete(key);
  }
}

function localReplaySetIfNew(key, ttlMs) {
  pruneExpiringMap(localReplayCache);
  if (localReplayCache.has(key)) return false;
  localReplayCache.set(key, Date.now() + ttlMs);
  return true;
}

function localRateAllow(key, limit, windowMs) {
  pruneExpiringMap(localRateCache);
  const now = Date.now();
  const current = localRateCache.get(key);

  if (!current || current.resetAt <= now) {
    localRateCache.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (current.count >= limit) return false;
  current.count += 1;
  localRateCache.set(key, current);
  return true;
}

async function checkReplay(userId, nonce, scope = "msg") {
  const key = `sreplay:${scope}:${userId}:${nonce}`;
  if (redisWrite) {
    const ok = await redisWrite.set(key, "1", "EX", SOCKET_NONCE_TTL_SEC, "NX");
    return ok === "OK";
  }
  return localReplaySetIfNew(key, SOCKET_NONCE_TTL_SEC * 1000);
}

async function checkRate(userId, eventName) {
  const limit = SOCKET_RATE_LIMITS[eventName] || SOCKET_RATE_LIMITS.default;
  const key = `srl:${eventName}:${userId}`;

  if (redisWrite) {
    const bucket = Math.floor(Date.now() / (SOCKET_RATE_WINDOW_SEC * 1000));
    const redisKey = `${key}:${bucket}`;
    const count = await redisWrite.incr(redisKey);
    if (count === 1) {
      await redisWrite.expire(redisKey, SOCKET_RATE_WINDOW_SEC + 2);
    }
    return count <= limit;
  }

  return localRateAllow(key, limit, SOCKET_RATE_WINDOW_SEC * 1000);
}

function normalizeHandshake(socket) {
  const auth = socket.handshake.auth || {};
  const headers = socket.handshake.headers || {};
  const authorization = auth.token || headers.authorization || "";
  const token = String(authorization).replace(/^Bearer\s+/i, "").trim();

  return {
    token,
    userId: auth.userId,
    deviceId: auth.deviceId || headers["x-device-id"],
    xTimestamp: auth.xTimestamp || headers["x-timestamp"],
    xNonce: auth.xNonce || headers["x-nonce"],
  };
}

export async function verifySocketHandshakeInput(
  input,
  { now = Date.now(), checkReplayFn = checkReplay } = {}
) {
  const handshake = {
    token: input?.token || "",
    userId: input?.userId,
    deviceId: input?.deviceId,
    xTimestamp: input?.xTimestamp,
    xNonce: input?.xNonce,
  };

  if (!handshake.token) {
    throw new Error("UNAUTHORIZED");
  }

  let decoded;
  try {
    decoded = jwt.verify(handshake.token, process.env.JWT_SECRET);
  } catch (err) {
    logger.warn({ msg: "[Socket] JWT verify failed", error: err.message });
    throw new Error("UNAUTHORIZED");
  }

  const role = decoded.role || "user";
  const tokenUserId = decoded.userId ? String(decoded.userId) : "";
  const claimedUserId = handshake.userId ? String(handshake.userId) : tokenUserId;
  const deviceId = handshake.deviceId ? String(handshake.deviceId) : "";

  if (role !== "admin") {
    const tokenDeviceId = decoded.deviceId ? String(decoded.deviceId) : "";
    if (tokenUserId && claimedUserId && claimedUserId !== tokenUserId && claimedUserId !== String(decoded.username)) {
      logger.warn({ msg: "[Socket] UserId mismatch", claimedUserId, tokenUserId, username: decoded.username });
      throw new Error("UNAUTHORIZED");
    }
    if (tokenDeviceId && deviceId && deviceId !== tokenDeviceId) {
      logger.warn({ msg: "[Socket] DeviceId mismatch", deviceId, tokenDeviceId });
      throw new Error("UNAUTHORIZED");
    }
  }

  const parsedTs = parseTs(handshake.xTimestamp);
  const ts = Number.isFinite(parsedTs) ? parsedTs : now;
  const nonce = (handshake.xNonce && nonceValid(String(handshake.xNonce)))
    ? String(handshake.xNonce)
    : `socket_${now}_${Math.random().toString(36).slice(2, 10)}`;

  if (Math.abs(now - ts) > SOCKET_TS_WINDOW_MS) {
    logger.warn({ msg: "[Socket] Timestamp window expired", ts, now });
    throw new Error("UNAUTHORIZED");
  }

  if (handshake.xNonce) {
    const replayKeyUser = claimedUserId || decoded.username || input?.socketId || "socket";
    const replayOk = await checkReplayFn(replayKeyUser, nonce, "conn");
    if (!replayOk) {
      logger.warn({ msg: "[Socket] Replay detected for nonce", nonce });
      throw new Error("UNAUTHORIZED");
    }
  }

  return {
    userId: claimedUserId || tokenUserId || "",
    username: decoded.username || null,
    role,
    deviceId: decoded.deviceId || null,
  };
}

async function authenticateSocket(socket) {
  const authData = await verifySocketHandshakeInput(
    {
      ...normalizeHandshake(socket),
      socketId: socket.id,
    }
  );

  socket.data.auth = authData;
}

function emitSocketSecurityError(socket, code, message) {
  socket.emit("error", { code, message });
}

async function persistSocketLocation(userIdStr, lat, lng, username = null, extra = {}) {
  try {
    const now = new Date();
    const Heartbeat = mongoose.models.SecureMeHeartbeat;
    if (Heartbeat && (username || userIdStr)) {
      await Heartbeat.findOneAndUpdate(
        username ? { username } : { username: userIdStr },
        {
          lat,
          lng,
          lastSeen: now,
          active: true,
          ...(extra.batteryPct !== undefined && { batteryPct: extra.batteryPct }),
          ...(extra.mode && { mode: extra.mode }),
          ...(extra.networkStatus !== undefined && { networkStatus: extra.networkStatus }),
          ...(extra.networkUnstable !== undefined && { networkUnstable: extra.networkUnstable }),
          ...(extra.appState && { appState: extra.appState }),
        },
        { upsert: Boolean(username) }
      ).catch(() => {});
    }

    if (CabEscortTrip && userIdStr) {
      await CabEscortTrip.updateMany(
        { userId: userIdStr, status: "active" },
        { currentLocation: { latitude: lat, longitude: lng }, updatedAt: now }
      ).catch(() => {});
    }

    if (WalkSession && userIdStr) {
      await WalkSession.updateMany(
        { userId: userIdStr, status: "ACTIVE" },
        { currentLocation: { latitude: lat, longitude: lng }, updatedAt: now }
      ).catch(() => {});
    }

    if (UserLocation && userIdStr) {
      await UserLocation.findOneAndUpdate(
        { userId: userIdStr },
        { latitude: lat, longitude: lng, updatedAt: now },
        { upsert: true }
      ).catch(() => {});
    }
  } catch (err) {
    logger.error(`[Socket] persistSocketLocation error for ${userIdStr}: ${err.message}`);
  }
}

export function initSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: (origin, cb) => {
        const allowed = parseAllowedSocketOrigins();
        if (!origin || allowed.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      methods: ["GET", "POST"],
      credentials: true,
    },
    pingTimeout: 20_000,
    pingInterval: 25_000,
  });
  ioInstance = io;

  io.use(async (socket, next) => {
    try {
      await authenticateSocket(socket);
      next();
    } catch (err) {
      logger.warn(`[Socket] Handshake auth failed: ${err.message}`);
      next(new Error("UNAUTHORIZED"));
    }
  });

  if (redisSubscriber) {
    redisSubscriber.subscribe("location_update", "mode_change", "user_notification", (err, count) => {
      if (err) {
        logger.error(`[Socket] Redis subscribe error: ${err.message}`);
        return;
      }
      logger.info(`[Socket] Subscribed to ${count} Redis channel(s)`);
    });

    redisSubscriber.on("message", (channel, message) => {
      let payload;
      try {
        payload = JSON.parse(message);
      } catch {
        logger.warn(`[Socket] Bad JSON on channel ${channel}`);
        return;
      }

      if (channel === "location_update") {
        dashboardSockets.forEach((socketId) => io.to(socketId).emit("location_update", payload));
        liveLocationSubscribers.forEach((socketId) => io.to(socketId).emit("location_update", payload));
      }

      if (channel === "mode_change") {
        const { userId, mode } = payload;
        if (!userId || !mode) return;

        io.to(String(userId)).emit("mode", {
          mode,
          interval: intervalForMode(mode),
        });
        logger.info(`[Socket] Mode change -> user ${userId}: ${mode}`);
      }

      if (channel === "user_notification") {
        const { userId, type, ...data } = payload;
        if (!userId || !type) return;

        io.to(String(userId)).emit("user_notification", {
          type,
          ...data,
        });
        logger.info(`[Socket] Notification -> user ${userId}: ${type}`);
      }
    });
  }

  io.on("connection", (socket) => {
    const { userId, role } = socket.data?.auth || {};

    if (role === "dashboard" || role === "admin") {
      dashboardSockets.add(socket.id);
      logger.info(`[Socket] Dashboard connected: ${socket.id}`);

      socket.on("disconnect", () => {
        dashboardSockets.delete(socket.id);
        liveLocationSubscribers.delete(socket.id);
        logger.info(`[Socket] Dashboard disconnected: ${socket.id}`);
      });
      return;
    }

    if (!userId) {
      logger.warn("[Socket] Connection rejected - no authenticated userId");
      socket.disconnect(true);
      return;
    }

    const userIdStr = String(userId);
    socket.join(userIdStr);
    logger.info(`[Socket] User connected: ${userIdStr} (socket ${socket.id})`);

    socket.use(async (packet, next) => {
      try {
        const eventName = packet?.[0];
        const data = packet?.[1];

        if (!eventName || eventName === "location_update") {
          return next();
        }

        const allowed = await checkRate(userIdStr, eventName);
        if (!allowed) {
          emitSocketSecurityError(socket, "RATE_LIMITED", "Too many socket messages");
          return;
        }

        if (!data || typeof data !== "object") {
          emitSocketSecurityError(socket, "BAD_SECURITY_HEADERS", "Invalid socket security envelope");
          return;
        }

        const secTs = parseTs(data.xTimestamp);
        const secNonce = String(data.xNonce || "");
        if (
          !Number.isFinite(secTs) ||
          Math.abs(Date.now() - secTs) > SOCKET_TS_WINDOW_MS ||
          !nonceValid(secNonce)
        ) {
          emitSocketSecurityError(socket, "BAD_SECURITY_HEADERS", "Invalid socket security envelope");
          return;
        }

        const replayOk = await checkReplay(userIdStr, secNonce, `msg:${eventName}`);
        if (!replayOk) {
          emitSocketSecurityError(socket, "REPLAY_DETECTED", "Duplicate socket message detected");
          return;
        }

        next();
      } catch (err) {
        logger.warn(`[Socket] Packet security middleware error: ${err.message}`);
      }
    });

    socket.on("subscribe_location_updates", (data = {}) => {
      liveLocationSubscribers.add(socket.id);
      socket.emit("subscription_ack", {
        channel: "location_updates",
        action: "subscribed",
        ok: true,
        data,
      });
    });

    socket.on("unsubscribe_location_updates", (data = {}) => {
      liveLocationSubscribers.delete(socket.id);
      socket.emit("subscription_ack", {
        channel: "location_updates",
        action: "unsubscribed",
        ok: true,
        data,
      });
    });

    socket.on("subscribe_patrol_dispatch", (data = {}) => {
      const tripId = String(data.tripId || "");
      if (!validRoomId(tripId)) {
        emitSocketSecurityError(socket, "BAD_SUBSCRIPTION", "Invalid tripId for patrol dispatch subscription");
        return;
      }

      socket.join(`patrol_dispatch:${tripId}`);
      socket.emit("subscription_ack", {
        channel: "patrol_dispatch",
        action: "subscribed",
        ok: true,
        tripId,
      });
    });

    socket.on("unsubscribe_patrol_dispatch", (data = {}) => {
      const tripId = String(data.tripId || "");
      if (!validRoomId(tripId)) {
        emitSocketSecurityError(socket, "BAD_SUBSCRIPTION", "Invalid tripId for patrol dispatch unsubscription");
        return;
      }

      socket.leave(`patrol_dispatch:${tripId}`);
      socket.emit("subscription_ack", {
        channel: "patrol_dispatch",
        action: "unsubscribed",
        ok: true,
        tripId,
      });
    });

    socket.on("subscribe_incident_reports", (data = {}) => {
      const tripId = String(data.tripId || "");
      if (!validRoomId(tripId)) {
        emitSocketSecurityError(socket, "BAD_SUBSCRIPTION", "Invalid tripId for incident subscription");
        return;
      }

      socket.join(`incident_reports:${tripId}`);
      socket.emit("subscription_ack", {
        channel: "incident_reports",
        action: "subscribed",
        ok: true,
        tripId,
      });
    });

    socket.on("unsubscribe_incident_reports", (data = {}) => {
      const tripId = String(data.tripId || "");
      if (!validRoomId(tripId)) {
        emitSocketSecurityError(socket, "BAD_SUBSCRIPTION", "Invalid tripId for incident unsubscription");
        return;
      }

      socket.leave(`incident_reports:${tripId}`);
      socket.emit("subscription_ack", {
        channel: "incident_reports",
        action: "unsubscribed",
        ok: true,
        tripId,
      });
    });

    (async () => {
      try {
        let mode = "normal";
        if (redisWrite) {
          const stored = await redisWrite.get(`user:${userIdStr}:mode`);
          if (stored) mode = stored;
        }
        socket.emit("mode", { mode, interval: intervalForMode(mode) });
      } catch (err) {
        logger.warn(`[Socket] Could not fetch mode for ${userIdStr}: ${err.message}`);
        socket.emit("mode", { mode: "normal", interval: NORMAL_INTERVAL });
      }
    })();

    socket.on("location_update", async (data = {}) => {
      try {
        const allowed = await checkRate(userIdStr, "location_update");
        if (!allowed) {
          emitSocketSecurityError(socket, "RATE_LIMITED", "Too many socket messages");
          return;
        }

        const secTs = parseTs(data.xTimestamp);
        const secNonce = String(data.xNonce || "");
        if (
          !Number.isFinite(secTs) ||
          Math.abs(Date.now() - secTs) > SOCKET_TS_WINDOW_MS ||
          !nonceValid(secNonce)
        ) {
          emitSocketSecurityError(socket, "BAD_SECURITY_HEADERS", "Invalid socket security envelope");
          return;
        }

        const replayOk = await checkReplay(userIdStr, secNonce, "msg:location_update");
        if (!replayOk) {
          emitSocketSecurityError(socket, "REPLAY_DETECTED", "Duplicate socket message detected");
          return;
        }

        const payload = {
          userId: userIdStr,
          lat: data?.lat,
          lng: data?.lng,
          type: data?.type || "unknown",
          timestamp: data?.timestamp || Date.now(),
          username: socket.data?.auth?.username || data?.username || null,
        };

        if (
          typeof payload.lat !== "number" ||
          typeof payload.lng !== "number" ||
          payload.lat < -90 ||
          payload.lat > 90 ||
          payload.lng < -180 ||
          payload.lng > 180
        ) {
          emitSocketSecurityError(socket, "INVALID_COORDS", "Invalid coordinates");
          return;
        }

        if (redisWrite) {
          await redisWrite.set(
            `user:${userIdStr}:location`,
            JSON.stringify(payload),
            "EX",
            LOCATION_TTL
          );
          await redisWrite.publish("location_update", JSON.stringify(payload));
        } else {
          dashboardSockets.forEach((socketId) => io.to(socketId).emit("location_update", payload));
          liveLocationSubscribers.forEach((socketId) => io.to(socketId).emit("location_update", payload));
        }

        persistSocketLocation(userIdStr, payload.lat, payload.lng, payload.username).catch((err) =>
          logger.error(`[Socket] persistSocketLocation error in location_update: ${err.message}`)
        );
      } catch (err) {
        logger.error(`[Socket] location_update error for ${userIdStr}: ${err.message}`);
      }
    });

    socket.on("disconnect", (reason) => {
      liveLocationSubscribers.delete(socket.id);
      logger.info(`[Socket] User ${userIdStr} disconnected: ${reason}`);
    });

    // ── NETWORK MONITOR: heartbeat from frontend ──
    socket.on("HEARTBEAT", async (data = {}) => {
      // data.userId is advisory — always trust the authenticated userId from the token
      handleHeartbeat(userIdStr).catch((err) =>
        logger.error(`[Socket] HEARTBEAT handler error for ${userIdStr}: ${err.message}`)
      );

      if (typeof data.lat === "number" && typeof data.lng === "number" && data.lat >= -90 && data.lat <= 90 && data.lng >= -180 && data.lng <= 180) {
        const username = socket.data?.auth?.username || data.username || null;
        const payload = {
          userId: userIdStr,
          lat: data.lat,
          lng: data.lng,
          type: data.mode || "secureme",
          timestamp: Date.now(),
          username,
          batteryPct: data.batteryPct,
        };
        if (redisWrite) {
          await redisWrite.set(`user:${userIdStr}:location`, JSON.stringify(payload), "EX", LOCATION_TTL).catch(() => {});
          await redisWrite.publish("location_update", JSON.stringify(payload)).catch(() => {});
        } else {
          dashboardSockets.forEach((sId) => io.to(sId).emit("location_update", payload));
          liveLocationSubscribers.forEach((sId) => io.to(sId).emit("location_update", payload));
        }
        persistSocketLocation(userIdStr, data.lat, data.lng, username, data).catch((err) =>
          logger.error(`[Socket] persistSocketLocation error in HEARTBEAT: ${err.message}`)
        );
      } else if (data.batteryPct !== undefined || data.mode) {
        const username = socket.data?.auth?.username || data.username || null;
        const Heartbeat = mongoose.models.SecureMeHeartbeat;
        if (Heartbeat && (username || userIdStr)) {
          Heartbeat.findOneAndUpdate(
            username ? { username } : { username: userIdStr },
            {
              lastSeen: new Date(),
              active: true,
              ...(data.batteryPct !== undefined && { batteryPct: data.batteryPct }),
              ...(data.mode && { mode: data.mode }),
              ...(data.networkStatus !== undefined && { networkStatus: data.networkStatus }),
              ...(data.networkUnstable !== undefined && { networkUnstable: data.networkUnstable }),
              ...(data.appState && { appState: data.appState }),
            },
            { upsert: Boolean(username) }
          ).catch(() => {});
        }
      }
    });
  });

  logger.info("[Socket] Socket.IO server initialised");
  return { io, redisWrite };
}

export async function triggerAlertMode(userId) {
  const userIdStr = String(userId);
  try {
    if (!redisWrite) {
      logger.warn("[Socket] triggerAlertMode called but Redis unavailable");
      return;
    }

    const current = await redisWrite.get(`user:${userIdStr}:mode`);
    if (current === "alert") return;

    await redisWrite.set(`user:${userIdStr}:mode`, "alert", "EX", ALERT_MODE_TTL);
    await redisWrite.publish("mode_change", JSON.stringify({ userId: userIdStr, mode: "alert" }));
    logger.info(`[Socket] Alert mode SET for user ${userIdStr}`);
  } catch (err) {
    logger.error(`[Socket] triggerAlertMode error for ${userIdStr}: ${err.message}`);
  }
}

export async function resolveAlertMode(userId) {
  const userIdStr = String(userId);
  try {
    if (!redisWrite) {
      logger.warn("[Socket] resolveAlertMode called but Redis unavailable");
      return;
    }

    await redisWrite.set(`user:${userIdStr}:mode`, "normal");
    await redisWrite.publish("mode_change", JSON.stringify({ userId: userIdStr, mode: "normal" }));
    logger.info(`[Socket] Alert mode RESOLVED for user ${userIdStr}`);
  } catch (err) {
    logger.error(`[Socket] resolveAlertMode error for ${userIdStr}: ${err.message}`);
  }
}

export function emitPatrolDispatchUpdate(tripId, dispatch) {
  if (!ioInstance || !tripId) return;
  ioInstance.to(`patrol_dispatch:${String(tripId)}`).emit("patrol_dispatch_update", {
    tripId: String(tripId),
    dispatch: dispatch || null,
  });
}

export function emitIncidentReportsUpdate(tripId, reports = []) {
  if (!ioInstance || !tripId) return;
  ioInstance.to(`incident_reports:${String(tripId)}`).emit("incident_reports_update", {
    tripId: String(tripId),
    reports: Array.isArray(reports) ? reports : [],
  });
}

/**
 * socket.js  —  Central WebSocket client for SecureOcte frontend.
 *
 * Mirrors api.js: one shared connection, reused everywhere, with the
 * same device-binding + replay-protection headers the REST layer uses
 * (X-Device-Id / X-Timestamp / X-Nonce, sent here as handshake.auth
 * fields instead of HTTP headers).
 *
 * Matches the contract implemented in safety-backend/socket/socketManager.js:
 *   - handshake auth: { token, userId, deviceId, xTimestamp, xNonce }
 *   - server pushes `mode` events → { mode: "normal"|"alert", interval }
 *   - client emits `location_update` with its own xTimestamp/xNonce envelope
 *   - client emits `HEARTBEAT` (no envelope required server-side)
 *   - room subscriptions: subscribe_patrol_dispatch / subscribe_incident_reports
 *   - server emits: location_update, mode, patrol_dispatch_update,
 *     incident_reports_update, NETWORK_ALERT, user_notification, error
 *
 * NOTE: This module intentionally does NOT replace REST calls that persist
 * data (e.g. PUT /api/panic/location, POST /api/secureme/heartbeat). Those
 * REST paths remain as the source of truth / fallback. Socket emits are an
 * additive, faster real-time channel — see useWalkEngine.js and
 * Batterymonitor.js for the dual REST+socket pattern.
 */

import { io } from "socket.io-client";
import { BASE_URL, getDeviceId, _uuidV4 } from "./api";

const NORMAL_INTERVAL_MS = 15_000;
const ALERT_INTERVAL_MS  = 5_000;

let socket = null;
let currentMode = "normal";
let currentInterval = NORMAL_INTERVAL_MS;

const listeners = {
  locationUpdate: new Set(),
  modeChange:     new Set(),
  networkAlert:   new Set(),
  notification:   new Set(),
  patrolDispatch: new Map(), // tripId -> Set(cb)
  incidentReports: new Map(), // tripId -> Set(cb)
  socketError:    new Set(),
};

function envelope() {
  return { xTimestamp: String(Date.now()), xNonce: _uuidV4() };
}

/**
 * connectSocket — call once after login (token becomes available).
 * Safe to call again with a fresh token; it will tear down any
 * existing connection first.
 *
 * @param {string} token   JWT from AuthContext
 * @param {string} userId  user._id (or admin username) — must match token
 * @param {"user"|"admin"} role
 */
export async function connectSocket({ token, userId, role = "user" }) {
  if (!token || !userId) {
    console.log("[Socket] connectSocket called without token/userId — skipping");
    return null;
  }

  if (socket) {
    disconnectSocket();
  }

  const deviceId = await getDeviceId();
  const { xTimestamp, xNonce } = envelope();

  socket = io(BASE_URL, {
    transports: ["websocket"],
    auth: (cb) => {
      cb({
        token,
        userId: String(userId),
        deviceId,
        ...envelope(),
      });
    },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  });

  socket.on("connect", () => {
    console.log("[Socket] ✅ Connected:", socket.id);
  });

  socket.on("connect_error", (err) => {
    console.log("[Socket] ❌ Connect error:", err.message);
  });

  socket.on("disconnect", (reason) => {
    console.log("[Socket] Disconnected:", reason);
  });

  socket.on("error", (payload = {}) => {
    console.log("[Socket] ⚠️ Server error event:", payload.code, payload.message);
    listeners.socketError.forEach((cb) => cb(payload));
  });

  socket.on("mode", (payload = {}) => {
    currentMode = payload.mode === "alert" ? "alert" : "normal";
    currentInterval = payload.interval || (currentMode === "alert" ? ALERT_INTERVAL_MS : NORMAL_INTERVAL_MS);
    console.log(`[Socket] Mode → ${currentMode} (interval ${currentInterval}ms)`);
    listeners.modeChange.forEach((cb) => cb({ mode: currentMode, interval: currentInterval }));
  });

  socket.on("location_update", (payload) => {
    listeners.locationUpdate.forEach((cb) => cb(payload));
  });

  socket.on("NETWORK_ALERT", (payload) => {
    listeners.networkAlert.forEach((cb) => cb(payload));
  });

  socket.on("user_notification", (payload) => {
    listeners.notification.forEach((cb) => cb(payload));
  });

  socket.on("patrol_dispatch_update", (payload = {}) => {
    const set = listeners.patrolDispatch.get(String(payload.tripId));
    if (set) set.forEach((cb) => cb(payload.dispatch));
  });

  socket.on("incident_reports_update", (payload = {}) => {
    const set = listeners.incidentReports.get(String(payload.tripId));
    if (set) set.forEach((cb) => cb(payload.reports || []));
  });

  return socket;
}

export function disconnectSocket() {
  if (!socket) return;
  try {
    socket.removeAllListeners();
    socket.disconnect();
  } catch (_) {}
  socket = null;
  currentMode = "normal";
  currentInterval = NORMAL_INTERVAL_MS;
}

export function isSocketConnected() {
  return !!socket?.connected;
}

/** Current server-assigned location send interval (ms) — 15s normal / 5s alert. */
export function getLocationInterval() {
  return currentInterval;
}

export function getCurrentMode() {
  return currentMode;
}

/**
 * emitLocationUpdate — sends one location ping over the socket.
 * type: "walk" | "cab" | "patrol" | "secureme" | "unknown"
 * Fire-and-forget; does not persist to the panic/trip DB record —
 * pair with the relevant REST PUT/POST for that where persistence matters.
 */
export function emitLocationUpdate({ lat, lng, type = "unknown", username = null }) {
  if (!socket?.connected) return false;
  if (typeof lat !== "number" || typeof lng !== "number") return false;

  socket.emit("location_update", {
    lat,
    lng,
    type,
    username,
    timestamp: Date.now(),
    ...envelope(),
  });
  return true;
}

/**
 * emitHeartbeat — companion to the REST POST /heartbeat call in
 * Batterymonitor.js. Feeds the fast Redis-keyspace watchdog in
 * services/networkMonitor.js on the backend. No security envelope
 * required by the server for this event.
 */
export function emitHeartbeat(payload = {}) {
  if (!socket?.connected) return false;
  socket.emit("HEARTBEAT", {
    ...payload,
    ...envelope(),
  });
  return true;
}

export function onLocationUpdate(cb) {
  listeners.locationUpdate.add(cb);
  return () => listeners.locationUpdate.delete(cb);
}

export function onModeChange(cb) {
  listeners.modeChange.add(cb);
  return () => listeners.modeChange.delete(cb);
}

export function onNetworkAlert(cb) {
  listeners.networkAlert.add(cb);
  return () => listeners.networkAlert.delete(cb);
}

export function onUserNotification(cb) {
  listeners.notification.add(cb);
  return () => listeners.notification.delete(cb);
}

export function onSocketError(cb) {
  listeners.socketError.add(cb);
  return () => listeners.socketError.delete(cb);
}

/**
 * subscribePatrolDispatch(tripId, cb) — joins the patrol_dispatch:{tripId}
 * room and registers a listener. Returns an unsubscribe function that
 * both removes the listener and leaves the room if no listeners remain.
 */
export function subscribePatrolDispatch(tripId, cb) {
  const id = String(tripId || "");
  if (!id || !socket) return () => {};

  if (!listeners.patrolDispatch.has(id)) {
    listeners.patrolDispatch.set(id, new Set());
  }
  const set = listeners.patrolDispatch.get(id);
  set.add(cb);

  if (set.size === 1) {
    socket.emit("subscribe_patrol_dispatch", { tripId: id, ...envelope() });
  }

  return () => {
    set.delete(cb);
    if (set.size === 0) {
      listeners.patrolDispatch.delete(id);
      socket?.emit("unsubscribe_patrol_dispatch", { tripId: id, ...envelope() });
    }
  };
}

/**
 * subscribeIncidentReports(tripId, cb) — same pattern as above for
 * incident_reports:{tripId}.
 */
export function subscribeIncidentReports(tripId, cb) {
  const id = String(tripId || "");
  if (!id || !socket) return () => {};

  if (!listeners.incidentReports.has(id)) {
    listeners.incidentReports.set(id, new Set());
  }
  const set = listeners.incidentReports.get(id);
  set.add(cb);

  if (set.size === 1) {
    socket.emit("subscribe_incident_reports", { tripId: id, ...envelope() });
  }

  return () => {
    set.delete(cb);
    if (set.size === 0) {
      listeners.incidentReports.delete(id);
      socket?.emit("unsubscribe_incident_reports", { tripId: id, ...envelope() });
    }
  };
}

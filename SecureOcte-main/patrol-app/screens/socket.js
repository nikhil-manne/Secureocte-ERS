/**
 * socket.js  —  Central WebSocket client for Patrol App.
 */

import { io } from "socket.io-client";
import { BASE_URL, getDeviceId, _uuidV4 } from "./api";

const NORMAL_INTERVAL_MS = 15_000;
const ALERT_INTERVAL_MS = 5_000;

let socket = null;
let currentMode = "normal";
let currentInterval = NORMAL_INTERVAL_MS;

const listeners = {
  locationUpdate: new Set(),
  modeChange: new Set(),
  networkAlert: new Set(),
  notification: new Set(),
  patrolDispatch: new Map(),
  incidentReports: new Map(),
  socketError: new Set(),
};

function envelope() {
  return { xTimestamp: String(Date.now()), xNonce: _uuidV4() };
}

export async function connectSocket({ token, userId, role = "user" }) {
  if (!token || !userId) {
    console.log("[Socket] connectSocket called without token/userId — skipping");
    return null;
  }

  if (socket) {
    disconnectSocket();
  }

  const deviceId = await getDeviceId();

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

export function getLocationInterval() {
  return currentInterval;
}

export function getCurrentMode() {
  return currentMode;
}

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

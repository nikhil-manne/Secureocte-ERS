/**
 * api.js  —  Central HTTP helper for SecureOcte frontend.
 *
 * Every request automatically attaches:
 *   Authorization : Bearer <token>
 *   Content-Type  : application/json
 *   X-Device-Id   : stable per-install device ID     ← device binding
 *   X-Timestamp   : Date.now() in ms                 ← replay protection
 *   X-Nonce       : cryptographically random UUID    ← replay protection
 *
 * Errors:
 *   401 → throws AuthError  (screens redirect to Login)
 *   other non-2xx → throws Error with server message
 */

import * as SecureStore from "expo-secure-store";
import * as Application from "expo-application";

export const BASE_URL = "https://server-r9k4.onrender.com";

// ── Error types ───────────────────────────────────────────────
export class AuthError extends Error {
  constructor(msg = "Session expired. Please log in again.") {
    super(msg); this.name = "AuthError";
  }
}

// ── Device ID ─────────────────────────────────────────────────
// Stable per-install. Cached in module scope after first read.
let _deviceId = null;

export async function getDeviceId() {
  if (_deviceId) return _deviceId;

  // 1. Previously persisted ID (survives app updates)
  try {
    const stored = await SecureStore.getItemAsync("so_device_id");
    if (stored) { _deviceId = stored; return stored; }
  } catch (_) {}

  // 2. Native installation ID
  try {
    const native =
      (typeof Application.getAndroidId === "function" ? Application.getAndroidId() : null) ||
      (typeof Application.getIosIdForVendorAsync === "function" ? await Application.getIosIdForVendorAsync() : null);
    if (native) {
      _deviceId = native;
      await SecureStore.setItemAsync("so_device_id", native).catch(() => {});
      return native;
    }
  } catch (_) {}

  // 3. Generate a random UUID, persist it
  try {
    const id = _uuidV4();
    _deviceId = id;
    await SecureStore.setItemAsync("so_device_id", id).catch(() => {});
    return id;
  } catch (_) {}

  // 4. Session-only fallback (should never reach here in practice)
  _deviceId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return _deviceId;
}

// ── Nonce (UUID v4) ───────────────────────────────────────────
// Exported so socket.js can reuse the exact same nonce generator
// for socket handshake / per-packet replay protection instead of
// duplicating this logic.
export function _uuidV4() {
  // RFC 4122 version 4 UUID using Math.random
  // Sufficient for replay nonce — not for cryptographic keys
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── Security headers (fresh per request) ─────────────────────
async function securityHeaders(token) {
  const deviceId = await getDeviceId();
  const headers = {
    "Content-Type" : "application/json",
    "X-Device-Id"  : deviceId,
    "X-Timestamp"  : String(Date.now()),
    "X-Nonce"      : _uuidV4(),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/**
 * apiFetch
 * @param {string} path       e.g. "/api/walk/start"
 * @param {object} options    fetch options — method, body, extra headers
 * @param {string|null} token JWT from AuthContext
 */
export async function apiFetch(path, options = {}, token = null) {
  const { body, headers: extraHeaders = {}, ...rest } = options;

  const headers = {
    ...(await securityHeaders(token)),
    ...extraHeaders,       // caller overrides go last
  };

  const response = await fetch(`${BASE_URL}${path}`, {
    ...rest,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (response.status === 401) {
    const json = await response.json().catch(() => ({}));
    throw new AuthError(json.error || "Unauthorized");
  }
  if (!response.ok) {
    const json = await response.json().catch(() => ({}));
    throw new Error(json.error || `Request failed (${response.status})`);
  }
  return response.json();
}

/**
 * apiMultipart  —  file uploads (audio, images).
 * Does NOT set Content-Type so fetch sets the correct multipart boundary.
 * Still attaches replay + device headers.
 *
 * Audio uploads go through ffmpeg + Google Speech + Gemini on the server
 * which takes 8–15 s. We use a 30 s timeout and 1 automatic retry.
 */
export async function apiMultipart(path, formData, token = null, timeoutMs = 30000) {
  const deviceId = await getDeviceId();
  const headers = {
    "X-Device-Id" : deviceId,
    "X-Timestamp" : String(Date.now()),
    "X-Nonce"     : _uuidV4(),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  // AbortController gives us a real fetch timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers,
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (response.status === 401) {
        const json = await response.json().catch(() => ({}));
        throw new AuthError(json.error || "Unauthorized");
      }
      if (!response.ok) {
        const json = await response.json().catch(() => ({}));
        throw new Error(json.error || `Upload failed (${response.status})`);
      }
      return response.json();

    } catch (err) {
      lastErr = err;

      // Auth errors — don't retry, throw immediately
      if (err instanceof AuthError) { clearTimeout(timer); throw err; }

      // Abort = our own timeout — don't retry
      if (err.name === "AbortError") {
        clearTimeout(timer);
        throw new Error("Request timeout — server took too long. Check your connection.");
      }

      // On first attempt of a 503, wait 1.5 s then retry once
      if (attempt === 1) {
        console.warn(`[apiMultipart] Attempt ${attempt} failed (${err.message}) — retrying in 1.5s…`);
        await new Promise((r) => setTimeout(r, 1500));
        // Fresh nonce + timestamp for the retry
        headers["X-Timestamp"] = String(Date.now());
        headers["X-Nonce"]     = _uuidV4();
        continue;
      }
    }
  }

  clearTimeout(timer);
  throw lastErr;
}

/**
 * rawFetchWithSecurity  —  for use in TaskManager background tasks and
 * other module-scope contexts where hooks are unavailable.
 *
 * Reads token and deviceId directly from SecureStore, then attaches
 * all security headers before calling fetch.
 *
 * @param {string} url   Full URL (not just path)
 * @param {object} opts  fetch options — method, body (plain object or string)
 */
export async function rawFetchWithSecurity(url, opts = {}) {
  const [token, deviceId] = await Promise.all([
    SecureStore.getItemAsync("userToken").catch(() => null),
    (async () => {
      // Try the cached device ID first; fall back to a fresh read
      if (_deviceId) return _deviceId;
      try {
        const s = await SecureStore.getItemAsync("so_device_id");
        if (s) { _deviceId = s; return s; }
      } catch (_) {}
      const id = _uuidV4();
      _deviceId = id;
      return id;
    })(),
  ]);

  const { body, headers: extraHeaders = {}, ...rest } = opts;
  const headers = {
    "Content-Type" : "application/json",
    "X-Device-Id"  : deviceId,
    "X-Timestamp"  : String(Date.now()),
    "X-Nonce"      : _uuidV4(),
    ...extraHeaders,
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  return fetch(url, {
    ...rest,
    headers,
    body: body && typeof body === "object" ? JSON.stringify(body) : body,
  });
}
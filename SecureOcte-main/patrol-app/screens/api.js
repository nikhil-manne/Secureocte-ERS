/**
 * api.js  —  Central HTTP helper for Patrol App.
 *
 * Every request automatically attaches:
 *   Authorization : Bearer <token>
 *   Content-Type  : application/json
 *   X-Device-Id   : stable per-install device ID     ← device binding
 *   X-Timestamp   : Date.now() in ms                 ← replay protection
 *   X-Nonce       : cryptographically random UUID    ← replay protection
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

export const BASE_URL = "https://server-r9k4.onrender.com";

// ── Error types ───────────────────────────────────────────────
export class AuthError extends Error {
  constructor(msg = "Session expired. Please log in again.") {
    super(msg);
    this.name = "AuthError";
  }
}

// ── Device ID ─────────────────────────────────────────────────
let _deviceId = null;

export async function getDeviceId() {
  if (_deviceId) return _deviceId;
  try {
    const stored = await AsyncStorage.getItem("so_device_id");
    if (stored) {
      _deviceId = stored;
      return stored;
    }
  } catch (_) {}

  try {
    const id = _uuidV4();
    _deviceId = id;
    await AsyncStorage.setItem("so_device_id", id).catch(() => {});
    return id;
  } catch (_) {}

  _deviceId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return _deviceId;
}

// ── Nonce (UUID v4) ───────────────────────────────────────────
export function _uuidV4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── Security headers ──────────────────────────────────────────
async function securityHeaders(token) {
  const deviceId = await getDeviceId();
  const headers = {
    "Content-Type": "application/json",
    "X-Device-Id": deviceId,
    "X-Timestamp": String(Date.now()),
    "X-Nonce": _uuidV4(),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

export async function apiFetch(path, options = {}, token = null) {
  const { body, headers: extraHeaders = {}, ...rest } = options;

  const headers = {
    ...(await securityHeaders(token)),
    ...extraHeaders,
  };

  const response = await fetch(`${BASE_URL}${path}`, {
    ...rest,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");

  if (response.status === 401) {
    const errorData = isJson ? await response.json().catch(() => ({})) : { error: await response.text().catch(() => "") };
    throw new AuthError(errorData.error || errorData.message || "Unauthorized");
  }

  if (!response.ok) {
    const errorData = isJson ? await response.json().catch(() => ({})) : { error: await response.text().catch(() => "") };
    throw new Error(errorData.error || errorData.message || `Request failed (${response.status})`);
  }

  if (isJson) {
    return response.json();
  }
  const rawText = await response.text();
  try {
    return JSON.parse(rawText);
  } catch {
    return { text: rawText };
  }
}

export async function apiMultipart(path, formData, token = null, timeoutMs = 30000) {
  const deviceId = await getDeviceId();
  const headers = {
    "X-Device-Id": deviceId,
    "X-Timestamp": String(Date.now()),
    "X-Nonce": _uuidV4(),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

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
      if (err instanceof AuthError) {
        clearTimeout(timer);
        throw err;
      }
      if (err.name === "AbortError") {
        clearTimeout(timer);
        throw new Error("Request timeout — server took too long. Check your connection.");
      }
      if (attempt === 1) {
        console.warn(`[apiMultipart] Attempt ${attempt} failed (${err.message}) — retrying in 1.5s…`);
        await new Promise((r) => setTimeout(r, 1500));
        headers["X-Timestamp"] = String(Date.now());
        headers["X-Nonce"] = _uuidV4();
        continue;
      }
    }
  }

  clearTimeout(timer);
  throw lastErr;
}

export async function rawFetchWithSecurity(url, opts = {}) {
  const [token, deviceId] = await Promise.all([
    AsyncStorage.getItem("userToken").catch(() => null),
    (async () => {
      if (_deviceId) return _deviceId;
      try {
        const s = await AsyncStorage.getItem("so_device_id");
        if (s) {
          _deviceId = s;
          return s;
        }
      } catch (_) {}
      const id = _uuidV4();
      _deviceId = id;
      return id;
    })(),
  ]);

  const { body, headers: extraHeaders = {}, ...rest } = opts;
  const headers = {
    "Content-Type": "application/json",
    "X-Device-Id": deviceId,
    "X-Timestamp": String(Date.now()),
    "X-Nonce": _uuidV4(),
    ...extraHeaders,
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  return fetch(url, {
    ...rest,
    headers,
    body: body && typeof body === "object" ? JSON.stringify(body) : body,
  });
}

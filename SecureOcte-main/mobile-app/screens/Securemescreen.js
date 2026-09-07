/**
 * SecureMeService.js
 * ─────────────────────────────────────────────────────────────
 * useSecureMe() — background-only hook, no UI.
 *
 * IMU (PRIMARY trigger)
 *   Accelerometer + Gyroscope sampled every 500ms.
 *   If gyro > 2.7 rad/s → rotation suppressed, resetIMU().
 *   If acc delta < 0.15g → imuStillTime += 500ms, noiseCount=0.
 *   If delta >= 0.15g → noiseCount++; resetIMU() only after noiseCount > 2.
 *   imuStillTime >= 30s (WALK) or 40s (CAB) → IMU breach.
 *   IMU poll skips entirely when verifyPending OR alertSent.
 *
 * GPS (VALIDATION — WALK mode only)
 *   Every 5s: haversine displacement from last coord (Balanced accuracy).
 *   displacement < 12m → gpsStillTime += 5s.
 *   Any movement >= 12m → resetGPS() (gpsStillTime = 0).
 *   gpsStillTime >= 30s → GPS breach.
 *   GPS poll skips entirely when verifyPending OR alertSent.
 *
 * Screen (VALIDATION)
 *   WALK: 30s no recordTouch() → Screen breach.
 *   CAB:  40s no recordTouch() → Screen breach.
 *   Screen timer won't fire if verifyPending OR alertSent.
 *   Any touch calls cancelVerification() + resets screenIdle + restarts timer.
 *
 * Decision logic:
 *   WALK mode → IMU AND (GPS OR Screen) → startGraceWindow()
 *   CAB  mode → IMU AND Screen          → startGraceWindow()
 *
 * IMU still window: WALK=30s, CAB=40s
 * Noise tolerance: up to 2 consecutive movement samples ignored before resetIMU()
 * IMU/GPS poll skips entirely if verifyPending OR alertSent
 *
 * Verification flow:
 *   evaluate() → startGraceWindow() (5s)
 *   → if imuStill still true → triggerBiometric() (verifyPending=true)
 *   → 30s timeout or fail → sendAlert() → resetAll()
 *   → success → resetAll()
 *
 * cancelVerification():
 *   Called on any touch — cancels bio timer, clears verifyPending.
 * ─────────────────────────────────────────────────────────────
 */

import { useEffect, useRef, useState, useCallback } from "react";
import * as Location from "expo-location";
import { Accelerometer, Gyroscope } from "expo-sensors";
import * as LocalAuthentication from "expo-local-authentication";
import * as Notifications from "expo-notifications";
import { Vibration } from "react-native";
import { useBatteryMonitor } from "./Batterymonitor";
import { apiFetch, apiMultipart, AuthError, BASE_URL } from "./api";
import React, { useContext } from "react";
import { AuthContext } from "./AuthContext";

/* ── IMU stationary detection ─────────────────────────────── */
const IMU_SAMPLE_INTERVAL_MS   = 500;   // pseudocode: IMU_SAMPLE_INTERVAL = 500ms
const IMU_STILL_WINDOW_WALK_MS = 30000; // pseudocode: IMU_STILL_WINDOW_WALK = 30s
const IMU_STILL_WINDOW_CAB_MS  = 40000; // pseudocode: IMU_STILL_WINDOW_CAB  = 40s
const IMU_MOVE_THRESHOLD       = 0.15;  // pseudocode: IMU_DELTA_THRESHOLD = 0.15g
const MAX_ROTATION_THRESHOLD   = 2.7;   // pseudocode: IMU_ROT_SUPPRESS = 2.7 rad/s
const IMU_NOISE_TOLERANCE      = 2;     // pseudocode: IMU_NOISE_TOLERANCE = 2 samples

/* ── GPS stationary detection ─────────────────────────────── */
const GPS_POLL_INTERVAL_MS   = 5000;  // pseudocode: GPS_INTERVAL = 5s
const GPS_STATIC_LIMIT_MS    = 30000; // pseudocode: GPS_STATIC_LIMIT = 30s
const GPS_RADIUS_M           = 12;    // pseudocode: GPS_RADIUS = 12m
const GPS_COORD_PRECISION    = 4;     // kept for log helper

/* ── Screen interaction ───────────────────────────────────── */
const SCREEN_IDLE_WALK_MS    = 30000; // pseudocode: SCREEN_IDLE_WALK = 30s
const SCREEN_IDLE_CAB_MS     = 40000; // pseudocode: SCREEN_IDLE_CAB  = 40s

/* ── Verification flow ────────────────────────────────────── */
const GRACE_DELAY_MS         = 5000;  // pseudocode: GRACE_DELAY = 5s
const BIO_TIMEOUT_MS         = 30000; // pseudocode: BIO_TIMEOUT = 30s

/* ── Zone polling ─────────────────────────────────────────── */
const ZONE_POLL_MS           = 30000;

/* ── Backend ──────────────────────────────────────────────── */
const BACKEND                = `${BASE_URL}/api/secureme`;

/* ── Point-in-polygon (ray casting) ──────────────────────── */
function pointInPolygon(lat, lng, polygon) {
  if (!polygon || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lat, yi = polygon[i].lng;
    const xj = polygon[j].lat, yj = polygon[j].lng;
    if ((yi > lng) !== (yj > lng) && lat < ((xj - xi) * (lng - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/* ── Check if point is inside ANY of the saved zones ─────── */
function pointInAnyZone(lat, lng, zones) {
  if (!zones || zones.length === 0) return false;
  return zones.some(polygon => pointInPolygon(lat, lng, polygon));
}

/* ── Coord snapshot key (for logs only) ──────────────────── */
function coordKey(lat, lng) {
  return `${lat.toFixed(GPS_COORD_PRECISION)},${lng.toFixed(GPS_COORD_PRECISION)}`;
}

/* ── Haversine distance (metres) ──────────────────────────── */
function distanceMetres(lat1, lng1, lat2, lng2) {
  const R  = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a  = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ── Local notification ───────────────────────────────────── */
async function notify(title, body, categoryIdentifier = null) {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: true,
        ...(categoryIdentifier ? { categoryIdentifier } : {}),
      },
      trigger: null,
    });
  } catch (e) {
    console.log("[SecureMe] notify error:", e.message);
  }
}

/* ════════════════════════════════════════════════════════════
   useSecureMe hook
════════════════════════════════════════════════════════════ */
export function useSecureMe({ user, token = null, mode = "walk" }) {
  // mode: "walk"    → full sensors + GPS stationary check ON
  // mode: "cab"     → full sensors, GPS stationary check OFF
  // mode: "passive" → zone check only (banner + toggle shown), NO notifications/sensors/alerts

  /* ── Public state ─────────────────────────────────────── */
  const [inZone,     setInZone]     = useState(false);
  const [secureMeOn, setSecureMeOn] = useState(false);

  /* ── Core refs ────────────────────────────────────────── */
  const zoneRef        = useRef(null);
  const coordsRef      = useRef(null);
  const inZoneRef      = useRef(false);
  const secureMeOnRef  = useRef(false);

  /* ── Breach refs ──────────────────────────────────────── */
  const gpsBreachRef    = useRef(false);
  const imuBreachRef    = useRef(false);
  const screenBreachRef = useRef(false);
  const alertSentRef    = useRef(false);

  /* ── IMU stationary detection refs ───────────────────────── */
  const gyroMagRef      = useRef(0);    // live gyro magnitude
  const lastIMUMagRef   = useRef(null); // lastAcc from pseudocode
  const imuStillTimeRef = useRef(0);    // imuStillTime ms accumulator
  const noiseCountRef   = useRef(0);    // consecutive movement samples (noise tolerance)
  const imuPollTimerRef = useRef(null); // setInterval handle

  /* ── GPS stationary detection refs ───────────────────── */
  const lastCoordKeyRef      = useRef(null); // for logs only
  const lastGPSCoordRef      = useRef(null); // {latitude, longitude} for haversine
  const gpsStillTimeRef      = useRef(0);    // gpsStillTime ms accumulator
  const gpsPollTimerRef      = useRef(null);

  /* ── Screen idle ──────────────────────────────────────── */
  const screenIdleTimer = useRef(null);

  /* ── Verification flow ────────────────────────────────── */
  const verifyPendingRef = useRef(false); // true while grace or biometric is active
  const graceTimerRef    = useRef(null);  // setTimeout handle for 5s grace window
  const bioTimerRef      = useRef(null);  // setTimeout handle for 30s bio timeout

  /* ── Sensor subs ──────────────────────────────────────── */
  const accelSubRef    = useRef(null);
  const gyroSubRef     = useRef(null);
  const locationSubRef = useRef(null);
  const pollTimerRef   = useRef(null);

  /* ── Function refs (prevent stale closures) ───────────── */
  const evaluateRef  = useRef(null);
  const sendAlertRef = useRef(null);
  const startIMURef  = useRef(null);
  const stopIMURef   = useRef(null);

  /* ── Battery heartbeat (dead-man switch) ──────────────────── */
  useBatteryMonitor({ user, enabled: secureMeOn, mode: "secureme" });

  /* ── State sync ───────────────────────────────────────── */
  const setZoneState = useCallback((v) => { inZoneRef.current = v;     setInZone(v);     }, []);
  const setSecState  = useCallback((v) => { secureMeOnRef.current = v; setSecureMeOn(v); }, []);

  /* ── Notification handler is set globally in App.js ───── */

  /* ══════════════════════════════════════════════════════
     sendAlert — pseudocode: FUNCTION sendAlert()
       alertSent = true
       vibratePattern()
       sendToBackend(reason, location)
     After alert fires, resetAll() so monitoring resumes fresh.
  ══════════════════════════════════════════════════════ */
  const sendAlert = useCallback(async (reason) => {
    if (alertSentRef.current) {
      console.log("[SecureMe] 🚨 sendAlert() called but alertSent=true — skipping duplicate");
      return;
    }
    alertSentRef.current = true;
    console.log("[SecureMe] 🚨 ─── ALERT FIRING ───");
    console.log(`[SecureMe] 🚨   reason  = "${reason}"`);
    console.log(`[SecureMe] 🚨   lat     = ${coordsRef.current?.latitude ?? "unknown"}`);
    console.log(`[SecureMe] 🚨   lng     = ${coordsRef.current?.longitude ?? "unknown"}`);
    console.log(`[SecureMe] 🚨   IMU     = ${imuBreachRef.current} | GPS = ${gpsBreachRef.current} | Screen = ${screenBreachRef.current}`);
    console.log(`[SecureMe] 🚨   mode    = ${mode}`);
    console.log("[SecureMe] 🚨   vibrating + sending notification...");
    Vibration.vibrate([400, 200, 400, 200, 800]);
    notify("🚨 SecureMe Alert", reason);

    try {
      await apiFetch("/api/secureme/alert", {
        method: "POST",
        body: {
          userId: user?.username,
          reason,
          lat: coordsRef.current?.latitude,
          lng: coordsRef.current?.longitude,
        },
      }, token);
      console.log("[SecureMe] 🚨   API → ✅ ok");
    } catch (e) {
      console.log("[SecureMe] 🚨   API → ❌ error:", e.message);
    }

    // pseudocode: resetAll() after alert
    console.log("[SecureMe] 🔄 ─── resetAll() after alert ───");
    gpsBreachRef.current    = false;
    imuBreachRef.current    = false;
    screenBreachRef.current = false;
    alertSentRef.current    = false;
    verifyPendingRef.current = false;
    imuStillTimeRef.current  = 0;
    noiseCountRef.current    = 0;
    lastIMUMagRef.current    = null;
    gpsStillTimeRef.current  = 0;
    lastGPSCoordRef.current  = null;
    lastCoordKeyRef.current  = null;
    console.log("[SecureMe] 🔄   all breach flags + counters cleared — monitoring resumes");
  }, [user, token]);

  useEffect(() => { sendAlertRef.current = sendAlert; }, [sendAlert]);

  /* ══════════════════════════════════════════════════════
     cancelVerification — pseudocode: FUNCTION cancelVerification()
       IF verifyPending:
         stopBiometricPrompt() / cancelBioTimer()
         verifyPending = false
     Called on any touch event to abort an in-progress verification.
  ══════════════════════════════════════════════════════ */
  const cancelVerification = useCallback(() => {
    const wasGrace = !!graceTimerRef.current;
    const wasBio   = !!bioTimerRef.current;
    if (!wasGrace && !wasBio && !verifyPendingRef.current) return;

    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
      console.log("[SecureMe] 🚫 Grace window cancelled by touch");
    }
    if (bioTimerRef.current) {
      clearTimeout(bioTimerRef.current);
      bioTimerRef.current = null;
      console.log("[SecureMe] 🚫 Bio timer cancelled by touch");
    }
    if (verifyPendingRef.current) {
      verifyPendingRef.current = false;
      console.log("[SecureMe] 🚫 verifyPending cleared by cancelVerification()");
    }
  }, []);

  /* ══════════════════════════════════════════════════════
     triggerBiometric — pseudocode: FUNCTION triggerBiometric()
       verifyPending = true
       showBiometricPrompt()
       START bioTimer BIO_TIMEOUT (30s)
     ON_BIOMETRIC_SUCCESS → resetAll()
     ON_BIOMETRIC_FAIL OR bioTimer EXPIRED → sendAlert()
  ══════════════════════════════════════════════════════ */
  const triggerBiometric = useCallback(() => {
    if (bioTimerRef.current) {
      console.log("[SecureMe] 🔐 triggerBiometric() skipped — bio already running");
      return;
    }
    verifyPendingRef.current = true;
    console.log(`[SecureMe] 🔐 ─── triggerBiometric() ───`);
    console.log(`[SecureMe] 🔐   verifyPending=true | bioTimeout=${BIO_TIMEOUT_MS / 1000}s`);
    console.log(`[SecureMe] 🔐   state: IMU=${imuBreachRef.current} GPS=${gpsBreachRef.current} Screen=${screenBreachRef.current}`);

    let resolved = false;

    // START bioTimer BIO_TIMEOUT
    bioTimerRef.current = setTimeout(() => {
      if (!resolved) {
        console.log(`[SecureMe] ⏱ Bio timer expired after ${BIO_TIMEOUT_MS / 1000}s → sendAlert()`);
        bioTimerRef.current = null;
        sendAlertRef.current?.("SecureMe inactivity confirmed — biometric timed out");
      }
    }, BIO_TIMEOUT_MS);

    // showBiometricPrompt()
    (async () => {
      try {
        console.log("[SecureMe] 🔐 Showing biometric prompt...");
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: "SecureMe — Verify it's you",
          fallbackLabel: "Use Passcode",
          disableDeviceFallback: false,
        });
        resolved = true;
        clearTimeout(bioTimerRef.current);
        bioTimerRef.current = null;

        if (result.success) {
          // ON_BIOMETRIC_SUCCESS → resetAll()
          console.log("[SecureMe] 🔐 ─── BIOMETRIC SUCCESS ───");
          console.log("[SecureMe] 🔐   User verified → resetAll() → monitoring resumes fresh");
          verifyPendingRef.current = false;
          gpsBreachRef.current     = false;
          imuBreachRef.current     = false;
          screenBreachRef.current  = false;
          alertSentRef.current     = false;
          imuStillTimeRef.current  = 0;
          noiseCountRef.current    = 0;
          lastIMUMagRef.current    = null;
          gpsStillTimeRef.current  = 0;
          lastGPSCoordRef.current  = null;
          lastCoordKeyRef.current  = null;
          console.log("[SecureMe] 🔐   resetAll() complete — all sensors resume normally");
        } else {
          // ON_BIOMETRIC_FAIL → sendAlert()
          console.log(`[SecureMe] 🔐 ─── BIOMETRIC FAILED ───`);
          console.log(`[SecureMe] 🔐   error="${result.error}" warning="${result.warning}" → sendAlert()`);
          sendAlertRef.current?.("SecureMe inactivity confirmed — biometric failed");
        }
      } catch (e) {
        resolved = true;
        clearTimeout(bioTimerRef.current);
        bioTimerRef.current = null;
        console.log("[SecureMe] biometric exception:", e.message, "→ sendAlert()");
        sendAlertRef.current?.("Biometric error: " + e.message);
      }
    })();
  }, []);

  /* ══════════════════════════════════════════════════════
     startGraceWindow — pseudocode: FUNCTION startGraceWindow()
       WAIT GRACE_DELAY (5s)
       IF verifyPending OR alertSent → RETURN
       IF NOT imuStill → RETURN  (motion resumed during grace)
       triggerBiometric()
  ══════════════════════════════════════════════════════ */
  const startGraceWindow = useCallback(() => {
    if (graceTimerRef.current) {
      console.log("[SecureMe] ⏳ grace window already running — skipping duplicate");
      return;
    }
    console.log(`[SecureMe] ⏳ ─── startGraceWindow() ───`);
    console.log(`[SecureMe] ⏳   waiting ${GRACE_DELAY_MS / 1000}s before showing biometric`);
    console.log(`[SecureMe] ⏳   state: IMU=${imuBreachRef.current} GPS=${gpsBreachRef.current} Screen=${screenBreachRef.current}`);
    verifyPendingRef.current = true; // block further evaluate() calls during grace

    graceTimerRef.current = setTimeout(() => {
      graceTimerRef.current = null;
      console.log(`[SecureMe] ⏳ ─── grace window expired ───`);
      console.log(`[SecureMe] ⏳   verifyPending=${verifyPendingRef.current} alertSent=${alertSentRef.current} imuStill=${imuBreachRef.current}`);

      if (!verifyPendingRef.current) {
        console.log("[SecureMe] ⏳   → ABORTED: verifyPending was cleared (touch cancelled it)");
        return;
      }
      if (alertSentRef.current) {
        console.log("[SecureMe] ⏳   → ABORTED: alertSent=true");
        verifyPendingRef.current = false;
        return;
      }
      if (!imuBreachRef.current) {
        console.log("[SecureMe] ⏳   → ABORTED: imuStill=false — motion resumed during grace window");
        verifyPendingRef.current = false;
        return;
      }

      console.log("[SecureMe] ⏳   → PASSED: imuStill=true — launching biometric prompt now");
      triggerBiometric();
    }, GRACE_DELAY_MS);
  }, [triggerBiometric]);

  /* ══════════════════════════════════════════════════════
     evaluate — pseudocode: FUNCTION evaluate()
       IF verifyPending OR alertSent → RETURN
       WALK: imuStill AND (gpsStatic OR screenIdle) → startGraceWindow()
       CAB:  imuStill AND screenIdle               → startGraceWindow()
  ══════════════════════════════════════════════════════ */
  const evaluate = useCallback((gps, imu, scr) => {
    if (verifyPendingRef.current) {
      console.log(`[SecureMe] 📊 evaluate() SKIPPED — verifyPending=true | incoming IMU=${imu} GPS=${gps} Screen=${scr}`);
      return;
    }
    if (alertSentRef.current) {
      console.log(`[SecureMe] 📊 evaluate() SKIPPED — alertSent=true | incoming IMU=${imu} GPS=${gps} Screen=${scr}`);
      return;
    }

    console.log(`[SecureMe] 📊 ─── evaluate() ───`);
    console.log(`[SecureMe] 📊   mode        = ${mode}`);
    console.log(`[SecureMe] 📊   IMU breach  = ${imu}  (imuStillTime=${imuStillTimeRef.current / 1000}s)`);
    console.log(`[SecureMe] 📊   GPS breach  = ${gps}  (gpsStillTime=${gpsStillTimeRef.current / 1000}s)`);
    console.log(`[SecureMe] 📊   Screen idle = ${scr}`);
    console.log(`[SecureMe] 📊   verifyPend  = ${verifyPendingRef.current}`);
    console.log(`[SecureMe] 📊   alertSent   = ${alertSentRef.current}`);

    if (mode === "walk") {
      if (imu && (gps || scr)) {
        console.log(`[SecureMe] 🟠 WALK condition MET — IMU=${imu} GPS=${gps} Screen=${scr} → startGraceWindow()`);
        startGraceWindow();
      } else {
        console.log(`[SecureMe] 🟡 WALK condition not met — need IMU + (GPS or Screen). IMU=${imu} GPS=${gps} Screen=${scr}`);
      }
    } else if (mode === "cab") {
      if (imu && scr) {
        console.log(`[SecureMe] 🟠 CAB condition MET — IMU=${imu} Screen=${scr} → startGraceWindow()`);
        startGraceWindow();
      } else {
        console.log(`[SecureMe] 🟡 CAB condition not met — need IMU + Screen. IMU=${imu} Screen=${scr}`);
      }
    }
  }, [startGraceWindow, mode]);

  useEffect(() => { evaluateRef.current = evaluate; }, [evaluate]);

  /* ══════════════════════════════════════════════════════
     stopIMU
  ══════════════════════════════════════════════════════ */
  const stopIMU = useCallback(() => {
    try { accelSubRef.current?.remove(); } catch (_) {}
    try { gyroSubRef.current?.remove();  } catch (_) {}
    accelSubRef.current   = null;
    gyroSubRef.current    = null;
    gyroMagRef.current    = 0;
    lastIMUMagRef.current = null;
    imuStillTimeRef.current = 0;
    noiseCountRef.current   = 0;
    if (imuPollTimerRef.current) {
      clearInterval(imuPollTimerRef.current);
      imuPollTimerRef.current = null;
    }
    console.log("[SecureMe] 🔴 IMU stopped — all counters cleared");
  }, []);

  useEffect(() => { stopIMURef.current = stopIMU; }, [stopIMU]);

  /* ══════════════════════════════════════════════════════
     startIMU — implements pseudocode ON_IMU_SAMPLE

     ON_IMU_SAMPLE(accMag, gyroMag):
       IF verifyPending OR alertSent → RETURN
       IF gyroMag > IMU_ROT_SUPPRESS → resetIMU(); RETURN
       IF lastAcc == null → lastAcc = accMag; RETURN
       delta = abs(accMag - lastAcc)
       IF delta < IMU_DELTA_THRESHOLD:
           imuStillTime += 500ms; noiseCount = 0
       ELSE:
           noiseCount += 1
           IF noiseCount > IMU_NOISE_TOLERANCE → resetIMU()
       REQUIRED_WINDOW = CAB ? 40s : 30s
       IF imuStillTime >= REQUIRED_WINDOW → imuStill=true; evaluate()
       lastAcc = accMag
  ══════════════════════════════════════════════════════ */
  const startIMU = useCallback(() => {
    if (imuPollTimerRef.current) {
      console.log("[SecureMe] IMU already running");
      return;
    }
    const stillWindowMs = mode === "cab" ? IMU_STILL_WINDOW_CAB_MS : IMU_STILL_WINDOW_WALK_MS;
    console.log(`[SecureMe] 🟢 IMU starting — interval=${IMU_SAMPLE_INTERVAL_MS}ms, stillWindow=${stillWindowMs / 1000}s (mode=${mode}), threshold=${IMU_MOVE_THRESHOLD}g, rotSuppress=${MAX_ROTATION_THRESHOLD}rad/s, noiseTol=${IMU_NOISE_TOLERANCE}`);

    /* Gyroscope — track live rotation magnitude */
    try {
      Gyroscope.setUpdateInterval(IMU_SAMPLE_INTERVAL_MS);
      gyroSubRef.current = Gyroscope.addListener(({ x, y, z }) => {
        gyroMagRef.current = Math.sqrt(x * x + y * y + z * z);
      });
      console.log("[SecureMe] ✅ Gyroscope attached at", IMU_SAMPLE_INTERVAL_MS, "ms");
    } catch (e) {
      console.log("[SecureMe] Gyroscope error:", e.message);
    }

    /* Accelerometer — continuously update latest magnitude */
    let latestMag = 0;
    try {
      Accelerometer.setUpdateInterval(IMU_SAMPLE_INTERVAL_MS);
      accelSubRef.current = Accelerometer.addListener(({ x, y, z }) => {
        latestMag = Math.sqrt(x * x + y * y + z * z);
      });
      console.log("[SecureMe] ✅ Accelerometer attached at", IMU_SAMPLE_INTERVAL_MS, "ms");
    } catch (e) {
      console.log("[SecureMe] Accelerometer error:", e.message);
    }

    /* Poll every 500ms — implements ON_IMU_SAMPLE */
    let _imuTickCount = 0; // heartbeat counter
    imuPollTimerRef.current = setInterval(() => {
      _imuTickCount++;

      if (!secureMeOnRef.current) {
        if (_imuTickCount % 20 === 0) console.log("[SecureMe] IMU tick skipped — secureMeOn=false");
        return;
      }
      if (imuBreachRef.current) {
        if (_imuTickCount % 20 === 0) console.log("[SecureMe] IMU tick skipped — imuBreach=true (awaiting resetAll)");
        return;
      }

      // IF verifyPending OR alertSent → RETURN
      if (verifyPendingRef.current || alertSentRef.current) {
        if (_imuTickCount % 20 === 0) console.log(`[SecureMe] IMU tick skipped — verifyPending=${verifyPendingRef.current} alertSent=${alertSentRef.current}`);
        return;
      }

      const accMag  = latestMag;
      const gyroMag = gyroMagRef.current;

      // Periodic heartbeat every 10s (20 ticks × 500ms) to confirm IMU is alive
      if (_imuTickCount % 20 === 0) {
        console.log(`[SecureMe] IMU heartbeat — tick=${_imuTickCount} accMag=${accMag.toFixed(3)} gyro=${gyroMag.toFixed(3)} stillTime=${(imuStillTimeRef.current / 1000).toFixed(1)}s noise=${noiseCountRef.current}`);
      }

      // IF gyroMag > IMU_ROT_SUPPRESS → resetIMU(); RETURN
      if (gyroMag > MAX_ROTATION_THRESHOLD) {
        console.log(`[SecureMe] IMU: 🔄 GYRO SUPPRESS — gyro=${gyroMag.toFixed(3)} > ${MAX_ROTATION_THRESHOLD} rad/s → resetIMU() | stillTime was ${(imuStillTimeRef.current / 1000).toFixed(1)}s`);
        imuStillTimeRef.current = 0;
        noiseCountRef.current   = 0;
        lastIMUMagRef.current   = accMag;
        return;
      }

      // IF lastAcc == null → initialise and return
      if (lastIMUMagRef.current === null) {
        lastIMUMagRef.current = accMag;
        console.log(`[SecureMe] IMU: 🟢 first sample — accMag=${accMag.toFixed(3)} gyro=${gyroMag.toFixed(3)}`);
        return;
      }

      const delta = Math.abs(accMag - lastIMUMagRef.current);

      if (delta < IMU_MOVE_THRESHOLD) {
        // Still — accumulate imuStillTime, reset noiseCount
        imuStillTimeRef.current += IMU_SAMPLE_INTERVAL_MS;
        noiseCountRef.current    = 0;
        const stillSec  = (imuStillTimeRef.current / 1000).toFixed(1);
        const targetSec = (stillWindowMs / 1000).toFixed(0);
        const pct       = Math.min(100, Math.round((imuStillTimeRef.current / stillWindowMs) * 100));
        console.log(`[SecureMe] IMU: 🟢 STILL — delta=${delta.toFixed(4)}g < ${IMU_MOVE_THRESHOLD}g | stillTime=${stillSec}s / ${targetSec}s (${pct}%) | accMag=${accMag.toFixed(3)} gyro=${gyroMag.toFixed(3)}`);
      } else {
        // Movement — increment noiseCount; resetIMU() only after tolerance exceeded
        noiseCountRef.current += 1;
        console.log(`[SecureMe] IMU: 🟡 MOVEMENT — delta=${delta.toFixed(4)}g >= ${IMU_MOVE_THRESHOLD}g | noiseCount=${noiseCountRef.current}/${IMU_NOISE_TOLERANCE} | stillTime was ${(imuStillTimeRef.current / 1000).toFixed(1)}s | accMag=${accMag.toFixed(3)}`);

        if (noiseCountRef.current > IMU_NOISE_TOLERANCE) {
          console.log(`[SecureMe] IMU: 🔴 RESET — noiseCount ${noiseCountRef.current} > tolerance ${IMU_NOISE_TOLERANCE} → resetIMU() | stillTime ${(imuStillTimeRef.current / 1000).toFixed(1)}s wiped`);
          imuStillTimeRef.current = 0;
          noiseCountRef.current   = 0;
        }
      }

      // REQUIRED_WINDOW check — IF imuStillTime >= REQUIRED_WINDOW → imuStill=true; evaluate()
      if (imuStillTimeRef.current >= stillWindowMs) {
        console.log(`[SecureMe] IMU: 🛑 BREACH — stationary for ${stillWindowMs / 1000}s confirmed (mode=${mode}) | GPS=${gpsBreachRef.current} Screen=${screenBreachRef.current}`);
        imuBreachRef.current    = true;
        imuStillTimeRef.current = 0;
        noiseCountRef.current   = 0;
        lastIMUMagRef.current   = null;
        evaluateRef.current?.(gpsBreachRef.current, true, screenBreachRef.current);
      }

      // lastAcc = accMag
      lastIMUMagRef.current = accMag;
    }, IMU_SAMPLE_INTERVAL_MS);

    console.log("[SecureMe] ✅ IMU poll timer started (", IMU_SAMPLE_INTERVAL_MS, "ms)");
  }, [mode]);

  useEffect(() => { startIMURef.current = startIMU; }, [startIMU]);

  /* ══════════════════════════════════════════════════════
     startGPSPoll — implements pseudocode EVERY GPS_INTERVAL

     EVERY GPS_INTERVAL (5s):
       IF MODE == CAB OR verifyPending OR alertSent → RETURN
       displacement = distance(lastCoord, currentCoord)
       IF displacement < GPS_RADIUS → gpsStillTime += 5s
       ELSE → resetGPS()
       IF gpsStillTime >= GPS_STATIC_LIMIT → gpsStatic=true; evaluate()
       lastCoord = currentCoord
  ══════════════════════════════════════════════════════ */
  const startGPSPoll = useCallback(() => {
    if (gpsPollTimerRef.current) return;
    console.log(`[SecureMe] 📍 GPS poll starting — every ${GPS_POLL_INTERVAL_MS / 1000}s, radius=${GPS_RADIUS_M}m, staticLimit=${GPS_STATIC_LIMIT_MS / 1000}s`);
    lastCoordKeyRef.current  = null;
    lastGPSCoordRef.current  = null;
    gpsStillTimeRef.current  = 0;

    let _gpsTickCount = 0;
    gpsPollTimerRef.current = setInterval(async () => {
      _gpsTickCount++;

      if (!secureMeOnRef.current) {
        console.log("[SecureMe] GPS tick skipped — secureMeOn=false");
        return;
      }
      if (gpsBreachRef.current) {
        console.log("[SecureMe] GPS tick skipped — gpsBreach=true (awaiting resetAll)");
        return;
      }

      // IF verifyPending OR alertSent → RETURN
      if (verifyPendingRef.current || alertSentRef.current) {
        console.log(`[SecureMe] GPS tick skipped — verifyPending=${verifyPendingRef.current} alertSent=${alertSentRef.current}`);
        return;
      }

      console.log(`[SecureMe] GPS: 📡 tick #${_gpsTickCount} — fetching location (Balanced)...`);
      try {
        const loc = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        const { latitude, longitude, accuracy: locAccuracy } = loc.coords;
        const key = coordKey(latitude, longitude);

        if (lastGPSCoordRef.current === null) {
          lastGPSCoordRef.current = { latitude, longitude };
          lastCoordKeyRef.current = key;
          gpsStillTimeRef.current = 0;
          console.log(`[SecureMe] GPS: 🟢 first fix — pos=${key} accuracy=±${locAccuracy?.toFixed(0) ?? "?"}m`);
          return;
        }

        const displacement = distanceMetres(
          lastGPSCoordRef.current.latitude,
          lastGPSCoordRef.current.longitude,
          latitude,
          longitude
        );

        const pct = Math.min(100, Math.round((gpsStillTimeRef.current / GPS_STATIC_LIMIT_MS) * 100));
        console.log(`[SecureMe] GPS: tick #${_gpsTickCount} | displacement=${displacement.toFixed(1)}m (radius=${GPS_RADIUS_M}m) | stillTime=${gpsStillTimeRef.current / 1000}s/${GPS_STATIC_LIMIT_MS / 1000}s (${pct}%) | accuracy=±${locAccuracy?.toFixed(0) ?? "?"}m | pos=${key}`);

        if (displacement < GPS_RADIUS_M) {
          // Within radius — gpsStillTime += GPS_INTERVAL
          gpsStillTimeRef.current += GPS_POLL_INTERVAL_MS;
          console.log(`[SecureMe] GPS: 🟡 STATIC — stillTime now ${gpsStillTimeRef.current / 1000}s / ${GPS_STATIC_LIMIT_MS / 1000}s | IMU=${imuBreachRef.current} Screen=${screenBreachRef.current}`);

          if (gpsStillTimeRef.current >= GPS_STATIC_LIMIT_MS) {
            console.log(`[SecureMe] GPS: 🛑 BREACH — static for ${GPS_STATIC_LIMIT_MS / 1000}s within ${GPS_RADIUS_M}m | IMU=${imuBreachRef.current} Screen=${screenBreachRef.current}`);
            gpsBreachRef.current    = true;
            gpsStillTimeRef.current = 0;
            lastGPSCoordRef.current = null;
            lastCoordKeyRef.current = null;
            evaluateRef.current?.(true, imuBreachRef.current, screenBreachRef.current);
          }
        } else {
          // Moved — resetGPS()
          console.log(`[SecureMe] GPS: ✅ MOVING — displacement=${displacement.toFixed(1)}m >= ${GPS_RADIUS_M}m → resetGPS() | stillTime ${gpsStillTimeRef.current / 1000}s wiped`);
          gpsStillTimeRef.current = 0;
          lastGPSCoordRef.current = { latitude, longitude };
          lastCoordKeyRef.current = key;
        }
      } catch (e) {
        console.log(`[SecureMe] GPS: ❌ poll error on tick #${_gpsTickCount} —`, e.message);
      }
    }, GPS_POLL_INTERVAL_MS);
  }, []);

  const stopGPSPoll = useCallback(() => {
    if (gpsPollTimerRef.current) {
      clearInterval(gpsPollTimerRef.current);
      gpsPollTimerRef.current = null;
      lastCoordKeyRef.current = null;
      lastGPSCoordRef.current = null;
      gpsStillTimeRef.current = 0;
      console.log("[SecureMe] 📍 GPS poll stopped — counters cleared");
    }
  }, []);

  /* ══════════════════════════════════════════════════════
     fetchZone
  ══════════════════════════════════════════════════════ */
  const fetchZone = useCallback(async () => {
    if (!token) {
      console.log("[SecureMe] fetchZone: no token yet — skipping (will retry when token arrives)");
      return;
    }
    try {
      let data;
      try {
        data = await apiFetch("/api/secureme/get-zone", { method: "GET" }, token);
      } catch (e) {
        console.log("[SecureMe] get-zone HTTP error:", e.message);
        return;
      }
      console.log("[SecureMe] get-zone raw:", JSON.stringify(data).slice(0, 300));

      let polygons = [];

      if (Array.isArray(data)) {
        if (data.length === 0) {
          console.log("[SecureMe] ⚠️ No zones returned from backend");
          return;
        }
        if (data[0] && typeof data[0] === "object" && Array.isArray(data[0].zone)) {
          polygons = data.map(zoneObj => zoneObj.zone).filter(z => z && z.length >= 3);
          console.log(`[SecureMe] ✅ Loaded ${polygons.length} zone(s) from new format`);
        } else if (data[0] && typeof data[0].lat === "number") {
          polygons = [data];
          console.log("[SecureMe] ✅ Loaded 1 zone from legacy flat format");
        }
      } else if (Array.isArray(data?.zone) && data.zone.length >= 3) {
        polygons = [data.zone];
        console.log("[SecureMe] ✅ Loaded 1 zone from {zone:[...]} format");
      }

      if (polygons.length > 0) {
        zoneRef.current = polygons;
        console.log(`[SecureMe] ✅ ${polygons.length} zone(s) stored, first has ${polygons[0].length} pts`);
      } else {
        console.log("[SecureMe] ⚠️ Could not parse any valid zones from response");
      }
    } catch (e) {
      console.log("[SecureMe] fetchZone error:", e.message);
    }
  }, [token]);

  /* ══════════════════════════════════════════════════════
     Location watcher for zone entry/exit — ONE instance
  ══════════════════════════════════════════════════════ */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") {
          console.log("[SecureMe] ❌ Location permission denied");
          return;
        }
        console.log("[SecureMe] 📍 Zone watcher starting...");

        locationSubRef.current = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, distanceInterval: 10 },
          (loc) => {
            if (!alive) return;
            const { latitude, longitude } = loc.coords;
            coordsRef.current = { latitude, longitude };

            const zones = zoneRef.current;
            if (!zones || zones.length === 0) return;

            const inside = pointInAnyZone(latitude, longitude, zones);
            console.log(`[SecureMe] zone-check (${latitude.toFixed(5)},${longitude.toFixed(5)}) inside=${inside} wasIn=${inZoneRef.current} zones=${zones.length}`);

            if (inside && !inZoneRef.current) {
              console.log("[SecureMe] 🔴 ENTERED zone → show toggle");
              setZoneState(true);
              notify(
                "⚠️ High-Risk Zone Entered",
                "You have entered a high-risk area. Turn on SecureMe Mode to stay protected."
              );
            } else if (!inside && inZoneRef.current) {
              console.log("[SecureMe] 🟢 LEFT zone → hide toggle");
              setZoneState(false);
              const wasActive = secureMeOnRef.current;
              if (wasActive) {
                setSecState(false);
                stopIMURef.current?.();
                stopGPSPoll();
                clearTimeout(screenIdleTimer.current);
                cancelVerification(); // abort any in-flight grace/bio on zone exit
              }
              notify(
                "✅ High-Risk Zone Exited",
                wasActive
                  ? "You have left the high-risk area. SecureMe Mode has been turned off."
                  : "You have left the high-risk area. Stay safe!"
              );
            }
          }
        );
        console.log("[SecureMe] ✅ Zone watcher active");
      } catch (e) {
        console.log("[SecureMe] zone watcher error:", e.message);
      }
    })();

    return () => {
      alive = false;
      locationSubRef.current?.remove();
      locationSubRef.current = null;
    };
  }, []); // runs once — reads zoneRef via ref (always fresh)

  /* ── Zone polling ────────────────────────────────────── */
  useEffect(() => {
    fetchZone();
    pollTimerRef.current = setInterval(fetchZone, ZONE_POLL_MS);
    return () => clearInterval(pollTimerRef.current);
  }, [fetchZone]);

  /* ── Cleanup on unmount ──────────────────────────────── */
  useEffect(() => {
    return () => {
      stopIMURef.current?.();
      stopGPSPoll();
      locationSubRef.current?.remove();
      clearTimeout(screenIdleTimer.current);
      clearTimeout(graceTimerRef.current);
      clearTimeout(bioTimerRef.current);
      clearInterval(pollTimerRef.current);
    };
  }, [stopGPSPoll]);

  /* ══════════════════════════════════════════════════════
     toggleSecureMe — pseudocode: FUNCTION startSecureMe(mode)
       resetAll()
       startIMUListener()
       IF MODE == WALK → startGPSMonitor()
       startScreenMonitor()
  ══════════════════════════════════════════════════════ */
  const toggleSecureMe = useCallback((on) => {
    console.log("[SecureMe] 🔘 toggle →", on, "mode:", mode);
    if (mode === "passive") {
      console.log("[SecureMe] passive mode — sensors blocked on HomeScreen");
      return;
    }
    setSecState(on);

    if (on) {
      // pseudocode: resetAll() before starting
      console.log("[SecureMe] 🔄 resetAll() on enable");
      gpsBreachRef.current     = false;
      imuBreachRef.current     = false;
      screenBreachRef.current  = false;
      alertSentRef.current     = false;
      verifyPendingRef.current = false;
      lastIMUMagRef.current    = null;
      imuStillTimeRef.current  = 0;
      noiseCountRef.current    = 0;
      gpsStillTimeRef.current  = 0;
      lastGPSCoordRef.current  = null;
      lastCoordKeyRef.current  = null;
      console.log("[SecureMe] ✅ All state cleared on enable");

      // startIMUListener()
      startIMURef.current?.();

      // IF MODE == WALK → startGPSMonitor()
      if (mode === "walk") {
        startGPSPoll();
      } else {
        console.log("[SecureMe] 📍 GPS stationary poll disabled for cab mode");
      }

      // startScreenTimer() — pseudocode: IF NOT verifyPending AND NOT alertSent → screenIdle=true; evaluate()
      const screenIdleMs = mode === "cab" ? SCREEN_IDLE_CAB_MS : SCREEN_IDLE_WALK_MS;
      console.log(`[SecureMe] 📵 Screen idle timer set to ${screenIdleMs / 1000}s (mode=${mode})`);
      clearTimeout(screenIdleTimer.current);
      screenIdleTimer.current = setTimeout(() => {
        if (screenBreachRef.current)    return;
        if (!secureMeOnRef.current)     return;
        if (verifyPendingRef.current) {
          console.log("[SecureMe] 📵 Screen timer fired but verifyPending=true — skipping");
          return;
        }
        if (alertSentRef.current) {
          console.log("[SecureMe] 📵 Screen timer fired but alertSent=true — skipping");
          return;
        }
        console.log(`[SecureMe] 📵 Screen: 🛑 BREACH — no touch for ${screenIdleMs / 1000}s (mode=${mode}) | IMU=${imuBreachRef.current} GPS=${gpsBreachRef.current}`);
        screenBreachRef.current = true;
        evaluateRef.current?.(gpsBreachRef.current, imuBreachRef.current, true);
      }, screenIdleMs);

    } else {
      // pseudocode: stopSecureMe() — stopIMU() + stopGPS() + cancelScreenTimer() + cancelVerification()
      stopIMURef.current?.();
      stopGPSPoll();
      clearTimeout(screenIdleTimer.current);
      cancelVerification(); // cancels grace timer + bio timer, clears verifyPending
      console.log("[SecureMe] ⭕ stopSecureMe() — all sensors stopped");
    }
  }, [setSecState, mode, startGPSPoll, stopGPSPoll, cancelVerification]);

  /* ══════════════════════════════════════════════════════
     recordTouch — pseudocode: ON_TOUCH_EVENT
       cancelVerification()
       screenIdle = false
       restartScreenTimer()
  ══════════════════════════════════════════════════════ */
  const recordTouch = useCallback(() => {
    if (!secureMeOnRef.current) return;

    const now = new Date().toISOString().substring(11, 23); // HH:MM:SS.mmm

    // cancelVerification() — abort grace window or bio if active
    cancelVerification();

    // screenIdle = false
    screenBreachRef.current = false;

    // restartScreenTimer()
    const screenIdleMs = mode === "cab" ? SCREEN_IDLE_CAB_MS : SCREEN_IDLE_WALK_MS;
    clearTimeout(screenIdleTimer.current);
    console.log(`[SecureMe] 👆 TOUCH at ${now} — screenIdle reset, timer restarted (${screenIdleMs / 1000}s) | IMU=${imuBreachRef.current} GPS=${gpsBreachRef.current}`);
    screenIdleTimer.current = setTimeout(() => {
      if (screenBreachRef.current)  return;
      if (!secureMeOnRef.current)   return;
      if (verifyPendingRef.current) {
        console.log("[SecureMe] 📵 Screen timer fired but verifyPending=true — skipping");
        return;
      }
      if (alertSentRef.current) {
        console.log("[SecureMe] 📵 Screen timer fired but alertSent=true — skipping");
        return;
      }
      console.log(`[SecureMe] 📵 Screen: 🛑 BREACH — no touch for ${screenIdleMs / 1000}s (mode=${mode}) | IMU=${imuBreachRef.current} GPS=${gpsBreachRef.current}`);
      screenBreachRef.current = true;
      evaluateRef.current?.(gpsBreachRef.current, imuBreachRef.current, true);
    }, screenIdleMs);
  }, [mode, cancelVerification]);

  return { inZone, secureMeOn, toggleSecureMe, recordTouch };
}
/**
 * useWalkEngine.js
 *
 * A persistent hook that lives in App.js and NEVER unmounts.
 * It owns all sensor subscriptions, GPS watcher, safety logic,
 * and live readings so they survive navigation back to HomeScreen.
 *
 * WalkMonitoringScreen is just a display layer — it reads from
 * the values this hook exposes and calls the actions it provides.
 *
 * PANIC FLOW:
 *   1. sendLocationToServer() → POST /api/panic → gets alertId back
 *   2. Immediately starts a 5s interval → PUT /api/panic/location
 *      (updates lat/lng in-place so dashboard map shows live movement)
 *   3. Interval stops when stopMonitoring() is called or panic is cleared
 */

import { useState, useRef, useEffect } from "react";
import { Alert, AppState } from "react-native";
import * as Location from "expo-location";
import { Accelerometer, Gyroscope } from "expo-sensors";
import * as LocalAuthentication from "expo-local-authentication";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { apiFetch, apiMultipart, rawFetchWithSecurity, AuthError, BASE_URL } from "./api";
import { emitLocationUpdate, getLocationInterval, onModeChange } from "./socket";
import React, { useContext } from "react";
import { AuthContext } from "./AuthContext";

/* ── Thresholds ── */
const SPEED_THRESHOLD        = 15;    // km/h
const STRONG_SHAKE_THRESHOLD = 3.2;
const MEDIUM_SHAKE_THRESHOLD = 1.9;
const MEDIUM_SHAKE_LIMIT     = 4;
const MEDIUM_WINDOW          = 9000;
const COOLDOWN               = 2500;
const MAX_ROTATION_THRESHOLD = 4.5;
const SENSOR_INTERVAL        = 80;   // ms — 10 Hz
const PANIC_LOCATION_INTERVAL = 5000; // ms — live location update after panic

const BACKEND_URL           = BASE_URL;

/* ── Walk Monitoring Engine (Adaptive Sampling) ── */
const LOW_RATE_HZ            = 8;
const BURST_RATE_HZ          = 60;
const BURST_DURATION_MS      = 3000;
const SUSPICIOUS_ACC_FACTOR  = 1.6;
const SUSPICIOUS_DELTA_ACC   = 0.6;   // g
const SUSPICIOUS_GYRO_FACTOR = 1.5;
const BASELINE_WINDOW_SEC    = 15;
const STATE_LOW              = "LOW_MONITOR";
const STATE_BURST            = "BURST";
const WALK_BG_LOCATION_TASK = "walk-background-location";

/* ── Background location task — must live at module scope ── */
if (!TaskManager.isTaskDefined(WALK_BG_LOCATION_TASK)) {
  TaskManager.defineTask(WALK_BG_LOCATION_TASK, async ({ data, error }) => {
    if (error) { console.error("[Walk BG Task]", error); return; }
    if (!data?.locations?.length) return;

    const { latitude, longitude, speed } = data.locations[0].coords;
    const speedKmh = (speed || 0) * 3.6;

    await AsyncStorage.setItem("WALK_LAST_LOCATION", JSON.stringify({ latitude, longitude }));

    if (speedKmh >= SPEED_THRESHOLD) {
      const lastNotifTime = await AsyncStorage.getItem("WALK_LAST_NOTIF_TIME");
      const now = Date.now();
      if (!lastNotifTime || now - parseInt(lastNotifTime) > 5000) {
        await AsyncStorage.setItem("WALK_LAST_NOTIF_TIME", String(now));
        try {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: "⚠️ Safety Check",
              body: "You seem to be moving fast. Are you safe? Please respond.",
              sound: true,
              categoryIdentifier: "safety",
              priority: "max",
            },
            trigger: null,
          });
        } catch (e) { console.error("[Walk BG Task] notification failed:", e); }
      }
    }
  });
}

async function getReliableLocation() {
  try {
    const last = await Location.getLastKnownPositionAsync({ maxAge: 120000, requiredAccuracy: 500 });
    if (last) return last;
  } catch (_) {}
  for (const [accuracy, timeout] of [
    [Location.Accuracy.Lowest,   10000],
    [Location.Accuracy.Balanced, 15000],
  ]) {
    try {
      return await Promise.race([
        Location.getCurrentPositionAsync({ accuracy }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeout)),
      ]);
    } catch (_) {}
  }
  throw new Error(
    "Location unavailable. Please check:\n1. Settings → Location → turn ON\n2. App permissions → Location → Allow all the time"
  );
}

export function useWalkEngine({ user, token = null }) {

  /* ── State ── */
  const [monitoring,         setMonitoring]         = useState(false);
  const [coords,             setCoords]             = useState(null);
  const [speed,              setSpeed]              = useState(0);
  const [gyroRotation,       setGyroRotation]       = useState(0);
  const [accelDelta,         setAccelDelta]         = useState(0);
  const [elapsed,            setElapsed]            = useState(0);
  const [walkSessionId,      setWalkSessionId]      = useState(null);
  const [safetyAlertVisible, setSafetyAlertVisible] = useState(false);
  const [isStoppingTrip,     setIsStoppingTrip]     = useState(false);
  const [notifInterval,      setNotifInterval]      = useState(300000);

  /* ── Refs ── */
  const coordsRef           = useRef(null);
  const gyroRotationRef     = useRef(0);
  const lastMagnitudeRef    = useRef(0);
  const lastShakeTimeRef    = useRef(0);
  const mediumShakesRef     = useRef([]);
  const safetyAlertTimeout  = useRef(null);
  const safetyPendingRef    = useRef(false);
  const lastNotifTimeRef    = useRef(0);
  const accelSubRef         = useRef(null);
  const gyroSubRef          = useRef(null);
  const elapsedIntervalRef  = useRef(null);
  const fgLocationSub       = useRef(null);
  const notifIntervalRef    = useRef(300000);
  const periodicNotifTimer  = useRef(null);
  const monitoringRef       = useRef(false);
  const appStateRef         = useRef(AppState.currentState);
  const askUserSafetyRef    = useRef(null);

  /* ── Panic live-location refs ── */
  const panicAlertIdRef       = useRef(null);  // alertId from POST /api/panic
  const panicLocationTimerRef = useRef(null);  // setInterval handle for 5s updates
  const panicModeUnsubRef     = useRef(null);  // unsubscribe fn for socket onModeChange

  /* ── Walk Monitoring Engine refs ── */
  const walkEngineStateRef  = useRef(STATE_LOW);
  const baselineAccRef      = useRef(0);
  const baselineGyroRef     = useRef(0);
  const burstEndTimeRef     = useRef(0);
  const baselineReadyRef    = useRef(false); // stays false until background baseline completes

  /* Sync scalar refs */
  useEffect(() => { monitoringRef.current    = monitoring;    }, [monitoring]);
  useEffect(() => { notifIntervalRef.current = notifInterval; }, [notifInterval]);

  /* ── Elapsed timer ── */
  useEffect(() => {
    if (monitoring) {
      elapsedIntervalRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
    } else {
      clearInterval(elapsedIntervalRef.current);
      setElapsed(0);
    }
    return () => clearInterval(elapsedIntervalRef.current);
  }, [monitoring]);

  /* ── Restore coords from storage on foreground ── */
  useEffect(() => {
    const sub = AppState.addEventListener("change", async (next) => {
      if (appStateRef.current.match(/inactive|background/) && next === "active") {
        /* Foreground restore: reset to low-rate unless burst is active */
        if (monitoringRef.current && walkEngineStateRef.current === STATE_LOW) {
          _setSensorRate(LOW_RATE_HZ);
        }
        try {
          const saved = await AsyncStorage.getItem("WALK_LAST_LOCATION");
          if (saved) {
            const parsed = JSON.parse(saved);
            coordsRef.current = parsed;
            setCoords(parsed);
          }
        } catch (_) {}
      } else if (next.match(/inactive|background/)) {
        /* Background: drop to a lower rate to conserve battery if in low state */
        if (monitoringRef.current && walkEngineStateRef.current === STATE_LOW) {
          _setSensorRate(4);
        }
      }
      appStateRef.current = next;
    });
    return () => sub.remove();
  }, []);

  /* ── Notification listeners ── */
  useEffect(() => {
    const receivedSub = Notifications.addNotificationReceivedListener((notification) => {
      const { type } = notification.request.content.data ?? {};
      if (type === "safety_check" || type === "safety_check_periodic") {
        if (!safetyPendingRef.current) {
          safetyPendingRef.current = true;
          setSafetyAlertVisible(true);
          _armSafetyTimeout();
        }
      }
    });

    const responseSub = Notifications.addNotificationResponseReceivedListener(async (response) => {
      const action   = response.actionIdentifier;
      const data     = response.notification.request.content.data ?? {};
      const isSafety =
        data.type === "safety_check" ||
        data.type === "safety_check_periodic" ||
        response.notification.request.content.categoryIdentifier === "safety";
      if (!isSafety) return;

      _clearSafetyTimeout();
      setSafetyAlertVisible(false);
      safetyPendingRef.current = false;

      if (action === "SAFE_YES") {
        const ok = await verifyUserWithBiometric();
        if (!ok) sendLocationToServer("SAFETY_CHECK_NO_RESPONSE");
        scheduleNextPeriodicNotification(notifIntervalRef.current);
      } else if (action === "SAFE_NO") {
        sendLocationToServer("SAFETY_CHECK_NO");
      } else if (action === Notifications.DEFAULT_ACTION_IDENTIFIER) {
        safetyPendingRef.current = true;
        setSafetyAlertVisible(true);
        _armSafetyTimeout();
      }
    });

    return () => { receivedSub.remove(); responseSub.remove(); };
  }, []);

  /* ─────────────────────────────────────
     Internal helpers
  ───────────────────────────────────── */

  const _armSafetyTimeout = () => {
    if (safetyAlertTimeout.current) clearTimeout(safetyAlertTimeout.current);
    safetyAlertTimeout.current = setTimeout(() => {
      setSafetyAlertVisible(false);
      safetyPendingRef.current   = false;
      safetyAlertTimeout.current = null;
      sendLocationToServer("SAFETY_CHECK_NO_RESPONSE");
    }, 15000);
  };

  const _clearSafetyTimeout = () => {
    if (safetyAlertTimeout.current) {
      clearTimeout(safetyAlertTimeout.current);
      safetyAlertTimeout.current = null;
    }
  };

  const scheduleNextPeriodicNotification = (intervalMs) => {
    if (periodicNotifTimer.current) clearTimeout(periodicNotifTimer.current);
    const delay = Math.max(60000, intervalMs);
    periodicNotifTimer.current = setTimeout(async () => {
      if (!monitoringRef.current) return;
      try {
        await Notifications.scheduleNotificationAsync({
          content: {
            title: "⚠️ Safety Check",
            body: "Are you safe? Please respond within 30 seconds.",
            sound: true,
            priority: "max",
            data: { type: "safety_check_periodic" },
            categoryIdentifier: "safety",
          },
          trigger: null,
        });
      } catch (e) { console.error("[WalkEngine] periodic notif failed:", e); }
      scheduleNextPeriodicNotification(notifIntervalRef.current);
    }, delay);
  };

  const cancelPeriodicNotifications = () => {
    if (periodicNotifTimer.current) {
      clearTimeout(periodicNotifTimer.current);
      periodicNotifTimer.current = null;
    }
  };

  /* ════════════════════════════════════════
     PANIC LIVE-LOCATION STREAM
  ════════════════════════════════════════ */

  /* Send one live location update → PUT /api/panic/location */
  const _sendPanicLocationUpdate = async () => {
    const alertId = panicAlertIdRef.current;
    if (!alertId) return;

    let latitude, longitude;
    try {
      if (coordsRef.current) {
        ({ latitude, longitude } = coordsRef.current);
      } else {
        const saved = await AsyncStorage.getItem("WALK_LAST_LOCATION");
        if (saved) {
          ({ latitude, longitude } = JSON.parse(saved));
        } else {
          const loc = await getReliableLocation();
          latitude  = loc.coords.latitude;
          longitude = loc.coords.longitude;
        }
      }
    } catch (err) {
      console.log("[WalkEngine] location fetch for update failed:", err.message);
      return;
    }

    try {
      await rawFetchWithSecurity(`${BACKEND_URL}/api/panic/location`, {
        method: "PUT",
        body: { alertId, latitude, longitude },
      });
    } catch (err) {
      console.log("[WalkEngine] panic location update failed:", err.message);
    }

    // Fire-and-forget socket push — faster path to the dashboard/patrol
    // subscribers than the REST PUT above, which remains the source of
    // truth for the Panic DB record (socket does not persist to it).
    emitLocationUpdate({ latitude, longitude, lat: latitude, lng: longitude, type: "walk" });
  };

  /*
   * Start streaming location after a panic trigger.
   * Interval is server-driven: panicRoutes.js on the backend calls
   * triggerAlertMode() on trigger, which pushes a `mode: "alert"` socket
   * event with a 5s interval. We read that interval live via
   * getLocationInterval() and re-arm the timer whenever it changes,
   * rather than hardcoding PANIC_LOCATION_INTERVAL — this keeps the app
   * in sync if the backend's alert/normal cadence is ever retuned.
   */
  const _startPanicLocationStream = (alertId) => {
    if (panicLocationTimerRef.current) clearInterval(panicLocationTimerRef.current);
    panicAlertIdRef.current = alertId;

    const armTimer = (intervalMs) => {
      if (panicLocationTimerRef.current) clearInterval(panicLocationTimerRef.current);
      panicLocationTimerRef.current = setInterval(_sendPanicLocationUpdate, intervalMs || PANIC_LOCATION_INTERVAL);
    };

    /* Fire once immediately, then on the current (likely already "alert") interval */
    _sendPanicLocationUpdate();
    armTimer(getLocationInterval());

    /* Re-arm if the server's mode/interval changes while panic is active */
    if (panicModeUnsubRef.current) panicModeUnsubRef.current();
    panicModeUnsubRef.current = onModeChange(({ interval }) => {
      if (panicAlertIdRef.current) armTimer(interval);
    });

    console.log("[WalkEngine] 📍 Panic location stream started — alertId:", alertId);
  };

  /* Stop the stream and clear panic record on backend */
  const _stopPanicLocationStream = async () => {
    if (panicLocationTimerRef.current) {
      clearInterval(panicLocationTimerRef.current);
      panicLocationTimerRef.current = null;
    }
    if (panicModeUnsubRef.current) {
      panicModeUnsubRef.current();
      panicModeUnsubRef.current = null;
    }
    if (panicAlertIdRef.current) {
      try {
        await rawFetchWithSecurity(`${BACKEND_URL}/api/panic`, { method: "DELETE" });
      } catch (err) {
        console.log("[WalkEngine] panic clear failed:", err.message);
      }
      panicAlertIdRef.current = null;
      console.log("[WalkEngine] 🛑 Panic location stream stopped");
    }
  };

  /* ════════════════════════════════════════
     sendLocationToServer
     Triggers panic → stores alertId → (re)starts 5s location stream.
  ════════════════════════════════════════ */
  const sendLocationToServer = async (alertReason) => {
    let latitude, longitude;
    try {
      if (coordsRef.current) {
        ({ latitude, longitude } = coordsRef.current);
      } else {
        const saved = await AsyncStorage.getItem("WALK_LAST_LOCATION");
        if (saved) {
          ({ latitude, longitude } = JSON.parse(saved));
        } else {
          const loc = await getReliableLocation();
          latitude  = loc.coords.latitude;
          longitude = loc.coords.longitude;
        }
      }
    } catch (err) { console.log("Location fetch failed:", err.message); return; }

    try {
      const res = await rawFetchWithSecurity(`${BACKEND_URL}/api/panic`, {
        method: "POST",
        body: { latitude, longitude, alertReason },
      });

      if (res.ok) {
        const data = await res.json();
        if (data.alertId) {
          /* New alert created — (re)start the location stream with the fresh alertId */
          _startPanicLocationStream(data.alertId);
        }
      } else {
        console.log("[WalkEngine] panic trigger failed:", res.status);
      }
    } catch (err) {
      console.log("Panic send failed:", err.message);
    }
  };

  /* askUserSafety */
  const askUserSafety = async () => {
    if (safetyPendingRef.current) return;
    const now = Date.now();
    if (now - lastNotifTimeRef.current < COOLDOWN) return;
    lastNotifTimeRef.current = now;
    safetyPendingRef.current = true;
    setSafetyAlertVisible(true);
    _armSafetyTimeout();

    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: "⚠️ Safety Check",
          body: "Are you safe? Please respond within 30 seconds.",
          sound: true,
          priority: "max",
          data: { type: "safety_check" },
          categoryIdentifier: "safety",
        },
        trigger: null,
      });
    } catch (e) {
      console.error("[WalkEngine] askUserSafety failed:", e);
      safetyPendingRef.current = false;
      setSafetyAlertVisible(false);
    }
  };

  askUserSafetyRef.current = askUserSafety;

  /* ════════════════════════════════════════
     WALK MONITORING ENGINE — Adaptive Sampling
  ════════════════════════════════════════ */

  /**
   * Collect sensor samples over `durationSec` at LOW_RATE_HZ and
   * return the average magnitude. Used once at session start to
   * establish a personal baseline for suspicious-motion detection.
   */
  const _computeBaselineMagnitude = (sensorApi, durationSec) =>
    new Promise((resolve) => {
      const samples  = [];
      const intervalMs = Math.round(1000 / LOW_RATE_HZ);
      sensorApi.setUpdateInterval(intervalMs);
      const sub = sensorApi.addListener(({ x, y, z }) => {
        samples.push(Math.sqrt(x * x + y * y + z * z));
      });
      setTimeout(() => {
        sub.remove();
        const avg = samples.length
          ? samples.reduce((a, b) => a + b, 0) / samples.length
          : 1;
        resolve(avg);
      }, durationSec * 1000);
    });

  /** Switch both accelerometer and gyroscope to a new update rate (Hz). */
  const _setSensorRate = (hz) => {
    const ms = Math.round(1000 / hz);
    Accelerometer.setUpdateInterval(ms);
    Gyroscope.setUpdateInterval(ms);
  };

  /**
   * Evaluates whether current sensor readings warrant escalating to BURST mode.
   * Mirrors the pseudocode's ON_SENSOR_DATA LOW-branch exactly:
   *   1. If baseline not ready yet → burst (full detection during warmup)
   *   2. accMag spike vs baseline   → burst
   *   3. delta acc spike            → burst
   *   4. gyro spike vs baseline     → burst
   */
  const _isSuspicious = (accMag, gyroMag) => {
    if (!baselineReadyRef.current)                                     return true;
    if (accMag  > baselineAccRef.current  * SUSPICIOUS_ACC_FACTOR)    return true;
    if (Math.abs(accMag - lastMagnitudeRef.current) > SUSPICIOUS_DELTA_ACC) return true;
    if (gyroMag > baselineGyroRef.current * SUSPICIOUS_GYRO_FACTOR)   return true;
    return false;
  };

  /** Elevate to high-frequency burst sampling for BURST_DURATION_MS. */
  const _startBurstMode = () => {
    if (walkEngineStateRef.current === STATE_BURST) return;
    console.log("[WalkEngine] Burst mode started");
    walkEngineStateRef.current = STATE_BURST;
    burstEndTimeRef.current    = Date.now() + BURST_DURATION_MS;
    _setSensorRate(BURST_RATE_HZ);
  };

  /** Return to low-power monitoring after burst window expires. */
  const _stopBurstMode = () => {
    console.log("[WalkEngine] Burst mode stopped");
    walkEngineStateRef.current = STATE_LOW;
    _setSensorRate(LOW_RATE_HZ);
  };

  /* ═══════════════════════════════════
     START MONITORING
     Follows pseudocode Steps 1–12 exactly.
  ═══════════════════════════════════ */
  const startMonitoring = async () => {
    console.log("START MONITORING CLICKED");

    /* ── STEP 1: Request Motion Permission (iOS critical) ── */
    try {
      // expo-sensors exposes a requestPermissionsAsync on iOS; it's a no-op on Android.
      const motionResult = await Accelerometer.requestPermissionsAsync();
      if (motionResult.status !== "granted") {
        console.log("Motion permission denied");
        Alert.alert("Permission Required", "Motion permission is required to monitor your walk.");
        return;
      }
      console.log("Motion permission granted");
    } catch (_) {
      // Android doesn't need this — ignore errors on non-iOS platforms.
    }

    /* ── STEP 2: Request Foreground Location ── */
    const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
    if (fgStatus !== "granted") {
      console.log("Foreground location permission denied");
      Alert.alert("Permission Required", "Location permission is needed to start monitoring.");
      return;
    }
    console.log("Foreground location granted");

    /* ── STEP 3: Request Background Location ── */
    const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
    if (bgStatus !== "granted") {
      console.log("Background location permission denied — continuing with limited functionality");
      Alert.alert(
        "Background Location Required",
        "For safety checks while the app is in background, please go to:\nSettings → Apps → SecureOcte → Permissions → Location → Allow all the time",
        [{ text: "OK" }]
      );
      // DO NOT return — allow limited foreground-only functionality.
    } else {
      console.log("Background location granted");
    }

    /* ── STEP 4: Check Location Services (GPS on/off) ── */
    const providerStatus = await Location.getProviderStatusAsync();
    if (!providerStatus.locationServicesEnabled) {
      console.log("Location services disabled");
      Alert.alert("Location Services Off", "Please enable Location Services in Settings → Location.");
      return;
    }
    console.log("Location services enabled");

    /* ── STEP 5: Get Initial Location (fail-safe) ── */
    let initialLoc;
    try {
      initialLoc = await getReliableLocation();
      console.log("Initial location fetched");
    } catch (err) {
      console.log("Initial location fetch failed:", err.message);
      Alert.alert("Location Unavailable", "Unable to fetch your location. Please check:\n1. Settings → Location → turn ON\n2. App permissions → Location → Allow all the time");
      return;
    }

    await startWalkSessionInBackend(initialLoc.coords.latitude, initialLoc.coords.longitude);

    try {
      /* ── STEP 6: Start Background Location Task ── */
      console.log("Starting background location task");
      const alreadyRunning = await Location.hasStartedLocationUpdatesAsync(WALK_BG_LOCATION_TASK).catch(() => false);
      if (!alreadyRunning) {
        await Location.startLocationUpdatesAsync(WALK_BG_LOCATION_TASK, {
          accuracy: Location.Accuracy.High,
          timeInterval: 2000,
          distanceInterval: 3,
          showsBackgroundLocationIndicator: true,
          foregroundService: {
            notificationTitle: "Walk Monitoring Active",
            notificationBody: "SecureOcte is watching over your walk",
            notificationColor: "#13ec49",
          },
          pausesUpdatesAutomatically: false,
          activityType: Location.ActivityType.Fitness,
        });
        console.log("Background location task started");
      } else {
        console.log("Background location task already running");
      }

      /* ── STEP 7: Start Foreground Location Watcher ── */
      console.log("Starting foreground location watcher");
      fgLocationSub.current?.remove?.();
      fgLocationSub.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 2000, distanceInterval: 2 },
        (loc) => {
          const c = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
          coordsRef.current = c;
          setCoords(c);
          const speedKmh = (loc.coords.speed || 0) * 3.6;
          setSpeed(speedKmh);
          // IF speed > threshold → triggerSafetyCheck()
          if (speedKmh >= SPEED_THRESHOLD) askUserSafetyRef.current?.();
        }
      );

      /* ── STEP 8: Start Gyroscope Listener (LOW_RATE, switch to BURST on suspicious rotation) ── */
      console.log("Starting gyroscope listener");
      Gyroscope.setUpdateInterval(Math.round(1000 / LOW_RATE_HZ)); // LOW RATE
      gyroSubRef.current?.remove();
      gyroSubRef.current = Gyroscope.addListener(({ x, y, z }) => {
        const rot = Math.sqrt(x * x + y * y + z * z);
        gyroRotationRef.current = rot;
        setGyroRotation(rot);

        // IF rotation is suspicious → switch to BURST MODE
        if (
          walkEngineStateRef.current === STATE_LOW &&
          rot > baselineGyroRef.current * SUSPICIOUS_GYRO_FACTOR
        ) {
          _startBurstMode();
        }
      });

      /* ── STEP 9: Start Accelerometer Listener ── */
      console.log("Starting accelerometer listener");
      // LOW RATE initially — escalates to BURST when suspicious, back to LOW when burst expires
      Accelerometer.setUpdateInterval(Math.round(1000 / LOW_RATE_HZ));
      accelSubRef.current?.remove();
      accelSubRef.current = Accelerometer.addListener(({ x, y, z }) => {
        const magnitude = Math.sqrt(x * x + y * y + z * z);
        const gyroMag   = gyroRotationRef.current;
        const delta     = Math.abs(magnitude - lastMagnitudeRef.current);
        const now       = Date.now();

        setAccelDelta(delta);

        /* ── LOW STATE branch ── */
        if (walkEngineStateRef.current === STATE_LOW) {
          // IF suspicious movement → start BURST MODE
          if (_isSuspicious(magnitude, gyroMag)) {
            _startBurstMode();
          }
          lastMagnitudeRef.current = magnitude;
          return;
        }

        /* ── BURST STATE branch ── */
        // Dead-band noise filter
        if (delta < 0.4) { lastMagnitudeRef.current = magnitude; return; }
        // High-rotation false-positive guard (device spinning, not a shake)
        if (gyroRotationRef.current > MAX_ROTATION_THRESHOLD && delta < 3) {
          lastMagnitudeRef.current = magnitude; return;
        }

        // IF strong shake → triggerSafetyCheck()
        if (delta > STRONG_SHAKE_THRESHOLD) {
          if (now - lastShakeTimeRef.current > COOLDOWN) {
            lastShakeTimeRef.current = now;
            askUserSafetyRef.current?.();
          }
        }

        // IF multiple medium shakes within window → triggerSafetyCheck()
        if (delta > MEDIUM_SHAKE_THRESHOLD) {
          const updated = [...mediumShakesRef.current, now].filter(t => now - t < MEDIUM_WINDOW);
          if (updated.length >= MEDIUM_SHAKE_LIMIT) {
            lastShakeTimeRef.current = now;
            askUserSafetyRef.current?.();
            mediumShakesRef.current = [];
          } else {
            mediumShakesRef.current = updated;
          }
        }

        // IF burst duration over → switch back to LOW MODE
        if (now >= burstEndTimeRef.current) {
          _stopBurstMode();
        }

        lastMagnitudeRef.current = magnitude;
      });

      /* ── STEP 10: Start Notification System ── */
      console.log("Scheduling periodic safety notifications");
      // Cancel any stale notifications, then schedule fresh periodic safety checks
      await Notifications.cancelAllScheduledNotificationsAsync();
      scheduleNextPeriodicNotification(notifIntervalRef.current);

      /* ── STEP 11: Initialise Engine State ── */
      // baselineReady = false, state = LOW, monitoring = true
      // _isSuspicious() returns true (conservative) while baseline is not ready,
      // so burst-mode detection is active from the first sensor sample.
      baselineReadyRef.current   = false;
      walkEngineStateRef.current = STATE_LOW;
      setMonitoring(true);
      console.log("Monitoring started");

      /* ── STEP 12: Compute Baselines in Background ── */
      console.log("Computing baselines in background (15s)…");
      // Collects 15s of accelerometer + gyroscope samples to personalise
      // the suspicious-motion thresholds to this user's normal walking pattern.
      // setMonitoring(true) has already fired above so the UI is live immediately.
      //   baselineAcc  = average accelerometer magnitude over 15 sec
      //   baselineGyro = average gyroscope magnitude over 15 sec
      //   baselineReady = true once both complete (or fall back to safe defaults)
      Promise.all([
        _computeBaselineMagnitude(Accelerometer, BASELINE_WINDOW_SEC),
        _computeBaselineMagnitude(Gyroscope,     BASELINE_WINDOW_SEC),
      ]).then(([bAcc, bGyro]) => {
        baselineAccRef.current  = bAcc;
        baselineGyroRef.current = bGyro;
        baselineReadyRef.current = true;
        console.log(`[WalkEngine] Baselines ready — acc: ${bAcc.toFixed(3)}, gyro: ${bGyro.toFixed(3)}`);
      }).catch((err) => {
        console.log("[WalkEngine] Baseline computation failed:", err.message);
        // Fall back: use safe defaults so suspicious check still works
        baselineAccRef.current   = 1.0;
        baselineGyroRef.current  = 0.5;
        baselineReadyRef.current = true;
      });

    } catch (err) {
      console.log("Start monitoring failed:", err.message);
      Alert.alert("Error", "Could not start monitoring. Please check location services and try again.\n\n" + err.message);
    }
  };

  /* ═══════════════════════════════════
     STOP MONITORING
  ═══════════════════════════════════ */
  const stopMonitoring = async () => {
    console.log("STOP MONITORING CLICKED");
    setIsStoppingTrip(true);
    let verified = false;
    try   { verified = await verifyUserWithBiometric(); }
    catch (err) { console.log("Biometric error:", err.message); }
    finally     { setIsStoppingTrip(false); }

    if (!verified) {
      console.log("Biometric verification failed — trip continues");
      Alert.alert(
        "Verification Failed",
        "Could not verify your identity. The trip will continue for your safety.\n\nIf you are in danger, use the Police Support button.",
        [{ text: "OK" }]
      );
      sendLocationToServer("STOP_BIOMETRIC_FAILED");
      return;
    }
    console.log("Biometric verification passed");

    try {
      if (await Location.hasStartedLocationUpdatesAsync(WALK_BG_LOCATION_TASK))
        await Location.stopLocationUpdatesAsync(WALK_BG_LOCATION_TASK);
      console.log("Background location task stopped");
    } catch (_) {}

    fgLocationSub.current?.remove?.();
    fgLocationSub.current = null;
    console.log("Foreground location watcher removed");

    accelSubRef.current?.remove(); accelSubRef.current = null;
    console.log("Accelerometer listener removed");

    gyroSubRef.current?.remove();  gyroSubRef.current  = null;
    console.log("Gyroscope listener removed");

    _clearSafetyTimeout();
    cancelPeriodicNotifications();
    console.log("Notifications cancelled");

    /* Stop panic stream and clear backend record */
    await _stopPanicLocationStream();

    await Notifications.cancelAllScheduledNotificationsAsync();
    await AsyncStorage.multiRemove(["WALK_SESSION_ID", "WALK_LAST_LOCATION", "WALK_LAST_NOTIF_TIME"]);
    await stopWalkSessionInBackend();
    console.log("Walk session ended");

    setSafetyAlertVisible(false);
    safetyPendingRef.current  = false;
    coordsRef.current         = null;
    gyroRotationRef.current   = 0;
    lastMagnitudeRef.current  = 0;
    lastShakeTimeRef.current  = 0;
    mediumShakesRef.current   = [];
    lastNotifTimeRef.current  = 0;
    walkEngineStateRef.current = STATE_LOW;
    baselineAccRef.current     = 0;
    baselineGyroRef.current    = 0;
    burstEndTimeRef.current    = 0;
    baselineReadyRef.current   = false;
    setMonitoring(false);
    setSpeed(0);
    setGyroRotation(0);
    setAccelDelta(0);
    setCoords(null);
    console.log("Monitoring stopped");
  };

  /* ─────────────────────────────────────────────────────────────
     FIX: Use rawFetchWithSecurity so X-Device-Id + Authorization
     are automatically attached — plain fetch() was missing the
     X-Device-Id header which caused 401 from verifyToken middleware.
  ───────────────────────────────────────────────────────────── */
  const startWalkSessionInBackend = async (latitude, longitude) => {
    try {
      const res = await rawFetchWithSecurity(`${BACKEND_URL}/api/walk/start`, {
        method: "POST",
        body: {
          // FIX: username fallback prevents Mongoose "required" validation error
          username: user?.username || user?.name || "unknown",
          latitude,
          longitude,
        },
      });
      const data = await res.json();
      if (data.session?._id) {
        setWalkSessionId(data.session._id);
        await AsyncStorage.setItem("WALK_SESSION_ID", data.session._id);
        return data.session._id;
      }
    } catch (err) { console.log("Walk start failed:", err.message); }
    return null;
  };

  /* FIX: Use rawFetchWithSecurity for stop too — same missing header issue */
  const stopWalkSessionInBackend = async () => {
    const sessionId = walkSessionId || (await AsyncStorage.getItem("WALK_SESSION_ID"));
    if (!sessionId) return;
    try {
      await rawFetchWithSecurity(`${BACKEND_URL}/api/walk/stop/${sessionId}`, {
        method: "POST",
      });
      setWalkSessionId(null);
      await AsyncStorage.removeItem("WALK_SESSION_ID");
    } catch (err) { console.log("Walk stop failed:", err.message); }
  };

  const verifyUserWithBiometric = async () => {
    try {
      const hasHW    = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (!hasHW || !enrolled) {
        Alert.alert("Authentication unavailable", "Device lock not enabled");
        return false;
      }
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Confirm it's you",
        fallbackLabel: "Use device PIN",
      });
      return result.success;
    } catch (_) { return false; }
  };

  /* ── Safety check UI actions ── */
  const confirmSafe = async () => {
    const ok = await verifyUserWithBiometric();
    if (!ok) { sendLocationToServer("SAFETY_CHECK_NO_RESPONSE"); return; }
    _clearSafetyTimeout();
    setSafetyAlertVisible(false);
    safetyPendingRef.current = false;
  };

  const confirmNotSafe = () => {
    _clearSafetyTimeout();
    setSafetyAlertVisible(false);
    safetyPendingRef.current = false;
    sendLocationToServer("SAFETY_CHECK_NO");
  };

  const handleEmergency = () => {
    sendLocationToServer("MANUAL_PANIC");
  };

  const handleSaveInterval = async (newInterval) => {
    setNotifInterval(newInterval);
    notifIntervalRef.current = newInterval;
    if (monitoring) {
      await Notifications.cancelAllScheduledNotificationsAsync();
      cancelPeriodicNotifications();
      scheduleNextPeriodicNotification(newInterval);
    }
  };

  return {
    monitoring,
    coords,
    speed,
    gyroRotation,
    accelDelta,
    elapsed,
    walkSessionId,
    safetyAlertVisible,
    isStoppingTrip,
    notifInterval,
    startMonitoring,
    stopMonitoring,
    confirmSafe,
    confirmNotSafe,
    handleEmergency,
    handleSaveInterval,
  };
}
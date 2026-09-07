/**
 * BatteryMonitor.js (UPDATED WITH NETWORK INSTABILITY MODE)
 */

import { useEffect, useRef, useCallback } from "react";
import { AppState, Alert } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import * as Battery from "expo-battery";
import * as Location from "expo-location";
import { rawFetchWithSecurity, BASE_URL } from "./api";
import { emitHeartbeat, emitLocationUpdate, onModeChange, getLocationInterval } from "./socket";

// ─── CONFIG ──────────────────────────────────────────────────
const BACKEND = `${BASE_URL}/api/secureme`;
const POLL_INTERVAL = 15_000;
const MAX_RETRIES = 3;
const GPS_CACHE_AGE = 60_000;

const RETRY_DELAYS = [2_000, 5_000, 8_000];

export function useBatteryMonitor({ user, enabled = false, mode = "secureme" }) {
  const batteryRef = useRef(null);
  const coordsRef = useRef(null);
  const enabledRef = useRef(enabled);
  const pollTimer = useRef(null);
  const lastHeartbeat = useRef(0);

  // ✅ NEW: instability tracking
  const unstableRef = useRef(false);
  const successCount = useRef(0);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  // ── Battery ────────────────────────────────────────────────
  const fetchBattery = useCallback(async () => {
    try {
      const level = await Battery.getBatteryLevelAsync();
      batteryRef.current = level;
      console.log(`[BatteryMonitor:${mode}] 🔋 ${(level * 100).toFixed(1)}%`);
    } catch (e) {
      console.log(`[BatteryMonitor:${mode}] battery read error:`, e.message);
    }
  }, [mode]);

  // ── Network Status ─────────────────────────────────────────
  const fetchNetworkStatus = useCallback(async () => {
    try {
      const state = await NetInfo.fetch();
      return state.isConnected ?? true;
    } catch {
      return true;
    }
  }, []);

  // ── Location ───────────────────────────────────────────────
  const fetchCoords = useCallback(async () => {
    try {
      // Skip cached position in alert/panic mode or fast intervals to guarantee live GPS accuracy
      const isAlertMode = mode === "alert" || getLocationInterval() <= 5000;
      if (!isAlertMode) {
        const cached = await Location.getLastKnownPositionAsync({
          maxAge: 10_000,
          requiredAccuracy: 50,
        });
        if (cached) {
          coordsRef.current = {
            lat: cached.coords.latitude,
            lng: cached.coords.longitude,
          };
          return;
        }
      }
    } catch { }

    try {
      const isAlertMode = mode === "alert" || getLocationInterval() <= 5000;
      const loc = await Location.getCurrentPositionAsync({
        accuracy: isAlertMode ? Location.Accuracy.High : Location.Accuracy.Balanced,
      });
      coordsRef.current = {
        lat: loc.coords.latitude,
        lng: loc.coords.longitude,
      };
    } catch { }
  }, [mode]);

  // ── Heartbeat ──────────────────────────────────────────────
  const sendHeartbeat = useCallback(async () => {
    if (!enabledRef.current) return;
    if (!user?.username) return;

    await fetchCoords().catch(() => { });

    const batteryPct =
      batteryRef.current !== null
        ? Math.round(batteryRef.current * 100)
        : null;

    const networkStatus = await fetchNetworkStatus();
    const lat = coordsRef.current?.lat ?? null;
    const lng = coordsRef.current?.lng ?? null;

    // Fire-and-forget socket heartbeat — feeds the fast Redis-keyspace
    // watchdog (services/networkMonitor.js on the backend) in parallel
    // with the REST POST below, which remains the source of truth /
    // fallback (Mongo poll path in secureme.cjs) if the socket is down.
    emitHeartbeat({
      username: user?.username,
      batteryPct,
      mode,
      lat,
      lng,
      appState: AppState.currentState,
      networkStatus,
      networkUnstable: unstableRef.current,
    });

    // Also emit location_update over socket for live streaming to dashboard and backend
    if (lat !== null && lng !== null) {
      emitLocationUpdate({
        lat,
        lng,
        type: mode,
        username: user?.username,
      });
    }

    const startTime = Date.now();

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const retryCount = attempt - 1;

      try {
        const res = await rawFetchWithSecurity(`${BACKEND}/heartbeat`, {
          method: "POST",
          body: {
            username: user.username,
            batteryPct,
            mode,
            lat: coordsRef.current?.lat ?? null,
            lng: coordsRef.current?.lng ?? null,
            appState: AppState.currentState,
            timestamp: Date.now(),
            networkStatus,
            retryCount,
            networkUnstable: unstableRef.current, // ✅ KEY FIELD
          },
        });

        lastHeartbeat.current = Date.now();

        const duration = Date.now() - startTime;

        // 🔴 Detect delayed poll
        if (duration > 18000) {
          if (!unstableRef.current) {
            unstableRef.current = true;
            successCount.current = 0;

            console.log(`[BatteryMonitor:${mode}] ⚠️ NETWORK UNSTABLE (delayed poll)`);

            Alert.alert(
              "Network Issue",
              "Network instability detected. Monitoring may be unreliable. Stay alert."
            );
          }
        }

        // 🟢 Recovery
        if (unstableRef.current) {
          successCount.current += 1;

          if (successCount.current >= 4) {
            unstableRef.current = false;
            successCount.current = 0;

            console.log(`[BatteryMonitor:${mode}] ✅ Network stabilized`);
          }
        }

        console.log(
          `[BatteryMonitor:${mode}] 💓 heartbeat → ${res.status}` +
          ` (battery=${batteryPct}%, net=${networkStatus}, unstable=${unstableRef.current}, attempt=${attempt})`
        );

        break;

      } catch (e) {
        console.log(
          `[BatteryMonitor:${mode}] heartbeat failed (attempt ${attempt}/${MAX_RETRIES}):`,
          e.message
        );

        if (attempt < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt - 1]));
        }

        // 🔴 Retry exhausted → instability
        if (attempt === MAX_RETRIES) {
          if (!unstableRef.current) {
            unstableRef.current = true;
            successCount.current = 0;

            console.log(`[BatteryMonitor:${mode}] ⚠️ NETWORK UNSTABLE (retry failure)`);
          }
        }
      }
    }
  }, [user, mode, fetchCoords, fetchNetworkStatus]);

  // ── Stop ───────────────────────────────────────────────────
  const sendStop = useCallback(async () => {
    if (!user?.username) return;
    try {
      await rawFetchWithSecurity(`${BACKEND}/heartbeat`, {
        method: "DELETE",
        body: { username: user.username, mode },
      });
      console.log(`[BatteryMonitor:${mode}] 🟢 Clean stop sent`);
    } catch (e) {
      console.log(`[BatteryMonitor:${mode}] clean stop failed:`, e.message);
    }
  }, [user, mode]);

  // ── Lifecycle ──────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
      sendStop();
      return;
    }

    const armTimer = (intervalMs) => {
      if (pollTimer.current) clearInterval(pollTimer.current);
      const targetInterval = intervalMs || getLocationInterval() || 15_000;
      pollTimer.current = setInterval(async () => {
        await fetchBattery();
        await sendHeartbeat();
      }, targetInterval);
      console.log(`[BatteryMonitor:${mode}] ⏱ Poll interval armed at ${targetInterval} ms`);
    };

    (async () => {
      await fetchBattery();
      await sendHeartbeat();
      armTimer(getLocationInterval());
    })();

    const unsubMode = onModeChange(({ interval }) => {
      console.log(`[BatteryMonitor:${mode}] ⚡ Mode change -> switching poll interval to ${interval} ms`);
      armTimer(interval);
    });

    return () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
      if (unsubMode) unsubMode();
    };
  }, [enabled, mode, fetchBattery, sendHeartbeat, sendStop]);

  // ── App Resume Recovery ────────────────────────────────────
  useEffect(() => {
    const sub = AppState.addEventListener("change", async (nextState) => {
      if (nextState !== "active") return;
      if (!enabledRef.current) return;

      const elapsed = Date.now() - lastHeartbeat.current;

      console.log(
        `[BatteryMonitor:${mode}] 📲 Resume — elapsed=${elapsed}ms`
      );

      await fetchBattery();
      await sendHeartbeat();
    });

    return () => sub.remove();
  }, [mode, fetchBattery, sendHeartbeat]);
}
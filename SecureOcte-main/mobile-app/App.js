import React, { useState, useEffect, useRef } from "react";
import { Alert } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";

import AuthScreen from "./screens/AuthScreen";
import HomeScreen from "./screens/HomeScreen";
import WalkMonitoringScreen from "./screens/WalkMonitoringScreen";
import CabMonitoringScreen from "./screens/CabMonitoringScreen";
import ProfileScreen from "./screens/ProfileScreen";
import AIChatScreen from "./screens/AIChatScreen";
import VoiceCabAssistantScreen from "./screens/VoiceCabAssistantScreen";
import PatrolVehicleScreen from "./screens/Patrolvehiclescreen";
import ReportIncidentScreen from "./screens/Reportincidentscreen";
import IncidentReportsScreen from "./screens/IncidentReportsScreen";
import { useSecureMe } from "./screens/Securemescreen";
import { useWalkEngine } from "./screens/useWalkEngine";
import { connectSocket, disconnectSocket, onNetworkAlert } from "./screens/socket";

/* ─────────────────────────────────────────────────────────────
   GLOBAL notification handler — must be set before any component
   mounts. Controls how notifications appear when app is FOREGROUND.
───────────────────────────────────────────────────────────── */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/* ─────────────────────────────────────────────────────────────
   Register all notification categories at module load time.
   This runs once when the JS bundle is evaluated — before any
   screen mounts — so categories exist in production builds.
───────────────────────────────────────────────────────────── */
async function registerNotificationCategories() {
  try {
    // "safety" category — used by WalkMonitoring safety checks
    await Notifications.setNotificationCategoryAsync("safety", [
      {
        identifier: "SAFE_YES",
        buttonTitle: "✅ Yes, I'm Safe",
        options: { opensAppToForeground: true },
      },
      {
        identifier: "SAFE_NO",
        buttonTitle: "🆘 No, Send Help",
        options: { isDestructive: true, opensAppToForeground: true },
      },
    ]);

    // "secureme" category — used by SecureMe biometric prompt
    await Notifications.setNotificationCategoryAsync("secureme", [
      {
        identifier: "VERIFY_NOW",
        buttonTitle: "🔐 Verify Now",
        options: { opensAppToForeground: true },
      },
      {
        identifier: "SEND_ALERT",
        buttonTitle: "🚨 Send Alert",
        options: { isDestructive: true, opensAppToForeground: true },
      },
    ]);

    // "deviation" category — used by CabMonitoring route deviation alerts
    await Notifications.setNotificationCategoryAsync("deviation", [
      {
        identifier: "DEV_SAFE",
        buttonTitle: "✅ I'm Safe",
        options: { opensAppToForeground: true },
      },
      {
        identifier: "DEV_SUSPICIOUS",
        buttonTitle: "🤨 Suspicious",
        options: { opensAppToForeground: true },
      },
      {
        identifier: "DEV_HELP",
        buttonTitle: "🆘 Need Help",
        options: { isDestructive: true, opensAppToForeground: true },
      },
    ]);

    console.log("[App] ✅ Notification categories registered");
  } catch (e) {
    console.log("[App] category registration error:", e.message);
  }
}

export default function App() {
  const [user, setUser]       = useState(null);
  const [token, setToken]     = useState(null);
  const [section, setSection] = useState("home");
  const [cabRouteData, setCabRouteData] = useState(null);
  const responseListenerRef   = useRef(null);

  /* ── Walk Engine — sensors + GPS live forever, survive navigation ── */
  const walkEngine = useWalkEngine({ user: user ?? { username: "" } });

  /* ── Single SecureMe instance — never unmounts ── */
  // mode is derived from the active section so cab screen gets cab behaviour:
  //   "cab"  → GPS check OFF, IMU window 40s, screen idle 40s
  //   "walk" → GPS check ON,  IMU window 30s, screen idle 30s
  const secureMeMode = section === "cab" ? "cab" : "walk";
  const { inZone, secureMeOn, toggleSecureMe, recordTouch } =
    useSecureMe({ user: user ?? { username: "" }, token, mode: secureMeMode });

  /* ── Reset SecureMe whenever the active section changes ──────────────────
     useSecureMe reads `mode` at the moment sensors start (captured in the
     startIMU closure). If the user had SecureMe on and then navigated to a
     different screen, the running engine would still use the old mode's
     still-window and GPS behaviour. Turning it off on every section change
     ensures the next enable() picks up the correct mode fresh.
  ────────────────────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (secureMeOn) {
      console.log(`[App] section changed to "${section}" — resetting SecureMe (was on with stale mode)`);
      toggleSecureMe(false);
    }
  }, [section]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    (async () => {
      // 1. Request permissions
      if (Device.isDevice) {
        const { status: existingStatus } =
          await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;

        if (existingStatus !== "granted") {
          const { status } = await Notifications.requestPermissionsAsync({
            ios: {
              allowAlert: true,
              allowBadge: true,
              allowSound: true,
              allowCriticalAlerts: false,
              provideAppNotificationSettings: false,
              allowProvisional: false,  // full permissions, not provisional
            },
          });
          finalStatus = status;
        }

        if (finalStatus !== "granted") {
          console.log("[App] ❌ Notification permission not granted");
          return;
        }

        // 2. Register categories (must happen after permission granted)
        await registerNotificationCategories();
        console.log("[App] ✅ Notifications ready");
      } else {
        console.log("[App] Not a real device — skipping notification setup");
      }
    })();

    // 3. Global response listener — handles button taps from ANY notification
    //    Works when app is background, foreground, or just opened from notif
    responseListenerRef.current =
      Notifications.addNotificationResponseReceivedListener((response) => {
        const actionId = response.actionIdentifier;
        const notifData = response.notification.request.content.data ?? {};

        console.log("[App] notification action:", actionId, "data:", notifData);

        if (actionId === "SAFE_YES") {
          // User confirmed they are safe — do nothing / log
          console.log("[App] User confirmed safe ✅");
        } else if (actionId === "SAFE_NO") {
          // User said not safe — backend alert already handled by Walk screen
          // but we can show a reassurance alert if app comes to foreground
          Alert.alert("🚨 Help is on the way", "Your emergency contacts have been notified.");
        } else if (actionId === "VERIFY_NOW") {
          // User tapped Verify Now on SecureMe biometric notification
          // The biometric prompt is already launched by SecureMeService
          console.log("[App] User tapping verify — biometric handled by service");
        } else if (actionId === "SEND_ALERT") {
          // User explicitly chose to send alert from SecureMe notification
          console.log("[App] User chose to send alert from notification");
        } else if (actionId === "DEV_SAFE") {
          // User tapped "I'm Safe" on deviation notification — navigate to cab screen
          console.log("[App] Deviation: user confirmed safe");
          setSection("cab");
        } else if (actionId === "DEV_SUSPICIOUS") {
          // User tapped "Suspicious" on deviation notification — open app to cab screen
          console.log("[App] Deviation: user flagged suspicious");
          setSection("cab");
        } else if (actionId === "DEV_HELP") {
          // User tapped "Need Help" on deviation notification — open app and go to cab
          console.log("[App] Deviation: user requested help");
          Alert.alert("🚨 Help is on the way", "Emergency contacts and police have been notified.");
          setSection("cab");
        }
      });

    return () => {
      responseListenerRef.current?.remove();
    };
  }, []);

  /* ── WebSocket lifecycle — connect once user+token are available,
     tear down on logout. Reuses the same JWT the REST layer uses. ── */
  useEffect(() => {
    if (!user || !token) {
      disconnectSocket();
      return;
    }

    connectSocket({ token, userId: user.id, role: "user" });

    return () => {
      disconnectSocket();
    };
  }, [user?.id, token]);

  /* ── NETWORK_ALERT is dashboard-facing by default (admin sockets),
     but we still surface it defensively in case a future backend
     change routes it to the affected user's own session too. ── */
  useEffect(() => {
    const unsub = onNetworkAlert((payload) => {
      console.log("[App] NETWORK_ALERT received:", payload);
    });
    return unsub;
  }, []);

  /* AUTH */
  if (!user) {
    return (
      <AuthScreen
        onAuthSuccess={(userData, tokenArg, mobileArg, jwtArg, genderArg, dobArg) => {
          if (userData && typeof userData === "object") {
            setUser(userData);
            if (tokenArg && typeof tokenArg === "string") setToken(tokenArg);
          } else {
            setUser({ id: userData, username: tokenArg, mobile: mobileArg, gender: genderArg, dob: dobArg });
            if (jwtArg) setToken(jwtArg);
          }
        }}
      />
    );
  }

  /* PROFILE */
  if (section === "profile") {
    return (
      <ProfileScreen
        user={user}
        goBack={() => setSection("home")}
        updateUser={(updated) => setUser(updated)}
      />
    );
  }

  /* WALK MONITORING */
  if (section === "walk") {
    return (
      <WalkMonitoringScreen
        user={user}
        goBack={() => setSection("home")}
        inZone={inZone}
        secureMeOn={secureMeOn}
        toggleSecureMe={toggleSecureMe}
        recordTouch={recordTouch}
        walkEngine={walkEngine}
      />
    );
  }

  /* CAB MONITORING */
  if (section === "cab") {
    return (
      <CabMonitoringScreen
        user={user}
        goBack={() => setSection("home")}
        routeData={cabRouteData}
        inZone={inZone}
        secureMeOn={secureMeOn}
        toggleSecureMe={toggleSecureMe}
        recordTouch={recordTouch}
      />
    );
  }

  /* CAB VOICE ASSISTANT */
  if (section === "cabVoiceAssistant") {
    return (
      <VoiceCabAssistantScreen
        user={user}
        goBack={() => setSection("home")}
        navigateToCabMonitoring={(routeData) => {
          setCabRouteData(routeData);
          setSection("cab");
        }}
      />
    );
  }

  /* PATROL VEHICLE */
if (section === "patrol") {
  return (
    <PatrolVehicleScreen
      user={user}
      token={token}
      goBack={() => setSection("home")}
    />
  );
}

  /* REPORT INCIDENT */
  if (section === "reportIncident") {
    return (
      <ReportIncidentScreen
        user={user}
        token={token}
        goBack={() => setSection("home")}
      />
    );
  }

  /* VIEW INCIDENT REPORTS */
  if (section === "incidentReports") {
    return (
      <IncidentReportsScreen
        user={user}
        token={token}
        goBack={() => setSection("home")}
      />
    );
  }

  /* AI CHAT */
  if (section === "ai") {
    return (
      <AIChatScreen
        user={user}
        onBack={() => setSection("home")}
      />
    );
  }

  /* HOME */
  return (
    <HomeScreen
      user={user}
      token={token}
      onSelectSection={setSection}
      inZone={inZone}
      walkMonitoring={walkEngine.monitoring}
      walkElapsed={walkEngine.elapsed}
    />
  );
}
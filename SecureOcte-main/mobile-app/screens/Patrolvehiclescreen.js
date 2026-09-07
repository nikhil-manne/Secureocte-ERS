/**
 * PatrolVehicleScreen.js
 *
 * Officer night-shift patrol screen.
 * - Setup screen  → officer enters vehicle details & patrol zone → START PATROL
 * - Active screen → full-screen map, live 5-sec location push to backend,
 *                   breadcrumb trail, speed badge
 * - Dispatch      → polls backend every 5 s for a forwarded victim alert
 *                 → shows in-app full-screen banner with victim details
 *                 → officer taps "Navigate to Victim" → opens Google Maps / Apple Maps
 *                 → mission strip shows at bottom when banner is dismissed but still active
 */

import React, { useState, useEffect, useRef, useContext } from "react";
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Alert,
  SafeAreaView,
  StatusBar,
  ScrollView,
  AppState,
  Platform,
  BackHandler,
  Modal,
  ActivityIndicator,
} from "react-native";
import MapView, { Marker, Polyline } from "react-native-maps";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import * as Notifications from "expo-notifications";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { apiFetch, apiMultipart, rawFetchWithSecurity, AuthError, BASE_URL } from "./api";
import { emitLocationUpdate, getLocationInterval, subscribePatrolDispatch, subscribeIncidentReports } from "./socket";
import { AuthContext } from "./AuthContext";

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const BACKEND_URL = BASE_URL;
const API_KEY = Constants.expoConfig?.extra?.googleApiKey || "";
const LOCATION_UPDATE_INTERVAL = 5000;
const DISPATCH_POLL_INTERVAL = 5000;
const PATROL_BG_TASK = "PATROL_BACKGROUND_LOCATION_TASK";
const NEARBY_POLL_INTERVAL = 10000; // fetch nearby users every 10 s
const NEARBY_RADIUS_KM = 5;     // 5 km radius
const INCIDENT_POLL_INTERVAL = 5000;  // poll assigned incidents every 5 s

/* ── Incident category metadata ── */
const INCIDENT_CAT_META = {
  "Public Disturbance": { emoji: "📢", color: "#f97316", bg: "rgba(249,115,22,0.12)" },
  "Suspicious Gathering": { emoji: "👥", color: "#8b5cf6", bg: "rgba(139,92,246,0.12)" },
  "Risky Behavior": { emoji: "⚡", color: "#ef4444", bg: "rgba(239,68,68,0.12)" },
};

// ─────────────────────────────────────────────────────────────────────────────
//  BACKGROUND LOCATION TASK  (module-level — must be outside component)
// ─────────────────────────────────────────────────────────────────────────────
TaskManager.defineTask(PATROL_BG_TASK, async ({ data, error }) => {
  if (error) { console.error("[Patrol BG Task] error:", error); return; }
  if (!data) return;
  const { locations } = data;
  if (!locations?.length) return;
  const { latitude, longitude } = locations[0].coords;
  try {
    const tripId = await AsyncStorage.getItem("PATROL_TRIP_ID");
    if (!tripId) return;
    await rawFetchWithSecurity(`${BACKEND_URL}/api/patrol/update-location`, {
      method: "POST",
      body: { tripId, latitude, longitude },
    });
  } catch (e) {
    console.error("[Patrol BG Task] update failed:", e);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  MODULE HELPERS
// ─────────────────────────────────────────────────────────────────────────────
async function getReliableLocation() {
  try {
    const last = await Location.getLastKnownPositionAsync({ maxAge: 120000, requiredAccuracy: 500 });
    if (last) return last;
  } catch (_) { }
  try {
    return await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 12000)),
    ]);
  } catch (_) { }
  return await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low });
}

async function getExpoPushToken() {
  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;
    if (existing !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== "granted") return null;
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;
    const tokenData = projectId
      ? await Notifications.getExpoPushTokenAsync({ projectId })
      : await Notifications.getExpoPushTokenAsync();
    return tokenData.data;
  } catch (e) {
    console.warn("[Patrol] push token error:", e);
    return null;
  }
}

// Haversine distance in km between two lat/lng points
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Decode Google encoded polyline
function decodePolyline(t) {
  let p = [], i = 0, lat = 0, lng = 0;
  while (i < t.length) {
    let b, s = 0, r = 0;
    do { b = t.charCodeAt(i++) - 63; r |= (b & 0x1f) << s; s += 5; } while (b >= 0x20);
    const dlat = r & 1 ? ~(r >> 1) : r >> 1; lat += dlat; s = 0; r = 0;
    do { b = t.charCodeAt(i++) - 63; r |= (b & 0x1f) << s; s += 5; } while (b >= 0x20);
    const dlng = r & 1 ? ~(r >> 1) : r >> 1; lng += dlng;
    p.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return p;
}

// Minimum distance (km) from a point to any segment of a polyline
function minDistToPolylineKm(lat, lng, polyline) {
  let min = Infinity;
  for (const pt of polyline) {
    const d = haversineKm(lat, lng, pt.latitude, pt.longitude);
    if (d < min) min = d;
  }
  return min;
}

const DARK_MAP_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#242f3e" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#746855" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#242f3e" }] },
  { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#d59563" }] },
  { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#d59563" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#263c3f" }] },
  { featureType: "poi.park", elementType: "labels.text.fill", stylers: [{ color: "#6b9a76" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#38414e" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#212a37" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#9ca5b3" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#746855" }] },
  { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#1f2835" }] },
  { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#f3d19c" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#2f3948" }] },
  { featureType: "transit.station", elementType: "labels.text.fill", stylers: [{ color: "#d59563" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#17263c" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#515c6d" }] },
  { featureType: "water", elementType: "labels.text.stroke", stylers: [{ color: "#17263c" }] },
];

// ─────────────────────────────────────────────────────────────────────────────
//  COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export default function PatrolVehicleScreen({ user: propUser, token: propToken, goBack }) {
  const auth = useContext(AuthContext);
  const user = propUser || auth?.user;
  const token = propToken || auth?.token;
  const logout = auth?.logout;
  const updateUser = auth?.updateUser;

  // ── Map Theme ──────────────────────────────────────────────────────────
  const [isDarkMap, setIsDarkMap] = useState(false);

  // ── Setup ──────────────────────────────────────────────────────────────
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [vehicleType, setVehicleType] = useState("patrol_car");
  const [patrolZone, setPatrolZone] = useState("");
  const [badgeNumber, setBadgeNumber] = useState(user?.badgeNumber || "");

  // ── Profile Page ────────────────────────────────────────────────────────
  const [showProfilePage, setShowProfilePage] = useState(false);
  const [editName, setEditName] = useState(user?.name || user?.username || "");
  const [editBadge, setEditBadge] = useState(user?.badgeNumber || badgeNumber || "");
  const [editMobile, setEditMobile] = useState(user?.mobile || "");
  const [editDept, setEditDept] = useState(user?.department || "Night Patrol");
  const [editStation, setEditStation] = useState(user?.station || "Main Station");
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => {
    if (user) {
      setEditName(user.name || user.username || "");
      if (user.badgeNumber) {
        setEditBadge(user.badgeNumber);
        setBadgeNumber(user.badgeNumber);
      }
      setEditMobile(user.mobile || "");
      setEditDept(user.department || "Night Patrol");
      setEditStation(user.station || "Main Station");
    }
  }, [user]);

  useEffect(() => {
    let isMounted = true;
    const activeToken = token || auth?.token;
    if (activeToken) {
      apiFetch("/api/auth/me", {}, activeToken)
        .then((me) => {
          if (isMounted && me) {
            if (me.badgeNumber) setBadgeNumber(me.badgeNumber);
            if (updateUser) updateUser(me);
          }
        })
        .catch((err) => console.warn("[Patrol] /api/auth/me fetch failed:", err.message));
    }
    return () => { isMounted = false; };
  }, [token, auth?.token]);

  const handleSaveProfile = async () => {
    if (!editName.trim() || !editBadge.trim()) {
      Alert.alert("Required Fields", "Officer Name and Badge Number are required.");
      return;
    }
    setSavingProfile(true);
    try {
      const activeToken = token || auth?.token;
      const res = await apiFetch("/api/auth/officer/update", {
        method: "PUT",
        body: {
          name: editName.trim(),
          badgeNumber: editBadge.trim(),
          mobile: editMobile.trim(),
          department: editDept.trim(),
          station: editStation.trim(),
        },
      }, activeToken);

      if (res?.user) {
        setBadgeNumber(res.user.badgeNumber);
        if (updateUser) updateUser(res.user);
        Alert.alert("Success ✅", "Officer profile updated successfully!");
        setShowProfilePage(false);
      }
    } catch (err) {
      Alert.alert("Update Failed", err.message || "Could not update officer profile.");
    } finally {
      setSavingProfile(false);
    }
  };

  const handleLogout = () => {
    Alert.alert("Log Out", "Are you sure you want to end shift and log out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Log Out",
        style: "destructive",
        onPress: async () => {
          if (isPatrolActive) {
            await doEndPatrol();
          }
          if (logout) {
            await logout();
          }
        },
      },
    ]);
  };

  // ── Trip ───────────────────────────────────────────────────────────────
  const [isPatrolActive, setIsPatrolActive] = useState(false);
  const [tripId, setTripId] = useState(null);
  const [currentLocation, setCurrentLocation] = useState(null);
  const [region, setRegion] = useState(null);
  const [breadcrumbs, setBreadcrumbs] = useState([]);
  const [currentSpeedKmh, setCurrentSpeedKmh] = useState(null);
  const currentLocationRef = useRef(null);
  const tripIdRef = useRef(null);

  // ── Dispatch alert ─────────────────────────────────────────────────────
  const [dispatchAlert, setDispatchAlert] = useState(null);
  const [showDispatchBanner, setShowDispatchBanner] = useState(false);
  const lastDispatchKeyRef = useRef(null);

  // ── Nearby active users (walk + cab within 5 km) ────────────────────────
  const [nearbyUsers, setNearbyUsers] = useState([]);
  const [selectedNearby, setSelectedNearby] = useState(null); // tapped marker callout

  // ── Assigned incident reports ────────────────────────────────────────────
  const [incidentAlerts, setIncidentAlerts] = useState([]); // all active assigned incidents
  const [activeIncident, setActiveIncident] = useState(null); // incident shown in banner
  const [showIncidentBanner, setShowIncidentBanner] = useState(false);
  const [incidentNavActive, setIncidentNavActive] = useState(false);
  const [incidentNavCoords, setIncidentNavCoords] = useState([]);
  const [incidentNavDist, setIncidentNavDist] = useState("");
  const [incidentNavEta, setIncidentNavEta] = useState("");
  const [incidentNavDest, setIncidentNavDest] = useState(null);
  const [resolvingIncidentId, setResolvingIncidentId] = useState(null); // ID being resolved (shows spinner)
  const [resolveToast, setResolveToast] = useState(false); // brief "Resolved ✓" flash
  const seenIncidentIdsRef = useRef(new Set()); // IDs already shown as banner
  const incidentNavActiveRef = useRef(false);
  const incidentNavRouteRef = useRef([]);
  const incidentNavDestRef = useRef(null);
  const lastIncidentRerouteRef = useRef(0);

  // ── In-app navigation to victim ─────────────────────────────────────────
  const [navActive, setNavActive] = useState(false);
  const [navRouteCoords, setNavRouteCoords] = useState([]);   // decoded polyline
  const [navDistanceText, setNavDistanceText] = useState("");   // e.g. "2.3 km"
  const [navDurationText, setNavDurationText] = useState("");   // e.g. "7 mins"
  const [navDestination, setNavDestination] = useState(null); // { lat, lng, name }
  const navActiveRef = useRef(false); // ref for stale-closure-safe read inside intervals
  const navRouteRef = useRef([]);     // ref copy so location update can read without re-render
  const lastRerouteRef = useRef(0);  // timestamp of last reroute to throttle

  const mapRef = useRef(null);
  const appStateRef = useRef(AppState.currentState);

  // ── AppState ────────────────────────────────────────────────────────────
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (appStateRef.current.match(/inactive|background/) && state === "active") {
        if (currentLocationRef.current && mapRef.current) {
          mapRef.current.animateToRegion(
            { ...currentLocationRef.current, latitudeDelta: 0.01, longitudeDelta: 0.01 },
            400
          );
        }
      }
      appStateRef.current = state;
    });
    return () => sub.remove();
  }, []);

  // ── Android back button ─────────────────────────────────────────────────
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (isPatrolActive) {
        Alert.alert("End Patrol?", "The patrol is still active. End it first.", [{ text: "OK" }]);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [isPatrolActive]);

  // ── Foreground location → backend every 5 s ─────────────────────────────
  useEffect(() => {
    if (!isPatrolActive || !tripId) return;
    const interval = setInterval(async () => {
      try {
        const loc = await getReliableLocation();
        const { latitude, longitude, speed } = loc.coords;
        setCurrentLocation({ latitude, longitude });
        currentLocationRef.current = { latitude, longitude };
        setBreadcrumbs((prev) => [...prev, { latitude, longitude }]);
        if (speed != null && speed >= 0) setCurrentSpeedKmh(Math.round(speed * 3.6));
        mapRef.current?.animateToRegion(
          { latitude, longitude, latitudeDelta: 0.008, longitudeDelta: 0.008 },
          300
        );
        await rawFetchWithSecurity(`${BACKEND_URL}/api/patrol/update-location`, {
          method: "POST",
          body: { tripId, latitude, longitude },
        });

        // Fire-and-forget socket push for real-time dashboard tracking.
        // Kept on the same fixed LOCATION_UPDATE_INTERVAL cadence (not the
        // server mode-driven interval) because this tick also drives the
        // reroute/ETA logic below, which is throttled independently.
        emitLocationUpdate({ lat: latitude, lng: longitude, type: "patrol" });

        // ── Reroute check while in-app navigation is active ──────────────
        if (navActiveRef.current && navDestination) {
          const now = Date.now();
          // Throttle reroutes to max once every 15 s
          if (now - lastRerouteRef.current > 15000) {
            // Check if officer is more than 80 m off the current route
            const route = navRouteRef.current;
            if (route.length > 0) {
              const offDist = minDistToPolylineKm(latitude, longitude, route);
              if (offDist > 0.08) { // 80 m threshold
                lastRerouteRef.current = now;
                const result = await fetchDrivingRoute(
                  latitude, longitude,
                  navDestination.lat, navDestination.lng
                );
                if (result) {
                  setNavRouteCoords(result.coords);
                  navRouteRef.current = result.coords;
                  setNavDistanceText(result.distanceText);
                  setNavDurationText(result.durationText);
                }
              } else {
                // Update live distance/ETA even without reroute
                const distKm = haversineKm(latitude, longitude, navDestination.lat, navDestination.lng);
                if (distKm < 0.05) {
                  // Arrived — auto-stop navigation
                  stopNavigation();
                }
              }
            }
          }
        }

        // ── Reroute check for incident navigation ────────────────────────
        if (incidentNavActiveRef.current && incidentNavDestRef.current) {
          const now = Date.now();
          if (now - lastIncidentRerouteRef.current > 15000) {
            const route = incidentNavRouteRef.current;
            if (route.length > 0) {
              const offDist = minDistToPolylineKm(latitude, longitude, route);
              if (offDist > 0.08) {
                lastIncidentRerouteRef.current = now;
                const dest = incidentNavDestRef.current;
                const result = await fetchDrivingRoute(latitude, longitude, dest.lat, dest.lng);
                if (result) {
                  setIncidentNavCoords(result.coords);
                  incidentNavRouteRef.current = result.coords;
                  setIncidentNavDist(result.distanceText);
                  setIncidentNavEta(result.durationText);
                }
              } else {
                const distKm = haversineKm(latitude, longitude, incidentNavDestRef.current.lat, incidentNavDestRef.current.lng);
                if (distKm < 0.05) stopIncidentNavigation();
              }
            }
          }
        }
      } catch (err) {
        console.error("[Patrol] location update error:", err);
      }
    }, LOCATION_UPDATE_INTERVAL);
    return () => clearInterval(interval);
  }, [isPatrolActive, tripId]);

  // ── Poll backend for dispatched alert every 5 s ─────────────────────────
  // NOTE: kept as the PRIMARY path. The backend defines
  // emitPatrolDispatchUpdate() in socket/socketManager.js but does not yet
  // call it from anywhere (checked: no call sites in routes/ or services/
  // as of the current safety-backend). Do not remove this poll until that
  // is wired up server-side, or dispatch alerts will silently stop.
  const handleDispatchPayload = useRef(async (d) => {
    if (!d || d.acknowledged) return;
    const key = String(d.dispatchedAt);
    if (lastDispatchKeyRef.current === key) return;
    lastDispatchKeyRef.current = key;
    setDispatchAlert({
      lat: d.latitude,
      lng: d.longitude,
      userName: d.userName,
      alertType: d.alertType,
    });
    setShowDispatchBanner(true);
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "📨 Mission Dispatched",
        body: `Victim: ${d.userName || "Unknown"} — Tap to navigate`,
        sound: true,
        data: { type: "DISPATCH_ALERT", lat: d.latitude, lng: d.longitude, userName: d.userName, alertType: d.alertType },
      },
      trigger: null,
    });
  }).current;

  useEffect(() => {
    if (!isPatrolActive) return;
    const interval = setInterval(async () => {
      try {
        const id = tripIdRef.current;
        if (!id) return;
        const res = await rawFetchWithSecurity(`${BACKEND_URL}/api/patrol/pending-dispatch/${id}`, { method: "GET" });
        const data = await res.json();
        if (!data?.success || !data.dispatch) return;
        await handleDispatchPayload(data.dispatch);
      } catch (pollErr) {
        console.warn("[Patrol] dispatch poll error:", pollErr);
      }
    }, DISPATCH_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [isPatrolActive]);

  // ── Socket subscription — SECONDARY / forward-compatible path.
  // Starts receiving events automatically once the backend wires
  // emitPatrolDispatchUpdate() into the actual dispatch-creation flow;
  // no further app changes needed at that point. Runs harmlessly
  // alongside the REST poll above (handleDispatchPayload dedupes on
  // dispatchedAt either way).
  useEffect(() => {
    if (!isPatrolActive || !tripId) return;
    const unsubscribe = subscribePatrolDispatch(tripId, (dispatch) => {
      handleDispatchPayload(dispatch).catch((err) =>
        console.warn("[Patrol] socket dispatch handling error:", err)
      );
    });
    return unsubscribe;
  }, [isPatrolActive, tripId]);

  // ── Fetch nearby active walk + cab users every 10 s ───────────────────────
  useEffect(() => {
    if (!isPatrolActive) return;
    const fetchNearby = async () => {
      const myLoc = currentLocationRef.current;
      if (!myLoc) return;
      try {
        const [walkRes, cabRes] = await Promise.all([
          rawFetchWithSecurity(`${BACKEND_URL}/api/walk/active`, { method: "GET" }),
          rawFetchWithSecurity(`${BACKEND_URL}/api/cab-escort/active`, { method: "GET" }),
        ]);
        const walkData = await walkRes.json();
        const cabData = await cabRes.json();

        const walkSessions = Array.isArray(walkData) ? walkData : [];
        const cabTrips = cabData?.trips || [];

        const nearby = [];

        // Walk users — location is startLocation
        for (const s of walkSessions) {
          const lat = s.startLocation?.latitude;
          const lng = s.startLocation?.longitude;
          if (lat == null || lng == null) continue;
          const dist = haversineKm(myLoc.latitude, myLoc.longitude, lat, lng);
          if (dist <= NEARBY_RADIUS_KM) {
            nearby.push({
              id: s._id,
              type: "walk",
              username: s.username || s.userId || "Unknown",
              lat,
              lng,
              dist: dist.toFixed(2),
            });
          }
        }

        // Cab users — location is currentLocation
        for (const t of cabTrips) {
          const lat = t.currentLocation?.latitude;
          const lng = t.currentLocation?.longitude;
          if (lat == null || lng == null) continue;
          const dist = haversineKm(myLoc.latitude, myLoc.longitude, lat, lng);
          if (dist <= NEARBY_RADIUS_KM) {
            nearby.push({
              id: t._id,
              type: "cab",
              username: t.username || t.userId || "Unknown",
              lat,
              lng,
              dist: dist.toFixed(2),
            });
          }
        }

        setNearbyUsers(nearby);
      } catch (e) {
        console.warn("[Patrol] nearby users fetch error:", e);
      }
    };

    fetchNearby(); // run immediately on patrol start
    const interval = setInterval(fetchNearby, NEARBY_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [isPatrolActive]);

  // ── Poll assigned incident reports every 5 s ────────────────────────────
  // NOTE: kept as the PRIMARY path, same reasoning as the dispatch poll
  // above — emitIncidentReportsUpdate() exists in socketManager.js but is
  // not called anywhere in the current backend, so the socket path below
  // is forward-compatible only until that's wired up server-side.
  const handleIncidentReports = useRef(async (reports = []) => {
    setIncidentAlerts(reports);

    // Show banner for any NEW pending incident not yet seen
    for (const report of reports) {
      if (report.status !== "pending") continue;
      const rid = String(report._id);
      if (seenIncidentIdsRef.current.has(rid)) continue;
      seenIncidentIdsRef.current.add(rid);

      setActiveIncident(report);
      setShowIncidentBanner(true);

      await Notifications.scheduleNotificationAsync({
        content: {
          title: `🚨 Incident — ${report.category}`,
          body: `${report.crowdSize} · ${report.behaviorIndicators?.[0] || "reported"} · Tap to view`,
          sound: true,
          data: {
            type: "INCIDENT_REPORT",
            reportId: rid,
            latitude: report.location?.latitude,
            longitude: report.location?.longitude,
            category: report.category,
            crowdSize: report.crowdSize,
            behaviorIndicators: report.behaviorIndicators,
            note: report.note,
            username: report.username,
          },
        },
        trigger: null,
      });
      break; // one banner at a time; next update shows the next
    }
  }).current;

  useEffect(() => {
    if (!isPatrolActive) return;

    const fetchAssignedIncidents = async () => {
      const id = tripIdRef.current;
      if (!id) return;
      try {
        const res = await rawFetchWithSecurity(`${BACKEND_URL}/api/incident/assigned/${id}`, { method: "GET" });
        const data = await res.json();
        if (!data?.success) return;
        await handleIncidentReports(data.reports || []);
      } catch (e) {
        console.warn("[Patrol] incident poll error:", e);
      }
    };

    fetchAssignedIncidents();
    const interval = setInterval(fetchAssignedIncidents, INCIDENT_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [isPatrolActive]);

  // ── Socket subscription — SECONDARY / forward-compatible path ──────────
  useEffect(() => {
    if (!isPatrolActive || !tripId) return;
    const unsubscribe = subscribeIncidentReports(tripId, (reports) => {
      handleIncidentReports(reports).catch((err) =>
        console.warn("[Patrol] socket incident handling error:", err)
      );
    });
    return unsubscribe;
  }, [isPatrolActive, tripId]);

  // ── Notification tap (killed / background) ─────────────────────────────
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const d = response.notification.request.content.data;
      if (d?.type === "DISPATCH_ALERT" && d.lat != null) {
        setDispatchAlert({ lat: d.lat, lng: d.lng, userName: d.userName, alertType: d.alertType });
        setShowDispatchBanner(true);
      }
      // Tap on incident push → restore banner
      if (d?.type === "INCIDENT_REPORT" && d.reportId) {
        setIncidentAlerts((prev) => {
          const match = prev.find((r) => String(r._id) === d.reportId);
          if (match) { setActiveIncident(match); setShowIncidentBanner(true); }
          return prev;
        });
      }
    });
    return () => sub.remove();
  }, []);

  // ────────────────────────────────────────────────────────────────────────
  //  START PATROL
  // ────────────────────────────────────────────────────────────────────────
  const handleStartPatrol = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission Denied", "Location permission is required to start patrol.");
        return;
      }
    } catch (e) {
      console.warn("[Patrol] Permission request warning:", e);
    }

    try {
      try {
        const providerStatus = await Location.getProviderStatusAsync().catch(() => null);
        if (providerStatus && !providerStatus.locationServicesEnabled && !providerStatus.gpsAvailable && !providerStatus.networkAvailable) {
          console.warn("[Patrol] Location provider status reported inactive, proceeding with GPS location query...");
        }
      } catch (_) { }

      const loc = await getReliableLocation();
      const { latitude, longitude } = loc.coords;
      const current = { latitude, longitude };
      setCurrentLocation(current);
      currentLocationRef.current = current;
      setRegion({ latitude, longitude, latitudeDelta: 0.01, longitudeDelta: 0.01 });
      setBreadcrumbs([current]);

      const expoPushToken = await getExpoPushToken();
      const finalBadge = badgeNumber?.trim() || user?.badgeNumber || "PB-101";
      const finalVehicle = vehicleNumber?.trim() || "PATROL-01";

      const res = await rawFetchWithSecurity(`${BACKEND_URL}/api/patrol/start`, {
        method: "POST",
        body: {
          officerId: user?.id || user?._id,
          officerName: user?.name || user?.username || "Patrol Officer",
          badgeNumber: finalBadge,
          vehicleNumber: finalVehicle,
          vehicleType: vehicleType || "patrol_car",
          patrolZone: patrolZone || "Zone Alpha",
          currentLocation: current,
          expoPushToken: expoPushToken || null,
        },
      });
      const data = await res.json();
      if (!data?.success) throw new Error(data?.error || data?.message || "Backend failed to start patrol.");

      const newTripId = data.trip._id;
      setTripId(newTripId);
      tripIdRef.current = newTripId;
      await AsyncStorage.setItem("PATROL_TRIP_ID", newTripId);
      setIsPatrolActive(true);

      try {
        await Location.requestBackgroundPermissionsAsync().catch(() => { });
        await Location.startLocationUpdatesAsync(PATROL_BG_TASK, {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: LOCATION_UPDATE_INTERVAL,
          distanceInterval: 10,
          showsBackgroundLocationIndicator: true,
          foregroundService: {
            notificationTitle: "🚔 Patrol Active",
            notificationBody: "Live location is being tracked.",
            notificationColor: "#13ec49",
          },
        }).catch((bgErr) => {
          console.warn("[Patrol] Background location update skipped in Expo Go:", bgErr.message);
        });
      } catch (bgErr) {
        console.warn("[Patrol] Background location error:", bgErr.message);
      }

    } catch (err) {
      console.error("[Patrol] start error:", err);
      if (err instanceof AuthError || err.message === "Unauthorized") {
        Alert.alert("Session Expired", "Your session has expired. Please sign in again.", [
          { text: "Sign In", onPress: () => logout && logout() }
        ]);
      } else {
        Alert.alert("Error", err.message || "Unable to start patrol.");
      }
    }
  };

  // ────────────────────────────────────────────────────────────────────────
  //  END PATROL
  // ────────────────────────────────────────────────────────────────────────
  const handleEndPatrol = () => {
    Alert.alert("End Patrol?", "Are you sure you want to end this patrol session?", [
      { text: "Cancel", style: "cancel" },
      { text: "Yes, End Patrol", style: "destructive", onPress: doEndPatrol },
    ]);
  };

  const doEndPatrol = async () => {
    try {
      const id = tripIdRef.current || tripId;
      if (id) {
        await rawFetchWithSecurity(`${BACKEND_URL}/api/patrol/complete/${id}`, {
          method: "POST",
        });
      }
      const isRegistered = await TaskManager.isTaskRegisteredAsync(PATROL_BG_TASK);
      if (isRegistered) await Location.stopLocationUpdatesAsync(PATROL_BG_TASK);
      await AsyncStorage.removeItem("PATROL_TRIP_ID");
    } catch (err) {
      console.error("[Patrol] end error:", err);
    } finally {
      setIsPatrolActive(false);
      setTripId(null);
      tripIdRef.current = null;
      setCurrentLocation(null);
      setBreadcrumbs([]);
      setCurrentSpeedKmh(null);
      setDispatchAlert(null);
      setShowDispatchBanner(false);
      lastDispatchKeyRef.current = null;
      setNearbyUsers([]);
      setSelectedNearby(null);
      setNavActive(false);
      setNavRouteCoords([]);
      navRouteRef.current = [];
      setNavDestination(null);
      // incident cleanup
      setIncidentAlerts([]);
      setActiveIncident(null);
      setShowIncidentBanner(false);
      setIncidentNavActive(false);
      setIncidentNavCoords([]);
      incidentNavRouteRef.current = [];
      setIncidentNavDest(null);
      incidentNavDestRef.current = null;
      incidentNavActiveRef.current = false;
      seenIncidentIdsRef.current = new Set();
      setResolvingIncidentId(null);
      setResolveToast(false);
    }
  };

  // ────────────────────────────────────────────────────────────────────────
  //  FETCH DRIVING ROUTE (Google Directions API)
  // ────────────────────────────────────────────────────────────────────────
  const fetchDrivingRoute = async (fromLat, fromLng, toLat, toLng) => {
    try {
      const url =
        `https://maps.googleapis.com/maps/api/directions/json` +
        `?origin=${fromLat},${fromLng}` +
        `&destination=${toLat},${toLng}` +
        `&mode=driving&key=${API_KEY}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.status !== "OK" || !data.routes?.length) {
        console.warn("[Nav] Directions API:", data.status);
        return null;
      }
      const route = data.routes[0];
      const leg = route.legs[0];
      const coords = decodePolyline(route.overview_polyline.points);
      return {
        coords,
        distanceText: leg.distance.text,
        durationText: leg.duration.text,
      };
    } catch (e) {
      console.error("[Nav] fetchDrivingRoute error:", e);
      return null;
    }
  };

  // ────────────────────────────────────────────────────────────────────────
  //  NAVIGATE TO VICTIM — start in-app navigation
  // ────────────────────────────────────────────────────────────────────────
  const navigateToVictim = async () => {
    if (!dispatchAlert) return;
    const { lat, lng, userName } = dispatchAlert;

    // Acknowledge on backend so this dispatch won't re-trigger
    try {
      const id = tripIdRef.current || tripId;
      if (id) {
        await rawFetchWithSecurity(`${BACKEND_URL}/api/patrol/dispatch/acknowledge/${id}`, {
          method: "POST",
        });
      }
    } catch (_) { }

    setShowDispatchBanner(false);

    // Fetch route from current officer position to victim
    const origin = currentLocationRef.current;
    if (!origin) return;

    const result = await fetchDrivingRoute(origin.latitude, origin.longitude, lat, lng);
    if (result) {
      setNavRouteCoords(result.coords);
      navRouteRef.current = result.coords;
      setNavDistanceText(result.distanceText);
      setNavDurationText(result.durationText);
    }
    setNavDestination({ lat, lng, name: userName || "Victim" });
    navActiveRef.current = true;
    setNavActive(true);

    // Zoom map to show full route
    if (mapRef.current && result?.coords?.length) {
      const lats = result.coords.map(p => p.latitude);
      const lngs = result.coords.map(p => p.longitude);
      mapRef.current.fitToCoordinates(result.coords, {
        edgePadding: { top: 120, right: 40, bottom: 160, left: 40 },
        animated: true,
      });
    }
  };

  // ────────────────────────────────────────────────────────────────────────
  //  STOP IN-APP NAVIGATION
  // ────────────────────────────────────────────────────────────────────────
  const stopNavigation = () => {
    navActiveRef.current = false;
    setNavActive(false);
    setNavRouteCoords([]);
    navRouteRef.current = [];
    setNavDistanceText("");
    setNavDurationText("");
    setNavDestination(null);
  };

  // ────────────────────────────────────────────────────────────────────────
  //  NAVIGATE TO INCIDENT LOCATION
  // ────────────────────────────────────────────────────────────────────────
  const navigateToIncident = async (report) => {
    if (!report?.location) return;
    const { latitude: toLat, longitude: toLng } = report.location;
    const origin = currentLocationRef.current;
    if (!origin) return;

    // Acknowledge the incident so it stops pulsing as new
    try {
      const id = tripIdRef.current || tripId;
      if (id) {
        await rawFetchWithSecurity(`${BACKEND_URL}/api/incident/acknowledge/${report._id}`, {
          method: "POST",
          body: JSON.stringify({ status: "acknowledged" }),
        });
        setIncidentAlerts((prev) =>
          prev.map((r) => String(r._id) === String(report._id) ? { ...r, status: "acknowledged" } : r)
        );
      }
    } catch (_) { }

    setShowIncidentBanner(false);

    const result = await fetchDrivingRoute(origin.latitude, origin.longitude, toLat, toLng);
    if (result) {
      setIncidentNavCoords(result.coords);
      incidentNavRouteRef.current = result.coords;
      setIncidentNavDist(result.distanceText);
      setIncidentNavEta(result.durationText);
    }

    const dest = { lat: toLat, lng: toLng, name: report.category, _id: String(report._id) };
    setIncidentNavDest(dest);
    incidentNavDestRef.current = dest;
    incidentNavActiveRef.current = true;
    setIncidentNavActive(true);

    if (mapRef.current && result?.coords?.length) {
      mapRef.current.fitToCoordinates(result.coords, {
        edgePadding: { top: 120, right: 40, bottom: 200, left: 40 },
        animated: true,
      });
    }
  };

  // ────────────────────────────────────────────────────────────────────────
  //  STOP INCIDENT NAVIGATION
  // ────────────────────────────────────────────────────────────────────────
  const stopIncidentNavigation = () => {
    incidentNavActiveRef.current = false;
    incidentNavDestRef.current = null;
    setIncidentNavActive(false);
    setIncidentNavCoords([]);
    incidentNavRouteRef.current = [];
    setIncidentNavDist("");
    setIncidentNavEta("");
    setIncidentNavDest(null);
  };

  // ────────────────────────────────────────────────────────────────────────
  //  RESOLVE INCIDENT — mark as resolved on backend, stop nav, show toast
  // ────────────────────────────────────────────────────────────────────────
  const resolveIncident = async (reportId) => {
    if (!reportId || resolvingIncidentId) return;
    setResolvingIncidentId(reportId);
    try {
      await rawFetchWithSecurity(`${BACKEND_URL}/api/incident/acknowledge/${reportId}`, {
        method: "POST",
        body: JSON.stringify({ status: "resolved" }),
      });

      // Remove from local list immediately
      setIncidentAlerts((prev) => prev.filter((r) => String(r._id) !== String(reportId)));

      // Stop navigation if this was the destination
      if (
        incidentNavDestRef.current &&
        String(incidentNavDest?._id) === String(reportId)
      ) {
        stopIncidentNavigation();
      }

      // Hide banner if it was showing this report
      if (String(activeIncident?._id) === String(reportId)) {
        setShowIncidentBanner(false);
        setActiveIncident(null);
      }

      // Flash success toast for 2.5 s
      setResolveToast(true);
      setTimeout(() => setResolveToast(false), 2500);

    } catch (err) {
      console.error("[Patrol] resolve incident error:", err);
      Alert.alert("Error", "Could not resolve the incident. Please try again.");
    } finally {
      setResolvingIncidentId(null);
    }
  };

  // ────────────────────────────────────────────────────────────────────────
  //  RENDER — INCIDENT ALERT BANNER
  // ────────────────────────────────────────────────────────────────────────
  const renderIncidentBanner = () => {
    if (!showIncidentBanner || !activeIncident) return null;
    const cat = INCIDENT_CAT_META[activeIncident.category] || { emoji: "🚨", color: "#ef4444", bg: "rgba(239,68,68,0.12)" };
    const lat = activeIncident.location?.latitude;
    const lng = activeIncident.location?.longitude;
    const origin = currentLocationRef.current;
    const distKm = (origin && lat != null)
      ? haversineKm(origin.latitude, origin.longitude, lat, lng)
      : null;
    const distStr = distKm != null
      ? distKm < 1 ? `${Math.round(distKm * 1000)} m away` : `${distKm.toFixed(1)} km away`
      : null;

    return (
      <View style={styles.incidentOverlay}>
        <View style={[styles.incidentCard, { borderColor: cat.color + "80" }]}>

          {/* Header row */}
          <View style={styles.incidentBannerHeader}>
            <View style={[styles.incidentLivePill, { backgroundColor: cat.bg, borderColor: cat.color + "50" }]}>
              <View style={[styles.incidentLiveDot, { backgroundColor: cat.color }]} />
              <Text style={[styles.incidentLiveText, { color: cat.color }]}>INCIDENT ASSIGNED</Text>
            </View>
            <TouchableOpacity style={styles.incidentCloseBtn} onPress={() => setShowIncidentBanner(false)}>
              <Text style={styles.incidentCloseTxt}>✕</Text>
            </TouchableOpacity>
          </View>

          {/* Category + emoji */}
          <View style={styles.incidentTitleRow}>
            <Text style={styles.incidentEmoji}>{cat.emoji}</Text>
            <View style={{ flex: 1 }}>
              <Text style={[styles.incidentCategoryText, { color: cat.color }]}>
                {activeIncident.category}
              </Text>
              {distStr && <Text style={styles.incidentDistText}>📍 {distStr}</Text>}
            </View>
            {/* pending count badge if more queued */}
            {incidentAlerts.filter(r => r.status === "pending" && String(r._id) !== String(activeIncident._id)).length > 0 && (
              <View style={styles.incidentQueueBadge}>
                <Text style={styles.incidentQueueText}>
                  +{incidentAlerts.filter(r => r.status === "pending" && String(r._id) !== String(activeIncident._id)).length} more
                </Text>
              </View>
            )}
          </View>

          {/* Detail box */}
          <View style={styles.incidentDetailBox}>
            <IncidentDetailRow label="REPORTER" value={activeIncident.username || "Citizen"} />
            <View style={styles.incidentDivider} />
            <IncidentDetailRow label="CROWD" value={activeIncident.crowdSize} />
            <View style={styles.incidentDivider} />
            <IncidentDetailRow
              label="INDICATORS"
              value={(activeIncident.behaviorIndicators || []).join(", ") || "—"}
            />
            {activeIncident.note ? (
              <>
                <View style={styles.incidentDivider} />
                <IncidentDetailRow label="NOTE" value={activeIncident.note} />
              </>
            ) : null}
            {lat != null && (
              <>
                <View style={styles.incidentDivider} />
                <IncidentDetailRow
                  label="COORDS"
                  value={`${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`}
                  mono
                />
              </>
            )}
          </View>

          {/* Action buttons */}
          <TouchableOpacity
            style={[styles.incidentNavBtn, { backgroundColor: cat.color }]}
            onPress={() => navigateToIncident(activeIncident)}
            activeOpacity={0.85}
          >
            <Text style={styles.incidentNavBtnText}>🗺️  Navigate to Incident</Text>
          </TouchableOpacity>

          {/* Resolve directly from banner — officer already on scene */}
          <TouchableOpacity
            style={[
              styles.incidentResolveBannerBtn,
              resolvingIncidentId === String(activeIncident._id) && { opacity: 0.55 },
            ]}
            onPress={() => resolveIncident(String(activeIncident._id))}
            disabled={!!resolvingIncidentId}
            activeOpacity={0.8}
          >
            <Text style={styles.incidentResolveBannerIcon}>
              {resolvingIncidentId === String(activeIncident._id) ? "…" : "✓"}
            </Text>
            <Text style={styles.incidentResolveBannerText}>Mark as Resolved</Text>
          </TouchableOpacity>

          <Text style={styles.incidentFooterNote}>
            Citizen report · Assigned by system based on proximity
          </Text>
        </View>
      </View>
    );
  };

  // ────────────────────────────────────────────────────────────────────────
  //  RENDER — DISPATCH BANNER
  // ────────────────────────────────────────────────────────────────────────
  const renderDispatchBanner = () => {
    if (!showDispatchBanner || !dispatchAlert) return null;
    const typeLabel =
      dispatchAlert.alertType === "cab" ? "🚖 Cab Alert" :
        dispatchAlert.alertType === "walk" ? "🚶 Walk Panic" :
          dispatchAlert.alertType === "highrisk" ? "🚨 High Risk Alert" : "🆘 Emergency Alert";

    return (
      <View style={styles.dispatchOverlay}>
        <View style={styles.dispatchCard}>

          {/* Top row */}
          <View style={styles.dispatchHeader}>
            <View style={styles.dispatchLivePill}>
              <View style={styles.dispatchLiveDot} />
              <Text style={styles.dispatchLiveText}>DISPATCHED</Text>
            </View>
            <TouchableOpacity
              style={styles.dispatchCloseBtn}
              onPress={() => setShowDispatchBanner(false)}
            >
              <Text style={styles.dispatchCloseTxt}>✕</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.dispatchTitle}>📨 Mission Assigned</Text>
          <Text style={styles.dispatchSubtitle}>{typeLabel}</Text>

          {/* Info box */}
          <View style={styles.dispatchInfoBox}>
            <View style={styles.dispatchInfoRow}>
              <Text style={styles.dispatchInfoLabel}>VICTIM</Text>
              <Text style={styles.dispatchInfoValue} numberOfLines={1}>
                {dispatchAlert.userName || "Unknown"}
              </Text>
            </View>
            <View style={styles.dispatchDivider} />
            <View style={styles.dispatchInfoRow}>
              <Text style={styles.dispatchInfoLabel}>LOCATION</Text>
              <Text style={styles.dispatchInfoCoords}>
                {Number(dispatchAlert.lat).toFixed(5)}, {Number(dispatchAlert.lng).toFixed(5)}
              </Text>
            </View>
          </View>

          {/* Navigate CTA */}
          <TouchableOpacity
            style={styles.dispatchNavBtn}
            onPress={navigateToVictim}
            activeOpacity={0.85}
          >
            <Text style={styles.dispatchNavBtnText}>🗺️  Navigate to Victim</Text>
          </TouchableOpacity>

          <Text style={styles.dispatchFooterNote}>
            Forwarded by Ground Station Authority
          </Text>
        </View>
      </View>
    );
  };

  // ────────────────────────────────────────────────────────────────────────
  //  RENDER — SETUP SCREEN
  // ────────────────────────────────────────────────────────────────────────
  const renderSetupScreen = () => (
    <View style={styles.setupRoot}>
      <StatusBar barStyle="light-content" backgroundColor="#0b1329" />

      <View style={styles.setupHeader}>
        {goBack ? (
          <TouchableOpacity onPress={goBack} style={styles.backBtn}>
            <Text style={styles.backArrow}>←</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.shieldBadge}>
            <Text style={styles.shieldIcon}>🚔</Text>
          </View>
        )}

        <View style={styles.headerTitleWrap}>
          <Text style={styles.setupHeaderTitle}>PATROL OFFICER APP</Text>
          <Text style={styles.setupHeaderSubtitle}>
            👮 {user?.name || user?.username || "Officer"} ({user?.badgeNumber || badgeNumber || "PB-101"})
          </Text>
        </View>

        <TouchableOpacity
          style={styles.personIconButton}
          onPress={() => setShowProfilePage(true)}
          activeOpacity={0.8}
        >
          <Text style={styles.personIconText}>👤</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.setupContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >

        <Text style={styles.fieldLabel}>BADGE / OFFICER ID <Text style={styles.optional}>(Optional)</Text></Text>
        <View style={styles.inputCard}>
          <TextInput
            style={styles.fieldInput}
            placeholder="e.g. HYD-2247"
            placeholderTextColor="#64748b"
            value={badgeNumber}
            onChangeText={setBadgeNumber}
            autoCapitalize="characters"
          />
          <Text style={styles.inputIcon}>🪪</Text>
        </View>

        <Text style={styles.fieldLabel}>VEHICLE NUMBER <Text style={styles.optional}>(Optional)</Text></Text>
        <View style={styles.inputCard}>
          <TextInput
            style={styles.fieldInput}
            placeholder="e.g. TS09PA1234"
            placeholderTextColor="#64748b"
            value={vehicleNumber}
            onChangeText={setVehicleNumber}
            autoCapitalize="characters"
          />
          <Text style={styles.inputIcon}>🚗</Text>
        </View>

        <Text style={styles.fieldLabel}>PATROL ZONE <Text style={styles.optional}>(Optional)</Text></Text>
        <View style={styles.inputCard}>
          <TextInput
            style={styles.fieldInput}
            placeholder="e.g. Sector 4 / Banjara Hills"
            placeholderTextColor="#64748b"
            value={patrolZone}
            onChangeText={setPatrolZone}
          />
          <Text style={styles.inputIcon}>📍</Text>
        </View>

        <Text style={styles.fieldLabel}>VEHICLE TYPE</Text>
        <View style={styles.vehicleRow}>
          {[
            { key: "patrol_car", emoji: "🚔", label: "PATROL CAR" },
            { key: "motorcycle", emoji: "🏍️", label: "MOTORCYCLE" },
          ].map(({ key, emoji, label }) => (
            <TouchableOpacity
              key={key}
              style={[styles.vehicleCard, vehicleType === key && styles.vehicleCardActive]}
              onPress={() => setVehicleType(key)}
            >
              <Text style={styles.vehicleEmoji}>{emoji}</Text>
              <Text style={[styles.vehicleLabel, vehicleType === key && styles.vehicleLabelActive]}>
                {label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={{ height: 140 }} />
      </ScrollView>

      <View style={styles.setupFooter}>
        <TouchableOpacity style={styles.startTripBtn} onPress={handleStartPatrol} activeOpacity={0.88}>
          <Text style={styles.startTripIcon}>▶</Text>
          <Text style={styles.startTripText}>START PATROL</Text>
        </TouchableOpacity>
        <Text style={styles.setupFooterNote}>
          Your live location will be shared with Command Control Room continuously.
        </Text>
      </View>
    </View>
  );

  // ────────────────────────────────────────────────────────────────────────
  //  RENDER — ACTIVE PATROL SCREEN
  // ────────────────────────────────────────────────────────────────────────
  const renderPatrolScreen = () => (
    <View style={styles.trackingRoot}>
      <StatusBar barStyle="light-content" backgroundColor="#0b1329" />

      {/* Floating top header card */}
      <View style={styles.trackingTopCard}>
        <View style={{ flex: 1 }}>
          <Text style={styles.trackingVehicle}>
            {vehicleNumber || vehicleType.replace("_", " ").toUpperCase()}
          </Text>
          <View style={styles.monitoringRow}>
            <View style={styles.monitoringDot} />
            <Text style={styles.monitoringLabel}>ACTIVE PATROL</Text>
          </View>
          {patrolZone ? (
            <Text style={styles.patrolZoneTag}>📍 {patrolZone}</Text>
          ) : null}
        </View>
        {/* Nearby users count badge */}
        {nearbyUsers.length > 0 && (
          <View style={styles.nearbyCountBadge}>
            <Text style={styles.nearbyCountNumber}>{nearbyUsers.length}</Text>
            <Text style={styles.nearbyCountLabel}>NEARBY</Text>
          </View>
        )}
        <View style={styles.etaBadge}>
          <Text style={styles.etaLabel}>SPEED</Text>
          <Text style={styles.etaValue}>
            {currentSpeedKmh != null ? `${currentSpeedKmh}` : "--"}
          </Text>
          <Text style={styles.etaUnit}>km/h</Text>
        </View>

        <TouchableOpacity
          style={[styles.personIconButton, { marginLeft: 8 }]}
          onPress={() => setShowProfilePage(true)}
          activeOpacity={0.8}
        >
          <Text style={styles.personIconText}>👤</Text>
        </TouchableOpacity>
      </View>

      {/* Full-screen map */}
      <View style={styles.trackingMapWrap}>
        {region && (
          <MapView
            ref={mapRef}
            style={StyleSheet.absoluteFillObject}
            initialRegion={region}
            customMapStyle={isDarkMap ? DARK_MAP_STYLE : []}
          >
            {currentLocation && (
              <Marker coordinate={currentLocation} anchor={{ x: 0.5, y: 0.5 }}>
                <View style={styles.vehicleMarkerWrap}>
                  <View style={styles.vehicleMarker}>
                    <Text style={{ fontSize: 20 }}>
                      {vehicleType === "motorcycle" ? "🏍️" : vehicleType === "van" ? "🚐" : "🚔"}
                    </Text>
                  </View>
                  <View style={styles.vehicleSafeBadge}>
                    <View style={styles.vehicleSafeDot} />
                    <Text style={styles.vehicleSafeText}>SAFE</Text>
                  </View>
                </View>
              </Marker>
            )}

            {/* Victim marker visible on map once dispatched */}
            {dispatchAlert && (
              <Marker
                coordinate={{ latitude: dispatchAlert.lat, longitude: dispatchAlert.lng }}
                anchor={{ x: 0.5, y: 0.5 }}
              >
                <View style={styles.victimMarker}>
                  <Text style={{ fontSize: 20 }}>🆘</Text>
                </View>
              </Marker>
            )}

            {/* Nearby active users within 5 km */}
            {nearbyUsers.map((u) => (
              <Marker
                key={u.id}
                coordinate={{ latitude: u.lat, longitude: u.lng }}
                anchor={{ x: 0.5, y: 0.5 }}
                onPress={() => setSelectedNearby(selectedNearby?.id === u.id ? null : u)}
              >
                <View style={[
                  styles.nearbyMarker,
                  u.type === "cab" ? styles.nearbyMarkerCab : styles.nearbyMarkerWalk,
                  selectedNearby?.id === u.id && styles.nearbyMarkerSelected,
                ]}>
                  <Text style={{ fontSize: 16 }}>{u.type === "cab" ? "🚖" : "🚶"}</Text>
                </View>
              </Marker>
            ))}

            {breadcrumbs.length > 1 && (
              <Polyline
                coordinates={breadcrumbs}
                strokeWidth={4}
                strokeColor="rgba(19, 236, 73, 0.6)"
              />
            )}

            {/* In-app navigation route to victim */}
            {navActive && navRouteCoords.length > 1 && (
              <>
                {/* Shadow layer */}
                <Polyline
                  coordinates={navRouteCoords}
                  strokeWidth={8}
                  strokeColor="rgba(59,130,246,0.25)"
                />
                {/* Main route line */}
                <Polyline
                  coordinates={navRouteCoords}
                  strokeWidth={5}
                  strokeColor="#3b82f6"
                />
              </>
            )}

            {/* Incident navigation route */}
            {incidentNavActive && incidentNavCoords.length > 1 && (
              <>
                <Polyline coordinates={incidentNavCoords} strokeWidth={8} strokeColor="rgba(249,115,22,0.25)" />
                <Polyline coordinates={incidentNavCoords} strokeWidth={5} strokeColor="#f97316" />
              </>
            )}

            {/* Incident location markers */}
            {incidentAlerts.map((inc) => {
              const lat = inc.location?.latitude;
              const lng = inc.location?.longitude;
              if (lat == null || lng == null) return null;
              const cat = INCIDENT_CAT_META[inc.category] || { emoji: "🚨", color: "#ef4444" };
              return (
                <Marker
                  key={String(inc._id)}
                  coordinate={{ latitude: lat, longitude: lng }}
                  anchor={{ x: 0.5, y: 0.5 }}
                  onPress={() => { setActiveIncident(inc); setShowIncidentBanner(true); }}
                >
                  <View style={[styles.incidentMapMarker, { borderColor: cat.color, backgroundColor: cat.color + "22" }]}>
                    <Text style={{ fontSize: 18 }}>{cat.emoji}</Text>
                    {inc.status === "pending" && <View style={[styles.incidentMarkerDot, { backgroundColor: cat.color }]} />}
                  </View>
                </Marker>
              );
            })}
          </MapView>
        )}

        {/* Selected nearby user callout */}
        {selectedNearby && (
          <View style={styles.nearbyCallout}>
            <View style={styles.nearbyCalloutLeft}>
              <Text style={styles.nearbyCalloutEmoji}>
                {selectedNearby.type === "cab" ? "🚖" : "🚶"}
              </Text>
              <View>
                <Text style={styles.nearbyCalloutName} numberOfLines={1}>
                  {selectedNearby.username}
                </Text>
                <Text style={styles.nearbyCalloutSub}>
                  {selectedNearby.type === "cab" ? "Cab Trip" : "Walk Session"} · {selectedNearby.dist} km away
                </Text>
              </View>
            </View>
            <TouchableOpacity
              style={styles.nearbyCalloutClose}
              onPress={() => setSelectedNearby(null)}
            >
              <Text style={{ color: "rgba(255,255,255,0.4)", fontSize: 16 }}>✕</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Map Dark / Light Theme Toggle */}
        <TouchableOpacity
          style={styles.mapThemeToggleBtn}
          onPress={() => setIsDarkMap((prev) => !prev)}
          activeOpacity={0.85}
        >
          <Text style={styles.mapThemeToggleText}>
            {isDarkMap ? "☀️ Light Map" : "🌙 Dark Map"}
          </Text>
        </TouchableOpacity>

        {/* Locate me */}
        <TouchableOpacity
          style={styles.locateMeBtn}
          onPress={async () => {
            try {
              const loc = await getReliableLocation();
              mapRef.current?.animateToRegion({
                latitude: loc.coords.latitude,
                longitude: loc.coords.longitude,
                latitudeDelta: 0.008,
                longitudeDelta: 0.008,
              }, 400);
            } catch (_) { }
          }}
        >
          <Text style={{ fontSize: 20 }}>📍</Text>
        </TouchableOpacity>

        {/* Dispatch banner overlays the map */}
        {renderDispatchBanner()}

        {/* Incident banner overlays the map (shown when no dispatch banner) */}
        {!showDispatchBanner && renderIncidentBanner()}
      </View>

      {/* ── In-app Navigation HUD (dispatch) ── */}
      {navActive && navDestination && (
        <View style={styles.navHud}>
          <View style={styles.navHudLeft}>
            <View style={styles.navHudIconWrap}>
              <Text style={{ fontSize: 20 }}>🆘</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.navHudName} numberOfLines={1}>
                {navDestination.name}
              </Text>
              <View style={styles.navHudMeta}>
                {navDistanceText ? (
                  <View style={styles.navHudPill}>
                    <Text style={styles.navHudPillText}>📍 {navDistanceText}</Text>
                  </View>
                ) : null}
                {navDurationText ? (
                  <View style={[styles.navHudPill, styles.navHudPillBlue]}>
                    <Text style={styles.navHudPillText}>🕒 {navDurationText}</Text>
                  </View>
                ) : null}
              </View>
            </View>
          </View>
          <TouchableOpacity style={styles.navHudStopBtn} onPress={stopNavigation}>
            <Text style={styles.navHudStopIcon}>✕</Text>
            <Text style={styles.navHudStopText}>Stop</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Incident Navigation HUD ── */}
      {incidentNavActive && incidentNavDest && (
        <View style={styles.incidentHudWrap}>

          {/* Resolve success toast */}
          {resolveToast && (
            <View style={styles.resolveToast}>
              <Text style={styles.resolveToastIcon}>✓</Text>
              <Text style={styles.resolveToastText}>Incident resolved successfully</Text>
            </View>
          )}

          <View style={[styles.navHud, { borderTopColor: "rgba(249,115,22,0.4)", borderTopWidth: 1 }]}>
            <View style={styles.navHudLeft}>
              <View style={[styles.navHudIconWrap, { borderColor: "#f97316", backgroundColor: "rgba(249,115,22,0.12)" }]}>
                <Text style={{ fontSize: 20 }}>🚨</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.navHudName} numberOfLines={1}>
                  {incidentNavDest.name}
                </Text>
                <View style={styles.navHudMeta}>
                  {incidentNavDist ? (
                    <View style={[styles.navHudPill, { backgroundColor: "rgba(249,115,22,0.12)" }]}>
                      <Text style={[styles.navHudPillText, { color: "#f97316" }]}>📍 {incidentNavDist}</Text>
                    </View>
                  ) : null}
                  {incidentNavEta ? (
                    <View style={[styles.navHudPill, { backgroundColor: "rgba(249,115,22,0.08)" }]}>
                      <Text style={[styles.navHudPillText, { color: "#f97316" }]}>🕒 {incidentNavEta}</Text>
                    </View>
                  ) : null}
                </View>
              </View>
            </View>

            {/* Right — Resolve + Stop */}
            <View style={styles.incidentHudActions}>
              <TouchableOpacity
                style={[styles.incidentResolveBtn, resolvingIncidentId && { opacity: 0.55 }]}
                onPress={() => {
                  const matched = incidentAlerts.find(
                    (r) =>
                      r.location?.latitude === incidentNavDest?.lat &&
                      r.location?.longitude === incidentNavDest?.lng
                  );
                  const rid = incidentNavDest?._id || matched?._id;
                  if (rid) resolveIncident(rid);
                }}
                disabled={!!resolvingIncidentId}
                activeOpacity={0.8}
              >
                <Text style={styles.incidentResolveBtnIcon}>
                  {resolvingIncidentId ? "…" : "✓"}
                </Text>
                <Text style={styles.incidentResolveBtnText}>Resolved</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.navHudStopBtn, { borderColor: "rgba(249,115,22,0.3)", backgroundColor: "rgba(249,115,22,0.08)" }]}
                onPress={stopIncidentNavigation}
              >
                <Text style={[styles.navHudStopIcon, { color: "#f97316" }]}>✕</Text>
                <Text style={[styles.navHudStopText, { color: "#f97316" }]}>Stop</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* Bottom bar */}
      <View style={styles.trackingBottom}>
        {/* Dispatch mission strip — compact reminder when banner is dismissed */}
        {dispatchAlert && !showDispatchBanner && (
          <TouchableOpacity
            style={styles.missionStrip}
            onPress={() => setShowDispatchBanner(true)}
            activeOpacity={0.85}
          >
            <View style={styles.missionStripDot} />
            <Text style={styles.missionStripText} numberOfLines={1}>
              📨 Active Mission: {dispatchAlert.userName || "Unknown"} — Tap to view
            </Text>
          </TouchableOpacity>
        )}

        {/* Incident strips — one per active incident not currently shown as banner */}
        {incidentAlerts
          .filter((inc) => !showIncidentBanner || String(inc._id) !== String(activeIncident?._id))
          .filter((inc) => inc.status !== "resolved")
          .slice(0, 3)
          .map((inc) => {
            const cat = INCIDENT_CAT_META[inc.category] || { emoji: "🚨", color: "#ef4444" };
            return (
              <TouchableOpacity
                key={String(inc._id)}
                style={[styles.incidentStrip, { borderColor: cat.color + "60", backgroundColor: cat.color + "12" }]}
                onPress={() => { setActiveIncident(inc); setShowIncidentBanner(true); }}
                activeOpacity={0.85}
              >
                <View style={[styles.incidentStripDot, { backgroundColor: cat.color }]} />
                <Text style={styles.incidentStripEmoji}>{cat.emoji}</Text>
                <Text style={[styles.incidentStripText, { color: cat.color }]} numberOfLines={1}>
                  {inc.category}: {inc.crowdSize}
                  {inc.status === "acknowledged" ? " · In Progress" : " · NEW"}
                </Text>
                <Text style={[styles.incidentStripChevron, { color: cat.color }]}>›</Text>
              </TouchableOpacity>
            );
          })
        }

        <TouchableOpacity style={styles.cancelTripBtn} onPress={handleEndPatrol} activeOpacity={0.85}>
          <Text style={styles.cancelTripIcon}>✕</Text>
          <Text style={styles.cancelTripText}>END PATROL</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderProfilePage = () => (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0b1329" />
      <View style={styles.profileHeader}>
        <TouchableOpacity
          onPress={() => setShowProfilePage(false)}
          style={styles.profileBackBtn}
        >
          <Text style={styles.profileBackText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.profileHeaderTitle}>OFFICER PROFILE</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 20 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.profileBadgeCard}>
          <Text style={{ fontSize: 54, marginBottom: 8 }}>👮</Text>
          <Text style={styles.profileNameText}>
            {editName || user?.name || user?.username || "Officer"}
          </Text>
          <Text style={styles.profileBadgeText}>
            Badge #{editBadge || badgeNumber || "PB-101"}
          </Text>
          <View style={styles.profileRolePill}>
            <Text style={styles.profileRoleText}>
              {user?.role ? user.role.toUpperCase() : "OFFICER"}
            </Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Full Name</Text>
          <TextInput
            style={styles.input}
            value={editName}
            onChangeText={setEditName}
            placeholder="Officer Name"
            placeholderTextColor="#64748b"
          />

          <Text style={styles.label}>Badge Number</Text>
          <TextInput
            style={styles.input}
            value={editBadge}
            onChangeText={setEditBadge}
            placeholder="Badge # (e.g. PB-4092)"
            placeholderTextColor="#64748b"
            autoCapitalize="characters"
          />

          <Text style={styles.label}>Mobile Number</Text>
          <TextInput
            style={styles.input}
            value={editMobile}
            onChangeText={setEditMobile}
            placeholder="Mobile # (e.g. 9876543210)"
            placeholderTextColor="#64748b"
            keyboardType="phone-pad"
          />

          <Text style={styles.label}>Department</Text>
          <TextInput
            style={styles.input}
            value={editDept}
            onChangeText={setEditDept}
            placeholder="Department (e.g. Night Patrol)"
            placeholderTextColor="#64748b"
          />

          <Text style={styles.label}>Police Station</Text>
          <TextInput
            style={styles.input}
            value={editStation}
            onChangeText={setEditStation}
            placeholder="Station Name"
            placeholderTextColor="#64748b"
          />

          <TouchableOpacity
            style={[styles.submitBtn, savingProfile && styles.disabledBtn]}
            onPress={handleSaveProfile}
            disabled={savingProfile}
          >
            {savingProfile ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.submitBtnText}>SAVE PROFILE DETAILS</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.logoutCardBtn}
            onPress={handleLogout}
          >
            <Text style={styles.logoutCardBtnText}>🚪 LOG OUT OF SHIFT</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );

  if (showProfilePage) {
    return renderProfilePage();
  }

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: "#0b1329" }]}>
      <StatusBar barStyle="light-content" backgroundColor="#0b1329" />
      {isPatrolActive ? renderPatrolScreen() : renderSetupScreen()}
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  STYLES
// ─────────────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b1329" },
  safeArea: { flex: 1, backgroundColor: "#0b1329" },

  // Setup Screen (Dark AuthScreen Theme)
  setupRoot: { flex: 1, backgroundColor: "#0b1329" },
  setupHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingTop: 54,
    paddingBottom: 18,
    backgroundColor: "#1e293b",
    borderBottomWidth: 1,
    borderBottomColor: "#334155",
  },
  headerTitleWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    marginHorizontal: 8,
  },
  setupHeaderTitle: {
    fontSize: 17,
    fontWeight: "900",
    color: "#38bdf8",
    letterSpacing: 1.2,
    textAlign: "center",
  },
  setupHeaderSubtitle: {
    fontSize: 12,
    color: "#94a3b8",
    fontWeight: "600",
    marginTop: 3,
    textAlign: "center",
  },
  backBtn: { width: 40, height: 40, justifyContent: "center" },
  backArrow: { fontSize: 22, color: "#38bdf8", fontWeight: "700" },
  shieldBadge: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: "rgba(56, 189, 248, 0.15)", justifyContent: "center", alignItems: "center",
    borderWidth: 1, borderColor: "#38bdf8",
  },
  shieldIcon: { fontSize: 20 },
  personIconButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#0f172a",
    borderWidth: 1.5,
    borderColor: "#38bdf8",
    alignItems: "center",
    justifyContent: "center",
  },
  personIconText: { fontSize: 20 },

  setupContent: { paddingHorizontal: 20, paddingTop: 16 },
  fieldLabel: {
    fontSize: 12, fontWeight: "700", color: "#cbd5e1",
    letterSpacing: 0.8, marginBottom: 8, marginTop: 10,
    textTransform: "uppercase",
  },
  optional: { color: "#64748b", fontWeight: "500", fontSize: 12 },
  inputCard: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#0f172a", borderRadius: 10,
    borderWidth: 1, borderColor: "#334155",
    paddingHorizontal: 16, paddingVertical: 12,
    marginBottom: 16,
  },
  fieldInput: { flex: 1, fontSize: 15, color: "#f8fafc" },
  inputIcon: { fontSize: 20, marginLeft: 10 },
  vehicleRow: { flexDirection: "row", gap: 10, marginBottom: 20 },
  vehicleCard: {
    flex: 1, backgroundColor: "#0f172a",
    borderRadius: 12, borderWidth: 1.5, borderColor: "#334155",
    paddingVertical: 16, alignItems: "center", gap: 6,
  },
  vehicleCardActive: { borderColor: "#38bdf8", backgroundColor: "#1e293b" },
  vehicleEmoji: { fontSize: 26 },
  vehicleLabel: { fontSize: 10, fontWeight: "800", color: "#64748b", letterSpacing: 0.8 },
  vehicleLabelActive: { color: "#38bdf8" },
  setupFooter: {
    position: "absolute", bottom: 0, left: 0, right: 0,
    backgroundColor: "#0b1329",
    paddingHorizontal: 20, paddingBottom: 30, paddingTop: 14,
    borderTopWidth: 1, borderTopColor: "#334155",
  },
  startTripBtn: {
    backgroundColor: "#0284c7", flexDirection: "row",
    alignItems: "center", justifyContent: "center",
    gap: 10, paddingVertical: 16, borderRadius: 10,
    elevation: 6, shadowColor: "#0284c7",
    shadowOpacity: 0.4, shadowRadius: 8, shadowOffset: { width: 0, height: 4 },
  },
  startTripIcon: { color: "#fff", fontSize: 16, fontWeight: "900" },
  startTripText: { color: "#fff", fontSize: 15, fontWeight: "800", letterSpacing: 1 },
  setupFooterNote: { color: "#64748b", textAlign: "center", fontSize: 12, marginTop: 10 },

  // Profile Page Styles
  profileHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 54,
    paddingBottom: 18,
    backgroundColor: "#1e293b",
    borderBottomWidth: 1,
    borderBottomColor: "#334155",
  },
  profileBackBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: "#0f172a",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#334155",
  },
  profileBackText: {
    color: "#38bdf8",
    fontSize: 14,
    fontWeight: "700",
  },
  profileHeaderTitle: {
    fontSize: 18,
    fontWeight: "900",
    color: "#38bdf8",
    letterSpacing: 1.2,
  },
  profileBadgeCard: {
    backgroundColor: "#1e293b",
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "#334155",
  },
  profileNameText: {
    fontSize: 22,
    fontWeight: "800",
    color: "#f8fafc",
    marginBottom: 4,
  },
  profileBadgeText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#94a3b8",
    marginBottom: 12,
  },
  profileRolePill: {
    backgroundColor: "rgba(56, 189, 248, 0.15)",
    borderWidth: 1,
    borderColor: "#38bdf8",
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
  },
  profileRoleText: {
    color: "#38bdf8",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1,
  },
  card: {
    backgroundColor: "#1e293b",
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: "#334155",
  },
  label: {
    fontSize: 12,
    fontWeight: "700",
    color: "#cbd5e1",
    marginBottom: 6,
    marginTop: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: "#0f172a",
    borderWidth: 1,
    borderColor: "#334155",
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: "#f8fafc",
    fontSize: 15,
  },
  submitBtn: {
    backgroundColor: "#0284c7",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 20,
  },
  disabledBtn: {
    opacity: 0.6,
  },
  submitBtnText: {
    color: "#ffffff",
    fontWeight: "800",
    fontSize: 14,
    letterSpacing: 1,
  },
  logoutCardBtn: {
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    borderWidth: 1,
    borderColor: "#ef4444",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 14,
  },
  logoutCardBtnText: {
    color: "#ef4444",
    fontWeight: "800",
    fontSize: 14,
    letterSpacing: 1,
  },
  startTripIcon: { fontSize: 16, color: "#0f1c14" },
  startTripText: { fontSize: 18, fontWeight: "900", color: "#0f1c14", letterSpacing: 1 },
  setupFooterNote: { color: "#94a3b8", fontSize: 11, textAlign: "center", marginTop: 12, lineHeight: 16 },

  // Active patrol
  trackingRoot: { flex: 1, backgroundColor: "#fff" },
  trackingTopCard: {
    position: "absolute", top: 12, left: 12, right: 12, zIndex: 30,
    backgroundColor: "#fff", borderRadius: 18, padding: 14,
    flexDirection: "row", alignItems: "center",
    elevation: 8, shadowColor: "#000",
    shadowOpacity: 0.1, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
  },
  trackingVehicle: { fontSize: 16, fontWeight: "900", color: "#0f172a", letterSpacing: 0.5 },
  monitoringRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  monitoringDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#13ec49" },
  monitoringLabel: { color: "#64748b", fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  patrolZoneTag: { color: "#64748b", fontSize: 11, marginTop: 3 },
  etaBadge: {
    backgroundColor: "#f0fdf4", borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 8,
    alignItems: "center", minWidth: 64,
  },
  etaLabel: { color: "#64748b", fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  etaValue: { color: "#0f1c14", fontSize: 22, fontWeight: "900" },
  etaUnit: { color: "#94a3b8", fontSize: 9, fontWeight: "700" },
  trackingMapWrap: { flex: 1 },
  vehicleMarkerWrap: {
    alignItems: "center",
  },
  vehicleMarker: {
    backgroundColor: "#13ec49",
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: "center",
    alignItems: "center",
    elevation: 6,
    borderWidth: 2.5,
    borderColor: "#0aad35",
    shadowColor: "#13ec49",
    shadowOpacity: 0.55,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },

    // REMOVE THIS
    // overflow: "hidden",
  },
  vehicleSafeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: "#0aad35",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginTop: 3,
    elevation: 4,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  vehicleSafeDot: {
    width: 5, height: 5, borderRadius: 3,
    backgroundColor: "#fff",
  },
  vehicleSafeText: {
    color: "#fff",
    fontSize: 8,
    fontWeight: "900",
    letterSpacing: 1,
  },
  victimMarker: {
    backgroundColor: "#fef2f2", borderRadius: 24,
    padding: 6, elevation: 6, borderWidth: 2, borderColor: "#ef4444",
    shadowColor: "#ef4444", shadowOpacity: 0.3,
    shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
  },
  mapThemeToggleBtn: {
    position: "absolute",
    right: 16,
    bottom: 80,
    zIndex: 20,
    backgroundColor: "#1e293b",
    borderWidth: 1.5,
    borderColor: "#38bdf8",
    borderRadius: 25,
    paddingHorizontal: 14,
    paddingVertical: 10,
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    flexDirection: "row",
    alignItems: "center",
  },
  mapThemeToggleText: {
    color: "#38bdf8",
    fontWeight: "800",
    fontSize: 13,
    letterSpacing: 0.5,
  },
  locateMeBtn: {
    position: "absolute", bottom: 16, right: 16, zIndex: 20,
    backgroundColor: "#fff", padding: 14, borderRadius: 28,
    elevation: 6, shadowColor: "#000",
    shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 3 },
  },
  trackingBottom: {
    backgroundColor: "#fff", paddingHorizontal: 16,
    paddingBottom: 24, paddingTop: 12,
    elevation: 8, shadowColor: "#000",
    shadowOpacity: 0.08, shadowRadius: 8, shadowOffset: { width: 0, height: -2 },
  },
  missionStrip: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "#fffbeb", borderWidth: 1, borderColor: "#fbbf24",
    borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14, marginBottom: 10,
  },
  missionStripDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#f59e0b" },
  missionStripText: { flex: 1, color: "#92400e", fontSize: 13, fontWeight: "700" },
  cancelTripBtn: {
    backgroundColor: "#fef2f2", borderRadius: 14,
    paddingVertical: 16, alignItems: "center",
    justifyContent: "center", flexDirection: "row", gap: 8,
  },
  cancelTripIcon: { fontSize: 14, color: "#ef4444" },
  cancelTripText: { fontSize: 15, fontWeight: "900", color: "#ef4444", letterSpacing: 0.8 },

  // Dispatch banner
  dispatchOverlay: {
    position: "absolute", inset: 0,
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "rgba(0,0,0,0.72)", zIndex: 200,
    justifyContent: "center", alignItems: "center",
    paddingHorizontal: 16,
  },
  dispatchCard: {
    backgroundColor: "#0a1018",
    borderWidth: 1.5, borderColor: "#FBBF24",
    borderRadius: 24, padding: 22, width: "100%",
    shadowColor: "#FBBF24", shadowOpacity: 0.4,
    shadowRadius: 24, shadowOffset: { width: 0, height: 4 }, elevation: 24,
  },
  dispatchHeader: {
    flexDirection: "row", justifyContent: "space-between",
    alignItems: "center", marginBottom: 14,
  },
  dispatchLivePill: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "rgba(19,236,73,0.12)",
    borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5,
    borderWidth: 1, borderColor: "rgba(19,236,73,0.3)",
  },
  dispatchLiveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#13ec49" },
  dispatchLiveText: { color: "#13ec49", fontSize: 10, fontWeight: "800", letterSpacing: 1.2 },
  dispatchCloseBtn: { padding: 4 },
  dispatchCloseTxt: { color: "rgba(255,255,255,0.4)", fontSize: 18 },
  dispatchTitle: { color: "#fff", fontSize: 20, fontWeight: "900", letterSpacing: 0.3, marginBottom: 4 },
  dispatchSubtitle: { color: "#FBBF24", fontSize: 12, fontWeight: "800", letterSpacing: 1.2, marginBottom: 18 },
  dispatchInfoBox: {
    backgroundColor: "rgba(255,255,255,0.05)",
    borderRadius: 14, padding: 14,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.08)", marginBottom: 18,
  },
  dispatchInfoRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 4 },
  dispatchDivider: { height: 1, backgroundColor: "rgba(255,255,255,0.07)", marginVertical: 8 },
  dispatchInfoLabel: { color: "#64748b", fontSize: 10, fontWeight: "800", letterSpacing: 1.2, width: 68 },
  dispatchInfoValue: { color: "#f0fdf4", fontSize: 15, fontWeight: "700", flex: 1 },
  dispatchInfoCoords: {
    color: "#94a3b8", fontSize: 12, flex: 1,
    fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
  },
  dispatchNavBtn: {
    backgroundColor: "#13ec49", borderRadius: 16,
    paddingVertical: 18, alignItems: "center",
    elevation: 8, shadowColor: "#13ec49",
    shadowOpacity: 0.45, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, marginBottom: 12,
  },
  dispatchNavBtnText: { color: "#0f1c14", fontSize: 16, fontWeight: "900", letterSpacing: 0.5 },
  dispatchFooterNote: { color: "#475569", fontSize: 11, textAlign: "center", lineHeight: 16 },

  // ── In-app Navigation HUD ───────────────────────────────────────────────
  navHud: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#0f172a",
    borderTopWidth: 1, borderTopColor: "rgba(59,130,246,0.4)",
    paddingHorizontal: 16, paddingVertical: 14,
    gap: 12,
  },
  navHudLeft: {
    flex: 1, flexDirection: "row", alignItems: "center", gap: 12,
  },
  navHudIconWrap: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: "rgba(239,68,68,0.15)",
    borderWidth: 2, borderColor: "#ef4444",
    justifyContent: "center", alignItems: "center",
  },
  navHudName: {
    color: "#f0fdf4", fontSize: 15, fontWeight: "800",
  },
  navHudMeta: {
    flexDirection: "row", gap: 6, marginTop: 4, flexWrap: "wrap",
  },
  navHudPill: {
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3,
  },
  navHudPillBlue: {
    backgroundColor: "rgba(59,130,246,0.15)",
  },
  navHudPillText: {
    color: "rgba(255,255,255,0.7)", fontSize: 11, fontWeight: "700",
  },
  navHudStopBtn: {
    backgroundColor: "rgba(239,68,68,0.12)",
    borderWidth: 1, borderColor: "rgba(239,68,68,0.3)",
    borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14,
    alignItems: "center", gap: 2,
  },
  navHudStopIcon: { color: "#ef4444", fontSize: 14, fontWeight: "800" },
  navHudStopText: { color: "#ef4444", fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },

  // Nearby user markers
  nearbyMarker: {
    borderRadius: 20, padding: 5, elevation: 5,
    shadowColor: "#000", shadowOpacity: 0.15,
    shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
    borderWidth: 2,
  },
  nearbyMarkerWalk: {
    backgroundColor: "#eff6ff", borderColor: "#3b82f6",
  },
  nearbyMarkerCab: {
    backgroundColor: "#fff7ed", borderColor: "#f59e0b",
  },
  nearbyMarkerSelected: {
    borderWidth: 3, elevation: 10,
    shadowOpacity: 0.35,
  },

  // Nearby count badge (top card)
  nearbyCountBadge: {
    backgroundColor: "#eff6ff", borderRadius: 12,
    paddingHorizontal: 10, paddingVertical: 8,
    alignItems: "center", minWidth: 52, marginRight: 8,
    borderWidth: 1, borderColor: "#bfdbfe",
  },
  nearbyCountNumber: { color: "#1d4ed8", fontSize: 18, fontWeight: "900" },
  nearbyCountLabel: { color: "#3b82f6", fontSize: 9, fontWeight: "800", letterSpacing: 0.8 },

  // Selected nearby user callout (floating above locate-me)
  nearbyCallout: {
    position: "absolute", bottom: 80, left: 12, right: 60,
    zIndex: 25,
    backgroundColor: "rgba(10,16,24,0.92)",
    borderRadius: 16, paddingVertical: 12, paddingHorizontal: 14,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    borderWidth: 1, borderColor: "rgba(59,130,246,0.4)",
    elevation: 10,
    shadowColor: "#3b82f6", shadowOpacity: 0.25,
    shadowRadius: 10, shadowOffset: { width: 0, height: 3 },
  },
  nearbyCalloutLeft: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  nearbyCalloutEmoji: { fontSize: 24 },
  nearbyCalloutName: { color: "#f0fdf4", fontSize: 14, fontWeight: "800" },
  nearbyCalloutSub: { color: "#64748b", fontSize: 11, marginTop: 2 },
  nearbyCalloutClose: { padding: 4, marginLeft: 8 },

  // ── Incident banner overlay ──────────────────────────────────────────────
  incidentOverlay: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "rgba(0,0,0,0.70)",
    zIndex: 190,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 16,
  },
  incidentCard: {
    backgroundColor: "#0a1018",
    borderWidth: 1.5,
    borderRadius: 24,
    padding: 22,
    width: "100%",
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 4 },
    elevation: 22,
  },
  incidentBannerHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 14,
  },
  incidentLivePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
  },
  incidentLiveDot: {
    width: 7, height: 7, borderRadius: 4,
  },
  incidentLiveText: {
    fontSize: 10, fontWeight: "800", letterSpacing: 1.2,
  },
  incidentCloseBtn: { padding: 4 },
  incidentCloseTxt: { color: "rgba(255,255,255,0.4)", fontSize: 18 },

  incidentTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 16,
  },
  incidentEmoji: { fontSize: 32 },
  incidentCategoryText: {
    fontSize: 20, fontWeight: "900", letterSpacing: 0.3,
  },
  incidentDistText: {
    color: "#94a3b8", fontSize: 12, marginTop: 3,
  },
  incidentQueueBadge: {
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 10,
    paddingHorizontal: 8, paddingVertical: 4,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.12)",
  },
  incidentQueueText: {
    color: "#94a3b8", fontSize: 11, fontWeight: "700",
  },

  incidentDetailBox: {
    backgroundColor: "rgba(255,255,255,0.05)",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    marginBottom: 18,
  },
  incidentDetailRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingVertical: 5,
  },
  incidentDetailLabel: {
    color: "#64748b",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.2,
    width: 74,
    paddingTop: 1,
  },
  incidentDetailValue: {
    color: "#f0fdf4",
    fontSize: 13,
    fontWeight: "600",
    flex: 1,
    lineHeight: 18,
  },
  incidentDetailValueMono: {
    color: "#94a3b8",
    fontSize: 11,
    flex: 1,
    fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
  },
  incidentDivider: {
    height: 1,
    backgroundColor: "rgba(255,255,255,0.06)",
    marginVertical: 4,
  },

  incidentNavBtn: {
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: "center",
    elevation: 6,
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    marginBottom: 12,
  },
  incidentNavBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "900",
    letterSpacing: 0.5,
  },
  incidentFooterNote: {
    color: "#475569", fontSize: 11, textAlign: "center", lineHeight: 16,
  },

  // ── Incident map marker ──────────────────────────────────────────────────
  incidentMapMarker: {
    borderRadius: 22,
    padding: 6,
    elevation: 6,
    borderWidth: 2,
    shadowOpacity: 0.25,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    position: "relative",
  },
  incidentMarkerDot: {
    position: "absolute",
    top: -3, right: -3,
    width: 10, height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: "#0a1018",
  },

  // ── Incident compact strip (bottom bar) ─────────────────────────────────
  incidentStrip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 9,
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  incidentStripDot: { width: 7, height: 7, borderRadius: 4 },
  incidentStripEmoji: { fontSize: 15 },
  incidentStripText: { flex: 1, fontSize: 12, fontWeight: "700" },
  incidentStripChevron: { fontSize: 18, fontWeight: "700" },

  // ── Incident HUD wrapper (houses toast + nav row) ────────────────────────
  incidentHudWrap: {
    backgroundColor: "#0f172a",
  },

  // ── Resolve success toast (sits above the HUD row) ───────────────────────
  resolveToast: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#16a34a",
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  resolveToastIcon: {
    color: "#fff", fontSize: 16, fontWeight: "900",
  },
  resolveToastText: {
    color: "#fff", fontSize: 13, fontWeight: "700", letterSpacing: 0.3,
  },

  // ── HUD action column (Resolve + Stop side by side) ──────────────────────
  incidentHudActions: {
    flexDirection: "column",
    gap: 6,
    alignItems: "stretch",
    minWidth: 72,
  },

  // ── Green Resolved button in HUD ─────────────────────────────────────────
  incidentResolveBtn: {
    backgroundColor: "#16a34a",
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    alignItems: "center",
    gap: 2,
    elevation: 3,
    shadowColor: "#16a34a",
    shadowOpacity: 0.35,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  incidentResolveBtnIcon: {
    color: "#fff", fontSize: 14, fontWeight: "900",
  },
  incidentResolveBtnText: {
    color: "#fff", fontSize: 9, fontWeight: "800", letterSpacing: 0.5,
  },

  // ── Mark as Resolved button inside the banner ────────────────────────────
  incidentResolveBannerBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "rgba(22,163,74,0.12)",
    borderWidth: 1.5,
    borderColor: "rgba(22,163,74,0.4)",
    borderRadius: 14,
    paddingVertical: 13,
    marginBottom: 12,
  },
  incidentResolveBannerIcon: {
    color: "#4ade80", fontSize: 16, fontWeight: "900",
  },
  incidentResolveBannerText: {
    color: "#4ade80", fontSize: 14, fontWeight: "700", letterSpacing: 0.3,
  },

  // ── Header Profile & Logout Buttons ──────────────────────────────────────
  headerProfileBtn: {
    backgroundColor: "rgba(2, 132, 199, 0.12)",
    borderWidth: 1,
    borderColor: "#0284c7",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  headerProfileBtnText: {
    color: "#0284c7",
    fontSize: 12,
    fontWeight: "700",
  },
  headerLogoutBtn: {
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    borderWidth: 1,
    borderColor: "#ef4444",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  headerLogoutBtnText: {
    color: "#ef4444",
    fontSize: 12,
    fontWeight: "700",
  },

  // ── Profile Edit Modal ───────────────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.75)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  modalCard: {
    width: "100%",
    backgroundColor: "#1e293b",
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: "#334155",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: "#38bdf8",
  },
  modalClose: {
    fontSize: 18,
    fontWeight: "800",
    color: "#94a3b8",
  },
  modalLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "#94a3b8",
    marginTop: 10,
    marginBottom: 4,
  },
  modalInput: {
    backgroundColor: "#0f172a",
    borderWidth: 1,
    borderColor: "#334155",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#f8fafc",
    fontSize: 14,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 20,
  },
  modalCancelBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: "#334155",
  },
  modalCancelText: {
    color: "#cbd5e1",
    fontWeight: "700",
    fontSize: 13,
  },
  modalSaveBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: "#0284c7",
  },
  modalSaveText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 13,
  },
});

/* ─────────────────────────────────────────────────────────────────────────────
   INCIDENT DETAIL ROW — helper sub-component for the banner detail box
───────────────────────────────────────────────────────────────────────────── */
function IncidentDetailRow({ label, value, mono = false }) {
  return (
    <View style={styles.incidentDetailRow}>
      <Text style={styles.incidentDetailLabel}>{label}</Text>
      <Text
        style={mono ? styles.incidentDetailValueMono : styles.incidentDetailValue}
        numberOfLines={4}
      >
        {value}
      </Text>
    </View>
  );
}
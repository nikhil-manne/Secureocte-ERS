import { Modal } from "react-native";
import AIChatScreen from "./AIChatScreen";

import {
  StyleSheet,
  View,
  Text,
  Switch,
  TextInput,
  TouchableOpacity,
  Alert,
  SafeAreaView,
  StatusBar,
  ScrollView,
  Keyboard,
  FlatList,
  Image,
  AppState,
  Platform,
  Linking,
  NativeModules,
  DeviceEventEmitter,
  Share,
  Clipboard,
  BackHandler,
} from "react-native";
import MapView, { Marker, Polyline } from "react-native-maps";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import * as Device from "expo-device";
import * as LocalAuthentication from "expo-local-authentication";
import Constants from "expo-constants";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { useBatteryMonitor } from "./Batterymonitor";
import { apiFetch, apiMultipart, rawFetchWithSecurity, AuthError, BASE_URL } from "./api";
import { emitLocationUpdate, onModeChange, getLocationInterval } from "./socket";
import React, { useState, useEffect, useRef } from "react";

// Notification handler is set globally in App.js

const API_KEY = Constants.expoConfig.extra.googleApiKey;
const BACKEND_URL = BASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
//  BACKGROUND LOCATION TASK  (module-level — must be outside component)
// ─────────────────────────────────────────────────────────────────────────────
const BACKGROUND_LOCATION_TASK = "CAB_BACKGROUND_LOCATION_TASK";

TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) { console.error("[BG Task] error:", error); return; }
  if (!data) return;
  const { locations } = data;
  if (!locations?.length) return;
  const { latitude, longitude } = locations[0].coords;
  try {
    const tripId = await AsyncStorage.getItem("SAFEPATH_TRIP_ID");
    if (!tripId) return;
    // rawFetchWithSecurity reads token + deviceId from SecureStore and attaches
    // all security headers (Authorization, X-Device-Id, X-Timestamp, X-Nonce)
    await rawFetchWithSecurity(`${BASE_URL}/api/cab-escort/update-location`, {
      method: "POST",
      body: { tripId, latitude, longitude },
    });
    // Hard lock — if emergency already dispatched, skip deviation check entirely
    const alreadyDispatched = await AsyncStorage.getItem("SAFEPATH_ALERT_DISPATCHED");
    if (alreadyDispatched === "1") return;
    const routeJSON = await AsyncStorage.getItem("SAFEPATH_ROUTE_COORDS");
    if (!routeJSON) return;
    const routeCoords = JSON.parse(routeJSON);
    // Ensure module-level segments are ready for the windowed search
    if (_routeSegments.length === 0 && routeCoords.length > 1) initRouteSegments(routeCoords);

    // ── BG sustained confirmation (BACKGROUND_CONFIRM_COUNT ticks) ───────────
    // Persist counter via AsyncStorage so it survives across BG task invocations.
    const bgCountRaw = await AsyncStorage.getItem("SAFEPATH_BG_DEV_COUNTER");
    let bgCounter = bgCountRaw ? parseInt(bgCountRaw, 10) : 0;

    if (isOffRouteStatic({ latitude, longitude })) {
      bgCounter += 1;
      console.log(`[BG Task] Off-route tick — bgDeviationCounter=${bgCounter}`);
      await AsyncStorage.setItem("SAFEPATH_BG_DEV_COUNTER", String(bgCounter));
      if (bgCounter >= BACKGROUND_CONFIRM_COUNT) {
        await AsyncStorage.setItem("SAFEPATH_BG_DEV_COUNTER", "0");
        await sendDeviationNotificationStatic();
      }
    } else {
      // On route — reset BG counter
      if (bgCounter !== 0) {
        await AsyncStorage.setItem("SAFEPATH_BG_DEV_COUNTER", "0");
        console.log("[BG Task] On route — bgDeviationCounter reset.");
      }
    }
  } catch (e) { console.error("[BG Task] update failed:", e); }
});

// Static helpers (usable outside component and in background task)
function haversineStatic(c1, c2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371e3;
  const dLat = toRad(c2.latitude - c1.latitude);
  const dLon = toRad(c2.longitude - c1.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(toRad(c1.latitude)) * Math.cos(toRad(c2.latitude));
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function isOffRouteStatic(userLocation) {
  // Use the already-built module-level _routeSegments — no reallocation per call.
  // Falls back gracefully if segments haven't been initialised yet.
  if (_routeSegments.length === 0) return false;
  const { distance } = getDistanceToNearestSegment(userLocation, _routeSegments);
  // Speed unknown in BG — use the most conservative (largest) low-speed threshold
  // so normal GPS drift (~30-60m in cities) doesn't trigger false positives.
  return distance > getDynamicThreshold(0);
}
async function sendDeviationNotificationStatic() {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: "❗ Route Deviation Detected",
      body: "You appear to be off your projected route. Are you okay?",
      sound: true,
      priority: Notifications.AndroidNotificationPriority.MAX,
      categoryIdentifier: "DEVIATION",
    },
    trigger: null,
  });
}

async function getReliableLocation() {
  try {
    const last = await Location.getLastKnownPositionAsync({
      maxAge: 120000,
      requiredAccuracy: 500,
    });
    if (last) {
      console.log("[Location] ✅ Using last known position");
      return last;
    }
  } catch (e) {
    console.log("[Location] last known unavailable:", e.message);
  }

  try {
    const loc = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Lowest }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10000)),
    ]);
    console.log("[Location] ✅ Got location via network/WiFi");
    return loc;
  } catch (e) {
    console.log("[Location] network/WiFi failed:", e.message);
  }

  try {
    const loc = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 15000)),
    ]);
    console.log("[Location] ✅ Got location via GPS");
    return loc;
  } catch (e) {
    console.log("[Location] GPS failed:", e.message);
  }

  throw new Error(
    "Location unavailable. Please check:\n" +
    "1. Settings → Location → turn ON\n" +
    "2. Settings → Apps → SecureOcte → Permissions → Location → Allow all the time\n" +
    "3. Make sure you are not in battery saver mode"
  );
}

// --- CONFIGURATION FOR DEVIATION LOGIC (OptimizedRouteDeviationSystem) ---
const LOCATION_UPDATE_INTERVAL = 5000;    // 5 s
const SUSTAINED_CHECK_COUNT = 5;       // ~25 s foreground confirmation (raised from 3 to reduce false positives)
const BACKGROUND_CONFIRM_COUNT = 4;       // BG ticks before firing alert (raised from 2 to reduce false positives)
const HEADING_THRESHOLD_DEG = 60;      // degrees
const MIN_DEVIATION_SPEED_KMH = 5;     // skip deviation checks below this speed (GPS noise at rest)
const HEADING_VALID_SPEED_KMH = 8;       // heading unreliable below this speed
const MAX_SUSPICIOUS_LIMIT = 3;
const REROUTE_SIMILARITY_THRESHOLD = 0.7;
const NO_RESPONSE_TIMEOUT = 15000;   // 15 s
const DEVIATION_COOLDOWN_MS = 60000;   // 60 s
const TRAVELED_PATH_LIMIT = 400;     // max points before trimming
const TRAFFIC_CHECK_INTERVAL_MS = 210000;  // 3.5 min (3–4 min per spec)

// ─────────────────────────────────────────────────────────────────────────────
//  MODULE-LEVEL ROUTE SEGMENTS  (Section 2 — INIT_ROUTE)
//  Populated once routeCoords are decoded; consumed by background task too.
// ─────────────────────────────────────────────────────────────────────────────
let _routeSegments = [];   // { start, end }[]

function initRouteSegments(coords) {
  _routeSegments = [];
  for (let i = 0; i < coords.length - 1; i++) {
    _routeSegments.push({ start: coords[i], end: coords[i + 1] });
  }
}

// ── Section 4 — Dynamic threshold (metres) based on speed ────────────────────
function getDynamicThreshold(speedKmh) {
  // Raised low-speed threshold from 35m → 80m to absorb typical urban GPS
  // drift (20-60m) that was causing false deviation alerts at rest / crawl.
  if (speedKmh < 10) return 80;
  if (speedKmh < 40) return 60;
  if (speedKmh < 70) return 80;
  return 100;
}

// ── Section 5 — Point-to-segment distance (metres) ───────────────────────────
function distPointToSegment(P, A, B) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371e3;

  // Convert to flat-Earth XY (metres) centred on A for the projection maths
  const latA = toRad(A.latitude), lonA = toRad(A.longitude);
  const latB = toRad(B.latitude), lonB = toRad(B.longitude);
  const latP = toRad(P.latitude), lonP = toRad(P.longitude);

  const cosLat = Math.cos((latA + latB) / 2);

  const APx = (lonP - lonA) * R * cosLat;
  const APy = (latP - latA) * R;
  const ABx = (lonB - lonA) * R * cosLat;
  const ABy = (latB - latA) * R;

  const abLen2 = ABx * ABx + ABy * ABy;
  if (abLen2 === 0) return haversineStatic(P, A); // degenerate segment

  const t = Math.max(0, Math.min(1, (APx * ABx + APy * ABy) / abLen2));

  const projLat = A.latitude + (t * (B.latitude - A.latitude));
  const projLon = A.longitude + (t * (B.longitude - A.longitude));

  return haversineStatic(P, { latitude: projLat, longitude: projLon });
}

function getDistanceToNearestSegment(point, segments, fromIdx = 0, window = 40) {
  // Windowed search: only scan ±window segments around last known position.
  // Falls back to full scan on first call (fromIdx=0, window covers whole route
  // when route is short) or when near the edges.
  const start = Math.max(0, fromIdx - window);
  const end = Math.min(segments.length - 1, fromIdx + window);
  let minDist = Infinity;
  let bestIdx = fromIdx;
  for (let i = start; i <= end; i++) {
    const d = distPointToSegment(point, segments[i].start, segments[i].end);
    if (d < minDist) { minDist = d; bestIdx = i; }
    if (minDist < 5) break; // clearly on-route — no need to check further
  }
  // Safety net: if windowed best is suspiciously large, do one full scan.
  // This handles the edge case where the user teleports (tunnel GPS jump).
  if (minDist > 150 && (end - start) < segments.length - 1) {
    for (let i = 0; i < segments.length; i++) {
      if (i >= start && i <= end) continue; // already checked
      const d = distPointToSegment(point, segments[i].start, segments[i].end);
      if (d < minDist) { minDist = d; bestIdx = i; }
    }
  }
  return { index: bestIdx, distance: minDist };
}

// ── Section 6 — Heading / bearing ────────────────────────────────────────────
function getBearing(A, B) {
  const toRad = (x) => (x * Math.PI) / 180;
  const toDeg = (x) => (x * 180) / Math.PI;
  const dLon = toRad(B.longitude - A.longitude);
  const lat1 = toRad(A.latitude), lat2 = toRad(B.latitude);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// ── Section 8 — Route similarity ─────────────────────────────────────────────
function routeSimilarity(newRouteCoords, originalCoords) {
  if (!originalCoords || originalCoords.length === 0) return 0;
  const SNAP_DIST = 30;                        // metres — "overlaps" if within 30 m
  const LAT_DEG_M = 111000;                    // ~metres per degree latitude
  const SNAP_DEG_LAT = SNAP_DIST / LAT_DEG_M;    // pre-computed cheap lat threshold
  let overlap = 0;
  for (const p of originalCoords) {
    const cosLat = Math.cos(p.latitude * Math.PI / 180);
    const snapDegLon = SNAP_DIST / (LAT_DEG_M * cosLat);
    for (const q of newRouteCoords) {
      // Bounding-box pre-filter: 3 cheap ops instead of 8 trig ops.
      // Skips ~90 % of pairs on a typical route overlap check.
      if (Math.abs(p.latitude - q.latitude) > SNAP_DEG_LAT) continue;
      if (Math.abs(p.longitude - q.longitude) > snapDegLon) continue;
      if (haversineStatic(p, q) < SNAP_DIST) { overlap++; break; }
    }
  }
  return overlap / originalCoords.length;
}

// ─────────────────────────────────────────────────────────────────────────────
//  POLICE STATIONS ALONG ROUTE  (Google Places API)
//
//  Strategy: sample waypoints evenly along the decoded route polyline, query
//  each waypoint for nearby police stations, then deduplicate by place_id.
//  This finds stations the entire length of the journey, not just near the
//  user's current position.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchPoliceStationsAlongRoute(routeCoords, apiKey) {
  if (!routeCoords || routeCoords.length === 0) return [];

  try {
    // Sample up to 8 waypoints spread evenly along the route
    const SAMPLE_COUNT = 8;
    const step = Math.max(1, Math.floor(routeCoords.length / SAMPLE_COUNT));
    const sampledPoints = [];
    for (let i = 0; i < routeCoords.length; i += step) {
      sampledPoints.push(routeCoords[i]);
    }
    const last = routeCoords[routeCoords.length - 1];
    if (sampledPoints[sampledPoints.length - 1] !== last) {
      sampledPoints.push(last);
    }

    const radius = 2000;
    const seenIds = new Set();
    const allStations = [];

    const results = await Promise.allSettled(
      sampledPoints.map(({ latitude, longitude }) =>
        fetch(
          `https://maps.googleapis.com/maps/api/place/nearbysearch/json` +
          `?location=${latitude},${longitude}` +
          `&radius=${radius}` +
          `&type=police` +
          `&key=${apiKey}`
        ).then((r) => r.json())
      )
    );

    const STATION_KEYWORDS = [
      "police station",
      "police thana",
      "thana",
      "thane",
      "police chowki",
      "chowki",
      "ps ",
      " ps",
    ];

    const EXCLUDE_KEYWORDS = [
      "office",
      "headquarters",
      " hq",
      "training",
      "academy",
      "school",
      "museum",
      "memorial",
      "welfare",
      "housing",
      "colony",
      "quarters",
      "canteen",
      "guest house",
      "commissioner",
      "commissionerate",
      "bureau",
      "department",
      "ministry",
    ];

    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const data = result.value;
      if (data.status !== "OK" && data.status !== "ZERO_RESULTS") continue;
      for (const p of data.results || []) {
        if (seenIds.has(p.place_id)) continue;

        const nameLower = (p.name || "").toLowerCase();
        const isStation = STATION_KEYWORDS.some((kw) => nameLower.includes(kw));
        const isExcluded = EXCLUDE_KEYWORDS.some((kw) => nameLower.includes(kw));

        if (!isStation || isExcluded) {
          console.log(`[Police] Skipped (not a station): ${p.name}`);
          continue;
        }

        seenIds.add(p.place_id);
        allStations.push({
          place_id: p.place_id,
          name: p.name,
          vicinity: p.vicinity || "",
          latitude: p.geometry.location.lat,
          longitude: p.geometry.location.lng,
        });
      }
    }

    console.log(`[Police] Found ${allStations.length} unique stations along route`);
    return allStations;
  } catch (e) {
    console.error("[Police] fetch error:", e.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SEND SOS ALERT  →  POST /api/secureme/alert
//  NOTE: this is now a factory that returns a component-scoped async fn so it
//  can use rawFetchWithSecurity (which auto-attaches Authorization, X-Device-Id,
//  X-Timestamp, X-Nonce). The old module-level plain fetch() was missing all of
//  those headers, causing the route's verifyToken + replayProtection to reject
//  the request and showing "Could not send SOS" error.
// ─────────────────────────────────────────────────────────────────────────────
function makeSendSOSAlert() {
  return async function sendSOSAlert({ userId, latitude, longitude, stationName }) {
    try {
      const res = await rawFetchWithSecurity(`${BACKEND_URL}/api/secureme/alert`, {
        method: "POST",
        body: {
          userId,
          trigger: "manual_sos",
          reason: `Emergency SOS near police station: ${stationName}`,
          lat: latitude,
          lng: longitude,
          mode: "cab",
        },
      });
      const text = await res.text();
      console.log("[SOS] response:", res.status, text);
      return res.ok;
    } catch (e) {
      console.error("[SOS] send error:", e.message);
      return false;
    }
  };
}
const sendSOSAlert = makeSendSOSAlert();

export default function CabMonitoringScreen({ user, goBack, routeData, inZone, secureMeOn, toggleSecureMe, recordTouch }) {
  const { driverImage, destination: routeDestination, vehicleType, vehicleNumber: routeVehicleNumber } = routeData || {};

  /* ── Auth token + deviceId — loaded once from SecureStore.
        Both are stored in refs so they're available immediately in all
        fetch calls without waiting for a re-render.
        FIX: authHeader() now includes X-Device-Id which verifyToken
        middleware requires for all mobile users. Missing this header
        caused every /start, /police-support, etc. call to return 401. ── */
  const tokenRef = useRef(null);
  const deviceIdRef = useRef(null);
  useEffect(() => {
    Promise.all([
      SecureStore.getItemAsync("userToken"),
      SecureStore.getItemAsync("so_device_id"),   // key used by api.js / getDeviceId()
    ])
      .then(([t, d]) => {
        if (t) tokenRef.current = t;
        if (d) deviceIdRef.current = d;
      })
      .catch(() => { });
  }, []);
  const authHeader = () => ({
    "Content-Type": "application/json",
    ...(tokenRef.current && { Authorization: `Bearer ${tokenRef.current}` }),
    ...(deviceIdRef.current && { "X-Device-Id": deviceIdRef.current }),
  });

  // --- STATE MANAGEMENT ---
  const [chatOpen, setChatOpen] = useState(false);
  const [isTripActive, setIsTripActive] = useState(false);

  // Heartbeat — backend auto-alerts if phone shuts down during cab trip
  useBatteryMonitor({ user, enabled: isTripActive, mode: "cab" });
  const [isMapPickerVisible, setIsMapPickerVisible] = useState(false);
  const [region, setRegion] = useState(null);
  const [destination, setDestination] = useState(routeDestination ?? null);
  const [tempDestination, setTempDestination] = useState(null);
  const [routeCoords, setRouteCoords] = useState([]);
  const [input, setInput] = useState("");
  const [mapPickerSearchInput, setMapPickerSearchInput] = useState("");
  const [predictions, setPredictions] = useState([]);
  const [activeInput, setActiveInput] = useState(null);
  const [driverIdPhoto, setDriverIdPhoto] = useState(driverImage ?? null);
  const [vehicleMode, setVehicleMode] = useState(vehicleType ?? 'driving');
  const [missingIdVideo, setMissingIdVideo] = useState(null);
  const [vehicleNumberInput, setVehicleNumberInput] = useState(routeVehicleNumber ?? '');
  const [reportSubmitted, setReportSubmitted] = useState(false);

  // ✅ BACKEND LIVE ESCORT STATE
  const [tripId, setTripId] = useState(null);

  // --- DEVIATION LOGIC STATE (OptimizedRouteDeviationSystem) ---
  const [suspiciousFlag, setSuspiciousFlag] = useState(0);
  const [yellowFlagMarkers, setYellowFlagMarkers] = useState([]); // suspicious marks on map
  const [redFlagMarkers, setRedFlagMarkers] = useState([]);       // police/help alerts on map
  const suspiciousFlagRef = useRef(0);           // Section 1 — suspiciousCounter
  const [isDeviated, setIsDeviated] = useState(false);
  const isDeviatedRef = useRef(false);           // Section 1 — isDeviated
  const [deviationLocation, setDeviationLocation] = useState(null);
  const [currentLocation, setCurrentLocation] = useState(null);

  // Section 1 — deviationCounter (sustained check before confirming)
  const deviationCounterRef = useRef(0);
  // Section 1 — lastValidSegmentIndex
  const lastValidSegmentIndexRef = useRef(0);
  // ONE-WAY LOCK — set to true the moment an emergency alert is dispatched.
  // Unlike isDeviatedRef / lastDeviationTimestamp, this is NEVER reset by
  // clearDeviationState, cooldown timers, or user responses.
  // The only way to clear it is explicitly starting a new trip.
  const alertDispatchedRef = useRef(false);

  // Reroute state
  const [rerouteCoords, setRerouteCoords] = useState([]);
  const [isRerouting, setIsRerouting] = useState(false);
  // Preserves the original green route even after a safety-check reroute
  const [originalRouteCoords, setOriginalRouteCoords] = useState([]);

  // Add new state for tracking traveled path
  const [traveledPath, setTraveledPath] = useState([]);

  // ── POLICE STATIONS ──────────────────────────────────────────────────────
  const [policeStations, setPoliceStations] = useState([]);
  const [policeLoading, setPoliceLoading] = useState(false);
  const policeStationsFetchedRef = useRef(false);

  // ── SOS modal state ───────────────────────────────────────────────────────
  const [sosStation, setSosStation] = useState(null);
  const [sosSending, setSosSending] = useState(false);

  // ── Police support banner ─────────────────────────────────────────────────
  const [policeSupportSent, setPoliceSupportSent] = useState(false);

  // ── Nearby Patrol Count ───────────────────────────────────────────────────
  const [nearbyPatrolCount, setNearbyPatrolCount] = useState(0);

  // ── LIVE STREAM STATE ─────────────────────────────────────────────────────
  const [streamId, setStreamId] = useState(null);
  const [streamUrl, setStreamUrl] = useState(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCreatingStream, setIsCreatingStream] = useState(false);
  const [showStreamModal, setShowStreamModal] = useState(false);

  // ── SPEED & TRAFFIC STATE ─────────────────────────────────────────────────
  const [currentSpeedKmh, setCurrentSpeedKmh] = useState(null);
  const [trafficStatus, setTrafficStatus] = useState(null);
  const [trafficAlertShown, setTrafficAlertShown] = useState(false);
  const trafficCheckIntervalRef = useRef(null);
  const trafficAlertShownRef = useRef(false);

  // --- REFS ---
  const mapRef = useRef(null);
  const debounceTimeout = useRef(null);
  const locationSubscriber = useRef(null);
  const deviationTimeoutRef = useRef(null);
  const cooldownTimeoutRef = useRef(null);
  const lastDeviationTimestamp = useRef(0);
  // ── Adaptive location accuracy tracking ──────────────────────────────────
  // Tracks the currently active watcher accuracy tier so we only restart the
  // watcher when the tier actually needs to change (avoids thrashing).
  const activeAccuracyRef = useRef(Location.Accuracy.Balanced); // start conservative
  // ── Suspicious-input cooldown window ─────────────────────────────────────
  // After a "Suspicious" response, block the next deviation alert until EITHER
  // 30 s have elapsed OR the user has moved ≥ 100 m from the flagged location.
  const suspiciousWindowTimerRef = useRef(null);  // setTimeout handle
  const suspiciousWindowActiveRef = useRef(false); // true while window is open
  const suspiciousWindowStartLocRef = useRef(null); // {latitude,longitude} at flag time
  const currentLocationRef = useRef(null);
  const destinationRef = useRef(destination);
  const vehicleModeRef = useRef(vehicleMode);
  const tripIdRef = useRef(null);
  const appState = useRef(AppState.currentState);

  // Keep refs in sync with state
  useEffect(() => { destinationRef.current = destination; }, [destination]);
  useEffect(() => { vehicleModeRef.current = vehicleMode; }, [vehicleMode]);
  useEffect(() => { tripIdRef.current = tripId; }, [tripId]);

  // ── Fetch police stations along route once routeCoords are available ─────
  useEffect(() => {
    if (!isTripActive || routeCoords.length === 0) return;

    const loadPoliceStations = async () => {
      setPoliceLoading(true);
      try {
        const stations = await fetchPoliceStationsAlongRoute(routeCoords, API_KEY);
        setPoliceStations(stations);
      } catch (e) {
        console.warn("[Police] Could not load stations:", e.message);
      } finally {
        setPoliceLoading(false);
      }
    };

    loadPoliceStations();
  }, [routeCoords, isTripActive]);

  // Reset police stations when trip ends
  useEffect(() => {
    if (!isTripActive) {
      setPoliceStations([]);
      setSosStation(null);
    }
  }, [isTripActive]);

  // ── Poll nearby patrol count every 10 s while trip is active ─────────────
  useEffect(() => {
    if (!isTripActive) {
      setNearbyPatrolCount(0);
      return;
    }
    const fetchPatrolCount = async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/patrol/active`);
        const data = await res.json();
        if (data?.success && Array.isArray(data.trips)) {
          const userLoc = currentLocationRef.current;
          const nearby = data.trips.filter((v) => {
            if (!v.currentLocation?.latitude || !v.currentLocation?.longitude) return false;
            // If user location not yet available, count all active patrols
            if (!userLoc) return true;
            const distM = haversineStatic(
              { latitude: userLoc.latitude, longitude: userLoc.longitude },
              { latitude: v.currentLocation.latitude, longitude: v.currentLocation.longitude }
            );
            return distM <= 5000; // within 5 km
          });
          setNearbyPatrolCount(nearby.length);
        }
      } catch (e) {
        console.warn("[Patrol] Could not fetch patrol count:", e.message);
      }
    };
    fetchPatrolCount();
    const interval = setInterval(fetchPatrolCount, 10000);
    return () => clearInterval(interval);
  }, [isTripActive]);

  // ✅ Open Map Picker directly when coming from Voice Assistant
  useEffect(() => {
    if (routeData?.openMapDirectly) {
      setIsMapPickerVisible(true);
    }
  }, [routeData]);

  // ✅ Auto-start Trip Escort when coming from Voice Assistant final step
  useEffect(() => {
    if (routeData?.startTripDirectly && routeData?.destination) {
      setDestination(routeData.destination);
      setVehicleMode(routeData.vehicleType ?? 'driving');
      setTimeout(() => handleStartTrip(), 600);
    }
  }, [routeData]);

  // 🔒 Block Android hardware back button during active trip
  useEffect(() => {
    if (!isTripActive) return;
    const onBackPress = () => {
      Alert.alert(
        "Trip is Active",
        "You cannot go back while a trip is in progress. Use the Cancel Trip button to end the trip safely.",
        [{ text: "OK", style: "cancel" }]
      );
      return true;
    };
    const sub = BackHandler.addEventListener("hardwareBackPress", onBackPress);
    return () => sub.remove();
  }, [isTripActive]);

  // ── Permissions + Notification Categories + Response Listener ──────────────
  useEffect(() => {
    (async () => {
      if (Device.isDevice) {
        const { status } = await Notifications.requestPermissionsAsync();
        if (status !== "granted") {
          Alert.alert("Notifications", "Please enable notifications for safety alerts.");
        }

        const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
        if (bgStatus !== "granted") {
          Alert.alert(
            "Background Location",
            "Please allow 'Always' location access so trip monitoring continues when the app is minimised."
          );
        }

        await Notifications.setNotificationCategoryAsync("DEVIATION", [
          {
            identifier: "DEVIATION_SAFE",
            buttonTitle: "✅ I'm Safe",
            options: { opensAppToForeground: true },
          },
          {
            identifier: "DEVIATION_SUSPICIOUS",
            buttonTitle: "🤨 Suspicious",
            options: { opensAppToForeground: true },
          },
          {
            identifier: "DEVIATION_HELP",
            buttonTitle: "🆘 Need Help",
            options: { opensAppToForeground: true, isDestructive: true },
          },
        ]);

        await Notifications.setNotificationCategoryAsync("SAFETY_CHECK", [
          {
            identifier: "SAFETY_YES",
            buttonTitle: "✅ Yes, I'm Safe",
            options: { opensAppToForeground: true },
          },
          {
            identifier: "SAFETY_NO",
            buttonTitle: "🆘 No – Send Help",
            options: { opensAppToForeground: true, isDestructive: true },
          },
        ]);
      }

      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") { alert("Permission denied for location"); return; }
      try {
        const loc = await getReliableLocation();
        setRegion({
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          latitudeDelta: 0.0922,
          longitudeDelta: 0.0421,
        });
      } catch (err) {
        console.error("Initial location error:", err);
        Alert.alert("Location Error", "Could not get your location. Please check that location services are on and try again.");
      }
    })();

    const notifSub = Notifications.addNotificationResponseReceivedListener(async (response) => {
      const action = response.actionIdentifier;

      // If emergency already dispatched, swallow all deviation notification actions.
      // The panic is already sent — user tapping buttons can't undo or re-trigger it.
      if (alertDispatchedRef.current &&
        ["DEVIATION_SAFE", "DEVIATION_SUSPICIOUS", "DEVIATION_HELP", "SAFETY_YES", "SAFETY_NO"].includes(action)) {
        console.log("[Notif] Alert already dispatched — ignoring post-dispatch action:", action);
        return;
      }

      if (action === "DEVIATION_SAFE") {
        const loc = currentLocationRef.current;
        if (loc) handleBiometricAndReroute(loc);
        // ✅ I'm Safe — reset suspicious counter to zero
        suspiciousFlagRef.current = 0;
        setSuspiciousFlag(0);
        resetDeviationState();

      } else if (action === "DEVIATION_SUSPICIOUS") {
        const next = suspiciousFlagRef.current + 1;
        suspiciousFlagRef.current = next;
        setSuspiciousFlag(next);
        if (currentLocationRef.current) {
          setYellowFlagMarkers(prev => [...prev, { ...currentLocationRef.current, id: Date.now() }]);
        }
        if (next >= 3) {
          triggerEmergencyAlert("Suspicious threshold reached.");
        } else {
          sendSystemNotification("Suspicious Logged", `Suspicious activity flag: ${next}/3`, "SAFETY_CHECK");
          // Open 30 s / 100 m window — suppress next deviation alert
          openSuspiciousWindow();
        }
        resetDeviationState();

      } else if (action === "DEVIATION_HELP") {
        sendPanicAlert("police");
        triggerEmergencyAlert("User requested help via notification.");

      } else if (action === "SAFETY_YES") {
        // Safety check confirmed — verify identity, then start new navigation
        // from current location so the user gets a fresh safe route (orange)
        // while the original green route remains visible for reference.
        const verified = await verifyBiometric();
        if (verified) {
          const loc = currentLocationRef.current;
          if (loc) {
            await sendSystemNotification(
              "✅ Safe — Calculating New Route",
              "Starting fresh navigation from your current location. Orange line is your new path.",
              null
            );
            startReroute(loc);
          } else {
            sendSystemNotification("✅ Verified", "Location unavailable — could not reroute.", null);
          }
          // ✅ I'm Safe — reset suspicious counter to zero
          suspiciousFlagRef.current = 0;
          setSuspiciousFlag(0);
          resetDeviationState();
        } else {
          sendPanicAlert("police");
        }

      } else if (action === "SAFETY_NO") {
        sendPanicAlert("police");
        triggerEmergencyAlert("User reported unsafe via notification.");
      }
    });

    const appStateSub = AppState.addEventListener("change", (nextState) => {
      appState.current = nextState;
    });

    return () => {
      notifSub.remove();
      appStateSub.remove();
    };
  }, []);

  // --- DEVIATION DETECTION ---

  useEffect(() => {
    const startLocationTracking = async () => {
      if (locationSubscriber.current) {
        locationSubscriber.current.remove();
      }

      const locationCallback = (newLocation) => {
        const newCoord = {
          latitude: newLocation.coords.latitude,
          longitude: newLocation.coords.longitude,
        };
        setCurrentLocation(newCoord);
        currentLocationRef.current = newCoord;
        // Close the suspicious-input window early if user has moved ≥ 100 m
        closeSuspiciousWindowIfMoved(newCoord);
        // Cap at TRAVELED_PATH_LIMIT (400) points — enough to draw the traveled polyline
        // without allocating an ever-growing array for multi-hour trips.
        setTraveledPath(prevPath => {
          const next = [...prevPath, newCoord];
          return next.length > TRAVELED_PATH_LIMIT ? next.slice(next.length - TRAVELED_PATH_LIMIT) : next;
        });

        // ── Adaptive accuracy: BALANCED when slow/stopped, HIGH when moving ──────
        // Mirrors spec: getAdaptiveLocation() — avoids GPS drain when stationary.
        const speedKmhForAccuracy = (newLocation.coords.speed != null && newLocation.coords.speed >= 0)
          ? newLocation.coords.speed * 3.6
          : 0;
        const desiredAccuracy = speedKmhForAccuracy < 15
          ? Location.Accuracy.Balanced
          : Location.Accuracy.High;

        // Switch watcher accuracy tier when speed crosses threshold.
        // We track the last tier in a ref to avoid unnecessary restarts every tick.
        if (desiredAccuracy !== activeAccuracyRef.current) {
          activeAccuracyRef.current = desiredAccuracy;
          console.log(`[Location] Switching accuracy to ${desiredAccuracy === Location.Accuracy.High ? "High" : "Balanced"} (speed=${speedKmhForAccuracy.toFixed(0)} km/h)`);
          // Re-start watcher on next tick — don't await here to avoid blocking the callback
          setTimeout(() => startLocationTracking(), 0);
          return; // current callback will be superseded
        }

        const rawSpeed = newLocation.coords.speed;
        if (rawSpeed != null && rawSpeed >= 0) {
          setCurrentSpeedKmh(Math.round(rawSpeed * 3.6));
        }

        const { latitude, longitude } = newLocation.coords;
        setRegion(prev => ({ ...prev, latitude, longitude }));

        // ── Section 3 — ON_LOCATION_UPDATE ────────────────────────────────
        if (_routeSegments.length > 0) {
          const now = Date.now();

          // Hard lock — emergency already dispatched this trip, stop all deviation processing
          if (alertDispatchedRef.current) return;

          // Respect deviation cooldown (don't re-fire while user responds)
          if (lastDeviationTimestamp.current &&
            (now - lastDeviationTimestamp.current) < DEVIATION_COOLDOWN_MS) {
            return;
          }

          const speedKmh = (newLocation.coords.speed != null && newLocation.coords.speed >= 0)
            ? newLocation.coords.speed * 3.6
            : 0;

          // Minimum-speed gate: GPS is too noisy at rest / crawl to detect
          // meaningful deviation. Skip checks entirely below MIN_DEVIATION_SPEED_KMH.
          if (speedKmh < MIN_DEVIATION_SPEED_KMH) {
            deviationCounterRef.current = 0; // reset so we start fresh once moving
            return;
          }

          const threshold = getDynamicThreshold(speedKmh); // Section 4

          const { index: nearestSegIdx, distance: minDistance } =
            getDistanceToNearestSegment(                         // Section 5
              { latitude, longitude },
              _routeSegments,
              lastValidSegmentIndexRef.current  // ← anchor window to last known position
            );

          // Section 6 — heading comparison
          const routeHeading = getBearing(
            _routeSegments[nearestSegIdx].start,
            _routeSegments[nearestSegIdx].end
          );
          const deviceHeading = newLocation.coords.heading ?? -1;
          const headingDiff = Math.abs(routeHeading - deviceHeading) % 360;
          const normHeadingDiff = headingDiff > 180 ? 360 - headingDiff : headingDiff;
          // Heading is only reliable above HEADING_VALID_SPEED_KMH (8 km/h per spec)
          const headingReliable = speedKmh >= HEADING_VALID_SPEED_KMH && deviceHeading >= 0;
          // Compound gate: distance off-route AND (heading wrong OR heading unreliable)
          // Heading facing right direction = driver likely on a parallel road / slow GPS,
          // not a genuine diversion — don't increment the counter.
          const headingWrong = !headingReliable || normHeadingDiff > HEADING_THRESHOLD_DEG;

          if (minDistance > threshold) {
            if (headingWrong) {
              // Off route AND heading confirms it — increment sustained counter (Section 3)
              deviationCounterRef.current += 1;
              console.log(
                `[Deviation] dist=${minDistance.toFixed(0)}m thresh=${threshold}m ` +
                `headingDiff=${normHeadingDiff.toFixed(0)}° counter=${deviationCounterRef.current}`
              );
            } else {
              // Distance off but heading is still correct — likely parallel road or GPS drift.
              // Don't increment; reset counter so we need a fresh run of bad readings.
              deviationCounterRef.current = 0;
              console.log(
                `[Deviation] dist=${minDistance.toFixed(0)}m but heading ok (${normHeadingDiff.toFixed(0)}°) — suppressed`
              );
            }
          } else {
            // On route — reset (Section 3: ELSE branch)
            deviationCounterRef.current = 0;
            isDeviatedRef.current = false;
            setIsDeviated(false);
            lastValidSegmentIndexRef.current = nearestSegIdx;
          }

          // Section 3 — CONFIRM after SUSTAINED_CHECK_COUNT consecutive off-route ticks
          if (deviationCounterRef.current >= SUSTAINED_CHECK_COUNT) {
            if (!isDeviatedRef.current) {
              console.log("[Deviation] Sustained threshold reached — confirming...");
              deviationCounterRef.current = 0;
              confirmDeviation({ latitude, longitude });
            }
          }
        }
      };

      try {
        locationSubscriber.current = await Location.watchPositionAsync(
          { accuracy: activeAccuracyRef.current, timeInterval: LOCATION_UPDATE_INTERVAL, distanceInterval: 10 },
          locationCallback
        );
      } catch (watchErr) {
        console.log("[Location] watchPositionAsync failed, falling back to Balanced:", watchErr.message);
        activeAccuracyRef.current = Location.Accuracy.Balanced;
        locationSubscriber.current = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, timeInterval: LOCATION_UPDATE_INTERVAL, distanceInterval: 15 },
          locationCallback
        );
      }
    };

    if (isTripActive) {
      startLocationTracking();
    }

    return () => {
      if (locationSubscriber.current) {
        locationSubscriber.current.remove();
        locationSubscriber.current = null;
      }
      if (deviationTimeoutRef.current) clearTimeout(deviationTimeoutRef.current);
      if (cooldownTimeoutRef.current) clearTimeout(cooldownTimeoutRef.current);
    };
  }, [isTripActive, routeCoords]);

  const haversineDistance = (coords1, coords2) => {
    const toRad = (x) => (x * Math.PI) / 180;
    const R = 6371e3;
    const dLat = toRad(coords2.latitude - coords1.latitude);
    const dLon = toRad(coords2.longitude - coords1.longitude);
    const lat1 = toRad(coords1.latitude);
    const lat2 = toRad(coords2.latitude);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  // ── Section 7 — CONFIRM_DEVIATION ──────────────────────────────────────────
  // Calls Directions API to check if a "new route" from here is similar to the
  // original route (i.e. the driver may have taken a legitimate detour).
  const confirmDeviation = async (currentCoord) => {
    if (isDeviatedRef.current) return; // already confirmed — skip

    // ── Suspicious-window gate ─────────────────────────────────────────────
    // If the user responded "Suspicious" recently, suppress the next alert
    // until 30 s have elapsed OR they've moved ≥ 100 m.
    if (suspiciousWindowActiveRef.current) {
      console.log("[Deviation] Suppressed — suspicious window still active.");
      return;
    }

    try {
      const currentDest = destinationRef.current;
      const currentMode = vehicleModeRef.current;
      if (currentDest && currentCoord) {
        const origin = `${currentCoord.latitude},${currentCoord.longitude}`;
        const dest = `${currentDest.latitude},${currentDest.longitude}`;
        const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${dest}&mode=${currentMode}&key=${API_KEY}`;
        const res = await fetch(url);
        const data = await res.json();

        if (data.routes?.length > 0) {
          const newRouteCoords = decodePolyline(data.routes[0].overview_polyline.points);
          const similarity = routeSimilarity(newRouteCoords, routeCoords); // Section 8

          if (similarity > REROUTE_SIMILARITY_THRESHOLD) {
            // The driver is probably on a valid alternative — not a real deviation
            console.log(`[Deviation] Reroute similarity ${similarity.toFixed(2)} > threshold — false positive, resetting.`);
            deviationCounterRef.current = 0;
            return;
          }
        }
      }
    } catch (e) {
      console.warn("[Deviation] confirmDeviation reroute check failed:", e.message);
      // Fall through to trigger alert — safer to err on side of caution
    }

    // Step-2: confirmed real deviation — Section 7
    console.log("[Deviation] Confirmed! Triggering alert.");
    lastDeviationTimestamp.current = Date.now();
    isDeviatedRef.current = true;
    setIsDeviated(true);
    handleDeviation(currentCoord);
  };

  const triggerEmergencyAlert = (reason) => {
    // Idempotency guard — once dispatched, never fire again for this trip.
    if (alertDispatchedRef.current) {
      console.log("[Emergency] Alert already dispatched — suppressing duplicate:", reason);
      return;
    }
    alertDispatchedRef.current = true; // ONE-WAY LOCK (in-memory)
    AsyncStorage.setItem("SAFEPATH_ALERT_DISPATCHED", "1"); // ONE-WAY LOCK (background task)
    console.log("[Emergency] 🚨 Dispatching alert:", reason);
    sendSystemNotification(
      "🚨 EMERGENCY TRIGGERED",
      `Reason: ${reason}. Emergency signal sent to Ground Station`,
      null
    );
    sendPanicAlert("police");
  };

  const startBackgroundLocationTask = async () => {
    try {
      const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
      if (isRegistered) await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
      await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
        accuracy: Location.Accuracy.High,
        timeInterval: LOCATION_UPDATE_INTERVAL,
        distanceInterval: 10,
        foregroundService: {
          notificationTitle: "🛡️ SecureOcte – Trip Active",
          notificationBody: "Monitoring your cab route. Tap to return to app.",
          notificationColor: "#27ae60",
        },
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
      });
      console.log("[SecureOcte] Background location task started.");
    } catch (err) {
      console.error("BG task start error:", err);
    }
  };

  const stopBackgroundLocationTask = async () => {
    try {
      const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
      if (isRegistered) await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    } catch (err) {
      console.error("BG task stop error:", err);
    }
  };

  const sendSystemNotification = async (title, body, categoryId) => {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: true,
        priority: Notifications.AndroidNotificationPriority.HIGH,
        ...(categoryId ? { categoryIdentifier: categoryId } : {}),
      },
      trigger: null,
    });
  };

  const verifyBiometric = async () => {
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();
      if (!hasHardware || !isEnrolled) return true;
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Verify your identity to confirm you're safe",
        fallbackLabel: "Use Passcode",
        disableDeviceFallback: false,
      });
      return result.success;
    } catch { return false; }
  };

  const handleBiometricAndReroute = async (fromLocation) => {
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();

      if (!hasHardware || !isEnrolled) {
        Alert.alert("⚠️ Biometric Not Available", "Rerouting from your current location.", [
          { text: "OK", onPress: () => startReroute(fromLocation) },
        ]);
        return;
      }

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Verify your identity to start a new safe route",
        fallbackLabel: "Use Passcode",
        disableDeviceFallback: false,
      });

      if (result.success) {
        await sendSystemNotification(
          "✅ Identity Verified",
          "Calculating new safe route from your current location.",
          null
        );
        startReroute(fromLocation);
      } else {
        Alert.alert(
          "❌ Verification Failed",
          result.error === "user_cancel" ? "Reroute cancelled." : "Biometric failed. Try again.",
          [
            { text: "Try Again", onPress: () => handleBiometricAndReroute(fromLocation) },
            { text: "Cancel" },
          ]
        );
      }
    } catch (err) {
      console.error("Biometric error:", err);
      startReroute(fromLocation);
    }
  };

  const startReroute = async (fromLocation) => {
    const currentDestination = destinationRef.current;
    const currentVehicleMode = vehicleModeRef.current;
    if (!currentDestination) { Alert.alert("No Destination", "Cannot reroute — no destination set."); return; }
    if (!fromLocation?.latitude) { Alert.alert("Location Error", "Cannot determine current location for reroute."); return; }

    setIsRerouting(true);
    try {
      const origin = `${fromLocation.latitude},${fromLocation.longitude}`;
      const dest = `${currentDestination.latitude},${currentDestination.longitude}`;
      let url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${dest}&mode=${currentVehicleMode}&key=${API_KEY}`;
      if (currentVehicleMode === "motorcycle") url += "&avoid=highways";

      const res = await fetch(url);
      const data = await res.json();

      if (data.routes?.length > 0) {
        const newCoords = decodePolyline(data.routes[0].overview_polyline.points);
        // Show new path as orange overlay — original green route stays on map
        setRerouteCoords(newCoords);
        // Do NOT call setRouteCoords — green baseline is preserved for display
        // Deviation detection now tracks the new orange route via segments
        initRouteSegments(newCoords); // Section 2 — re-init after reroute
        deviationCounterRef.current = 0; // reset counter on new route
        await AsyncStorage.setItem("SAFEPATH_ROUTE_COORDS", JSON.stringify(newCoords));
        mapRef.current?.animateToRegion(
          { ...fromLocation, latitudeDelta: 0.05, longitudeDelta: 0.05 },
          800
        );
        await sendSystemNotification(
          "🗺️ New Route Active",
          "Orange line shows your new safe path. Green line is your original planned route.",
          null
        );
      } else {
        Alert.alert("Route Error", `Could not calculate new route. Status: ${data.status}`);
      }
    } catch (err) {
      Alert.alert("Error", `Reroute failed: ${err.message}`);
    } finally {
      setIsRerouting(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  TRAFFIC ANALYSIS  (Google Directions API with departure_time=now)
  // ─────────────────────────────────────────────────────────────────────────
  const analyzeTraffic = async () => {
    const currentLoc = currentLocationRef.current;
    const currentDest = destinationRef.current;
    const currentMode = vehicleModeRef.current;
    if (!currentLoc || !currentDest) return;

    try {
      const origin = `${currentLoc.latitude},${currentLoc.longitude}`;
      const dest = `${currentDest.latitude},${currentDest.longitude}`;
      const url =
        `https://maps.googleapis.com/maps/api/directions/json` +
        `?origin=${origin}&destination=${dest}` +
        `&mode=${currentMode === "motorcycle" ? "driving" : currentMode}` +
        `&departure_time=now` +
        `&traffic_model=best_guess` +
        `&alternatives=true` +
        `&key=${API_KEY}`;

      const res = await fetch(url);
      const data = await res.json();

      if (!data.routes || data.routes.length === 0) return;

      const primaryRoute = data.routes[0];
      const leg = primaryRoute.legs?.[0];
      if (!leg) return;

      const normalDuration = leg.duration?.value ?? 0;
      const trafficDuration = leg.duration_in_traffic?.value ?? normalDuration;
      const ratio = normalDuration > 0 ? trafficDuration / normalDuration : 1;

      let level = "light";
      if (ratio >= 1.5) level = "heavy";
      else if (ratio >= 1.2) level = "moderate";

      setTrafficStatus(level);
      console.log(`[Traffic] ratio=${ratio.toFixed(2)} → ${level}`);

      if (level === "heavy" && data.routes.length > 1 && !trafficAlertShownRef.current) {
        trafficAlertShownRef.current = true;
        setTrafficAlertShown(true);

        const altRoute = data.routes[1];
        const altLeg = altRoute.legs?.[0];
        const altDurationMin = altLeg?.duration_in_traffic?.value
          ? Math.round(altLeg.duration_in_traffic.value / 60)
          : Math.round((altLeg?.duration?.value ?? 0) / 60);
        const altSummary = altRoute.summary || "Alternate route";

        Alert.alert(
          "🚦 Heavy Traffic Detected",
          `Upon heavy traffic a new route is being suggested, have a check.\n\nSuggested: "${altSummary}" (~${altDurationMin} min)`,
          [
            {
              text: "✅ Use New Route",
              onPress: async () => {
                const newCoords = decodePolyline(altRoute.overview_polyline.points);
                setRouteCoords(newCoords);
                setRerouteCoords(newCoords);
                await AsyncStorage.setItem("SAFEPATH_ROUTE_COORDS", JSON.stringify(newCoords));
                await sendSystemNotification(
                  "🗺️ Route Updated",
                  `New route via "${altSummary}" applied due to heavy traffic.`,
                  null
                );
                setTimeout(() => { trafficAlertShownRef.current = false; setTrafficAlertShown(false); }, 600000);
              },
            },
            {
              text: "Keep Current",
              style: "cancel",
              onPress: () => {
                setTimeout(() => { trafficAlertShownRef.current = false; setTrafficAlertShown(false); }, 300000);
              },
            },
          ],
          { cancelable: false }
        );
      }

      if (level !== "heavy" && trafficAlertShownRef.current) {
        trafficAlertShownRef.current = false;
        setTrafficAlertShown(false);
      }
    } catch (e) {
      console.warn("[Traffic] analysis error:", e.message);
    }
  };

  // Run traffic analysis every 2 minutes while trip is active
  useEffect(() => {
    if (!isTripActive) {
      if (trafficCheckIntervalRef.current) {
        clearInterval(trafficCheckIntervalRef.current);
        trafficCheckIntervalRef.current = null;
      }
      setTrafficStatus(null);
      setCurrentSpeedKmh(null);
      trafficAlertShownRef.current = false;
      setTrafficAlertShown(false);
      return;
    }
    const initialTimer = setTimeout(() => analyzeTraffic(), 15000);
    trafficCheckIntervalRef.current = setInterval(() => analyzeTraffic(), TRAFFIC_CHECK_INTERVAL_MS);
    return () => {
      clearTimeout(initialTimer);
      if (trafficCheckIntervalRef.current) {
        clearInterval(trafficCheckIntervalRef.current);
        trafficCheckIntervalRef.current = null;
      }
    };
  }, [isTripActive]);

  // ── Suspicious window helpers ─────────────────────────────────────────────
  // Opens a 30 s / 100 m window after every "Suspicious" input.
  // While the window is active, confirmDeviation() is gated and will not fire
  // a new alert.  The window closes automatically after 30 s; it also closes
  // early inside the location callback once the user has moved ≥ 100 m.
  const openSuspiciousWindow = () => {
    suspiciousWindowActiveRef.current = true;
    suspiciousWindowStartLocRef.current = currentLocationRef.current
      ? { ...currentLocationRef.current }
      : null;

    if (suspiciousWindowTimerRef.current) clearTimeout(suspiciousWindowTimerRef.current);
    suspiciousWindowTimerRef.current = setTimeout(() => {
      suspiciousWindowActiveRef.current = false;
      suspiciousWindowStartLocRef.current = null;
      suspiciousWindowTimerRef.current = null;
      console.log("[SuspiciousWindow] 30 s elapsed — window closed.");
    }, 30000); // 30 seconds
    console.log("[SuspiciousWindow] Opened (30 s / 100 m gate).");
  };

  const closeSuspiciousWindowIfMoved = (currentCoord) => {
    if (!suspiciousWindowActiveRef.current) return;
    const startLoc = suspiciousWindowStartLocRef.current;
    if (!startLoc || !currentCoord) return;
    const dist = haversineStatic(startLoc, currentCoord);
    if (dist >= 100) {
      if (suspiciousWindowTimerRef.current) clearTimeout(suspiciousWindowTimerRef.current);
      suspiciousWindowTimerRef.current = null;
      suspiciousWindowActiveRef.current = false;
      suspiciousWindowStartLocRef.current = null;
      console.log(`[SuspiciousWindow] ≥100 m moved (${dist.toFixed(0)} m) — window closed early.`);
    }
  };

  // Section 11 — RESET_ALL
  const clearDeviationState = () => {
    deviationCounterRef.current = 0;   // Section 1 — deviationCounter reset
    isDeviatedRef.current = false;
    setIsDeviated(false);
    setDeviationLocation(null);
    lastDeviationTimestamp.current = 0;
  };

  // Called when a trip fully ends — wipes all route overlays
  const clearAllRouteState = () => {
    setRouteCoords([]);
    setRerouteCoords([]);
    setOriginalRouteCoords([]);
    setTraveledPath([]);
    _routeSegments = [];
    // Clear suspicious-window timer on trip end
    if (suspiciousWindowTimerRef.current) {
      clearTimeout(suspiciousWindowTimerRef.current);
      suspiciousWindowTimerRef.current = null;
    }
    suspiciousWindowActiveRef.current = false;
    suspiciousWindowStartLocRef.current = null;
    clearDeviationState();
  };

  const resetDeviationState = () => {
    clearTimeout(deviationTimeoutRef.current);
    deviationTimeoutRef.current = null;
    setDeviationLocation(null);
    if (cooldownTimeoutRef.current) clearTimeout(cooldownTimeoutRef.current);
    cooldownTimeoutRef.current = setTimeout(() => {
      clearDeviationState();
    }, DEVIATION_COOLDOWN_MS);
  };

  const handleDeviation = (deviatedCoord) => {
    setDeviationLocation(deviatedCoord);

    Notifications.scheduleNotificationAsync({
      content: {
        title: "❗ Route Deviation Detected",
        body: "You appear to be off your route. Open the app to respond.",
        sound: true,
        categoryIdentifier: "deviation",
        data: { type: "deviation" },
      },
      trigger: null,
    }).catch(e => console.log("[Deviation] notify error:", e.message));

    if (deviationTimeoutRef.current) clearTimeout(deviationTimeoutRef.current);
    deviationTimeoutRef.current = setTimeout(() => {
      deviationTimeoutRef.current = null;
      // Lock check — alert may have been dispatched while waiting for user response
      if (alertDispatchedRef.current) return;
      const newFlag = suspiciousFlagRef.current + 1;
      suspiciousFlagRef.current = newFlag;
      setSuspiciousFlag(newFlag);
      setDeviationLocation(null);
      if (currentLocationRef.current) {
        setYellowFlagMarkers(prev => [...prev, { ...currentLocationRef.current, id: Date.now() }]);
      }
      console.log(`[Deviation] No response — flag now ${newFlag}`);

      if (newFlag >= 3) {
        triggerEmergencyAlert("No response to 3 consecutive deviations.");
        return;
      }

      Notifications.scheduleNotificationAsync({
        content: {
          title: "⚠️ No Response",
          body: `Suspicious activity flag: ${newFlag}/3. Please respond via the app.`,
          sound: true,
        },
        trigger: null,
      }).catch(() => { });

      if (cooldownTimeoutRef.current) clearTimeout(cooldownTimeoutRef.current);
      cooldownTimeoutRef.current = setTimeout(() => {
        clearDeviationState();
      }, DEVIATION_COOLDOWN_MS);
    }, NO_RESPONSE_TIMEOUT);

    Alert.alert(
      "❗ Route Deviation",
      "You appear to be off your projected route. Is everything okay?",
      [
        {
          text: "🆘 Need Help",
          onPress: () => {
            clearTimeout(deviationTimeoutRef.current);
            deviationTimeoutRef.current = null;
            sendPanicAlert("police");
            triggerEmergencyAlert("User requested help after route deviation.");
          },
        },
        {
          text: "🤨 Suspicious",
          onPress: () => {
            clearTimeout(deviationTimeoutRef.current);
            deviationTimeoutRef.current = null;
            const newFlag = suspiciousFlagRef.current + 1;
            suspiciousFlagRef.current = newFlag;
            setSuspiciousFlag(newFlag);
            setDeviationLocation(null);
            if (currentLocationRef.current) {
              setYellowFlagMarkers(prev => [...prev, { ...currentLocationRef.current, id: Date.now() }]);
            }
            if (newFlag >= 3) {
              triggerEmergencyAlert("Suspicion threshold of 3 reached.");
            } else {
              Alert.alert("Logged", `Suspicion flag: ${newFlag}/3`);
              // Open 30 s / 100 m window — suppress next deviation alert
              openSuspiciousWindow();
            }
            if (cooldownTimeoutRef.current) clearTimeout(cooldownTimeoutRef.current);
            cooldownTimeoutRef.current = setTimeout(clearDeviationState, DEVIATION_COOLDOWN_MS);
          },
        },
        {
          text: "✅ I'm Safe",
          style: "cancel",
          onPress: () => {
            clearTimeout(deviationTimeoutRef.current);
            deviationTimeoutRef.current = null;
            // ✅ I'm Safe — reset suspicious counter to zero
            suspiciousFlagRef.current = 0;
            setSuspiciousFlag(0);
            setDeviationLocation(null);
            if (cooldownTimeoutRef.current) clearTimeout(cooldownTimeoutRef.current);
            cooldownTimeoutRef.current = setTimeout(clearDeviationState, DEVIATION_COOLDOWN_MS);
          },
        },
      ],
      { cancelable: false }
    );
  };

  const sendPanicAlert = async (type) => {
    try {
      // Resolve tripId — prefer React state, fall back to AsyncStorage (background task context)
      let resolvedTripId = tripIdRef.current || tripId;
      if (!resolvedTripId) {
        resolvedTripId = await AsyncStorage.getItem("SAFEPATH_TRIP_ID");
      }

      if (!resolvedTripId) {
        console.warn("[sendPanicAlert] No active tripId found — cannot send police support alert.");
        Alert.alert("⚠️ No Active Trip", "A trip must be started before requesting police support.");
        return;
      }

      // Always send the live GPS coordinate so the alert document is pinned
      // to where the user IS now, not where the DB last saved them.
      const liveLoc = currentLocationRef.current;
      const response = await fetch(`${BACKEND_URL}/api/cab-escort/police-support`, {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({
          tripId: resolvedTripId,
          ...(liveLoc ? { currentLocation: { latitude: liveLoc.latitude, longitude: liveLoc.longitude } } : {}),
        }),
      });
      const text = await response.text();
      console.log("Police support API response:", response.status, text);

      let parsed = null;
      try { parsed = JSON.parse(text); } catch (_) { }

      if (response.ok && parsed?.success === true) {
        setPoliceSupportSent(true);
        if (currentLocationRef.current) {
          setRedFlagMarkers(prev => [...prev, { ...currentLocationRef.current, id: Date.now() }]);
        }
        Alert.alert(
          "✅ Alert Sent",
          type === "police" ? "Police have been notified!" : "Driver report submitted!"
        );
        console.log("[Police Support] Trip ID:", resolvedTripId, "| policeSupportRequested: true");
      } else {
        const errMsg = parsed?.msg || parsed?.error || text;
        Alert.alert("❌ Failed", `Unable to send alert.\n${errMsg}`);
      }
    } catch (error) {
      console.error("Error sending police support alert:", error);
      Alert.alert("⚠️ Error", "Something went wrong while sending the alert.");
    }
  };

  const getAutocompletePredictions = async (text) => {
    if (text.length < 3) { setPredictions([]); return; }
    const locationBias = region ? `&location=${region.latitude}%2C${region.longitude}&radius=50000` : "";
    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(text)}&key=${API_KEY}${locationBias}`;
    try {
      const response = await fetch(url);
      const data = await response.json();
      setPredictions(data.status === "OK" ? data.predictions : []);
    } catch (error) { console.error("Autocomplete error:", error); }
  };

  const getPlaceDetails = async (placeId) => {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=geometry&key=${API_KEY}`;
    try {
      const response = await fetch(url);
      const data = await response.json();
      return (data.status === "OK" && data.result.geometry) ? data.result.geometry.location : null;
    } catch (error) {
      console.error("Place Details error:", error);
      return null;
    }
  };

  const fetchRoute = async (originCoords, destCoords, mode, avoidHighways = false) => {
    try {
      const origin = `${originCoords.latitude},${originCoords.longitude}`;
      const dest = `${destCoords.latitude},${destCoords.longitude}`;
      let url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${dest}&mode=${mode}&key=${API_KEY}`;
      if (avoidHighways) url += '&avoid=highways';
      const res = await fetch(url);
      const data = await res.json();
      if (data.routes.length > 0) {
        const coords = decodePolyline(data.routes[0].overview_polyline.points);
        setRouteCoords(coords);
        // Snapshot the very first planned route as the permanent green baseline
        setOriginalRouteCoords(prev => prev.length === 0 ? coords : prev);
        initRouteSegments(coords); // Section 2 — INIT_ROUTE
        await AsyncStorage.setItem("SAFEPATH_ROUTE_COORDS", JSON.stringify(coords));
        return true;
      }
      if (data.status === 'ZERO_RESULTS') {
        Alert.alert("Route Not Found", `Could not find a route for the selected vehicle type (${mode}). Please try another mode or destination.`);
      }
      return false;
    } catch (err) {
      console.error("Fetch route error:", err);
      return false;
    }
  };

  const onSearchTextChange = (text, inputType) => {
    if (inputType === 'main') setInput(text);
    else setMapPickerSearchInput(text);
    if (debounceTimeout.current) clearTimeout(debounceTimeout.current);
    debounceTimeout.current = setTimeout(() => getAutocompletePredictions(text), 400);
  };

  const onPredictionSelect = async (prediction) => {
    const loc = await getPlaceDetails(prediction.place_id);
    if (!loc) { Alert.alert("Error", "Could not get location details."); return; }
    const newDestination = { latitude: loc.lat, longitude: loc.lng };
    if (activeInput === 'main') {
      setInput(prediction.description);
      setDestination(newDestination);
    } else if (activeInput === 'mapPicker') {
      setMapPickerSearchInput(prediction.description);
      setTempDestination(newDestination);
      mapRef.current?.animateToRegion(
        { latitude: newDestination.latitude, longitude: newDestination.longitude, latitudeDelta: 0.01, longitudeDelta: 0.01 },
        1000
      );
    }
    setPredictions([]);
    Keyboard.dismiss();
  };

  const handleManualSearch = async () => {
    Keyboard.dismiss();
    const searchText = activeInput === 'mapPicker' ? mapPickerSearchInput : input;
    if (searchText.length < 2) return;
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(searchText)}&key=${API_KEY}`;
    try {
      const response = await fetch(url);
      const data = await response.json();
      if (data.status === 'OK' && data.results[0]) {
        const { lat, lng } = data.results[0].geometry.location;
        const newDestination = { latitude: lat, longitude: lng };
        if (activeInput === 'mapPicker') {
          setTempDestination(newDestination);
          mapRef.current?.animateToRegion({ ...newDestination, latitudeDelta: 0.01, longitudeDelta: 0.01 }, 1000);
        }
      } else { Alert.alert("Not found", "Could not find that location."); }
    } catch (error) { console.error("Manual search error:", error); }
    setPredictions([]);
  };

  // ============================
  // ✅ BACKEND LIVE ESCORT HELPERS
  // ============================

  const startTripInBackend = async (current, dest) => {
    try {
      const payload = {
        destination: dest,
        vehicleNumber: vehicleNumberInput || "",
        vehicleType: vehicleMode,
        currentLocation: current,
        username: user?.username || user?.name || "",
      };
      console.log("[CabMonitoring] startTripInBackend payload:", JSON.stringify(payload));
      console.log("[CabMonitoring] token present:", !!tokenRef.current);

      const res = await fetch(`${BACKEND_URL}/api/cab-escort/start`, {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify(payload),
      });

      const text = await res.text();
      console.log("[CabMonitoring] /start response:", res.status, text);

      let data;
      try { data = JSON.parse(text); } catch (_) { data = {}; }

      if (!res.ok) {
        console.error("[CabMonitoring] /start failed:", res.status, data?.error);
        return null;
      }
      if (!data?.trip?._id) {
        console.error("[CabMonitoring] /start — no trip._id in response:", data);
        return null;
      }
      console.log("[CabMonitoring] 🚕 Trip started — tripId:", data.trip._id);
      return data.trip._id;
    } catch (err) {
      console.error("Start trip backend error:", err);
      return null;
    }
  };

  const updateLiveLocationBackend = async (lat, lng) => {
    // Always resolve tripId from ref (never stale, even mid-alert)
    const resolvedTripId = tripIdRef.current;
    if (!resolvedTripId) return;
    try {
      await rawFetchWithSecurity(`${BACKEND_URL}/api/cab-escort/update-location`, {
        method: "POST",
        body: { tripId: resolvedTripId, latitude: lat, longitude: lng },
      });
    } catch (err) {
      console.error("Live update error:", err);
    }

    // Fire-and-forget socket push for real-time dashboard tracking —
    // the REST POST above remains the source of truth for the
    // CabEscortTrip record; this is an additive faster channel.
    emitLocationUpdate({ lat, lng, type: "cab" });
  };

  const sendPoliceSupportBackend = async () => {
    /* 3-level tripId resolution: ref (immediate) → state → AsyncStorage (bg context) */
    let resolvedTripId = tripIdRef.current || tripId;
    if (!resolvedTripId) {
      resolvedTripId = await AsyncStorage.getItem("SAFEPATH_TRIP_ID");
    }
    if (!resolvedTripId) {
      Alert.alert("Trip not active", "Please start a trip before requesting police support.");
      return;
    }
    try {
      // Always send the live GPS coordinate so the alert document is pinned
      // to where the user IS now, not where the DB last saved them.
      const liveLoc = currentLocationRef.current;
      const response = await fetch(`${BACKEND_URL}/api/cab-escort/police-support`, {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({
          tripId: resolvedTripId,
          ...(liveLoc ? { currentLocation: { latitude: liveLoc.latitude, longitude: liveLoc.longitude } } : {}),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        setPoliceSupportSent(true);
        if (currentLocationRef.current) {
          setRedFlagMarkers(prev => [...prev, { ...currentLocationRef.current, id: Date.now() }]);
        }
        Alert.alert("🚨 Police Support Sent", "Trip details forwarded successfully.");
      } else {
        Alert.alert("❌ Failed", data?.error || "Unable to send police support alert.");
      }
    } catch (err) {
      console.error("Police support error:", err);
      Alert.alert("Error", "Failed to contact backend.");
    }
  };

  // ── LIVE STREAM — mirrors police dashboard createStream logic ─────────────
  const handleShareTrip = async () => {
    const userId = user?.username || user?.id || user?._id;
    if (!userId) {
      Alert.alert("Error", "User not identified. Cannot create stream.");
      return;
    }

    if (isStreaming && streamUrl) {
      setShowStreamModal(true);
      return;
    }

    setIsCreatingStream(true);
    try {
      const response = await fetch(`${BACKEND_URL}/api/stream/create`, {
        method: "POST",
        headers: authHeader(),   // FIX: was { "Content-Type": "application/json" } — missing Authorization + X-Device-Id
        body: JSON.stringify({ userId }),
      });
      const data = await response.json();

      if (!data?.streamId || !data?.streamUrl) {
        Alert.alert("Stream Error", "Backend did not return a stream URL. Please try again.");
        return;
      }

      setStreamId(data.streamId);
      setStreamUrl(data.streamUrl);
      setIsStreaming(true);
      setShowStreamModal(true);

      try { Clipboard.setString(data.streamUrl); } catch (e) { }

      console.log("[Stream] Created:", data.streamId, data.streamUrl);
    } catch (err) {
      console.error("[Stream] create error:", err);
      Alert.alert("Stream Error", "Failed to create live stream. Check your connection.");
    } finally {
      setIsCreatingStream(false);
    }
  };

  const stopStream = () => {
    setStreamId(null);
    setStreamUrl(null);
    setIsStreaming(false);
    setShowStreamModal(false);
  };

  const nativeShareStream = async (url, uid) => {
    try {
      await Share.share({
        message: `🚨 LIVE TRIP TRACKING\nUser: ${uid}\n${url}`,
        title: "Live Trip Tracking",
      });
    } catch (e) {
      console.error("[Stream] share error:", e);
    }
  };

  // ── Live-location stream while trip is active ────────────────────────────
  // Uses currentLocationRef (continuously updated by watchPositionAsync) so
  // the coords are always the latest GPS reading — not a one-shot fetch.
  // The interval adapts to the server-driven mode (normal=15 s, alert=5 s)
  // by listening to onModeChange, mirroring the pattern in useWalkEngine.js.
  const cabLocationTimerRef  = useRef(null);
  const cabModeUnsubRef      = useRef(null);

  useEffect(() => {
    if (!tripId || !isTripActive) {
      // Clean up if the trip just ended
      if (cabLocationTimerRef.current)  clearInterval(cabLocationTimerRef.current);
      if (cabModeUnsubRef.current)      cabModeUnsubRef.current();
      cabLocationTimerRef.current = null;
      cabModeUnsubRef.current     = null;
      return;
    }

    const _sendNow = () => {
      const loc = currentLocationRef.current;
      if (loc?.latitude != null && loc?.longitude != null) {
        updateLiveLocationBackend(loc.latitude, loc.longitude);
      }
    };

    const armTimer = (intervalMs) => {
      if (cabLocationTimerRef.current) clearInterval(cabLocationTimerRef.current);
      // Fire once immediately on arm, then on the given cadence
      _sendNow();
      cabLocationTimerRef.current = setInterval(_sendNow, intervalMs || 5000);
      console.log(`[CabLocation] ⏱ Stream interval set to ${intervalMs || 5000} ms`);
    };

    // Start at the current server-assigned interval (already "alert" if mode
    // was switched before the trip start, or "normal" 15 s otherwise)
    armTimer(getLocationInterval());

    // Re-arm whenever the backend changes the mode (e.g. alert triggered)
    if (cabModeUnsubRef.current) cabModeUnsubRef.current();
    cabModeUnsubRef.current = onModeChange(({ interval }) => {
      if (tripIdRef.current) {
        console.log(`[CabLocation] 🔔 Mode change received — re-arming at ${interval} ms`);
        armTimer(interval);
      }
    });

    return () => {
      if (cabLocationTimerRef.current) clearInterval(cabLocationTimerRef.current);
      if (cabModeUnsubRef.current)     cabModeUnsubRef.current();
      cabLocationTimerRef.current = null;
      cabModeUnsubRef.current     = null;
    };
  }, [tripId, isTripActive]);

  const completeTripBackend = async () => {
    if (!tripId) return;
    try {
      await fetch(`${BACKEND_URL}/api/cab-escort/complete/${tripId}`, {
        method: "POST",
        headers: authHeader(),   // FIX: was missing Authorization + X-Device-Id
      });
      console.log("✅ Trip marked completed in backend");
      setTripId(null);
    } catch (err) {
      console.error("Complete trip error:", err);
    }
  };

  const handleStartTrip = async () => {
    if (missingIdVideo) {
      Alert.alert("Pending Report", "Please submit or cancel your video report before starting a trip.");
      return;
    }
    if (!destination) { Alert.alert("Destination Required", "Please select a destination."); return; }

    // Reset the one-way emergency lock for each new trip
    alertDispatchedRef.current = false;
    AsyncStorage.removeItem("SAFEPATH_ALERT_DISPATCHED");
    AsyncStorage.removeItem("SAFEPATH_BG_DEV_COUNTER"); // reset BG deviation counter
    // Reset adaptive accuracy for fresh trip
    activeAccuracyRef.current = Location.Accuracy.Balanced;

    const providerStatus = await Location.getProviderStatusAsync();
    if (!providerStatus.locationServicesEnabled) {
      Alert.alert("Location Services Off", "Please enable Location Services in your phone's Settings → Location, then try again.");
      return;
    }

    try {
      const loc = await getReliableLocation(Location.Accuracy.High, 15000);
      const current = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };

      const latitudeDelta = region?.latitudeDelta ?? 0.01;
      const longitudeDelta = region?.longitudeDelta ?? 0.01;
      const newRegion = { latitude: current.latitude, longitude: current.longitude, latitudeDelta, longitudeDelta };
      setRegion(newRegion);
      mapRef.current?.animateToRegion(newRegion, 500);

      const shouldAvoidHighways = vehicleMode === 'motorcycle';
      const routeFetched = await fetchRoute(current, destination, vehicleMode, shouldAvoidHighways);
      if (routeFetched) {
        setIsTripActive(true);

        const newTripId = await startTripInBackend(current, destination);
        if (newTripId) {
          tripIdRef.current = newTripId;   // set immediately — don't wait for re-render
          setTripId(newTripId);
          await AsyncStorage.setItem("SAFEPATH_TRIP_ID", newTripId);
        }

        suspiciousFlagRef.current = 0;
        setSuspiciousFlag(0);
        isDeviatedRef.current = false;
        setIsDeviated(false);
        setDeviationLocation(null);
        setRerouteCoords([]);

        await startBackgroundLocationTask();

        await sendSystemNotification(
          "🛡️ Trip Escort Started",
          "Monitoring your journey. Minimise the app — tracking continues in background.",
          null
        );
      } else {
        Alert.alert("Route Error", "Unable to fetch route from your current location.");
      }
    } catch (err) {
      console.error("Error getting current location for trip start:", err);
      Alert.alert("Location Error", "Unable to get current location. Please ensure location services are enabled and try again.");
    }
  };

  const _doTripTeardown = async () => {
    await completeTripBackend();
    await stopBackgroundLocationTask();
    await AsyncStorage.removeItem("SAFEPATH_TRIP_ID");
    await AsyncStorage.removeItem("SAFEPATH_ROUTE_COORDS");
    await AsyncStorage.removeItem("SAFEPATH_BG_DEV_COUNTER"); // reset BG deviation counter

    if (deviationTimeoutRef.current) clearTimeout(deviationTimeoutRef.current);
    if (cooldownTimeoutRef.current) clearTimeout(cooldownTimeoutRef.current);
    // Clear suspicious window timer
    if (suspiciousWindowTimerRef.current) clearTimeout(suspiciousWindowTimerRef.current);
    suspiciousWindowTimerRef.current = null;
    suspiciousWindowActiveRef.current = false;
    suspiciousWindowStartLocRef.current = null;
    // Reset adaptive accuracy to conservative default for next trip
    activeAccuracyRef.current = Location.Accuracy.Balanced;

    setIsTripActive(false);
    setDestination(null);
    setTempDestination(null);
    setRouteCoords([]);
    setRerouteCoords([]);
    setOriginalRouteCoords([]);
    _routeSegments = [];
    setInput("");
    setPredictions([]);
    setDriverIdPhoto(null);
    setMissingIdVideo(null);
    setReportSubmitted(false);
    setVehicleNumberInput('');
    suspiciousFlagRef.current = 0;
    setSuspiciousFlag(0);
    setYellowFlagMarkers([]);
    setRedFlagMarkers([]);
    isDeviatedRef.current = false;
    setIsDeviated(false);
    setDeviationLocation(null);
    setTraveledPath([]);
    lastDeviationTimestamp.current = 0;

    await sendSystemNotification("✅ Trip Ended", "Your cab escort session has ended safely.", null);
    stopStream();
  };

  const handleCancelTrip = async () => {
    const isEmergency = arguments[0] === "__emergency__";
    if (isEmergency) { await _doTripTeardown(); return; }

    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();

      if (!hasHardware || !isEnrolled) {
        Alert.alert(
          "End Trip?",
          "Are you sure you want to end the trip escort?",
          [
            { text: "Yes, End Trip", style: "destructive", onPress: _doTripTeardown },
            { text: "No, Continue", style: "cancel" },
          ]
        );
        return;
      }

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Verify your identity to end the trip escort",
        fallbackLabel: "Use Passcode",
        disableDeviceFallback: false,
      });

      if (result.success) {
        const currentLoc = currentLocationRef.current;
        if (currentLoc && rerouteCoords.length === 0 && routeCoords.length > 0) {
          const offRoute = isOffRouteStatic(currentLoc);
          if (offRoute) {
            Alert.alert(
              "You appear to be off-route",
              "Would you like a new route to your destination, or end the trip?",
              [
                { text: "🗺️ New Route", onPress: () => startReroute(currentLoc) },
                { text: "❌ End Trip", style: "destructive", onPress: _doTripTeardown },
              ]
            );
            return;
          }
        }
        await _doTripTeardown();
      } else {
        if (result.error !== "user_cancel") {
          Alert.alert(
            "❌ Verification Failed",
            "Could not verify your identity. Trip continues for your safety.",
            [
              { text: "Try Again", onPress: handleCancelTrip },
              { text: "Keep Trip Active", style: "cancel" },
            ]
          );
        }
      }
    } catch (err) {
      console.error("Cancel trip biometric error:", err);
      await _doTripTeardown();
    }
  };

  const metersToLatitudeDelta = (meters) => meters / 111320;
  const metersToLongitudeDelta = (meters, latitude) => meters / (111320 * Math.cos(latitude * Math.PI / 180));

  const zoomToMyLocation = async () => {
    try {
      const loc = await getReliableLocation(Location.Accuracy.Balanced, 10000);
      const { latitude, longitude } = loc.coords;
      const spanMeters = 200;
      const latitudeDelta = metersToLatitudeDelta(spanMeters);
      const longitudeDelta = metersToLongitudeDelta(spanMeters, latitude);
      const newRegion = { latitude, longitude, latitudeDelta, longitudeDelta };
      setRegion(newRegion);
      mapRef.current?.animateToRegion(newRegion, 500);
    } catch (err) {
      console.error("Zoom to location error:", err);
      Alert.alert("Location Error", "Unable to get current location.");
    }
  };

  const handleConfirmDestination = async () => {
    if (!tempDestination) { Alert.alert("No destination selected", "Please tap on the map or search for a location."); return; }
    setDestination(tempDestination);
    try {
      const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${tempDestination.latitude},${tempDestination.longitude}&key=${API_KEY}`);
      const data = await res.json();
      if (data.status === "OK" && data.results[0]) setInput(data.results[0].formatted_address);
      else setInput("Custom Location");
    } catch (error) { setInput("Custom Location"); }
    setTempDestination(null);
    setIsMapPickerVisible(false);

    if (routeData?.onDestinationSelected) {
      routeData.onDestinationSelected();
    }
  };

  // ─── Police Station Markers ──────────────────────────────────────────────────
  const renderPoliceMarkers = () =>
    policeStations.map((station) => (
      <Marker
        key={station.place_id}
        coordinate={{ latitude: station.latitude, longitude: station.longitude }}
        anchor={{ x: 0.5, y: 0.5 }}
        zIndex={10}
        onPress={() => setSosStation(station)}
      >
        <View style={styles.policeMarkerBadge}>
          <Text style={styles.policeMarkerEmoji}>🚔</Text>
        </View>
      </Marker>
    ));

  // ─── Handle SOS Tap ─────────────────────────────────────────────────────────
  const handleSOSTap = async (station) => {
    if (sosSending) return;
    setSosSending(true);
    try {
      const loc = currentLocationRef.current;
      const ok = await sendSOSAlert({
        userId: user?._id ?? user?.id ?? "unknown",
        latitude: loc?.latitude ?? station.latitude,
        longitude: loc?.longitude ?? station.longitude,
        stationName: station.name,
      });
      if (ok) {
        Alert.alert(
          "🆘 SOS Sent",
          `Emergency alert sent. Nearest station: ${station.name}`,
          [{ text: "OK", onPress: () => setSosStation(null) }]
        );
      } else {
        Alert.alert("Error", "Could not send SOS. Please call emergency services directly.");
      }
    } catch (e) {
      console.error("[handleSOSTap]", e);
      Alert.alert("Error", "Could not send SOS. Please call emergency services directly.");
    } finally {
      setSosSending(false);
    }
  };

  // ─── SOS Bottom Sheet ────────────────────────────────────────────────────────
  const renderSOSSheet = () => {
    if (!sosStation) return null;
    return (
      <View style={styles.sosSheet}>
        <TouchableOpacity style={styles.sosCloseBtn} onPress={() => setSosStation(null)}>
          <Text style={styles.sosCloseBtnText}>✕</Text>
        </TouchableOpacity>
        <View style={styles.sosStationInfo}>
          <Text style={styles.sosStationEmoji}>🚔</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.sosStationName} numberOfLines={2}>{sosStation.name}</Text>
            {sosStation.vicinity ? (
              <Text style={styles.sosStationAddress} numberOfLines={2}>{sosStation.vicinity}</Text>
            ) : null}
          </View>
        </View>
        <View style={styles.sosDivider} />
        <TouchableOpacity
          style={styles.sosNavBtn}
          onPress={() => {
            const label = encodeURIComponent(sosStation.name);
            const url = Platform.select({
              ios: `maps:0,0?q=${label}@${sosStation.latitude},${sosStation.longitude}`,
              android: `geo:0,0?q=${sosStation.latitude},${sosStation.longitude}(${label})`,
            });
            Linking.openURL(url).catch(() =>
              Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${sosStation.latitude},${sosStation.longitude}&travelmode=driving`)
            );
          }}
        >
          <Text style={styles.sosNavBtnText}>🗺️  Navigate Here</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.sosEmergencyBtn, sosSending && styles.sosEmergencyBtnDisabled]}
          onPress={() => handleSOSTap(sosStation)}
          disabled={sosSending}
          activeOpacity={0.8}
        >
          <Text style={styles.sosEmergencyBtnText}>
            {sosSending ? "⏳  Sending SOS..." : "🆘  Request support"}
          </Text>
        </TouchableOpacity>
        <Text style={styles.sosHint}>Sends your live location to emergency services</Text>
      </View>
    );
  };

  // ─── Setup Screen ───────────────────────────────────────────────────────────
  const renderSetupScreen = () => (
    <View style={styles.setupRoot}>
      <StatusBar barStyle="dark-content" backgroundColor="#f0f4f0" />

      <View style={styles.setupHeader}>
        <TouchableOpacity onPress={goBack} style={styles.backBtn}>
          <Text style={styles.backArrow}>←</Text>
        </TouchableOpacity>
        <Text style={styles.setupHeaderTitle}>Cab Monitoring</Text>
        <View style={styles.shieldBadge}>
          <Text style={styles.shieldIcon}>🛡️</Text>
        </View>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.setupContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

        {inZone && (
          <View style={styles.secureMeBanner}>
            <View style={{ flex: 1 }}>
              <Text style={styles.secureMeTitle}>🔐 SecureMe Mode</Text>
              <Text style={styles.secureMeSub}>
                {secureMeOn ? "Active — sensors running" : "You're in a high-risk zone"}
              </Text>
            </View>
            <Switch
              value={secureMeOn}
              onValueChange={toggleSecureMe}
              trackColor={{ false: "#ccc", true: "#13ec49" }}
              thumbColor={secureMeOn ? "#fff" : "#888"}
            />
          </View>
        )}

        <Text style={styles.fieldLabel}>VEHICLE NUMBER <Text style={styles.optional}>(Optional)</Text></Text>
        <View style={styles.inputCard}>
          <TextInput
            style={styles.fieldInput}
            placeholder="e.g. TS09PA1234"
            placeholderTextColor="#aab"
            value={vehicleNumberInput}
            onChangeText={setVehicleNumberInput}
            autoCapitalize="characters"
          />
          <Text style={styles.inputIcon}>🚗</Text>
        </View>

        <Text style={styles.fieldLabel}>DESTINATION</Text>
        <View style={styles.inputCard}>
          <TextInput
            style={styles.fieldInput}
            placeholder="Where are you going?"
            placeholderTextColor="#aab"
            value={input}
            onChangeText={(text) => onSearchTextChange(text, "main")}
            onFocus={() => setActiveInput("main")}
          />
          <Text style={styles.inputIcon}>📍</Text>
        </View>
        {activeInput === "main" && predictions.length > 0 && (
          <View style={styles.predictionsList}>
            {predictions.map((item) => (
              <TouchableOpacity
                key={item.place_id}
                style={styles.predictionRow}
                onPress={() => onPredictionSelect(item)}
              >
                <Text style={styles.predictionText}>{item.description}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <TouchableOpacity style={styles.mapChooseRow} onPress={() => setIsMapPickerVisible(true)}>
          <Text style={styles.mapChooseText}>📍  Choose on Map</Text>
        </TouchableOpacity>

        <Text style={styles.fieldLabel}>SELECT VEHICLE TYPE</Text>
        <View style={styles.vehicleRow}>
          <TouchableOpacity
            style={[styles.vehicleCard, vehicleMode === "driving" && styles.vehicleCardActive]}
            onPress={() => setVehicleMode("driving")}
          >
            <Text style={styles.vehicleEmoji}>🚗</Text>
            <Text style={[styles.vehicleLabel, vehicleMode === "driving" && styles.vehicleLabelActive]}>CAR</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.vehicleCard, vehicleMode === "motorcycle" && styles.vehicleCardActive]}
            onPress={() => setVehicleMode("motorcycle")}
          >
            <Text style={styles.vehicleEmoji}>🏍️</Text>
            <Text style={[styles.vehicleLabel, vehicleMode === "motorcycle" && styles.vehicleLabelActive]}>AUTO/BIKE</Text>
          </TouchableOpacity>
        </View>

        <View style={{ height: 120 }} />
      </ScrollView>

      <View style={styles.setupFooter}>
        <TouchableOpacity style={styles.startTripBtn} onPress={handleStartTrip} activeOpacity={0.88}>
          <Text style={styles.startTripIcon}>▶</Text>
          <Text style={styles.startTripText}>START TRIP</Text>
        </TouchableOpacity>
        <Text style={styles.setupFooterNote}>
          By starting the trip, your location and cab details will be shared with Command Control Room until you reach your destination.
        </Text>
      </View>
    </View>
  );

  // ─── Map Picker Screen ───────────────────────────────────────────────────────
  const renderMapPickerScreen = () => (
    <View style={styles.mapPickerRoot}>
      {region && (
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFillObject}
          initialRegion={region}
          showsUserLocation={true}
          showsMyLocationButton={false}
          onPress={(e) => setTempDestination(e.nativeEvent.coordinate)}
        >
          {currentLocation && (
            <Marker coordinate={currentLocation} anchor={{ x: 0.5, y: 0.5 }}>
              <Text style={{ fontSize: 24 }}>{vehicleMode === "driving" ? "🚗" : "🏍️"}</Text>
            </Marker>
          )}
          {tempDestination && <Marker coordinate={tempDestination} />}
        </MapView>
      )}

      <View style={styles.mapPickerSearch}>
        <View style={styles.mapPickerSearchBar}>
          <TextInput
            style={styles.mapPickerInput}
            placeholder="Search for an area..."
            placeholderTextColor="#999"
            value={mapPickerSearchInput}
            onChangeText={(text) => onSearchTextChange(text, "mapPicker")}
            onFocus={() => setActiveInput("mapPicker")}
          />
          <TouchableOpacity onPress={handleManualSearch} style={styles.mapPickerSearchBtn}>
            <Text style={styles.mapPickerSearchBtnText}>Search</Text>
          </TouchableOpacity>
        </View>
        {activeInput === "mapPicker" && predictions.length > 0 && (
          <View style={styles.predictionsList}>
            {predictions.map((item) => (
              <TouchableOpacity
                key={item.place_id}
                style={styles.predictionRow}
                onPress={() => onPredictionSelect(item)}
              >
                <Text style={styles.predictionText}>{item.description}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>

      <TouchableOpacity style={styles.findMeBtn} onPress={zoomToMyLocation}>
        <Text style={{ fontSize: 20 }}>📍</Text>
      </TouchableOpacity>

      <View style={styles.mapPickerControls}>
        <TouchableOpacity style={styles.mapPickerBack} onPress={() => setIsMapPickerVisible(false)}>
          <Text style={styles.mapPickerBtnText}>← Back</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.mapPickerConfirm, !tempDestination && { opacity: 0.5 }]}
          onPress={handleConfirmDestination}
          disabled={!tempDestination}
        >
          <Text style={styles.mapPickerBtnText}>Confirm Pin ✓</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  // ─── Tracking Screen ────────────────────────────────────────────────────────
  const renderTrackingScreen = () => (
    <View style={styles.trackingRoot}>
      <StatusBar barStyle="dark-content" backgroundColor="#fff" />

      <View style={styles.trackingTopCard}>
        <View style={{ flex: 1 }}>
          <Text style={styles.trackingVehicle}>
            {vehicleNumberInput || (vehicleMode === "driving" ? "CAR TRIP" : "AUTO/BIKE TRIP")}
          </Text>
          <View style={styles.monitoringRow}>
            <View style={styles.monitoringDot} />
            <Text style={styles.monitoringLabel}>ACTIVE MONITORING</Text>
          </View>
        </View>
        <View style={styles.etaBadge}>
          <Text style={styles.etaLabel}>ETA</Text>
          <Text style={styles.etaValue}>{suspiciousFlag > 0 ? `⚠️ ${suspiciousFlag}/3` : "Live"}</Text>
        </View>
      </View>

      <View style={styles.trackingMapWrap}>
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFillObject}
          initialRegion={region}
          customMapStyle={mapStyle}
        >
          {currentLocation && (
            <Marker coordinate={currentLocation} anchor={{ x: 0.5, y: 0.5 }}>
              <View style={styles.vehicleMarker}>
                <Text style={{ fontSize: 22 }}>{vehicleMode === "driving" ? "🚗" : "🏍️"}</Text>
              </View>
            </Marker>
          )}
          {destination && <Marker coordinate={destination} pinColor="red" title="Destination" />}
          {deviationLocation && <Marker coordinate={deviationLocation} pinColor="orange" title="Deviation" />}

          {/* 🟡 Yellow flag markers — suspicious activity spots */}
          {yellowFlagMarkers.map((pin) => (
            <Marker key={`yflag-${pin.id}`} coordinate={{ latitude: pin.latitude, longitude: pin.longitude }} anchor={{ x: 0.5, y: 1 }} title="⚠️ Suspicious Activity">
              <View style={{ alignItems: "center" }}>
                <View style={{ backgroundColor: "#FFD600", borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2, borderWidth: 1.5, borderColor: "#F57F17", shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 3, elevation: 5 }}>
                  <Text style={{ fontSize: 14 }}>🚩</Text>
                </View>
                <View style={{ width: 2, height: 10, backgroundColor: "#F57F17" }} />
              </View>
            </Marker>
          ))}

          {/* 🔴 Red flag markers — police / help alert spots */}
          {redFlagMarkers.map((pin) => (
            <Marker key={`rflag-${pin.id}`} coordinate={{ latitude: pin.latitude, longitude: pin.longitude }} anchor={{ x: 0.5, y: 1 }} title="🚨 Police Support Requested">
              <View style={{ alignItems: "center" }}>
                <View style={{ backgroundColor: "#D32F2F", borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2, borderWidth: 1.5, borderColor: "#7F0000", shadowColor: "#f00", shadowOpacity: 0.45, shadowRadius: 4, elevation: 6 }}>
                  <Text style={{ fontSize: 14 }}>🚩</Text>
                </View>
                <View style={{ width: 2, height: 10, backgroundColor: "#7F0000" }} />
              </View>
            </Marker>
          ))}
          {/* Green baseline — original planned route, always visible */}
          {(originalRouteCoords.length > 0 ? originalRouteCoords : routeCoords).length > 0 && (
            <Polyline
              coordinates={originalRouteCoords.length > 0 ? originalRouteCoords : routeCoords}
              strokeWidth={5}
              strokeColor="#13ec49"
            />
          )}
          {/* Orange safety-check reroute — new path from user's post-deviation location */}
          {rerouteCoords.length > 0 && (
            <Polyline
              coordinates={rerouteCoords}
              strokeWidth={5}
              strokeColor="#FF8C00"
              lineDashPattern={[10, 5]}
              zIndex={2}
            />
          )}
          {traveledPath.length > 0 && (
            <Polyline coordinates={traveledPath} strokeWidth={4} strokeColor="rgba(52,152,219,0.3)" />
          )}
          {renderPoliceMarkers()}
        </MapView>

        <Modal visible={chatOpen} animationType="slide">
          <AIChatScreen onBack={() => setChatOpen(false)} />
        </Modal>

        <TouchableOpacity style={styles.locateMeBtn} onPress={zoomToMyLocation}>
          <Text style={{ fontSize: 20 }}>📍</Text>
        </TouchableOpacity>

        <View style={styles.speedOverlay}>
          <Text style={styles.speedValue}>
            {currentSpeedKmh != null ? currentSpeedKmh : "--"}
          </Text>
          <Text style={styles.speedUnit}>km/h</Text>
        </View>

        {/* ── Nearby Patrol Count Badge ────────────────────────────────── */}
        <View style={styles.patrolCountBadge}>
          <Text style={styles.patrolCountEmoji}>🚔</Text>
          <Text style={styles.patrolCountValue}>{nearbyPatrolCount}</Text>
          <Text style={styles.patrolCountLabel}>PATROLS{"\n"}NEARBY</Text>
        </View>

        {trafficStatus && (
          <View style={[
            styles.trafficBadge,
            trafficStatus === "heavy" && styles.trafficBadgeHeavy,
            trafficStatus === "moderate" && styles.trafficBadgeModerate,
            trafficStatus === "light" && styles.trafficBadgeLight,
          ]}>
            <Text style={styles.trafficBadgeEmoji}>
              {trafficStatus === "heavy" ? "🔴" : trafficStatus === "moderate" ? "🟡" : "🟢"}
            </Text>
            <Text style={styles.trafficBadgeText}>
              {trafficStatus === "heavy" ? "Heavy Traffic" : trafficStatus === "moderate" ? "Moderate" : "Clear"}
            </Text>
          </View>
        )}

        <TouchableOpacity style={styles.chatFab} onPress={() => setChatOpen(true)}>
          <Text style={{ fontSize: 24 }}>💬</Text>
          <View style={styles.chatFabBadge}><Text style={styles.chatFabBadgeText}>AI</Text></View>
        </TouchableOpacity>

        {renderSOSSheet()}
      </View>

      {policeSupportSent && (
        <View style={styles.policeBanner}>
          <Text style={styles.policeBannerEmoji}>🚔</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.policeBannerTitle}>Police Support Is On The Way</Text>
            <Text style={styles.policeBannerSub}>Please stay calm and wait — help is arriving soon</Text>
          </View>
          <TouchableOpacity onPress={() => setPoliceSupportSent(false)} style={styles.policeBannerClose}>
            <Text style={styles.policeBannerCloseText}>✕</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.trackingBottom}>
        <View style={styles.trackingBtnRow}>
          <TouchableOpacity style={styles.policeBtn} onPress={sendPoliceSupportBackend} activeOpacity={0.85}>
            <Text style={styles.policeBtnIcon}>👮</Text>
            <Text style={styles.policeBtnText}>POLICE SUPPORT</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.shareBtn, isStreaming && styles.shareBtnActive]}
            onPress={handleShareTrip}
            activeOpacity={0.85}
            disabled={isCreatingStream}
          >
            <Text style={styles.shareBtnIcon}>{isCreatingStream ? "⏳" : isStreaming ? "🟢" : "⤴"}</Text>
            <Text style={[styles.shareBtnText, isStreaming && styles.shareBtnTextActive]}>
              {isCreatingStream ? "CREATING..." : isStreaming ? "STREAMING" : "SHARE TRIP"}
            </Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.cancelTripBtn} onPress={handleCancelTrip} activeOpacity={0.85}>
          <Text style={styles.cancelTripIcon}>✕</Text>
          <Text style={styles.cancelTripText}>CANCEL TRIP</Text>
        </TouchableOpacity>
      </View>

      <Modal
        visible={showStreamModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowStreamModal(false)}
      >
        <TouchableOpacity
          style={styles.streamModalOverlay}
          activeOpacity={1}
          onPress={() => setShowStreamModal(false)}
        >
          <TouchableOpacity activeOpacity={1} style={styles.streamModalCard}>
            <TouchableOpacity style={styles.streamModalClose} onPress={() => setShowStreamModal(false)}>
              <Text style={styles.streamModalCloseText}>✕</Text>
            </TouchableOpacity>

            <Text style={styles.streamModalEmoji}>📡</Text>
            <Text style={styles.streamModalTitle}>Live Stream Created</Text>
            <Text style={styles.streamModalSub}>
              Tracking: <Text style={styles.streamModalUser}>{user?.username || user?.id}</Text>
              {streamId ? `  ·  ID: ${streamId.slice(0, 8)}…` : ""}
            </Text>

            <View style={styles.streamUrlBox}>
              <Text style={styles.streamUrlText} numberOfLines={3}>{streamUrl}</Text>
            </View>

            <View style={styles.streamBtnRow}>
              <TouchableOpacity
                style={styles.streamActionBtn}
                onPress={() => {
                  Clipboard.setString(streamUrl);
                  Alert.alert("✅ Copied!", "Stream URL copied to clipboard.");
                }}
              >
                <Text style={styles.streamActionBtnText}>📋 Copy URL</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.streamActionBtn, styles.streamActionBtnWhatsApp]}
                onPress={() => {
                  const msg = encodeURIComponent(`🚨 LIVE TRIP TRACKING\nUser: ${user?.username}\n${streamUrl}`);
                  Linking.openURL(`whatsapp://send?text=${msg}`).catch(() =>
                    Linking.openURL(`https://wa.me/?text=${msg}`)
                  );
                }}
              >
                <Text style={styles.streamActionBtnText}>💬 WhatsApp</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={styles.streamNativeShareBtn}
              onPress={() => nativeShareStream(streamUrl, user?.username || user?.id)}
            >
              <Text style={styles.streamNativeShareText}>⤴  Share via SMS / More</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.streamOpenMapBtn}
              onPress={() => Linking.openURL(streamUrl)}
            >
              <Text style={styles.streamOpenMapText}>🗺  Open Live Map</Text>
            </TouchableOpacity>

            <Text style={styles.streamModalFooter}>
              Anyone with this link can view the live navigation map — no login needed.
            </Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {inZone && (
        <View style={styles.secureMeFloating}>
          <Text style={styles.secureMeTitle}>🔐 SecureMe</Text>
          <Switch
            value={secureMeOn}
            onValueChange={toggleSecureMe}
            trackColor={{ false: "#ccc", true: "#13ec49" }}
            thumbColor={secureMeOn ? "#fff" : "#888"}
          />
        </View>
      )}
    </View>
  );

  const renderContent = () => {
    if (isMapPickerVisible) return renderMapPickerScreen();
    if (isTripActive) return renderTrackingScreen();
    return renderSetupScreen();
  };

  return (
    <TouchableOpacity activeOpacity={1} onPress={recordTouch} style={{ flex: 1 }}>
      <SafeAreaView style={[styles.safeArea, { backgroundColor: isTripActive ? "#fff" : "#f0f4f0" }]}>
        {renderContent()}
      </SafeAreaView>
    </TouchableOpacity>
  );
}

// --- HELPER FUNCTIONS ---
function decodePolyline(t) {
  let p = [], i = 0, lat = 0, lng = 0;
  while (i < t.length) {
    let b, s = 0, r = 0;
    do { b = t.charCodeAt(i++) - 63; r |= (b & 0x1f) << s; s += 5; } while (b >= 0x20);
    let dlat = r & 1 ? ~(r >> 1) : r >> 1; lat += dlat; s = 0; r = 0;
    do { b = t.charCodeAt(i++) - 63; r |= (b & 0x1f) << s; s += 5; } while (b >= 0x20);
    let dlng = r & 1 ? ~(r >> 1) : r >> 1; lng += dlng;
    p.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return p;
}

// ─── STYLES ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#fff" },

  // ── Setup Screen ──
  setupRoot: { flex: 1, backgroundColor: "#f0f4f0" },
  setupHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 36,
    paddingBottom: 14,
    backgroundColor: "#f0f4f0",
  },
  backBtn: { width: 40, height: 40, justifyContent: "center" },
  backArrow: { fontSize: 22, color: "#0f172a", fontWeight: "700" },
  setupHeaderTitle: { flex: 1, fontSize: 20, fontWeight: "800", color: "#0f172a", textAlign: "center" },
  shieldBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#13ec4922",
    justifyContent: "center",
    alignItems: "center",
  },
  shieldIcon: { fontSize: 20 },

  setupContent: { paddingHorizontal: 20, paddingTop: 8 },

  secureMeBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#bbf7d0",
    borderRadius: 14,
    padding: 14,
    marginBottom: 20,
    gap: 10,
  },
  secureMeTitle: { color: "#0f1c14", fontWeight: "700", fontSize: 14 },
  secureMeSub: { color: "#64748b", fontSize: 12, marginTop: 2 },

  fieldLabel: {
    fontSize: 14,
    fontWeight: "800",
    color: "#334155",
    letterSpacing: 1.2,
    marginBottom: 10,
    marginTop: 6,
  },
  optional: { color: "#94a3b8", fontWeight: "500", fontSize: 13 },

  inputCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 50,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    paddingHorizontal: 20,
    paddingVertical: 17,
    marginBottom: 18,
    elevation: 2,
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  fieldInput: { flex: 1, fontSize: 18, color: "#0f172a" },
  inputIcon: { fontSize: 22, marginLeft: 10 },

  predictionsList: {
    backgroundColor: "#fff",
    borderRadius: 12,
    marginTop: -10,
    marginBottom: 10,
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    maxHeight: 200,
  },
  predictionRow: { padding: 16, borderBottomWidth: 1, borderBottomColor: "#f1f5f9" },
  predictionText: { color: "#334155", fontSize: 16 },

  mapChooseRow: { alignItems: "flex-end", marginTop: -10, marginBottom: 20 },
  mapChooseText: { color: "#13ec49", fontSize: 14, fontWeight: "700" },

  vehicleRow: { flexDirection: "row", gap: 14, marginBottom: 20 },
  vehicleCard: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 16,
    borderWidth: 2,
    borderColor: "#e2e8f0",
    paddingVertical: 20,
    alignItems: "center",
    gap: 6,
    elevation: 2,
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  vehicleCardActive: { borderColor: "#13ec49", backgroundColor: "#f0fdf4" },
  vehicleEmoji: { fontSize: 32 },
  vehicleLabel: { fontSize: 11, fontWeight: "800", color: "#94a3b8", letterSpacing: 1 },
  vehicleLabelActive: { color: "#0f1c14" },

  setupFooter: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "#f0f4f0",
    paddingHorizontal: 20,
    paddingBottom: 30,
    paddingTop: 12,
  },
  startTripBtn: {
    backgroundColor: "#13ec49",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingVertical: 20,
    borderRadius: 50,
    elevation: 6,
    shadowColor: "#13ec49",
    shadowOpacity: 0.4,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  startTripIcon: { fontSize: 16, color: "#0f1c14" },
  startTripText: { fontSize: 18, fontWeight: "900", color: "#0f1c14", letterSpacing: 1 },
  setupFooterNote: { color: "#94a3b8", fontSize: 11, textAlign: "center", marginTop: 12, lineHeight: 16 },

  // ── Map Picker ──
  mapPickerRoot: { flex: 1 },
  mapPickerSearch: {
    position: "absolute",
    top: 16,
    left: 16,
    right: 16,
    zIndex: 20,
  },
  mapPickerSearchBar: {
    flexDirection: "row",
    backgroundColor: "#fff",
    borderRadius: 12,
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    overflow: "hidden",
  },
  mapPickerInput: { flex: 1, paddingHorizontal: 16, height: 54, fontSize: 17, color: "#333" },
  mapPickerSearchBtn: {
    paddingHorizontal: 18,
    justifyContent: "center",
    backgroundColor: "#13ec49",
  },
  mapPickerSearchBtnText: { fontWeight: "800", color: "#0f1c14", fontSize: 15 },
  findMeBtn: {
    position: "absolute",
    top: 80,
    right: 16,
    zIndex: 30,
    backgroundColor: "#fff",
    padding: 12,
    borderRadius: 24,
    elevation: 6,
  },
  mapPickerControls: {
    position: "absolute",
    bottom: 30,
    left: 20,
    right: 20,
    flexDirection: "row",
    gap: 12,
  },
  mapPickerBack: {
    flex: 0.8,
    backgroundColor: "#ef4444",
    padding: 15,
    borderRadius: 12,
    alignItems: "center",
  },
  mapPickerConfirm: {
    flex: 1,
    backgroundColor: "#13ec49",
    padding: 15,
    borderRadius: 12,
    alignItems: "center",
  },
  mapPickerBtnText: { color: "#fff", fontWeight: "800", fontSize: 15 },

  // ── Tracking Screen ──
  trackingRoot: { flex: 1, backgroundColor: "#fff" },

  trackingTopCard: {
    position: "absolute",
    top: 12,
    left: 12,
    right: 12,
    zIndex: 30,
    backgroundColor: "#fff",
    borderRadius: 18,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 14,
    gap: 10,
    elevation: 8,
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  trackingBackBtn: { width: 32, height: 32, justifyContent: "center" },
  trackingBackArrow: { fontSize: 20, color: "#0f172a", fontWeight: "700" },
  trackingVehicle: { fontSize: 18, fontWeight: "900", color: "#0f172a" },
  monitoringRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  monitoringDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#13ec49" },
  monitoringLabel: { color: "#64748b", fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  etaBadge: {
    backgroundColor: "#f0fdf4",
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#bbf7d0",
  },
  etaLabel: { color: "#64748b", fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  etaValue: { color: "#13ec49", fontSize: 16, fontWeight: "900" },

  trackingMapWrap: {
    flex: 1,
    position: "relative",
  },

  locateMeBtn: {
    position: "absolute",
    top: 85,
    right: 14,
    zIndex: 20,
    backgroundColor: "#fff",
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: "center",
    alignItems: "center",
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },

  filterPills: {
    position: "absolute",
    bottom: 16,
    left: 12,
    right: 12,
    flexDirection: "row",
    gap: 10,
    zIndex: 20,
  },
  pill: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.92)",
    borderRadius: 50,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: "center",
    elevation: 4,
    shadowColor: "#000",
    shadowOpacity: 0.1,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  pillActive: { backgroundColor: "rgba(255,255,255,0.96)", borderWidth: 1.5, borderColor: "#3b82f6" },
  pillActiveText: { color: "#3b82f6", fontSize: 12, fontWeight: "700" },
  pillText: { color: "#475569", fontSize: 12, fontWeight: "600" },

  chatFab: {
    position: "absolute",
    bottom: 72,
    right: 14,
    zIndex: 25,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#fff",
    justifyContent: "center",
    alignItems: "center",
    elevation: 8,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    borderWidth: 2,
    borderColor: "#f0fdf4",
  },
  chatFabBadge: {
    position: "absolute",
    top: -4,
    right: -4,
    backgroundColor: "#13ec49",
    width: 20,
    height: 20,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  chatFabBadgeText: { color: "#0f1c14", fontSize: 8, fontWeight: "900" },

  vehicleMarker: { alignItems: "center", justifyContent: "center" },

  trackingBottom: {
    backgroundColor: "#fff",
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 28,
    borderTopWidth: 1,
    borderTopColor: "#f1f5f9",
    gap: 10,
  },
  trackingBtnRow: { flexDirection: "row", gap: 12 },
  policeBtn: {
    flex: 1,
    backgroundColor: "#ef4444",
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: "center",
    gap: 6,
    elevation: 4,
    shadowColor: "#ef4444",
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  policeBtnIcon: { fontSize: 22 },
  policeBtnText: { color: "#fff", fontSize: 12, fontWeight: "800", letterSpacing: 0.5 },
  shareBtn: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: "center",
    gap: 6,
    borderWidth: 1.5,
    borderColor: "#e2e8f0",
    elevation: 2,
  },
  shareBtnIcon: { fontSize: 22, color: "#334155" },
  shareBtnText: { color: "#334155", fontSize: 12, fontWeight: "800", letterSpacing: 0.5 },
  shareBtnActive: {
    backgroundColor: "#f0fdf4",
    borderColor: "#bbf7d0",
  },
  shareBtnTextActive: { color: "#16a34a" },

  // ── Stream Modal ────────────────────────────────────────────────────────
  streamModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.75)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  streamModalCard: {
    backgroundColor: "#0d1a2d",
    borderRadius: 20,
    padding: 24,
    width: "100%",
    maxWidth: 400,
    borderWidth: 1,
    borderColor: "rgba(56,189,248,0.35)",
  },
  streamModalClose: {
    position: "absolute",
    top: 14,
    right: 14,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "rgba(255,255,255,0.1)",
    justifyContent: "center",
    alignItems: "center",
  },
  streamModalCloseText: { color: "rgba(255,255,255,0.6)", fontSize: 14, fontWeight: "700" },
  streamModalEmoji: { fontSize: 32, marginBottom: 8, textAlign: "center" },
  streamModalTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: 1,
    textAlign: "center",
    marginBottom: 4,
    textTransform: "uppercase",
  },
  streamModalSub: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 13,
    textAlign: "center",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    marginBottom: 16,
  },
  streamModalUser: { color: "#38BDF8", fontWeight: "700" },
  streamUrlBox: {
    backgroundColor: "rgba(0,0,0,0.4)",
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "rgba(56,189,248,0.2)",
  },
  streamUrlText: {
    color: "#38BDF8",
    fontSize: 12,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    lineHeight: 18,
  },
  streamBtnRow: { flexDirection: "row", gap: 10, marginBottom: 10 },
  streamActionBtn: {
    flex: 1,
    backgroundColor: "rgba(56,189,248,0.12)",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(56,189,248,0.3)",
  },
  streamActionBtnWhatsApp: {
    backgroundColor: "rgba(37,211,102,0.12)",
    borderColor: "rgba(37,211,102,0.3)",
  },
  streamActionBtnText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  streamNativeShareBtn: {
    backgroundColor: "rgba(245,158,11,0.1)",
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(245,158,11,0.3)",
    marginBottom: 10,
  },
  streamNativeShareText: { color: "#F59E0B", fontSize: 13, fontWeight: "700" },
  streamOpenMapBtn: {
    backgroundColor: "rgba(139,92,246,0.12)",
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(139,92,246,0.3)",
    marginBottom: 14,
  },
  streamOpenMapText: { color: "#8B5CF6", fontSize: 13, fontWeight: "700" },
  streamModalFooter: {
    color: "rgba(255,255,255,0.3)",
    fontSize: 11,
    textAlign: "center",
    lineHeight: 16,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  cancelTripBtn: {
    backgroundColor: "#3b82f6",
    borderRadius: 16,
    paddingVertical: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    elevation: 4,
    shadowColor: "#3b82f6",
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  cancelTripIcon: { fontSize: 18, color: "#fff", fontWeight: "900" },
  cancelTripText: { color: "#fff", fontSize: 16, fontWeight: "900", letterSpacing: 1 },

  secureMeFloating: {
    position: "absolute",
    top: 90,
    left: 14,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.95)",
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    gap: 8,
    zIndex: 25,
    elevation: 5,
  },

  // ── Police SOS bottom sheet ──
  sosSheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "#0d1b2a",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 28,
    borderTopWidth: 2,
    borderTopColor: "#1a237e",
    elevation: 20,
    zIndex: 50,
    shadowColor: "#000",
    shadowOpacity: 0.5,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: -4 },
  },
  sosCloseBtn: {
    position: "absolute",
    top: 14,
    right: 16,
    backgroundColor: "#1e2d3d",
    borderRadius: 16,
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  sosCloseBtnText: { color: "#aaa", fontSize: 16, fontWeight: "700" },
  sosStationInfo: { flexDirection: "row", alignItems: "flex-start", marginBottom: 12, paddingRight: 40 },
  sosStationEmoji: { fontSize: 28, marginRight: 12, marginTop: 2 },
  sosStationName: { color: "#fff", fontWeight: "700", fontSize: 15, lineHeight: 20 },
  sosStationAddress: { color: "#90a4ae", fontSize: 12, marginTop: 3, lineHeight: 16 },
  sosDivider: { height: 1, backgroundColor: "#1e2d3d", marginBottom: 14 },
  sosNavBtn: {
    backgroundColor: "#1e3a5f",
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#2980b9",
  },
  sosNavBtnText: { color: "#64b5f6", fontWeight: "700", fontSize: 15 },
  sosEmergencyBtn: {
    backgroundColor: "#b71c1c",
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
    marginBottom: 8,
    elevation: 4,
    shadowColor: "#f00",
    shadowOpacity: 0.35,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  sosEmergencyBtnDisabled: { backgroundColor: "#5d1010", opacity: 0.7 },
  sosEmergencyBtnText: { color: "#fff", fontWeight: "800", fontSize: 17, letterSpacing: 0.5 },
  sosHint: { color: "#546e7a", fontSize: 11, textAlign: "center", marginTop: 2 },
  policeMarkerBadge: {
    backgroundColor: "#1a237e",
    borderRadius: 20,
    padding: 5,
    borderWidth: 2,
    borderColor: "#fff",
    elevation: 5,
  },
  policeMarkerEmoji: { fontSize: 20 },

  // ── Police support banner ──
  policeBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0d1b2a",
    borderTopWidth: 2,
    borderTopColor: "#1a237e",
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 12,
  },
  policeBannerEmoji: { fontSize: 28 },
  policeBannerTitle: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 14,
    letterSpacing: 0.3,
  },
  policeBannerSub: {
    color: "#90a4ae",
    fontSize: 12,
    marginTop: 2,
  },
  policeBannerClose: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  policeBannerCloseText: { color: "#aaa", fontSize: 14, fontWeight: "700" },

  // ── Speed Overlay ──────────────────────────────────────────────────────────
  speedOverlay: {
    position: "absolute",
    bottom: 16,
    left: 14,
    backgroundColor: "rgba(13, 26, 45, 0.92)",
    borderRadius: 14,
    paddingVertical: 8,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "rgba(56,189,248,0.4)",
    zIndex: 20,
    elevation: 6,
    minWidth: 68,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  speedValue: {
    color: "#38BDF8",
    fontSize: 26,
    fontWeight: "900",
    letterSpacing: 1,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    lineHeight: 30,
  },
  speedUnit: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },

  // ── Patrol Count Badge ─────────────────────────────────────────────────────
  patrolCountBadge: {
    position: "absolute",
    bottom: 16,
    left: 100,
    backgroundColor: "rgba(13, 26, 45, 0.92)",
    borderRadius: 14,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
    borderWidth: 1.5,
    borderColor: "rgba(19,236,73,0.4)",
    zIndex: 20,
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  patrolCountEmoji: { fontSize: 18 },
  patrolCountValue: {
    color: "#13ec49",
    fontSize: 22,
    fontWeight: "900",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    lineHeight: 26,
  },
  patrolCountLabel: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
    lineHeight: 12,
  },

  // ── Traffic Badge ───────────────────────────────────────────────────────────
  trafficBadge: {
    position: "absolute",
    top: 140,
    right: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 20,
    paddingVertical: 7,
    paddingHorizontal: 12,
    zIndex: 20,
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    borderWidth: 1.5,
  },
  trafficBadgeHeavy: {
    backgroundColor: "rgba(185, 28, 28, 0.92)",
    borderColor: "rgba(239,68,68,0.6)",
  },
  trafficBadgeModerate: {
    backgroundColor: "rgba(120, 80, 0, 0.92)",
    borderColor: "rgba(234,179,8,0.6)",
  },
  trafficBadgeLight: {
    backgroundColor: "rgba(20, 83, 45, 0.92)",
    borderColor: "rgba(34,197,94,0.6)",
  },
  trafficBadgeEmoji: { fontSize: 14 },
  trafficBadgeText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.3,
  },

  map: { ...StyleSheet.absoluteFillObject },
});

const mapStyle = [
  { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "transit", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "labels.text", stylers: [{ visibility: "off" }] },
];
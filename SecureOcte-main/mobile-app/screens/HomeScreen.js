import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Animated,
  ScrollView,
  StatusBar,
  ActivityIndicator,
  Dimensions,
  Modal,
} from "react-native";
import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import MapView, { Marker, Circle, Polygon } from "react-native-maps";
import * as Location from "expo-location";
import * as LocalAuthentication from "expo-local-authentication";
import { Audio } from "expo-av";
import { apiFetch, apiMultipart, rawFetchWithSecurity, AuthError, BASE_URL } from "./api";
import { AuthContext } from "./AuthContext";
import HowToUseScreen from "./HowToUseScreen";
import { useHardwareVoiceTrigger } from "./HardwareVoiceService";

const { width } = Dimensions.get("window");
const SOS_COUNTDOWN = 15;

export default function HomeScreen({ user, token, onSelectSection, inZone, walkMonitoring, walkElapsed }) {
  /* ── State ── */
  const [recording, setRecording] = useState(null);
  const [listening, setListening] = useState(false);
  const [sosSending, setSosSending] = useState(false);

  /* ── SOS Countdown Modal ── */
  const [sosModalVisible, setSosModalVisible] = useState(false);
  const [sosCountdown, setSosCountdown] = useState(SOS_COUNTDOWN);
  const sosCountdownRef = useRef(null);       // kept for _doCancel / sendSOSNow compat
  const sosCountdownValue = useRef(SOS_COUNTDOWN);
  // Animated ring progress (1 → 0 over 15s)
  const sosProgress = useRef(new Animated.Value(1)).current;
  const sosProgressAnim = useRef(null);

  // ── Zero-delay SOS flow refs ──────────────────────────────────────────────
  const sosLockedRef    = useRef(false);  // multi-tap / re-entry lock
  const targetTimeRef   = useRef(null);   // epoch ms — countdown end target
  const tickTimerRef    = useRef(null);   // 250 ms interval handle
  // Preloaded location cache — populated async while modal is visible
  const sosLatRef       = useRef(null);
  const sosLngRef       = useRef(null);
  const sosAddressRef   = useRef(null);   // null until reverse-geocode completes
  const lastSOSSentAtRef = useRef(null);  // epoch ms of last successful SOS send

  /* ── How To Use Modal ── */
  const [howToUseVisible, setHowToUseVisible] = useState(false);

  /* ── Map Modal State ── */
  const [mapVisible, setMapVisible] = useState(false);
  const [zones, setZones] = useState([]);
  const [zonesLoading, setZonesLoading] = useState(false);
  const [userLocation, setUserLocation] = useState(null);
  const [locating, setLocating] = useState(false);
  const mapRef = useRef(null);

  /* ── Mic animation only ── */
  const micScale = useRef(new Animated.Value(1)).current;

  /* ── Hardware Voice Trigger (power / volume / bluetooth buttons) ── */
  const { triggerVoice, hwPhase } = useHardwareVoiceTrigger({
    user,
    token,
    onSelectSection,
    onSOS: () => {
      console.log("[HomeScreen] Voice SOS dispatched by HardwareVoiceService");
    },
  });

  /* ── Fetch Zones ── */
  const [rawZoneData, setRawZoneData] = useState(null);

  const normalizeZone = (zone) => {
    const points = zone.zone || [];
    if (!points.length) return null;
    const lat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
    const lng = points.reduce((sum, p) => sum + p.lng, 0) / points.length;
    const polygon = points.map(p => ({ latitude: p.lat, longitude: p.lng }));
    const risk = zone.riskLevel || zone.risk_level || zone.level || zone.risk || zone.type || "unknown";
    const name = zone.name || zone.zoneName || zone.zone_name || zone.title || zone.area || "Risk Zone";
    return { lat, lng, polygon, risk, name, _id: zone._id };
  };

  const fetchZones = async () => {
    try {
      setZonesLoading(true);
      const zoneRes  = await rawFetchWithSecurity(`${BASE_URL}/api/secureme/get-zone`, { method: "GET" });
      const zoneData = await zoneRes.json();
      setRawZoneData(zoneData);
      let raw = [];
      if (Array.isArray(zoneData)) raw = zoneData;
      else if (Array.isArray(zoneData?.zones)) raw = zoneData.zones;
      else if (Array.isArray(zoneData?.data)) raw = zoneData.data;
      else if (Array.isArray(zoneData?.results)) raw = zoneData.results;
      else if (Array.isArray(zoneData?.items)) raw = zoneData.items;
      else {
        const vals = Object.values(zoneData || {});
        raw = vals.filter(v => typeof v === "object" && v !== null && !Array.isArray(v));
        if (raw.length === 0 && vals.length > 0) raw = [zoneData];
      }
      const normalized = raw.map(normalizeZone).filter(z => z !== null && z.lat !== null && z.lng !== null);
      setZones(normalized);
      if (normalized.length > 0 && mapRef.current) {
        const coords = normalized.map(z => ({ latitude: z.lat, longitude: z.lng }));
        setTimeout(() => {
          mapRef.current?.fitToCoordinates(coords, {
            edgePadding: { top: 80, right: 60, bottom: 160, left: 60 },
            animated: true,
          });
        }, 500);
      }
    } catch (err) {
      Alert.alert("Error", "Could not load risk zones.");
    } finally {
      setZonesLoading(false);
    }
  };

  const openMap = () => {
    setMapVisible(true);
    fetchZones();
  };

  /* ── Locate Me ── */
  const handleLocateMe = async () => {
    try {
      setLocating(true);
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission Denied", "Location permission is required.");
        setLocating(false);
        return;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const coords = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
      setUserLocation(coords);
      mapRef.current?.animateToRegion({ ...coords, latitudeDelta: 0.05, longitudeDelta: 0.05 }, 800);
    } catch (err) {
      Alert.alert("Error", "Could not get your location.");
    } finally {
      setLocating(false);
    }
  };

  // ── CLEAR TIMER (centralised per spec) ──────────────────────────────────
  const clearTimer = () => {
    if (tickTimerRef.current) {
      clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
    // Also clear the legacy ref used by the animated ring
    if (sosCountdownRef.current) {
      clearInterval(sosCountdownRef.current);
      sosCountdownRef.current = null;
    }
  };

  // ── PRELOAD SOS DATA (runs async, non-blocking) ──────────────────────────
  // Fetches location + reverse-geocode while the modal countdown is visible.
  // Results are cached in refs so dispatchSOS can send immediately.
  const preloadSOSData = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") return;

      // Try cheap cached position first, fall back to fresh balanced fix (6s max)
      let loc = null;
      try {
        loc = await Location.getLastKnownPositionAsync({ maxAge: 60000, requiredAccuracy: 500 });
      } catch (_) {}
      if (!loc) {
        loc = await Promise.race([
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 6000)),
        ]);
      }

      sosLatRef.current = loc.coords.latitude;
      sosLngRef.current = loc.coords.longitude;
      console.log("[SOS] Location preloaded:", sosLatRef.current, sosLngRef.current);

      // Reverse-geocode non-blocking — address attaches if ready when SOS fires
      Location.reverseGeocodeAsync({ latitude: sosLatRef.current, longitude: sosLngRef.current })
        .then((geo) => {
          if (geo?.[0]) {
            const g = geo[0];
            sosAddressRef.current = [g.name, g.street, g.district, g.city, g.region, g.postalCode, g.country]
              .filter(Boolean).join(", ");
            console.log("[SOS] Address preloaded:", sosAddressRef.current);
          }
        })
        .catch(() => {});
    } catch (e) {
      console.log("[SOS] preloadSOSData failed:", e.message);
      // Non-fatal — send without location
    }
  };

  // ── DISPATCH SOS (sends immediately using cached coords) ────────────────
  const dispatchSOS = async () => {
    try {
      setSosSending(true);
      const lat     = sosLatRef.current;
      const lng     = sosLngRef.current;
      const address = sosAddressRef.current ?? "Location unknown";

      const sosRes = await rawFetchWithSecurity(`${BASE_URL}/api/secureme/alert`, {
        method: "POST",
        body: {
          userId:    user?.username,
          username:  user?.username,
          trigger:   "manual_sos",
          reason:    "User manually triggered SOS from Home screen",
          lat,
          lng,
          location:  address,
          mode:      "home",
          timestamp: new Date().toISOString(),
        },
      });

      if (!sosRes.ok) {
        const errData = await sosRes.json().catch(() => ({}));
        throw new Error(errData.error || `SOS failed (${sosRes.status})`);
      }
      Alert.alert("✅ SOS Sent", "Authorities have been notified.");
      lastSOSSentAtRef.current = Date.now(); // stamp for 30s cooldown
    } catch (err) {
      Alert.alert("Error", "Could not send SOS. Please call emergency services directly.");
    } finally {
      setSosSending(false);
      sosLockedRef.current = false; // release lock after send completes
    }
  };

  // ── START COUNTDOWN LOOP (250 ms ticks, no drift) ───────────────────────
  const startCountdownLoop = () => {
    tickTimerRef.current = setInterval(() => {
      const remaining = targetTimeRef.current - Date.now();
      if (remaining <= 0) {
        clearTimer();
        setSosModalVisible(false);
        sosProgressAnim.current?.stop();
        sosProgress.setValue(1);
        dispatchSOS();
        return;
      }
      const secs = Math.ceil(remaining / 1000);
      setSosCountdown(secs);
      sosCountdownValue.current = secs; // keep legacy ref in sync
    }, 250);
  };

  // ── START SOS FLOW ───────────────────────────────────────────────────────
  const startSOSFlow = () => {
    // STEP 1 — Show UI instantly (zero delay)
    setSosCountdown(SOS_COUNTDOWN);
    sosCountdownValue.current = SOS_COUNTDOWN;
    sosProgress.setValue(1);
    setSosModalVisible(true);

    // Animate ring draining over countdown duration
    sosProgressAnim.current = Animated.timing(sosProgress, {
      toValue: 0,
      duration: SOS_COUNTDOWN * 1000,
      useNativeDriver: false,
    });
    sosProgressAnim.current.start();

    // STEP 2 — Set target time (drift-free)
    targetTimeRef.current = Date.now() + SOS_COUNTDOWN * 1000;

    // STEP 3 — Start 250 ms countdown loop
    startCountdownLoop();

    // STEP 4 — Preload location data async (non-blocking)
    preloadSOSData();
  };

  // ── SOS BUTTON HANDLER (triple-gated per spec) ───────────────────────────
  const handleSOSTap = () => {
    if (sosLockedRef.current || sosModalVisible || sosSending) return;

    // 30s cooldown — block a new SOS if one was just sent
    if (lastSOSSentAtRef.current) {
      const elapsed = Date.now() - lastSOSSentAtRef.current;
      if (elapsed < 30000) {
        const remaining = Math.ceil((30000 - elapsed) / 1000);
        Alert.alert(
          "SOS Already Sent",
          `Please wait ${remaining} second${remaining !== 1 ? "s" : ""} before sending a new SOS.`
        );
        return;
      }
    }
    sosLockedRef.current = true;
    // Clear any stale preloaded data from a previous session
    sosLatRef.current     = null;
    sosLngRef.current     = null;
    sosAddressRef.current = null;
    startSOSFlow();
  };

  /* ── Internal reset helper ── */
  const _doCancel = () => {
    clearTimer();
    sosLockedRef.current = false;
    sosProgressAnim.current?.stop();
    setSosModalVisible(false);
    setSosCountdown(SOS_COUNTDOWN);
    sosProgress.setValue(1);
  };

  /* ── Cancel with biometric verification ── */
  const cancelSOSCountdown = async () => {
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled  = await LocalAuthentication.isEnrolledAsync();

      if (!hasHardware || !isEnrolled) {
        Alert.alert(
          "Cancel SOS?",
          "Biometric not available. Are you sure you want to cancel?",
          [
            { text: "Yes, I'm Safe", style: "destructive", onPress: _doCancel },
            { text: "Keep Counting", style: "cancel" },
          ]
        );
        return;
      }

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Verify it's you to cancel the SOS",
        fallbackLabel: "Use Passcode",
        disableDeviceFallback: false,
      });

      if (result.success) {
        _doCancel();
      } else if (result.error !== "user_cancel") {
        Alert.alert(
          "Verification Failed",
          "Could not verify your identity. SOS countdown continues.",
          [{ text: "OK" }]
        );
      }
      // If user_cancel (dismissed prompt), do nothing — countdown keeps going
    } catch (err) {
      console.error("[SOS Cancel] biometric error:", err);
    }
  };

  /* ── Send immediately ── */
  const sendSOSNow = () => {
    clearTimer();
    sosProgressAnim.current?.stop();
    setSosModalVisible(false);
    setSosCountdown(SOS_COUNTDOWN);
    sosProgress.setValue(1);
    dispatchSOS();
  };

  /* ── Cleanup on unmount ── */
  useEffect(() => {
    return () => {
      clearTimer();
      sosProgressAnim.current?.stop();
    };
  }, []);

  /* ── WAV Recording Options ── */
  const recordingOptions = {
    android: {
      extension: ".wav",
      outputFormat: Audio.AndroidOutputFormat.DEFAULT,
      audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
      sampleRate: 16000,
      numberOfChannels: 1,
      bitRate: 256000,
    },
    ios: {
      extension: ".wav",
      audioQuality: Audio.IOSAudioQuality.HIGH,
      sampleRate: 16000,
      numberOfChannels: 1,
      bitRate: 256000,
      linearPCMBitDepth: 16,
      linearPCMIsBigEndian: false,
      linearPCMIsFloat: false,
    },
  };

  const startRecording = async () => {
    if (recording) return;
    try {
      setListening(true);
      Animated.spring(micScale, { toValue: 1.3, useNativeDriver: true, friction: 3 }).start();
      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Permission Required", "Mic permission is needed.");
        resetMic();
        return;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording: rec } = await Audio.Recording.createAsync(recordingOptions);
      setRecording(rec);
    } catch (err) {
      resetMic();
    }
  };

  const stopRecording = async () => {
    if (!recording) { resetMic(); return; }
    try {
      setListening(false);
      Animated.spring(micScale, { toValue: 1, useNativeDriver: true }).start();
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      setRecording(null);
      sendAudioToBackend(uri);
    } catch (err) {
      setRecording(null);
      resetMic();
    }
  };

  const resetMic = () => {
    setListening(false);
    Animated.spring(micScale, { toValue: 1, useNativeDriver: true }).start();
  };

  const sendAudioToBackend = async (audioUri) => {
    try {
      const formData = new FormData();
      formData.append("audio", { uri: audioUri, name: "voice.wav", type: "audio/wav" });

      let result;
      try {
        // 30 s timeout — audio goes through ffmpeg + Google Speech + Gemini on server
        result = await apiMultipart(`/api/speech/command`, formData, token, 30000);
      } catch (uploadErr) {
        console.error("[Voice] Upload failed:", uploadErr.message);
        const isTimeout = uploadErr.message?.toLowerCase().includes("timeout");
        Alert.alert(
          isTimeout ? "Processing Took Too Long" : "Voice Processing Failed",
          isTimeout
            ? "The server took too long to respond. Please try again."
            : `Error: ${uploadErr.message}\n\nCheck your connection and try again.`
        );
        return;
      }

      const transcript = result?.transcript || "";
      const decision   = (result?.decision  || "UNKNOWN").trim().toUpperCase();

      console.log("[Voice] Transcript:", transcript, "| Decision:", decision);

      if (!transcript) {
        Alert.alert("No Speech Detected", "Please speak clearly and try again.");
        return;
      }

      if (decision === "WALK_MONITORING") {
        onSelectSection("walk");
      } else if (decision === "CAB_MONITORING") {
        onSelectSection("cabVoiceAssistant");
      } else if (decision === "SOS") {
        // Voice SOS — fire immediately, no countdown modal
        console.log("[Voice] 🚨 SOS decision — dispatching immediately");
        try {
          // Get location fresh (user just spoke — coords may not be preloaded)
          let lat = null, lng = null, address = "Location unknown";
          try {
            const { status } = await Location.requestForegroundPermissionsAsync();
            if (status === "granted") {
              let loc = null;
              try { loc = await Location.getLastKnownPositionAsync({ maxAge: 60000, requiredAccuracy: 500 }); } catch (_) {}
              if (!loc) {
                loc = await Promise.race([
                  Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
                  new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000)),
                ]);
              }
              lat = loc.coords.latitude;
              lng = loc.coords.longitude;
              // Best-effort reverse geocode (non-blocking)
              Location.reverseGeocodeAsync({ latitude: lat, longitude: lng })
                .then((geo) => {
                  if (geo?.[0]) {
                    const g = geo[0];
                    address = [g.name, g.street, g.district, g.city, g.region, g.postalCode, g.country]
                      .filter(Boolean).join(", ");
                  }
                }).catch(() => {});
            }
          } catch (_) {}

          const sosRes = await rawFetchWithSecurity(`${BASE_URL}/api/secureme/alert`, {
            method: "POST",
            body: {
              userId:    user?.username,
              username:  user?.username,
              trigger:   "voice_sos",
              reason:    `SOS triggered by voice command. User said: "${transcript}"`,
              lat,
              lng,
              location:  address,
              mode:      "voice",
              timestamp: new Date().toISOString(),
            },
          });

          if (!sosRes.ok) {
            const errData = await sosRes.json().catch(() => ({}));
            throw new Error(errData.error || `SOS failed (${sosRes.status})`);
          }

          Alert.alert("🚨 SOS Sent", "Emergency alert has been sent to authorities.");
        } catch (sosErr) {
          console.error("[Voice] SOS dispatch failed:", sosErr.message);
          Alert.alert("SOS Failed", "Could not send SOS. Please tap the red SOS button or call emergency services directly.");
        }
      } else {
        Alert.alert(
          "Command Not Understood",
          `You said: "${transcript}"\n\nTry:\n• "Start walk monitoring"\n• "Start cab monitoring"\n• "Send SOS" / "Help me"`
        );
      }
    } catch (err) {
      console.error("[Voice] Unexpected error:", err.message);
      Alert.alert("Error", `Voice processing failed: ${err.message}`);
    }
  };

  /* ── Zone color by risk level ── */
  const zoneColor = (level) => {
    switch ((level || "").toLowerCase()) {
      case "high":   return { fill: "rgba(220,38,38,0.25)",  stroke: "#dc2626" };
      case "medium": return { fill: "rgba(234,179,8,0.25)",  stroke: "#ca8a04" };
      case "low":    return { fill: "rgba(34,197,94,0.25)",  stroke: "#16a34a" };
      default:       return { fill: "rgba(220,38,38,0.25)",  stroke: "#dc2626" };
    }
  };

  /* ── Animated ring border color (green → red as countdown shrinks) ── */
  const ringColor = sosProgress.interpolate({
    inputRange: [0, 0.4, 1],
    outputRange: ["#dc2626", "#f97316", "#13ec49"],
  });

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />

      {/* ─────────────────── STICKY HEADER ─────────────────── */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.avatarRing}
          onPress={() => onSelectSection("profile")}
          activeOpacity={0.75}
        >
          <Ionicons name="person" size={18} color="#13ec49" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.welcomeText} numberOfLines={1}>
            Welcome, {user?.username} 👋
          </Text>
        </View>
        <TouchableOpacity style={styles.helpBtn} onPress={() => setHowToUseVisible(true)} activeOpacity={0.75}>
          <Ionicons name="help-circle-outline" size={28} color="#94a3b8" />
        </TouchableOpacity>
      </View>

      {/* ─────────────────── SCROLLABLE CONTENT ─────────────────── */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {walkMonitoring && (
          <TouchableOpacity
            style={styles.activeTripBanner}
            onPress={() => onSelectSection("walk")}
            activeOpacity={0.85}
          >
            <View style={styles.activeTripPulse}>
              <View style={styles.activeTripDot} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.activeTripTitle}>Walk Monitoring Active</Text>
              <Text style={styles.activeTripTime}>
                {String(Math.floor(walkElapsed / 60)).padStart(2, "0")}:
                {String(walkElapsed % 60).padStart(2, "0")} elapsed · Tap to return
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#13ec49" />
          </TouchableOpacity>
        )}

        {inZone && (
          <View style={styles.zoneBanner}>
            <Ionicons name="warning" size={15} color="#ef4444" />
            <Text style={styles.zoneBannerText}>
              You are in a high risk Zone. Secure Me mode is now Available
            </Text>
          </View>
        )}

        {/* ─────────────── SOS HERO ─────────────── */}
        <View style={styles.sosSection}>
          <TouchableOpacity
            style={styles.sosBtn}
            onPress={handleSOSTap}
            activeOpacity={0.85}
            disabled={sosSending}
          >
            {sosSending ? (
              <ActivityIndicator size="large" color="white" />
            ) : (
              <Text style={styles.sosText}>SOS</Text>
            )}
          </TouchableOpacity>
          <Text style={styles.sosCta}>Tap for immediate help</Text>
        </View>

        {/* ─────────────── QUICK PROTECTION GRID ─────────────── */}
        <Text style={styles.sectionTitle}>Quick Protection</Text>

        <View style={styles.grid}>
          <QuickCard
            icon={<MaterialIcons name="directions-walk" size={30} color="#3b82f6" />}
            label={"Walk\nMonitoring"}
            onPress={() => onSelectSection("walk")}
            accentColor="#3b82f6"
          />
          <QuickCard
            icon={<MaterialIcons name="local-taxi" size={30} color="#16a34a" />}
            label={"Cab/Auto\nMonitoring"}
            onPress={() => onSelectSection("cab")}
            accentColor="#16a34a"
          />
          <QuickCard
            icon={<MaterialIcons name="smart-toy" size={30} color="#f97316" />}
            label={"Neha - AI Chat\nAssistant"}
            onPress={() => onSelectSection("ai")}
            accentColor="#f97316"
          />
          <QuickCard
            icon={<MaterialIcons name="report-problem" size={30} color="#dc2626" />}
            label={"Report an\nIncident"}
            onPress={() => onSelectSection("reportIncident")}
            accentColor="#dc2626"
          />
        </View>

        {/* ─────────────── MAP CARD ─────────────── */}
        <TouchableOpacity style={styles.mapCard} onPress={openMap} activeOpacity={0.85}>
          <View style={styles.mapCardInner}>
            <View style={styles.mapCardIconWrap}>
              <Ionicons name="map" size={26} color="#16a34a" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.mapCardTitle}>Show High Risk Zones</Text>
              <Text style={styles.mapCardSub}>Tap to view risk areas near you</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#16a34a" />
          </View>
        </TouchableOpacity>

        {/* ─────────────── VIEW INCIDENT REPORTS ─────────────── */}
        <TouchableOpacity
          style={styles.viewReportsCard}
          onPress={() => onSelectSection("incidentReports")}
          activeOpacity={0.85}
        >
          <View style={styles.incidentCardLeft}>
            <View style={styles.viewReportsIconWrap}>
              <MaterialIcons name="list-alt" size={26} color="#7c3aed" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.viewReportsTitle}>View Incident Reports</Text>
              <Text style={styles.viewReportsSub}>Track submitted reports &amp; status</Text>
            </View>
          </View>
          <View style={styles.viewReportsArrow}>
            <Ionicons name="chevron-forward" size={18} color="#7c3aed" />
          </View>
        </TouchableOpacity>

        {/* ─────────────── OFFICER SECTION ─────────────── */}
        <Text style={[styles.sectionTitle, { marginTop: 26 }]}>For Officers only</Text>

        <TouchableOpacity
          style={styles.patrolCard}
          onPress={() => onSelectSection("patrol")}
          activeOpacity={0.85}
        >
          <View style={styles.patrolCardLeft}>
            <View style={styles.patrolCardIconWrap}>
              <MaterialIcons name="local-police" size={28} color="#13ec49" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.patrolCardTitle}>Patrol Vehicle</Text>
              <Text style={styles.patrolCardSub}>Start live patrol</Text>
            </View>
          </View>
          <View style={styles.patrolCardArrow}>
            <Ionicons name="chevron-forward" size={18} color="#13ec49" />
          </View>
        </TouchableOpacity>

        <View style={{ height: 24 }} />
      </ScrollView>

      {/* ─────────────────── HARDWARE VOICE INDICATOR ─────────────────── */}
      {hwPhase !== "idle" && (
        <Animated.View style={[
          styles.hwListeningBanner,
          hwPhase === "activating"  && styles.hwActivatingBanner,
          hwPhase === "processing"  && styles.hwProcessingBanner,
        ]}>
          <View style={[
            styles.hwPulseDot,
            hwPhase === "activating" && { backgroundColor: "#13ec49" },
            hwPhase === "processing" && { backgroundColor: "#f97316" },
          ]} />
          <Text style={styles.hwListeningText}>
            {hwPhase === "activating" ? "🔊 Voice assistant activated…"  :
             hwPhase === "listening"  ? "🎙 Listening…  Speak now"        :
                                        "⚙️  Processing your command…"}
          </Text>
        </Animated.View>
      )}

      {/* ─────────────────── BOTTOM NAV ─────────────────── */}
      <View style={styles.bottomNav}>
        <NavTab icon="home" label="Home" active />
        <TouchableOpacity
          style={styles.navVoiceBtn}
          onPressIn={startRecording}
          onPressOut={stopRecording}
          activeOpacity={0.85}
        >
          <Animated.View style={[
            styles.navVoiceBtnInner,
            (listening || hwPhase === "listening") && styles.navVoiceBtnActive,
            hwPhase === "processing" && styles.navVoiceBtnProcessing,
            { transform: [{ scale: micScale }] },
          ]}>
            <Ionicons
              name={(listening || hwPhase !== "idle") ? "mic-circle" : "mic"}
              size={28}
              color={(listening || hwPhase !== "idle") ? "#0f1c14" : "#ffffff"}
            />
          </Animated.View>
          <Text style={[styles.navLabel, styles.navVoiceLabel]}>
            {hwPhase === "listening"  ? "Listening…"  :
             hwPhase === "processing" ? "Processing…" :
             listening                ? "Listening…"  : "Voice"}
          </Text>
        </TouchableOpacity>
        <NavTab icon="person-outline" label="Profile" onPress={() => onSelectSection("profile")} />
      </View>

      {/* ─────────────────── SOS COUNTDOWN MODAL ─────────────────── */}
      <Modal
        visible={sosModalVisible}
        transparent
        animationType="fade"
        onRequestClose={cancelSOSCountdown}
      >
        <View style={styles.sosOverlay}>
          <View style={styles.sosModalCard}>
            {/* Header */}
            <View style={styles.sosModalHeader}>
              <Text style={styles.sosModalEmoji}>🚨</Text>
              <Text style={styles.sosModalTitle}>SOS ALERT</Text>
              <Text style={styles.sosModalSub}>
                Alert will auto-send if no action is taken
              </Text>
            </View>

            {/* Countdown ring */}
            <View style={styles.countdownWrap}>
              <Animated.View style={[styles.countdownRing, { borderColor: ringColor }]}>
                <Text style={styles.countdownNumber}>{sosCountdown}</Text>
                <Text style={styles.countdownUnit}>seconds</Text>
              </Animated.View>
            </View>

            {/* Status text */}
            <Text style={styles.sosAutoText}>
              Sending SOS automatically in{" "}
              <Text style={styles.sosAutoSeconds}>{sosCountdown}s</Text>
            </Text>

            {/* Action buttons */}
            <TouchableOpacity
              style={styles.sosSendNowBtn}
              onPress={sendSOSNow}
              activeOpacity={0.85}
            >
              <Ionicons name="send" size={18} color="#fff" />
              <Text style={styles.sosSendNowText}>Send SOS Now</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.sosCancelBtn}
              onPress={cancelSOSCountdown}
              activeOpacity={0.85}
            >
              <Ionicons name="close-circle-outline" size={18} color="#64748b" />
              <Text style={styles.sosCancelText}>Cancel — I'm Safe</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ─────────────────── HOW TO USE MODAL ─────────────────── */}
      <Modal
        visible={howToUseVisible}
        animationType="slide"
        onRequestClose={() => setHowToUseVisible(false)}
      >
        <HowToUseScreen onClose={() => setHowToUseVisible(false)} />
      </Modal>

      {/* ─────────────────── MAP MODAL ─────────────────── */}
      <Modal
        visible={mapVisible}
        animationType="slide"
        onRequestClose={() => setMapVisible(false)}
      >
        <View style={styles.modalRoot}>
          <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setMapVisible(false)} style={styles.modalBack}>
              <Ionicons name="arrow-back" size={24} color="#1e293b" />
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Risk Zone Map</Text>
            <TouchableOpacity onPress={fetchZones} style={styles.modalRefresh}>
              <Ionicons name="refresh" size={22} color="#13ec49" />
            </TouchableOpacity>
          </View>

          <View style={styles.mapContainer}>
            <MapView
              ref={mapRef}
              style={styles.map}
              initialRegion={{
                latitude: userLocation?.latitude || 17.385,
                longitude: userLocation?.longitude || 78.4867,
                latitudeDelta: 0.15,
                longitudeDelta: 0.15,
              }}
              showsMyLocationButton={false}
            >
              {zones.map((zone, idx) => {
                const colors = zoneColor(zone.risk);
                return (
                  <React.Fragment key={idx}>
                    <Polygon
                      coordinates={zone.polygon}
                      fillColor={colors.fill}
                      strokeColor={colors.stroke}
                      strokeWidth={2}
                    />
                    <Marker
                      coordinate={{ latitude: zone.lat, longitude: zone.lng }}
                      title={zone.name}
                      description={`Risk: ${zone.risk}`}
                    >
                      <View style={[styles.zoneMarker, { backgroundColor: colors.stroke }]}>
                        <Ionicons name="warning" size={12} color="white" />
                      </View>
                    </Marker>
                  </React.Fragment>
                );
              })}
              {userLocation && (
                <Marker coordinate={userLocation} title="You are here">
                  <View style={styles.userMarker}>
                    <View style={styles.userMarkerInner} />
                  </View>
                </Marker>
              )}
            </MapView>

            {zonesLoading && (
              <View style={styles.mapLoader}>
                <ActivityIndicator size="large" color="#13ec49" />
                <Text style={styles.mapLoaderText}>Loading risk zones...</Text>
              </View>
            )}

            <TouchableOpacity
              style={styles.locateBtn}
              onPress={handleLocateMe}
              disabled={locating}
              activeOpacity={0.85}
            >
              {locating ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <>
                  <Ionicons name="locate" size={20} color="white" />
                  <Text style={styles.locateBtnText}>Locate Me</Text>
                </>
              )}
            </TouchableOpacity>

            <View style={styles.legend}>
              <LegendItem color="#dc2626" label="High Risk" />
            </View>
          </View>

          <View style={styles.zonesBar}>
            <Ionicons name="shield-outline" size={16} color="#64748b" />
            <View style={{ flex: 1 }}>
              <Text style={styles.zonesBarText}>
                {zonesLoading
                  ? "Fetching zones..."
                  : `${zones.length} zone${zones.length !== 1 ? "s" : ""} plotted`}
              </Text>
              {!zonesLoading && zones.length === 0 && rawZoneData && (
                <Text style={styles.debugText}>
                  API keys: {
                    (() => {
                      const arr = Array.isArray(rawZoneData)
                        ? rawZoneData
                        : Array.isArray(rawZoneData?.zones) ? rawZoneData.zones
                        : Array.isArray(rawZoneData?.data) ? rawZoneData.data
                        : [rawZoneData];
                      return arr[0] ? Object.keys(arr[0]).join(", ") : "no data";
                    })()
                  }
                </Text>
              )}
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

/* ─── Legend Item ─── */
function LegendItem({ color, label }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendLabel}>{label}</Text>
    </View>
  );
}

/* ─── Quick Action Card ─── */
function QuickCard({ icon, label, onPress, accentColor = "#13ec49" }) {
  const scale = useRef(new Animated.Value(1)).current;
  return (
    <Animated.View style={[styles.cardWrap, { transform: [{ scale }] }]}>
      <TouchableOpacity
        style={[styles.card, { borderColor: accentColor + "33", borderWidth: 4 }]}
        onPress={onPress}
        onPressIn={() =>
          Animated.spring(scale, { toValue: 0.93, useNativeDriver: true, friction: 6 }).start()
        }
        onPressOut={() =>
          Animated.spring(scale, { toValue: 1, useNativeDriver: true }).start()
        }
        activeOpacity={1}
      >
        <View style={[styles.cardIconBox, { backgroundColor: accentColor + "1A" }]}>{icon}</View>
        <Text style={styles.cardLabel}>{label}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

/* ─── Voice Assistant Card ─── */
function VoiceCard({ micScale, listening, onPressIn, onPressOut }) {
  return (
    <View style={styles.cardWrap}>
      <TouchableOpacity
        style={[styles.card, listening && styles.cardListening]}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        activeOpacity={0.85}
      >
        <Animated.View
          style={[
            styles.cardIconBox,
            listening && styles.cardIconBoxListening,
            { transform: [{ scale: micScale }] },
          ]}
        >
          <Ionicons
            name={listening ? "mic-circle" : "mic"}
            size={30}
            color={listening ? "#0f1c14" : "#13ec49"}
          />
        </Animated.View>
        <Text style={styles.cardLabel}>Voice{"\n"}Assistant</Text>
        {listening ? (
          <Text style={styles.listeningTag}>● Listening...</Text>
        ) : (
          <Text style={styles.holdHint}>Hold to speak</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

/* ─── Bottom Nav Tab ─── */
function NavTab({ icon, label, active, onPress }) {
  return (
    <TouchableOpacity style={styles.navTab} onPress={onPress} activeOpacity={0.7}>
      <Ionicons name={icon} size={26} color={active ? "#13ec49" : "#475569"} />
      <Text style={[styles.navLabel, active && styles.navLabelActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

/* ─────────────────── STYLES ─────────────────── */
const CARD_W = (width - 48) / 2;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f6f8f6" },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 54,
    paddingBottom: 14,
    backgroundColor: "#ffffff",
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8e2",
  },
  avatarRing: {
    width: 42, height: 42, borderRadius: 21,
    borderWidth: 2, borderColor: "#13ec49",
    backgroundColor: "#e8fdf0",
    justifyContent: "center", alignItems: "center",
  },
  headerCenter: { flex: 1, alignItems: "center", paddingHorizontal: 8 },
  welcomeText: { color: "#0f172a", fontSize: 20, fontWeight: "800", letterSpacing: 0.2 },
  helpBtn: { width: 42, alignItems: "flex-end" },

  activeTripBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#0f1c14",
    borderWidth: 1.5,
    borderColor: "#13ec49",
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 14,
    elevation: 4,
    shadowColor: "#13ec49",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  activeTripPulse: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: "rgba(19,236,73,0.2)",
    justifyContent: "center", alignItems: "center",
  },
  activeTripDot: {
    width: 12, height: 12, borderRadius: 6, backgroundColor: "#13ec49",
  },
  activeTripTitle: { color: "#13ec49", fontSize: 13, fontWeight: "800", letterSpacing: 0.3 },
  activeTripTime: { color: "#94a3b8", fontSize: 11, fontWeight: "600", marginTop: 2 },

  zoneBanner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "#fff1f1", borderWidth: 1, borderColor: "#fca5a5",
    borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14, marginBottom: 16,
  },
  zoneBannerText: { color: "#dc2626", fontSize: 12, fontWeight: "700", flex: 1 },

  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 24 },

  sosSection: { alignItems: "center", marginBottom: 38, paddingVertical: 10 },
  sosBtn: {
    width: 230, height: 230, borderRadius: 115,
    backgroundColor: "#dc2626",
    justifyContent: "center", alignItems: "center",
    elevation: 12,
    shadowColor: "#ef4444", shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4, shadowRadius: 16,
  },
  sosText: { color: "white", fontSize: 66, fontWeight: "900", letterSpacing: -2 },
  sosCta: { marginTop: 20, color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 3, textTransform: "uppercase" },

  sectionTitle: { color: "#64748b", fontSize: 10, fontWeight: "800", letterSpacing: 3, textTransform: "uppercase", marginBottom: 14 },

  grid: { flexDirection: "row", flexWrap: "wrap", gap: 14, marginBottom: 22 },
  cardWrap: { width: CARD_W },
  card: {
    backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#e2e8f0",
    borderRadius: 16, padding: 18, minHeight: 132, justifyContent: "space-between",
  },
  cardListening: { borderColor: "#13ec49", backgroundColor: "#f0fdf4" },
  cardIconBox: {
    width: 52, height: 52, borderRadius: 13,
    backgroundColor: "rgba(19,236,73,0.12)",
    justifyContent: "center", alignItems: "center", marginBottom: 10,
  },
  cardIconBoxListening: { backgroundColor: "#13ec49" },
  cardLabel: { color: "#1e293b", fontSize: 13, fontWeight: "700", lineHeight: 19 },
  listeningTag: { color: "#13ec49", fontSize: 10, fontWeight: "700", marginTop: 4 },
  holdHint: { color: "#94a3b8", fontSize: 10, fontWeight: "600", marginTop: 4 },

  mapCard: {
    borderRadius: 16, backgroundColor: "#f0fdf4",
    borderWidth: 1, borderColor: "#bbf7d0",
    padding: 16, marginBottom: 0,
  },
  mapCardInner: { flexDirection: "row", alignItems: "center", gap: 14 },
  mapCardIconWrap: {
    width: 48, height: 48, borderRadius: 12,
    backgroundColor: "rgba(19,236,73,0.12)",
    justifyContent: "center", alignItems: "center",
  },
  mapCardTitle: { color: "#1e293b", fontSize: 14, fontWeight: "700", marginBottom: 2 },
  mapCardSub: { color: "#64748b", fontSize: 12, fontWeight: "500" },

  // ── Report Incident Card ──
  incidentCard: {
    borderRadius: 16,
    backgroundColor: "#fff5f5",
    borderWidth: 1.5,
    borderColor: "#fca5a533",
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 14,
    elevation: 2,
    shadowColor: "#dc2626",
    shadowOpacity: 0.1,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  incidentCardLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    flex: 1,
  },
  incidentCardIconWrap: {
    width: 50,
    height: 50,
    borderRadius: 13,
    backgroundColor: "#fef2f2",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#fca5a540",
  },
  incidentCardTitle: {
    color: "#7f1d1d",
    fontSize: 15,
    fontWeight: "800",
    marginBottom: 3,
  },
  incidentCardSub: {
    color: "#dc2626",
    fontSize: 12,
    fontWeight: "500",
  },
  incidentCardArrow: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: "#fee2e2",
    justifyContent: "center",
    alignItems: "center",
  },

  // ── View Reports Card ──
  viewReportsCard: {
    borderRadius: 16,
    backgroundColor: "#faf5ff",
    borderWidth: 1.5,
    borderColor: "#ddd6fe40",
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 10,
    elevation: 2,
    shadowColor: "#7c3aed",
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  viewReportsIconWrap: {
    width: 50,
    height: 50,
    borderRadius: 13,
    backgroundColor: "#ede9fe",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#c4b5fd40",
  },
  viewReportsTitle: {
    color: "#4c1d95",
    fontSize: 15,
    fontWeight: "800",
    marginBottom: 3,
  },
  viewReportsSub: {
    color: "#7c3aed",
    fontSize: 12,
    fontWeight: "500",
  },
  viewReportsArrow: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: "#ede9fe",
    justifyContent: "center",
    alignItems: "center",
  },

  // ── Officer / Patrol Card ──
  patrolCard: {
    borderRadius: 16,
    backgroundColor: "#0f1c14",
    borderWidth: 1,
    borderColor: "#13ec4933",
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    elevation: 3,
    shadowColor: "#13ec49",
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  patrolCardLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    flex: 1,
  },
  patrolCardIconWrap: {
    width: 50,
    height: 50,
    borderRadius: 13,
    backgroundColor: "rgba(19,236,73,0.12)",
    justifyContent: "center",
    alignItems: "center",
  },
  patrolCardTitle: {
    color: "#f0fdf4",
    fontSize: 15,
    fontWeight: "800",
    marginBottom: 3,
  },
  patrolCardSub: {
    color: "#4ade80",
    fontSize: 12,
    fontWeight: "500",
  },
  patrolCardArrow: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: "rgba(19,236,73,0.12)",
    justifyContent: "center",
    alignItems: "center",
  },

  bottomNav: {
    flexDirection: "row",
    backgroundColor: "#ffffff",
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    paddingTop: 10,
    paddingBottom: 30,
    paddingHorizontal: 8,
  },
  navTab: { flex: 1, alignItems: "center", gap: 3 },
  navLabel: { color: "#94a3b8", fontSize: 9, fontWeight: "700", letterSpacing: 0.8, textTransform: "uppercase" },
  navLabelActive: { color: "#13ec49" },

  navVoiceBtn: { flex: 1, alignItems: "center", gap: 4, marginTop: -22 },
  navVoiceBtnInner: {
    width: 58, height: 58, borderRadius: 29,
    backgroundColor: "#13ec49",
    justifyContent: "center", alignItems: "center",
    elevation: 8,
    shadowColor: "#13ec49", shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.45, shadowRadius: 10,
    borderWidth: 3, borderColor: "#ffffff",
  },
  navVoiceBtnActive: {
    backgroundColor: "#ef4444",
    shadowColor: "#ef4444",
    shadowOpacity: 0.7,
  },
  navVoiceBtnProcessing: {
    backgroundColor: "#f97316",
    shadowColor: "#f97316",
    shadowOpacity: 0.7,
  },
  navVoiceLabel: { color: "#13ec49", marginTop: 2 },

  /* ── Hardware voice listening indicator banner ── */
  hwListeningBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#0f1c14",
    borderTopWidth: 1.5,
    borderTopColor: "#ef4444",
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  hwActivatingBanner: {
    borderTopColor: "#13ec49",
    backgroundColor: "#071a0f",
  },
  hwProcessingBanner: {
    borderTopColor: "#f97316",
    backgroundColor: "#1a1200",
  },
  hwPulseDot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: "#ef4444",
  },
  hwListeningText: {
    color: "#f0fdf4",
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.3,
  },

  /* ── SOS Countdown Modal ── */
  sosOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.75)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  sosModalCard: {
    width: "100%",
    backgroundColor: "#0d1a0f",
    borderRadius: 24,
    paddingVertical: 32,
    paddingHorizontal: 28,
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: "#dc2626",
    elevation: 20,
    shadowColor: "#dc2626",
    shadowOpacity: 0.4,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
  },
  sosModalHeader: { alignItems: "center", marginBottom: 28 },
  sosModalEmoji: { fontSize: 36, marginBottom: 8 },
  sosModalTitle: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "900",
    letterSpacing: 3,
    textTransform: "uppercase",
  },
  sosModalSub: {
    color: "#94a3b8",
    fontSize: 13,
    fontWeight: "500",
    textAlign: "center",
    marginTop: 6,
    lineHeight: 18,
  },
  countdownWrap: { marginBottom: 20 },
  countdownRing: {
    width: 130,
    height: 130,
    borderRadius: 65,
    borderWidth: 6,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(220,38,38,0.08)",
  },
  countdownNumber: {
    color: "#fff",
    fontSize: 48,
    fontWeight: "900",
    lineHeight: 52,
  },
  countdownUnit: {
    color: "#64748b",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  sosAutoText: {
    color: "#94a3b8",
    fontSize: 13,
    fontWeight: "500",
    marginBottom: 28,
    textAlign: "center",
  },
  sosAutoSeconds: {
    color: "#ef4444",
    fontWeight: "800",
  },
  sosSendNowBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#dc2626",
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 32,
    width: "100%",
    justifyContent: "center",
    marginBottom: 12,
    elevation: 6,
    shadowColor: "#dc2626",
    shadowOpacity: 0.4,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  sosSendNowText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "900",
    letterSpacing: 0.5,
  },
  sosCancelBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 32,
    width: "100%",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  sosCancelText: {
    color: "#94a3b8",
    fontSize: 15,
    fontWeight: "700",
  },

  /* ── Map Modal ── */
  modalRoot: { flex: 1, backgroundColor: "#ffffff" },
  modalHeader: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingTop: 54, paddingBottom: 14,
    backgroundColor: "#ffffff", borderBottomWidth: 1, borderBottomColor: "#e2e8f0",
  },
  modalBack: { width: 40, justifyContent: "center" },
  modalTitle: { flex: 1, textAlign: "center", fontSize: 17, fontWeight: "800", color: "#0f172a" },
  modalRefresh: { width: 40, alignItems: "flex-end" },

  mapContainer: { flex: 1, position: "relative" },
  map: { flex: 1 },

  mapLoader: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "rgba(255,255,255,0.7)",
    justifyContent: "center", alignItems: "center", gap: 10,
  },
  mapLoaderText: { color: "#475569", fontSize: 14, fontWeight: "600" },

  locateBtn: {
    position: "absolute", bottom: 80, right: 16,
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "#13ec49", paddingVertical: 12, paddingHorizontal: 20,
    borderRadius: 50, elevation: 6,
    shadowColor: "#000", shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.2, shadowRadius: 6,
  },
  locateBtnText: { color: "#0f1c14", fontSize: 14, fontWeight: "800" },

  legend: {
    position: "absolute", bottom: 80, left: 16,
    backgroundColor: "rgba(255,255,255,0.95)", borderRadius: 12,
    paddingVertical: 10, paddingHorizontal: 14, gap: 6,
    elevation: 4, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 4,
  },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 8 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendLabel: { color: "#334155", fontSize: 12, fontWeight: "600" },

  zonesBar: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 16, paddingVertical: 14,
    backgroundColor: "#f8fafc", borderTopWidth: 1, borderTopColor: "#e2e8f0",
  },
  zonesBarText: { color: "#64748b", fontSize: 13, fontWeight: "600" },
  debugText: { color: "#ef4444", fontSize: 10, fontWeight: "500", marginTop: 2 },

  zoneMarker: {
    width: 26, height: 26, borderRadius: 13,
    justifyContent: "center", alignItems: "center",
    borderWidth: 2, borderColor: "white", elevation: 3,
  },
  userMarker: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: "rgba(59,130,246,0.3)",
    justifyContent: "center", alignItems: "center",
  },
  userMarkerInner: {
    width: 12, height: 12, borderRadius: 6,
    backgroundColor: "#3b82f6", borderWidth: 2, borderColor: "white",
  },
});
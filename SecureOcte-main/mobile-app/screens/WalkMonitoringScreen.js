import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  ScrollView,
  Switch,
  StatusBar,
  Dimensions,
  Animated,
  Alert,
  Linking,
  AppState,
} from "react-native";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import AIChatScreen from "./AIChatScreen";
import { useBatteryMonitor } from "./Batterymonitor";
import { AuthContext } from "./AuthContext";

const { width } = Dimensions.get("window");

/* Display-only constants for gauge rendering */
const SPEED_THRESHOLD        = 15;
const MAX_ROTATION_THRESHOLD = 2.75;
const STRONG_SHAKE_THRESHOLD = 3.5;

const INTERVAL_OPTIONS = [
  { label: "1 min",   value: 60000  },
  { label: "2 mins",  value: 120000 },
  { label: "3 mins",  value: 180000 },
  { label: "4 mins",  value: 240000 },
  { label: "5 mins",  value: 300000 },
  { label: "6 mins",  value: 360000 },
  { label: "7 mins",  value: 420000 },
  { label: "8 mins",  value: 480000 },
  { label: "9 mins",  value: 540000 },
  { label: "10 mins", value: 600000 },
];

/* ═══════════════════════════════════════
   SHAKE SENSITIVITY BAR
═══════════════════════════════════════ */
function ShakeSensitivityBar({ accelDelta }) {
  const pct            = Math.min(1, accelDelta / STRONG_SHAKE_THRESHOLD);
  const filledSegments = Math.round(pct * 5);
  const isShake        = accelDelta > STRONG_SHAKE_THRESHOLD;
  const label          = isShake ? "SHAKE!" : filledSegments >= 3 ? "HIGH" : filledSegments >= 1 ? "ACTIVE" : "LOW";
  const labelColor     = isShake ? "#ef4444" : filledSegments >= 3 ? "#f97316" : "#13ec49";

  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (isShake) {
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.08, duration: 80,  useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1,    duration: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [isShake]);

  return (
    <Animated.View style={[sensitivityStyles.card, { transform: [{ scale: pulseAnim }] }]}>
      <View style={sensitivityStyles.row}>
        <Text style={sensitivityStyles.title}>SHAKE SENSITIVITY</Text>
        <View style={[sensitivityStyles.badge, { backgroundColor: labelColor + "22" }]}>
          <Text style={[sensitivityStyles.badgeText, { color: labelColor }]}>{label}</Text>
        </View>
      </View>
      <View style={sensitivityStyles.barRow}>
        {[0, 1, 2, 3, 4].map((i) => (
          <View
            key={i}
            style={[
              sensitivityStyles.segment,
              {
                backgroundColor:
                  i < filledSegments
                    ? i >= 3 ? "#ef4444" : "#13ec49"
                    : "#e2e8f0",
              },
            ]}
          />
        ))}
      </View>
      <Text style={sensitivityStyles.hint}>
        {accelDelta > 0
          ? `Delta: ${accelDelta.toFixed(2)} g  ·  Monitoring for sudden movements or falls`
          : "Monitoring for sudden movements or falls"}
      </Text>
    </Animated.View>
  );
}

/* ═══════════════════════════════════════
   MAIN COMPONENT
═══════════════════════════════════════ */
export default function WalkMonitoringScreen({
  user,
  goBack,
  inZone,
  secureMeOn,
  toggleSecureMe,
  recordTouch,
  walkEngine,
}) {
  const {
    monitoring,
    coords,
    speed,
    gyroRotation,
    accelDelta,
    elapsed,
    safetyAlertVisible,
    isStoppingTrip,
    notifInterval,
    startMonitoring,
    stopMonitoring,
    confirmSafe,
    confirmNotSafe,
    handleEmergency,
    handleSaveInterval,
  } = walkEngine;

  const [chatOpen,        setChatOpen]        = useState(false);
  const [pendingInterval, setPendingInterval] = useState(notifInterval);
  const [intervalSaved,   setIntervalSaved]   = useState(false);
  const [intervalOpen,    setIntervalOpen]    = useState(false);

  /* ── Police dispatch banner ── */
  const [dispatchVisible, setDispatchVisible] = useState(false);

  /* ── Police alert confirmation dialog ── */
  const [policeAlertModal, setPoliceAlertModal] = useState(false);

  /* ── Location permission denied modal ── */
  const [permissionDenied, setPermissionDenied] = useState(false);

  /* ── Refs for spec-required guards ── */
  const emergencyTriggeredRef = useRef(false); // multi-tap lock
  const lastTouchTimeRef      = useRef(0);     // 500ms debounce
  const safetyTimerRef        = useRef(null);  // 30s safety check auto-timeout

  /* Battery monitor */
  useBatteryMonitor({ user, enabled: monitoring, mode: "walk" });

  // ── TOUCH DEBOUNCE (500 ms gate per spec) ──────────────────────────────────
  const handleTouch = useCallback(() => {
    const now = Date.now();
    if (now - lastTouchTimeRef.current < 500) return;
    lastTouchTimeRef.current = now;
    recordTouch();
  }, [recordTouch]);

  // ── EMERGENCY with multi-tap lock ─────────────────────────────────────────
  const handleEmergencyWithBanner = useCallback(() => {
    if (emergencyTriggeredRef.current) return; // idempotency guard
    emergencyTriggeredRef.current = true;
    handleEmergency();
    setDispatchVisible(true);
    setPoliceAlertModal(true);
  }, [handleEmergency]);

  // ── STOP MONITORING ───────────────────────────────────────────────────────
  const handleStopMonitoring = useCallback(async () => {
    setDispatchVisible(false);
    emergencyTriggeredRef.current = false; // reset lock for next session
    await stopMonitoring();
  }, [stopMonitoring]);

  // ── ENGINE STATE SYNC: clear banner + lock if monitoring ends externally ──
  useEffect(() => {
    if (!monitoring) {
      setDispatchVisible(false);
      emergencyTriggeredRef.current = false;
    }
  }, [monitoring]);

  // ── SCREEN FOCUS: re-sync dispatchVisible with engine state ───────────────
  // If the user navigates away and back, dispatchVisible is re-synced to
  // whether an emergency is genuinely still active (monitoring still on).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        // If monitoring stopped while app was backgrounded, clear the banner
        if (!monitoring) {
          setDispatchVisible(false);
          emergencyTriggeredRef.current = false;
        }
      }
    });
    return () => sub.remove();
  }, [monitoring]);

  // ── SAFETY CHECK MODAL: 30s auto-timeout → confirmNotSafe ─────────────────
  useEffect(() => {
    if (safetyAlertVisible) {
      // Start 30s countdown — if no user response, auto-trigger emergency
      safetyTimerRef.current = setTimeout(() => {
        console.log("[WalkMonitor] Safety check timeout — auto-triggering confirmNotSafe");
        confirmNotSafe();
        setPoliceAlertModal(true);
      }, 30000);
    } else {
      // Modal dismissed (user responded) — cancel the timeout
      if (safetyTimerRef.current) {
        clearTimeout(safetyTimerRef.current);
        safetyTimerRef.current = null;
      }
    }
    return () => {
      if (safetyTimerRef.current) {
        clearTimeout(safetyTimerRef.current);
        safetyTimerRef.current = null;
      }
    };
  }, [safetyAlertVisible, confirmNotSafe]);

  // ── LOCATION PERMISSION on mount ──────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        setPermissionDenied(true);
        Alert.alert(
          "Location Required",
          "Walk monitoring needs GPS access to keep you safe. Please enable Location in Settings.",
          [
            {
              text: "Open Settings",
              onPress: () => Linking.openSettings(),
            },
            {
              text: "Dismiss",
              style: "cancel",
              onPress: () => setPermissionDenied(false),
            },
          ],
          { cancelable: false }
        );
      }
    })();
  }, []);

  // ── UNMOUNT CLEANUP ───────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      emergencyTriggeredRef.current = false;
      setDispatchVisible(false);
      if (safetyTimerRef.current) {
        clearTimeout(safetyTimerRef.current);
        safetyTimerRef.current = null;
      }
    };
  }, []);

  // ── INTERVAL SAVE UI helper ───────────────────────────────────────────────
  const handleSaveIntervalUI = useCallback(async () => {
    await handleSaveInterval(pendingInterval);
    setIntervalSaved(true);
    setTimeout(() => setIntervalSaved(false), 2000);
  }, [handleSaveInterval, pendingInterval]);

  const formatElapsed = (s) => {
    const m   = Math.floor(s / 60).toString().padStart(2, "0");
    const sec = (s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  };

  return (
    <View style={styles.root} onTouchStart={handleTouch}>
      <StatusBar barStyle="dark-content" backgroundColor="#13ec49" />

      {/* ── AI Chat Modal ── */}
      <Modal visible={chatOpen} animationType="slide">
        <AIChatScreen onBack={() => setChatOpen(false)} />
      </Modal>

      {/* ── Safety Check Modal ── */}
      <Modal visible={safetyAlertVisible} transparent animationType="fade">
        <View style={styles.safetyOverlay}>
          <View style={styles.safetyCard}>
            <Text style={styles.safetyTitle}>⚠️ Safety Check</Text>
            <Text style={styles.safetyBody}>
              Are you safe? Please respond within 30 seconds.
            </Text>
            <TouchableOpacity style={styles.safetyYesBtn} onPress={confirmSafe}>
              <Text style={styles.safetyBtnText}>✅ Yes, I'm Safe</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.safetyNoBtn}
              onPress={() => { confirmNotSafe(); setPoliceAlertModal(true); }}
            >
              <Text style={styles.safetyBtnText}>🆘 No, Send Help</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── Police Alert Confirmation Modal ── */}
      <Modal visible={policeAlertModal} transparent animationType="fade">
        <View style={styles.policeAlertOverlay}>
          <View style={styles.policeAlertCard}>
            {/* Pulsing red dot */}
            <View style={styles.policeAlertIconWrap}>
              <View style={styles.policeAlertIconRing} />
              <View style={styles.policeAlertIconCore}>
                <MaterialIcons name="local-police" size={32} color="#fff" />
              </View>
            </View>

            <Text style={styles.policeAlertTitle}>ALERT SENT</Text>
            <Text style={styles.policeAlertSubtitle}>
              Authorities have been notified
            </Text>
            <Text style={styles.policeAlertBody}>
              Emergency services are aware of your location. Stay calm and remain where you are if it is safe to do so.
            </Text>

            <View style={styles.policeAlertDivider} />

            <TouchableOpacity
              style={styles.policeAlertBtn}
              onPress={() => setPoliceAlertModal(false)}
              activeOpacity={0.85}
            >
              <Text style={styles.policeAlertBtnText}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── GREEN TOP HEADER ── */}
      <View style={styles.topBar}>
        <View style={styles.topBarLeft}>
          <MaterialIcons name="favorite" size={20} color="#0f1c14" />
          <Text style={styles.topBarTitle}>
            {monitoring ? "MONITORING ACTIVE" : "WALK MONITORING"}
          </Text>
        </View>
        {monitoring && (
          <View style={styles.gpsBadge}>
            <View style={styles.gpsDot} />
            <Text style={styles.gpsText}>GPS LIVE</Text>
          </View>
        )}
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >

        {/* ── SecureMe Banner ── */}
        {inZone && (
          <View style={styles.secureMeBanner}>
            <View style={{ flex: 1 }}>
              <Text style={styles.secureMeTitle}>🔐 SecureMe Mode</Text>
              <Text style={styles.secureMeSub}>
                {secureMeOn
                  ? "Active — sensors running in background"
                  : "You're in a high-risk zone"}
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

        {/* ── Timer ── */}
        <View style={styles.timerSection}>
          <Text style={styles.timerLabel}>TIME ELAPSED</Text>
          <Text style={styles.timerValue}>{formatElapsed(elapsed)}</Text>
        </View>

        {/* ── Dual Gauges ── */}
        <View style={styles.gaugesRow}>

          {/* Speed gauge */}
          <View style={styles.gaugeWrap}>
            <View style={styles.gaugeOuter}>
              <View style={styles.gaugeTrack} />
              <View style={[
                styles.gaugeFill,
                {
                  borderTopColor:    speed > 0                        ? "#13ec49" : "transparent",
                  borderRightColor:  speed > SPEED_THRESHOLD * 0.33  ? "#13ec49" : "transparent",
                  borderBottomColor: speed > SPEED_THRESHOLD * 0.66  ? "#13ec49" : "transparent",
                  borderLeftColor:   speed > SPEED_THRESHOLD         ? "#ef4444" : "transparent",
                },
              ]} />
              <View style={styles.gaugeCenter}>
                <Text style={styles.gaugeLabelSmall}>SPEED</Text>
                <Text style={[
                  styles.gaugeValue,
                  speed >= SPEED_THRESHOLD && { color: "#ef4444" },
                ]}>
                  {speed.toFixed(0)}
                </Text>
                <Text style={styles.gaugeLabelSmall}>km/h</Text>
              </View>
            </View>
          </View>

          {/* Rotation gauge */}
          <View style={styles.gaugeWrap}>
            <View style={styles.gaugeOuter}>
              <View style={styles.gaugeTrack} />
              <View style={[
                styles.gaugeFill,
                {
                  borderTopColor:    gyroRotation > 0                               ? "#13ec49" : "transparent",
                  borderRightColor:  gyroRotation > MAX_ROTATION_THRESHOLD * 0.33  ? "#13ec49" : "transparent",
                  borderBottomColor: gyroRotation > MAX_ROTATION_THRESHOLD * 0.66  ? "#13ec49" : "transparent",
                  borderLeftColor:   gyroRotation > MAX_ROTATION_THRESHOLD         ? "#ef4444" : "transparent",
                },
              ]} />
              <View style={styles.gaugeCenter}>
                <Text style={styles.gaugeLabelSmall}>ROTATION</Text>
                <Text style={[
                  styles.gaugeValue,
                  gyroRotation > MAX_ROTATION_THRESHOLD && { color: "#ef4444" },
                ]}>
                  {gyroRotation.toFixed(1)}
                </Text>
                <Text style={styles.gaugeLabelSmall}>Rad/s</Text>
              </View>
            </View>
          </View>

        </View>

        {/* ── Location Coordinates ── */}
        <View style={styles.coordsBox}>
          <Text style={styles.coordsLabel}>LOCATION COORDINATES</Text>
          <Text style={styles.coordsValue}>
            {coords
              ? `Lat: ${coords.latitude.toFixed(5)},  Long: ${coords.longitude.toFixed(5)}`
              : monitoring
                ? "Acquiring GPS signal..."
                : "Start trip to enable GPS"}
          </Text>
        </View>

        {/* ── Shake Sensitivity Bar ── */}
        <ShakeSensitivityBar accelDelta={accelDelta} />

        {/* ── Notification Timeout ── */}
        <View style={styles.notifCard}>
          <View style={styles.notifCardHeader}>
            <Text style={styles.notifCardTitle}>CHECK NOTIFICATION TIMER</Text>
            <TouchableOpacity
              style={styles.notifBadge}
              onPress={() => { setPendingInterval(notifInterval); setIntervalOpen(o => !o); }}
            >
              <Text style={styles.notifBadgeText}>
                {INTERVAL_OPTIONS.find(o => o.value === notifInterval)?.label}
                {"  "}{intervalOpen ? "▲" : "▼"}
              </Text>
            </TouchableOpacity>
          </View>

          {intervalOpen && (
            <View style={styles.dropdownWrap}>
              {INTERVAL_OPTIONS.map((opt) => {
                const selected = pendingInterval === opt.value;
                return (
                  <TouchableOpacity
                    key={opt.value}
                    style={styles.radioRow}
                    onPress={() => setPendingInterval(opt.value)}
                  >
                    <View style={styles.radioOuter}>
                      {selected && <View style={styles.radioInner} />}
                    </View>
                    <Text style={[styles.radioLabel, selected && styles.radioLabelSelected]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity
                style={[styles.saveBtn, intervalSaved && styles.saveBtnDone]}
                onPress={() => { handleSaveIntervalUI(); setIntervalOpen(false); }}
              >
                <Text style={styles.saveBtnText}>{intervalSaved ? "✅ Saved!" : "Save"}</Text>
              </TouchableOpacity>
            </View>
          )}

          <Text style={styles.notifHint}>
            SELECT THE CHECK NOTIFICATION TIME ACCORDING TO YOUR CONVENIENCE
          </Text>
        </View>

        {/* ── Bottom Buttons ── */}
        <View style={styles.btnsSection}>

          {/* Police Support — use wrapped handler */}
          <TouchableOpacity style={styles.policeBtn} onPress={handleEmergencyWithBanner} activeOpacity={0.85}>
            <MaterialIcons name="local-police" size={22} color="#f7f7f7" />
            <Text style={styles.policeBtnText}>POLICE SUPPORT</Text>
          </TouchableOpacity>

          {/* Inline dispatch confirmation — shown after alert is sent, stays until trip ends */}
          {dispatchVisible && (
            <View style={styles.dispatchLabel}>
              <View style={styles.dispatchLabelDot} />
              <View style={{ flex: 1 }}>
                <Text style={styles.dispatchLabelTitle}>🚨 ALERT SENT — DISPATCH ON THE WAY</Text>
                <Text style={styles.dispatchLabelSub}>Police support has been notified. Stay on the line.</Text>
              </View>
            </View>
          )}

          {/* Start / Cancel Monitoring */}
          {!monitoring ? (
            <TouchableOpacity style={styles.startBtn} onPress={startMonitoring} activeOpacity={0.85}>
              <MaterialIcons name="shield" size={22} color="#000" />
              <Text style={styles.startBtnText}>START MONITORING</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.cancelBtn, isStoppingTrip && styles.cancelBtnDisabled]}
              onPress={handleStopMonitoring}
              disabled={isStoppingTrip}
              activeOpacity={0.85}
            >
              <Ionicons name="close-circle-outline" size={22} color="#fff" />
              <Text style={styles.cancelBtnText}>
                {isStoppingTrip ? "🔒 VERIFYING..." : "CANCEL MONITORING"}
              </Text>
            </TouchableOpacity>
          )}

          <Text style={styles.encryptedNote}>Monitoring is encrypted and secure</Text>
        </View>

        <View style={{ height: 20 }} />
      </ScrollView>

      {/* ── AI Chat FAB ── */}
      <TouchableOpacity style={styles.chatFab} onPress={() => setChatOpen(true)} activeOpacity={0.85}>
        <Ionicons name="chatbubble-ellipses" size={28} color="#0f1c14" />
        <View style={styles.chatFabBadge}>
          <Text style={styles.chatFabBadgeText}>AI</Text>
        </View>
      </TouchableOpacity>

      {/* ── Bottom Nav ── */}
      <View style={styles.bottomNav}>
        <NavTab icon="home-outline" label="Home"   onPress={goBack} />
        <NavTab icon="shield-checkmark" label="Safety" active />
      </View>
    </View>
  );
}

/* ── NavTab ── */
function NavTab({ icon, label, active, onPress }) {
  return (
    <TouchableOpacity style={styles.navTab} onPress={onPress} activeOpacity={0.7}>
      <Ionicons name={icon} size={24} color={active ? "#13ec49" : "#94a3b8"} />
      <Text style={[styles.navLabel, active && styles.navLabelActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

/* ══════════════════════════════════════
   STYLES
══════════════════════════════════════ */
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f6f8f6" },

  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#13ec49",
    paddingHorizontal: 20,
    paddingTop: 54,
    paddingBottom: 14,
  },
  topBarLeft:  { flexDirection: "row", alignItems: "center", gap: 10 },
  topBarTitle: { color: "#0f1c14", fontSize: 13, fontWeight: "900", letterSpacing: 2 },
  gpsBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(15,28,20,0.12)",
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
  },
  gpsDot:  { width: 8, height: 8, borderRadius: 4, backgroundColor: "#0f1c14" },
  gpsText: { color: "#0f1c14", fontSize: 11, fontWeight: "800", letterSpacing: 1 },

  scroll:        { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 100 },

  secureMeBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#bbf7d0",
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
    gap: 10,
  },
  secureMeTitle: { color: "#0f1c14", fontWeight: "700", fontSize: 14 },
  secureMeSub:   { color: "#64748b", fontSize: 12, marginTop: 2 },

  timerSection: { alignItems: "center", marginBottom: 24, marginTop: 8 },
  timerLabel:   { color: "#94a3b8", fontSize: 10, fontWeight: "800", letterSpacing: 3, textTransform: "uppercase" },
  timerValue:   { color: "#0f172a", fontSize: 64, fontWeight: "900", letterSpacing: -2, marginTop: 4 },

  gaugesRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 32,
    marginBottom: 20,
  },
  gaugeWrap: { alignItems: "center" },
  gaugeOuter: {
    width: 120,
    height: 120,
    borderRadius: 60,
    justifyContent: "center",
    alignItems: "center",
    position: "relative",
  },
  gaugeTrack: {
    position: "absolute",
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 7,
    borderColor: "#e2e8f0",
  },
  gaugeFill: {
    position: "absolute",
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 7,
    borderTopColor: "#13ec49",
    borderRightColor: "#13ec49",
    borderBottomColor: "transparent",
    borderLeftColor: "transparent",
    transform: [{ rotate: "-45deg" }],
  },
  gaugeCenter:     { alignItems: "center", zIndex: 2 },
  gaugeLabelSmall: { color: "#94a3b8", fontSize: 8, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" },
  gaugeValue:      { color: "#0f172a", fontSize: 22, fontWeight: "900", lineHeight: 26 },

  coordsBox:   { alignItems: "center", marginBottom: 20 },
  coordsLabel: { color: "#94a3b8", fontSize: 9, fontWeight: "800", letterSpacing: 2, textTransform: "uppercase" },
  coordsValue: { color: "#0f172a", fontSize: 12, fontFamily: "monospace", fontWeight: "700", marginTop: 4 },

  btnsSection: { gap: 12, marginTop: 4 },
  policeBtn: {
    backgroundColor: "#ff0000",
    paddingVertical: 18,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  policeBtnText: { color: "#f7f7f7", fontWeight: "900", fontSize: 16, letterSpacing: 1 },

  startBtn: {
    backgroundColor: "#13ec49",
    paddingVertical: 18,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
  },
  startBtnText: { color: "#000000", fontWeight: "900", fontSize: 16, letterSpacing: 1 },

  cancelBtn: {
    backgroundColor: "#334155",
    paddingVertical: 18,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  cancelBtnDisabled: { opacity: 0.6 },
  cancelBtnText: { color: "#fff", fontWeight: "900", fontSize: 16, letterSpacing: 1 },

  encryptedNote: { textAlign: "center", color: "#94a3b8", fontSize: 11, fontWeight: "500" },

  dispatchLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#1a0a0a",
    borderWidth: 1.5,
    borderColor: "#dc2626",
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  dispatchLabelDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#dc2626",
    shadowColor: "#dc2626",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 6,
    elevation: 4,
  },
  dispatchLabelTitle: {
    color: "#f87171",
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: 2,
  },
  dispatchLabelSub: {
    color: "#fca5a5",
    fontSize: 11,
    fontWeight: "500",
    lineHeight: 15,
  },

  safetyOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  safetyCard: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 28,
    width: "100%",
    alignItems: "center",
    gap: 14,
    elevation: 10,
  },
  safetyTitle:  { fontSize: 22, fontWeight: "900", color: "#0f172a" },
  safetyBody:   { fontSize: 14, color: "#475569", textAlign: "center", lineHeight: 21 },
  safetyYesBtn: {
    width: "100%",
    backgroundColor: "#13ec49",
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: "center",
  },
  safetyNoBtn: {
    width: "100%",
    backgroundColor: "#dc2626",
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: "center",
  },
  safetyBtnText: { color: "#fff", fontWeight: "800", fontSize: 15 },

  /* ── Police Alert Modal ── */
  policeAlertOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.72)",
    justifyContent: "center",
    alignItems: "center",
    padding: 28,
  },
  policeAlertCard: {
    backgroundColor: "#0f1117",
    borderRadius: 24,
    padding: 32,
    width: "100%",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: "#dc2626",
    elevation: 20,
    shadowColor: "#dc2626",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
    gap: 10,
  },
  policeAlertIconWrap: {
    width: 80,
    height: 80,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 6,
  },
  policeAlertIconRing: {
    position: "absolute",
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 2,
    borderColor: "#dc2626",
    opacity: 0.4,
  },
  policeAlertIconCore: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "#dc2626",
    justifyContent: "center",
    alignItems: "center",
  },
  policeAlertTitle: {
    color: "#ffffff",
    fontSize: 26,
    fontWeight: "900",
    letterSpacing: 3,
    textTransform: "uppercase",
    marginTop: 4,
  },
  policeAlertSubtitle: {
    color: "#f87171",
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  policeAlertBody: {
    color: "#94a3b8",
    fontSize: 13,
    textAlign: "center",
    lineHeight: 20,
    marginTop: 4,
    paddingHorizontal: 8,
  },
  policeAlertDivider: {
    width: "100%",
    height: 1,
    backgroundColor: "#1e293b",
    marginVertical: 6,
  },
  policeAlertBtn: {
    width: "100%",
    backgroundColor: "#dc2626",
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
    marginTop: 4,
  },
  policeAlertBtnText: {
    color: "#ffffff",
    fontWeight: "900",
    fontSize: 14,
    letterSpacing: 1.5,
  },

  chatFab: {
    position: "absolute",
    bottom: 90,
    right: 20,
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "#13ec49",
    justifyContent: "center",
    alignItems: "center",
    elevation: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    borderWidth: 3,
    borderColor: "#fff",
  },
  chatFabBadge: {
    position: "absolute",
    top: -2,
    right: -2,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#0f172a",
    justifyContent: "center",
    alignItems: "center",
  },
  chatFabBadgeText: { color: "#13ec49", fontSize: 8, fontWeight: "900" },

  bottomNav: {
    flexDirection: "row",
    backgroundColor: "#fff",
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    paddingTop: 10,
    paddingBottom: 28,
    paddingHorizontal: 8,
  },
  navTab:        { flex: 1, alignItems: "center", gap: 3 },
  navLabel:      { color: "#94a3b8", fontSize: 9, fontWeight: "700", letterSpacing: 0.8, textTransform: "uppercase" },
  navLabelActive: { color: "#13ec49" },

  notifCard: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 16,
    padding: 16,
    marginBottom: 14,
  },
  notifCardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  notifCardTitle:  { color: "#334155", fontSize: 12, fontWeight: "800", letterSpacing: 1 },
  notifBadge:      { backgroundColor: "rgba(19,236,73,0.12)", paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  notifBadgeText:  { color: "#000000", fontSize: 14, fontWeight: "800" },
  notifHint:       { color: "#94a3b8", fontSize: 10, textAlign: "center", marginTop: 8 },

  dropdownWrap:       { marginTop: 4 },
  radioRow:           { flexDirection: "row", alignItems: "center", paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: "#f1f5f9" },
  radioOuter:         { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: "#13ec49", alignItems: "center", justifyContent: "center", marginRight: 12 },
  radioInner:         { width: 10, height: 10, borderRadius: 5, backgroundColor: "#13ec49" },
  radioLabel:         { fontSize: 14, color: "#94a3b8" },
  radioLabelSelected: { color: "#0f172a", fontWeight: "700" },
  saveBtn:            { marginTop: 14, backgroundColor: "#13ec49", paddingVertical: 11, borderRadius: 24, alignItems: "center" },
  saveBtnDone:        { backgroundColor: "#16a34a" },
  saveBtnText:        { color: "#0f1c14", fontWeight: "800", fontSize: 14 },
});

/* Sensitivity bar sub-styles */
const sensitivityStyles = StyleSheet.create({
  card: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 16,
    padding: 16,
    marginBottom: 14,
  },
  row:       { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 14 },
  title:     { color: "#334155", fontSize: 12, fontWeight: "800", letterSpacing: 1 },
  badge:     { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  badgeText: { fontSize: 11, fontWeight: "800" },
  barRow:    { flexDirection: "row", gap: 5, height: 8 },
  segment:   { flex: 1, borderRadius: 99 },
  hint:      { color: "#94a3b8", fontSize: 10, textAlign: "center", marginTop: 10 },
});
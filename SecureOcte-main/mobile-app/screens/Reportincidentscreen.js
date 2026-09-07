/**
 * ReportIncidentScreen.js
 * ─────────────────────────────────────────────────────────────
 * Citizen incident reporting flow — 3 steps:
 *   Step 1 — Select incident category
 *   Step 2 — Fill indicators (crowd size + behavior + optional note)
 *   Step 3 — Consent modal → Submit → Success toast
 *
 * POST /api/incident/report
 */

import React, { useState, useRef, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  TextInput,
  Modal,
  Animated,
  Easing,
  StatusBar,
  ActivityIndicator,
  SafeAreaView,
  Platform,
  KeyboardAvoidingView,
} from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Location from "expo-location";
import { apiFetch, AuthError } from "./api";

/* ── Constants ─────────────────────────────────────────────── */
const CATEGORIES = [
  {
    id:    "Public Disturbance",
    icon:  "bullhorn",
    color: "#f97316",
    bg:    "#fff7ed",
    desc:  "Loud noise, fighting, or disruptive public behaviour",
  },
  {
    id:    "Suspicious Gathering",
    icon:  "account-group",
    color: "#8b5cf6",
    bg:    "#f5f3ff",
    desc:  "Unusual or suspicious group activity in public spaces",
  },
  {
    id:    "Risky Behavior",
    icon:  "alert-octagon",
    color: "#dc2626",
    bg:    "#fef2f2",
    desc:  "Aggressive, threatening, or dangerous conduct",
  },
];

const CROWD_SIZES = [
  { id: "Single person",        icon: "account",             count: "1"   },
  { id: "Small group (2–5)",    icon: "account-multiple",    count: "2-5" },
  { id: "Medium group (6–10)",  icon: "account-group",       count: "6-10"},
  { id: "Large group (10+)",    icon: "account-supervisor",  count: "10+" },
];

const BEHAVIOR_MAP = {
  "Public Disturbance":  [
    { id: "loud shouting",     icon: "volume-high"      },
    { id: "drinking visible",  icon: "cup"              },
    { id: "smoking visible",   icon: "smoking"          },
    { id: "blocking pathway",  icon: "road-variant"     },
  ],
  "Suspicious Gathering": [
    { id: "loitering",              icon: "walk"            },
    { id: "watching passersby",     icon: "eye"             },
    { id: "blocking entry",         icon: "gate"            },
    { id: "staying long duration",  icon: "clock-outline"   },
  ],
  "Risky Behavior": [
    { id: "aggressive tone",       icon: "emoticon-angry"   },
    { id: "harassment signs",      icon: "hand-front-right" },
    { id: "chasing",               icon: "run-fast"         },
    { id: "threatening gestures",  icon: "fist"             },
  ],
};

/* ── Component ─────────────────────────────────────────────── */
export default function ReportIncidentScreen({ token, user, goBack }) {
  /* step: 1 = category, 2 = indicators, 3 = consent modal */
  const [step,       setStep]       = useState(1);
  const [category,   setCategory]   = useState(null);
  const [crowdSize,  setCrowdSize]  = useState(null);
  const [behaviors,  setBehaviors]  = useState([]);
  const [note,       setNote]       = useState("");
  const [loading,    setLoading]    = useState(false);
  const [consentOpen,setConsentOpen]= useState(false);

  /* toast */
  const [toast, setToast] = useState({ visible: false, msg: "", success: true });
  const toastAnim = useRef(new Animated.Value(0)).current;

  /* step progress animation */
  const progressAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue:         step - 1,
      duration:        300,
      easing:          Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [step]);

  /* ── helpers ── */
  const showToast = (msg, success = true) => {
    setToast({ visible: true, msg, success });
    Animated.sequence([
      Animated.timing(toastAnim, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.delay(2800),
      Animated.timing(toastAnim, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]).start(() => setToast(t => ({ ...t, visible: false })));
  };

  const toggleBehavior = (id) => {
    setBehaviors(prev =>
      prev.includes(id) ? prev.filter(b => b !== id) : [...prev, id]
    );
  };

  const canProceedStep2 = crowdSize !== null && behaviors.length > 0;

  /* ── Step 1: select category ── */
  const handleSelectCategory = (cat) => {
    setCategory(cat);
    setBehaviors([]);
    setCrowdSize(null);
    setStep(2);
  };

  /* ── Step 2: open consent modal ── */
  const handleReviewReport = () => {
    if (!canProceedStep2) return;
    setConsentOpen(true);
  };

  /* ── Step 3: submit ── */
  const handleSubmit = async () => {
    setConsentOpen(false);
    setLoading(true);
    try {
      /* get location */
      let latitude = null, longitude = null;
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === "granted") {
          const pos = await Promise.race([
            Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
          ]);
          latitude  = pos.coords.latitude;
          longitude = pos.coords.longitude;
        }
      } catch (_) {}

      if (latitude === null || longitude === null) {
        showToast("Could not get your location. Please enable location access.", false);
        setLoading(false);
        return;
      }

      const data = await apiFetch(
        "/api/incident/report",
        {
          method: "POST",
          body: {
            category,
            crowdSize,
            behaviorIndicators: behaviors,
            note:               note.trim(),
            latitude,
            longitude,
          },
        },
        token
      );

      showToast("Report submitted. Authorities will review shortly.", true);

      /* reset after short delay */
      setTimeout(() => {
        setStep(1);
        setCategory(null);
        setCrowdSize(null);
        setBehaviors([]);
        setNote("");
      }, 1800);

    } catch (err) {
      if (err instanceof AuthError) {
        showToast("Session expired. Please log in again.", false);
      } else {
        showToast(err.message || "Submission failed. Please try again.", false);
      }
    } finally {
      setLoading(false);
    }
  };

  /* ── Active category meta ── */
  const activeCat = CATEGORIES.find(c => c.id === category);

  /* ── Render ── */
  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />

      {/* ── Header ── */}
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={step === 1 ? goBack : () => setStep(s => s - 1)}>
          <Ionicons name="arrow-back" size={22} color="#0f1c14" />
        </TouchableOpacity>
        <View style={s.headerCenter}>
          <Text style={s.headerTitle}>Report Incident</Text>
          <Text style={s.headerSub}>Step {step} of 2</Text>
        </View>
        <View style={{ width: 38 }} />
      </View>

      {/* ── Progress bar ── */}
      <View style={s.progressTrack}>
        <Animated.View
          style={[
            s.progressFill,
            {
              width: progressAnim.interpolate({
                inputRange:  [0, 1],
                outputRange: ["10%", "100%"],
              }),
            },
          ]}
        />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={s.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >

          {/* ══════════════════════════════════════════
              STEP 1 — Select category
          ══════════════════════════════════════════ */}
          {step === 1 && (
            <View>
              <Text style={s.sectionLabel}>What type of incident are you reporting?</Text>
              <Text style={s.sectionHint}>Your report will be sent to the nearest patrol unit.</Text>

              {CATEGORIES.map(cat => (
                <TouchableOpacity
                  key={cat.id}
                  style={[s.catCard, { borderColor: cat.color + "40", backgroundColor: cat.bg }]}
                  onPress={() => handleSelectCategory(cat.id)}
                  activeOpacity={0.75}
                >
                  <View style={[s.catIconBox, { backgroundColor: cat.color }]}>
                    <MaterialCommunityIcons name={cat.icon} size={24} color="#fff" />
                  </View>
                  <View style={s.catText}>
                    <Text style={[s.catTitle, { color: cat.color }]}>{cat.id}</Text>
                    <Text style={s.catDesc}>{cat.desc}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={cat.color} />
                </TouchableOpacity>
              ))}

              <View style={s.infoBox}>
                <Ionicons name="shield-checkmark-outline" size={16} color="#059669" />
                <Text style={s.infoText}>
                  Reports are reviewed by authorities. False reporting is punishable under law.
                </Text>
              </View>
            </View>
          )}

          {/* ══════════════════════════════════════════
              STEP 2 — Indicators
          ══════════════════════════════════════════ */}
          {step === 2 && activeCat && (
            <View>
              {/* Category badge */}
              <View style={[s.catBadge, { backgroundColor: activeCat.bg, borderColor: activeCat.color + "50" }]}>
                <MaterialCommunityIcons name={activeCat.icon} size={16} color={activeCat.color} />
                <Text style={[s.catBadgeText, { color: activeCat.color }]}>{activeCat.id}</Text>
              </View>

              {/* ── A. Crowd Size ── */}
              <Text style={s.sectionLabel}>A. Crowd Size</Text>
              <Text style={s.sectionHint}>Helps patrol plan their response.</Text>

              <View style={s.crowdGrid}>
                {CROWD_SIZES.map(cs => {
                  const sel = crowdSize === cs.id;
                  return (
                    <TouchableOpacity
                      key={cs.id}
                      style={[s.crowdChip, sel && s.crowdChipSel]}
                      onPress={() => setCrowdSize(cs.id)}
                      activeOpacity={0.7}
                    >
                      <MaterialCommunityIcons
                        name={cs.icon}
                        size={20}
                        color={sel ? "#ffffff" : "#475569"}
                      />
                      <Text style={[s.crowdChipText, sel && s.crowdChipTextSel]}>
                        {cs.id}
                      </Text>
                      {sel && (
                        <View style={s.crowdCheck}>
                          <Ionicons name="checkmark" size={12} color="#fff" />
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* ── B. Behavior Indicators ── */}
              <Text style={[s.sectionLabel, { marginTop: 24 }]}>B. Behavior Indicators</Text>
              <Text style={s.sectionHint}>Select all that apply.</Text>

              <View style={s.behaviorGrid}>
                {(BEHAVIOR_MAP[category] || []).map(beh => {
                  const sel = behaviors.includes(beh.id);
                  return (
                    <TouchableOpacity
                      key={beh.id}
                      style={[s.behaviorChip, sel && { backgroundColor: activeCat.color, borderColor: activeCat.color }]}
                      onPress={() => toggleBehavior(beh.id)}
                      activeOpacity={0.7}
                    >
                      <MaterialCommunityIcons
                        name={beh.icon}
                        size={17}
                        color={sel ? "#fff" : "#475569"}
                      />
                      <Text style={[s.behaviorChipText, sel && { color: "#fff" }]}>
                        {beh.id}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* ── Optional Note ── */}
              <Text style={[s.sectionLabel, { marginTop: 24 }]}>Additional Note  <Text style={s.optionalTag}>(optional)</Text></Text>
              <TextInput
                style={s.noteInput}
                placeholder="Describe what you observed…"
                placeholderTextColor="#94a3b8"
                multiline
                maxLength={500}
                value={note}
                onChangeText={setNote}
                textAlignVertical="top"
              />
              <Text style={s.charCount}>{note.length} / 500</Text>

              {/* ── Submit button ── */}
              <TouchableOpacity
                style={[s.submitBtn, !canProceedStep2 && s.submitBtnDisabled]}
                onPress={handleReviewReport}
                disabled={!canProceedStep2}
                activeOpacity={0.8}
              >
                {loading ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <>
                    <Ionicons name="send" size={18} color="#fff" />
                    <Text style={s.submitBtnText}>Review &amp; Submit Report</Text>
                  </>
                )}
              </TouchableOpacity>

              {!canProceedStep2 && (
                <Text style={s.validationHint}>
                  Please select a crowd size and at least one behavior indicator.
                </Text>
              )}
            </View>
          )}

        </ScrollView>
      </KeyboardAvoidingView>

      {/* ══════════════════════════════════════════
          CONSENT MODAL
      ══════════════════════════════════════════ */}
      <Modal
        visible={consentOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setConsentOpen(false)}
      >
        <View style={s.consentOverlay}>
          <View style={s.consentSheet}>

            {/* Icon */}
            <View style={s.consentIconWrap}>
              <Ionicons name="shield-half" size={32} color="#dc2626" />
            </View>

            <Text style={s.consentTitle}>Confirm Report</Text>

            {/* Summary */}
            <View style={s.consentSummary}>
              <SummaryRow icon="tag-outline"     label="Category"    value={category} />
              <SummaryRow icon="account-group"   label="Crowd Size"  value={crowdSize} />
              <SummaryRow
                icon="format-list-checks"
                label="Indicators"
                value={behaviors.join(", ") || "—"}
              />
              {note.trim() !== "" && (
                <SummaryRow icon="note-text-outline" label="Note" value={note.trim()} />
              )}
            </View>

            <Text style={s.consentBody}>
              This report will be reviewed by authorities. False reporting or misuse is punishable
              under law. By continuing, you agree to share your location and report details for
              verification.
            </Text>

            <View style={s.consentBtns}>
              <TouchableOpacity
                style={s.consentCancel}
                onPress={() => setConsentOpen(false)}
                activeOpacity={0.75}
              >
                <Text style={s.consentCancelText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={s.consentConfirm}
                onPress={handleSubmit}
                activeOpacity={0.8}
              >
                {loading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={s.consentConfirmText}>Submit Report</Text>
                )}
              </TouchableOpacity>
            </View>

          </View>
        </View>
      </Modal>

      {/* ══════════════════════════════════════════
          TOAST
      ══════════════════════════════════════════ */}
      {toast.visible && (
        <Animated.View
          style={[
            s.toast,
            toast.success ? s.toastSuccess : s.toastError,
            {
              opacity:   toastAnim,
              transform: [{
                translateY: toastAnim.interpolate({
                  inputRange:  [0, 1],
                  outputRange: [30, 0],
                }),
              }],
            },
          ]}
        >
          <Ionicons
            name={toast.success ? "checkmark-circle" : "alert-circle"}
            size={18}
            color="#fff"
          />
          <Text style={s.toastText}>{toast.msg}</Text>
        </Animated.View>
      )}
    </SafeAreaView>
  );
}

/* ── Helper component ──────────────────────────────────── */
function SummaryRow({ icon, label, value }) {
  return (
    <View style={s.summaryRow}>
      <MaterialCommunityIcons name={icon} size={14} color="#64748b" style={{ marginRight: 6 }} />
      <Text style={s.summaryLabel}>{label}:</Text>
      <Text style={s.summaryValue} numberOfLines={2}>{value}</Text>
    </View>
  );
}

/* ── Styles ─────────────────────────────────────────────── */
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f8fafc" },

  /* header */
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginTop:40,
    backgroundColor: "#ffffff",
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  backBtn: {
    width: 38, height: 38,
    borderRadius: 19,
    backgroundColor: "#f1f5f9",
    alignItems: "center",
    justifyContent: "center",
  },
  headerCenter: { flex: 1, alignItems: "center" },
  headerTitle:  { fontSize: 16, fontWeight: "700", color: "#0f1c14" },
  headerSub:    { fontSize: 12, color: "#64748b", marginTop: 1 },

  /* progress */
  progressTrack: {
    height: 4,
    backgroundColor: "#e2e8f0",
  },
  progressFill: {
    height: 4,
    backgroundColor: "#13ec49",
    borderRadius: 2,
  },

  scrollContent: {
    padding: 20,
    paddingBottom: 48,
  },

  sectionLabel: {
    fontSize: 15,
    fontWeight: "700",
    color: "#0f172a",
    marginBottom: 4,
  },
  sectionHint: {
    fontSize: 13,
    color: "#64748b",
    marginBottom: 16,
  },

  /* category cards */
  catCard: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    borderRadius: 14,
    borderWidth: 1.5,
    marginBottom: 12,
  },
  catIconBox: {
    width: 46, height: 46,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  catText:  { flex: 1 },
  catTitle: { fontSize: 15, fontWeight: "700", marginBottom: 3 },
  catDesc:  { fontSize: 12, color: "#64748b", lineHeight: 17 },

  /* info box */
  infoBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: "#f0fdf4",
    borderRadius: 10,
    padding: 12,
    marginTop: 8,
    gap: 8,
  },
  infoText: { flex: 1, fontSize: 12, color: "#065f46", lineHeight: 17 },

  /* category badge (step 2) */
  catBadge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    marginBottom: 20,
    gap: 6,
  },
  catBadgeText: { fontSize: 13, fontWeight: "600" },

  /* crowd grid */
  crowdGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  crowdChip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "#cbd5e1",
    backgroundColor: "#ffffff",
    gap: 7,
    position: "relative",
  },
  crowdChipSel: {
    backgroundColor: "#0f1c14",
    borderColor: "#0f1c14",
  },
  crowdChipText: { fontSize: 13, color: "#374151", fontWeight: "500" },
  crowdChipTextSel: { color: "#ffffff" },
  crowdCheck: {
    position: "absolute",
    top: -5, right: -5,
    width: 18, height: 18,
    borderRadius: 9,
    backgroundColor: "#13ec49",
    alignItems: "center",
    justifyContent: "center",
  },

  /* behavior grid */
  behaviorGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  behaviorChip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: "#cbd5e1",
    backgroundColor: "#ffffff",
    gap: 6,
  },
  behaviorChipText: { fontSize: 13, color: "#374151", fontWeight: "500" },

  /* note */
  noteInput: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "#e2e8f0",
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 90,
    fontSize: 14,
    color: "#0f172a",
    lineHeight: 20,
  },
  charCount: {
    fontSize: 11,
    color: "#94a3b8",
    textAlign: "right",
    marginTop: 4,
    marginBottom: 4,
  },
  optionalTag: { fontSize: 12, fontWeight: "400", color: "#94a3b8" },

  /* submit */
  submitBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#dc2626",
    borderRadius: 14,
    paddingVertical: 15,
    marginTop: 24,
    gap: 8,
  },
  submitBtnDisabled: { backgroundColor: "#94a3b8" },
  submitBtnText: { fontSize: 15, fontWeight: "700", color: "#ffffff" },
  validationHint: {
    textAlign: "center",
    fontSize: 12,
    color: "#94a3b8",
    marginTop: 8,
  },

  /* consent modal */
  consentOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  consentSheet: {
    backgroundColor: "#ffffff",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 36,
  },
  consentIconWrap: {
    width: 56, height: 56,
    borderRadius: 28,
    backgroundColor: "#fef2f2",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginBottom: 14,
  },
  consentTitle: {
    fontSize: 19,
    fontWeight: "800",
    color: "#0f172a",
    textAlign: "center",
    marginBottom: 16,
  },
  consentSummary: {
    backgroundColor: "#f8fafc",
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    gap: 8,
  },
  summaryRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    flexWrap: "wrap",
  },
  summaryLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#475569",
    marginRight: 4,
  },
  summaryValue: {
    fontSize: 12,
    color: "#0f172a",
    flex: 1,
    lineHeight: 17,
  },
  consentBody: {
    fontSize: 13,
    color: "#475569",
    lineHeight: 20,
    marginBottom: 24,
  },
  consentBtns: {
    flexDirection: "row",
    gap: 12,
  },
  consentCancel: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "#e2e8f0",
    alignItems: "center",
  },
  consentCancelText: { fontSize: 15, fontWeight: "600", color: "#475569" },
  consentConfirm: {
    flex: 2,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: "#dc2626",
    alignItems: "center",
    justifyContent: "center",
  },
  consentConfirmText: { fontSize: 15, fontWeight: "700", color: "#ffffff" },

  /* toast */
  toast: {
    position: "absolute",
    bottom: 36,
    left: 20,
    right: 20,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderRadius: 14,
    gap: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
    elevation: 6,
  },
  toastSuccess: { backgroundColor: "#059669" },
  toastError:   { backgroundColor: "#dc2626" },
  toastText: {
    flex: 1,
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "600",
    lineHeight: 18,
  },
});
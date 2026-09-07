import React, { useState, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  StatusBar,
  Animated,
  Dimensions,
} from "react-native";
import { Ionicons, MaterialIcons } from "@expo/vector-icons";

const { width } = Dimensions.get("window");

/* ─── Section data ─── */
const SECTIONS = [
  {
    id: "sos",
    icon: <Ionicons name="alert-circle" size={22} color="#dc2626" />,
    iconBg: "rgba(220,38,38,0.12)",
    accent: "#dc2626",
    title: "Manual SOS",
    subtitle: "Direct High Risk · Immediate Response",
    badges: [{ label: "HIGH RISK", color: "#dc2626" }],
    content: [
      {
        type: "how",
        heading: "How to Use",
        items: ["Tap the red SOS button anytime you feel unsafe."],
      },
      {
        type: "instant",
        heading: "What Happens Instantly",
        items: [
          "Live location is shared immediately",
          "Emergency alert sent to ground station",
          "Live tracking starts instantly",
          "Monitoring escalates to highest priority",
        ],
      },
      {
        type: "response",
        heading: "Ground Station Response",
        items: [
          "Alert appears immediately on control dashboard",
          "Nearest patrol is dispatched within seconds (deployment-based)",
          "Continuous tracking continues until resolved",
        ],
      },
    ],
  },
  {
    id: "walk",
    icon: <MaterialIcons name="directions-walk" size={22} color="#3b82f6" />,
    iconBg: "rgba(59,130,246,0.12)",
    accent: "#3b82f6",
    title: "Walk Monitoring",
    subtitle: "Stay protected on foot",
    badges: [{ label: "MOTION INTELLIGENCE", color: "#1579cb" }],
    content: [
      {
        type: "why",
        heading: "Why to Use",
        items: [
          "Walking alone",
          "Late-night travel",
          "Low-visibility or unfamiliar areas",
          "Feeling unsafe on foot",
        ],
      },
      {
        type: "when",
        heading: "When to Use",
        items: ["Start before beginning your walk for full protection coverage."],
      },
      {
        type: "steps",
        heading: "How to Use",
        steps: [
          "Open SecureOcte",
          "Open Walk Monitoring",
          "Click on Start Monitoring",
        ],
      },
      {
        type: "response",
        heading: "Ground Station Response",
        items: [
          "System continuously monitors movement patterns",
          "Detects sudden shakes, sudden speed increase, unusual behavior",
        ],
        note: "If suspicious activity detected — Warning prompt appears. If ignored → SOS auto-triggers. Ground station receives alert and escalates immediately.",
      },
    ],
  },
  {
    id: "cab",
    icon: <MaterialIcons name="local-taxi" size={22} color="#16a34a" />,
    iconBg: "rgba(22,163,74,0.12)",
    accent: "#16a34a",
    title: "Cab Monitoring",
    subtitle: "Safe rides with automatic oversight",
    badges: [{ label: "ROUTE INTELLIGENCE", color: "#02905c" }],
    content: [
      {
        type: "why",
        heading: "Why to Use",
        items: [
          "Using taxis, autos, or ride services",
          "Traveling late at night",
          "Using unknown vehicles",
        ],
      },
      {
        type: "when",
        heading: "When to Use",
        items: ["Start before the ride begins for full tracking coverage."],
      },
      {
        type: "steps",
        heading: "How to Use",
        steps: [
          "Open Cab Monitoring",
          "Enter vehicle number (optional but recommended)",
          "Add destination",
          "Tap Start Ride",
        ],
      },
      {
        type: "safety_check",
        heading: "Cab Safety Check System",
        checks: [
          { emoji: "✅", label: "YES (Safe)", desc: "Ride continues normally after successful verification", color: "#16a34a" },
          {
            emoji: "⚠️",
            label: "SUSPICIOUS",
            desc: "Suspicious flag added on route. After 3 sucessive flags → automatic emergency alert sent.",
            color: "#ca8a04",
          },
          {
            emoji: "❌",
            label: "NO (Not Safe)",
            desc: "SOS activates instantly. Live tracking shared. Ground station alerted immediately.",
            color: "#dc2626",
          },
        ],
      },
      {
        type: "response",
        heading: "Ground Station Response",
        items: [
          "Route monitored continuously",
          "Detects diversions, halts, irregular movement",
        ],
        note: "If alert triggers — Ground station responds instantly. followed by a call verification, Patrol dispatch begins immediately(deployment-based).",
      },
    ],
  },
  {
    id: "aichat",
    icon: <Ionicons name="chatbubble-ellipses" size={22} color="#f97316" />,
    iconBg: "rgba(249,115,22,0.12)",
    accent: "#f97316",
    title: "Neha – AI Companion",
    subtitle: "Friendly chat partner · Night travel support",
    badges: [{ label: "AI COMPANION", color: "#f97316" }],
    content: [
      {
        type: "info",
        heading: "What It Does",
        items: [
          "A friendly chat partner designed to keep you calm and comfortable while traveling alone, especially at night",
          "Talk casually, ask questions, or just stay connected during your journey",
        ],
      },
      {
        type: "when",
        heading: "When to Use",
        items: [
          "You feel uneasy traveling alone",
          "You want someone to talk to",
          "You need night safety tips",
          "You want light conversation during travel",
        ],
        note: "👉 Use SOS instead if you feel unsafe or in danger.",
      },
      {
        type: "steps",
        heading: "How to Use",
        steps: [
          "Tap Neha Companion from the home screen",
          "Chat naturally",
          "Continue the conversation as long as you want",
        ],
      },
      {
        type: "info",
        heading: "What Neha Can Do",
        items: [
          "Share night travel safety tips",
          "Tell you do's and don'ts while traveling alone",
          "Talk casually to keep you comfortable",
          "Share light stories and jokes",
        ],
        note: "⚠️ Important: Neha Companion is for comfort and guidance only. If you feel unsafe at any time, use SOS immediately.",
      },
    ],
  },
  {
    id: "secureme",
    icon: <MaterialIcons name="smart-toy" size={22} color="#a855f7" />,
    iconBg: "rgba(168,85,247,0.12)",
    accent: "#a855f7",
    title: "SecureMe Mode",
    subtitle: "Available in active trips · High-risk zones only",
    badges: [
      { label: "AUTO ALERTS", color: "#a855f7" },
    ],
    content: [
      {
        type: "info",
        heading: "What It Does",
        items: [
          "Activates advanced safety monitoring upon entering high risk zones",
          "Detects user's inactivity rather than user's irregular activity",
          "Strengthens automatic alert detection",
        ],
      },
      {
        type: "info",
        heading: "Active While",
        items: ["Trip is active and user enabled", "User remains in high-risk zone"],
      },
    ],
  },
  {
    id: "battery",
    icon: <Ionicons name="battery-dead" size={22} color="#ca8a04" />,
    iconBg: "rgba(202,138,4,0.12)",
    accent: "#ca8a04",
    title: "Battery Shutdown",
    subtitle: "Auto-alerts when power is critically low",
    badges: [
      { label: "GLOBAL", color: "#f97316" },
    ],
    content: [
      {
        type: "info",
        heading: "What Happens",
        items: [
          "activited automatically in both Walk and Cab Monitoring",
          "Last live location is sent automatically",
          "Emergency alert activates",
          "Prevents tracking loss during emergencies",
        ],
      },
      {
        type: "tip",
        tip: "Keep battery above 20% during travel.",
      },
    ],
  },
  {
    id: "report",
    icon: <MaterialIcons name="report-problem" size={22} color="#b45309" />,
    iconBg: "rgba(180,83,9,0.12)",
    accent: "#b45309",
    title: "Report an Incident",
    subtitle: "Alert nearest patrol · Real-time review",
    badges: [{ label: "COMMUNITY SAFETY", color: "#dc2626" }],
    content: [
      {
        type: "info",
        heading: "What It Does",
        items: [
          "Quickly informs the nearest patrol about suspicious or unsafe activity around you",
          "Reports are reviewed in real time by the ground station",
          "Assigned to nearby patrol if required",
        ],
      },
      {
        type: "when",
        heading: "When to Use",
        items: [
          "Public disturbance (noise, intoxicated behavior, disorderly activity)",
          "Suspicious gathering or loitering",
          "Risky or unusual behavior nearby",
        ],
        note: "👉 Use SOS instead if you are personally in danger.",
      },
      {
        type: "steps",
        heading: "How to Use",
        steps: [
          "Tap Report an Incident from the home screen or during a trip",
          "Select the incident type",
          "Choose visible indicators (behavior, crowd size, urgency)",
          "Add a note or photo (optional)",
          "Tap Submit Report and confirm",
        ],
        note: "Your location is shared automatically with authorities.",
      },
      {
        type: "response",
        heading: "What Happens Next",
        items: [
          "Your report is received by the ground station instantly",
          "Officers review and verify the situation",
          "Nearest patrol may be assigned if required",
          "You may see live status updates in the app",
        ],
        note: "⚠️ Important: Submit reports responsibly. False reporting or misuse is punishable under law.",
      },
    ],
  },
  {
    id: "network",
    icon: <Ionicons name="wifi-outline" size={22} color="#0891b2" />,
    iconBg: "rgba(8,145,178,0.12)",
    accent: "#0891b2",
    title: "If Network is Lost",
    subtitle: "Seamless monitoring even offline",
    badges: [{ label: "CAUTION !!!", color: "#a80614" }],
    content: [
      {
        type: "info",
        heading: "How It Works",
        items: [
          "Location saves automatically",
          "Sync resumes once connection returns",
          "Monitoring continues without interruption",
          "Polling can be done Through SMS in future",
        ],
      },
    ],
  },
  {
    id: "tips",
    icon: <Ionicons name="shield-checkmark" size={22} color="#059669" />,
    iconBg: "rgba(5,150,105,0.12)",
    accent: "#059669",
    title: "Best Way to Stay Safe",
    subtitle: "Tips for maximum protection",
    badges: [{ label: "PREVENTIVE", color: "#2fa72a" }],
    content: [
      {
        type: "tips",
        items: [
          "Start a trip before travel",
          "Keep location ON",
          "Respond to prompts quickly",
          "Use SOS whenever unsure",
        ],
      },
    ],
  },
];

/* ─── Accordion Section ─── */
function AccordionSection({ section }) {
  const [open, setOpen] = useState(false);
  const anim = useRef(new Animated.Value(0)).current;
  const rotateAnim = useRef(new Animated.Value(0)).current;

  const toggle = () => {
    const toValue = open ? 0 : 1;
    setOpen(!open);
    Animated.parallel([
      Animated.spring(anim, { toValue, useNativeDriver: false, friction: 12 }),
      Animated.timing(rotateAnim, { toValue, duration: 200, useNativeDriver: true }),
    ]).start();
  };

  const rotate = rotateAnim.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "180deg"] });

  return (
    <View style={[styles.sectionCard, open && { borderColor: section.accent + "55" }]}>
      {/* ── Header (always visible, tap to toggle) ── */}
      <TouchableOpacity
        style={styles.sectionHeader}
        onPress={toggle}
        activeOpacity={0.75}
      >
        <View style={[styles.sectionIconWrap, { backgroundColor: section.iconBg }]}>
          {section.icon}
        </View>
        <View style={styles.sectionMeta}>
          <View style={styles.sectionTitleRow}>
            <Text style={styles.sectionTitle}>{section.title}</Text>
            {section.badges?.map((b, i) => (
              <View key={i} style={[styles.badge, { backgroundColor: b.color + "22", borderColor: b.color + "55" }]}>
                <Text style={[styles.badgeText, { color: b.color }]}>{b.label}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.sectionSubtitle}>{section.subtitle}</Text>
        </View>
        <Animated.View style={{ transform: [{ rotate }] }}>
          <Ionicons name="chevron-down" size={18} color="#64748b" />
        </Animated.View>
      </TouchableOpacity>

      {/* ── Expandable body ── */}
      {open && (
        <View style={styles.sectionBody}>
          <View style={[styles.sectionDivider, { backgroundColor: section.accent + "33" }]} />
          {section.content.map((block, i) => (
            <ContentBlock key={i} block={block} accent={section.accent} />
          ))}
        </View>
      )}
    </View>
  );
}

/* ─── Content Block renderer ─── */
function ContentBlock({ block, accent }) {
  if (block.type === "steps") {
    return (
      <View style={styles.block}>
        <Text style={[styles.blockHeading, { color: accent }]}>{block.heading}</Text>
        {block.steps.map((step, i) => (
          <View key={i} style={styles.stepRow}>
            <View style={[styles.stepNum, { backgroundColor: accent }]}>
              <Text style={styles.stepNumText}>{i + 1}</Text>
            </View>
            <Text style={styles.stepText}>{step}</Text>
          </View>
        ))}
        {block.note && (
          <View style={[styles.noteBox, { borderLeftColor: accent }]}>
            <Text style={styles.noteText}>{block.note}</Text>
          </View>
        )}
      </View>
    );
  }

  if (block.type === "safety_check") {
    return (
      <View style={styles.block}>
        <Text style={[styles.blockHeading, { color: accent }]}>{block.heading}</Text>
        <View style={styles.promptBox}>
          <Text style={styles.promptQuestion}>SecureOcte may ask: "Are you safe?"</Text>
        </View>
        {block.checks.map((c, i) => (
          <View key={i} style={[styles.checkRow, { borderLeftColor: c.color }]}>
            <Text style={styles.checkEmoji}>{c.emoji}</Text>
            <View style={{ flex: 1 }}>
              <Text style={[styles.checkLabel, { color: c.color }]}>{c.label}</Text>
              <Text style={styles.checkDesc}>{c.desc}</Text>
            </View>
          </View>
        ))}
      </View>
    );
  }

  if (block.type === "tip") {
    return (
      <View style={styles.tipBox}>
        <Ionicons name="bulb-outline" size={16} color="#f97316" />
        <Text style={styles.tipText}>Tip: {block.tip}</Text>
      </View>
    );
  }

  if (block.type === "tips") {
    return (
      <View style={styles.block}>
        {block.items.map((item, i) => (
          <View key={i} style={styles.tipRow}>
            <Ionicons name="checkmark-circle" size={16} color={accent} style={{ marginTop: 1 }} />
            <Text style={styles.bulletText}>{item}</Text>
          </View>
        ))}
      </View>
    );
  }

  /* default: bullet list */
  return (
    <View style={styles.block}>
      {block.heading && (
        <Text style={[styles.blockHeading, { color: accent }]}>{block.heading}</Text>
      )}
      {block.items?.map((item, i) => (
        <View key={i} style={styles.bulletRow}>
          <View style={[styles.bulletDot, { backgroundColor: accent }]} />
          <Text style={styles.bulletText}>{item}</Text>
        </View>
      ))}
      {block.note && (
        <View style={[styles.noteBox, { borderLeftColor: accent }]}>
          <Text style={styles.noteText}>{block.note}</Text>
        </View>
      )}
    </View>
  );
}

/* ─── Main Screen ─── */
export default function HowToUseScreen({ onClose }) {
  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />

      {/* ── Header ── */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={onClose} activeOpacity={0.75}>
          <Ionicons name="arrow-back" size={22} color="#1e293b" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>How to Use</Text>
          <Text style={styles.headerSub}>SecureOcte Guide</Text>
        </View>
        <View style={styles.headerRight}>
          <View style={styles.shieldBadge}>
            <Ionicons name="shield-checkmark" size={18} color="#13ec49" />
          </View>
        </View>
      </View>

      {/* ── Intro Banner ── */}
      <View style={styles.introBanner}>
        <Text style={styles.introText}>
          SecureOcte protects you in real time using intelligent monitoring, instant alerts,
          and automated emergency response.{" "}
          <Text style={styles.introAccent}>Tap any section to learn more.</Text>
        </Text>
      </View>

      {/* ── Accordion List ── */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {SECTIONS.map((section) => (
          <AccordionSection key={section.id} section={section} />
        ))}
        <View style={{ height: 32 }} />
      </ScrollView>
    </View>
  );
}

/* ─────────────────── STYLES ─────────────────── */
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f6f8f6" },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 40,
    paddingBottom: 14,
    backgroundColor: "#ffffff",
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8e2",
  },
  backBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#f1f5f9",
    justifyContent: "center",
    alignItems: "center",
  },
  headerCenter: { flex: 1, alignItems: "center" },
  headerTitle: { color: "#0f172a", fontSize: 20, fontWeight: "800", letterSpacing: 0.2 },
  headerSub: { color: "#94a3b8", fontSize: 14, fontWeight: "600", marginTop: 1, letterSpacing: 0.5 },
  headerRight: { width: 42, alignItems: "flex-end" },
  shieldBadge: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: "rgba(19,236,73,0.12)",
    justifyContent: "center",
    alignItems: "center",
  },

  introBanner: {
    backgroundColor: "#0f1c14",
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: "#13ec4933",
  },
  introText: { color: "#94a3b8", fontSize: 14, lineHeight: 20, fontWeight: "500" },
  introAccent: { color: "#13ec49", fontWeight: "700" },

  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 16 },

  /* ── Section Card ── */
  sectionCard: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    marginBottom: 12,
    overflow: "hidden",
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    gap: 12,
  },
  sectionIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  sectionMeta: { flex: 1 },
  sectionTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  sectionTitle: { color: "#1e293b", fontSize: 15, fontWeight: "800" },
  sectionSubtitle: { color: "#64748b", fontSize: 12, fontWeight: "500", marginTop: 2 },

  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
  },
  badgeText: { fontSize: 9, fontWeight: "800", letterSpacing: 0.8 },

  sectionDivider: { height: 1, marginHorizontal: 16, marginBottom: 4 },
  sectionBody: { paddingHorizontal: 16, paddingBottom: 16 },

  /* ── Content Blocks ── */
  block: { marginTop: 12 },
  blockHeading: { fontSize: 11, fontWeight: "800", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 10 },

  bulletRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: 7 },
  bulletDot: { width: 6, height: 6, borderRadius: 3, marginTop: 6 },
  bulletText: { color: "#334155", fontSize: 13, fontWeight: "500", flex: 1, lineHeight: 20 },

  stepRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 10 },
  stepNum: {
    width: 26, height: 26, borderRadius: 13,
    justifyContent: "center", alignItems: "center",
  },
  stepNumText: { color: "#0f1c14", fontSize: 12, fontWeight: "900" },
  stepText: { color: "#334155", fontSize: 13, fontWeight: "600", flex: 1 },

  /* ── Safety Check ── */
  promptBox: {
    backgroundColor: "#f1f5f9",
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  promptQuestion: { color: "#475569", fontSize: 13, fontWeight: "700", textAlign: "center" },
  checkRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    borderLeftWidth: 3,
    paddingLeft: 12,
    paddingVertical: 8,
    marginBottom: 8,
    backgroundColor: "#f8fafc",
    borderRadius: 8,
  },
  checkEmoji: { fontSize: 20 },
  checkLabel: { fontSize: 13, fontWeight: "800", marginBottom: 2 },
  checkDesc: { color: "#64748b", fontSize: 12, fontWeight: "500", lineHeight: 18 },

  /* ── Note / Tip ── */
  noteBox: {
    borderLeftWidth: 3,
    paddingLeft: 12,
    paddingVertical: 8,
    marginTop: 8,
    backgroundColor: "#f8fafc",
    borderRadius: 8,
  },
  noteText: { color: "#475569", fontSize: 12, fontWeight: "600", lineHeight: 18 },

  tipBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(249,115,22,0.08)",
    borderRadius: 10,
    padding: 12,
    marginTop: 12,
    borderWidth: 1,
    borderColor: "rgba(249,115,22,0.2)",
  },
  tipText: { color: "#c2410c", fontSize: 13, fontWeight: "700", flex: 1 },

  tipRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 8 },
});
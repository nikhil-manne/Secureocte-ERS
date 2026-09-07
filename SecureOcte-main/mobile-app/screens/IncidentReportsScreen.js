/**
 * IncidentReportsScreen.js
 * ─────────────────────────────────────────────────────────────
 * Two modes auto-detected from the JWT role:
 *
 *  CITIZEN  (role = "user")
 *    → "My Reports" tab: their own submissions, status badge,
 *      assigned patrol info, pull-to-refresh
 *
 *  AUTHORITY (role = "admin" or officer with assignedPatrolTripId)
 *    → "Pending" tab  — all open reports, full detail, acknowledge/resolve actions
 *    → "All"     tab  — full history
 *
 * GET  /api/incident/my-reports
 * GET  /api/incident/pending
 * POST /api/incident/acknowledge/:id
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  RefreshControl,
  Modal,
  Animated,
  ActivityIndicator,
  SafeAreaView,
  StatusBar,
  Platform,
  Linking,
} from "react-native";
import { Ionicons, MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import { apiFetch, AuthError, BASE_URL } from "./api";

/* ─── decode role from JWT without a library ─── */
function decodeJwtRole(token) {
  try {
    const payload = token.split(".")[1];
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return decoded.role || "user";
  } catch {
    return "user";
  }
}

/* ─── constants ─── */
const STATUS_META = {
  pending:      { label: "Pending",      color: "#f97316", bg: "#fff7ed", icon: "clock-outline"        },
  acknowledged: { label: "Acknowledged", color: "#3b82f6", bg: "#eff6ff", icon: "check-circle-outline" },
  resolved:     { label: "Resolved",     color: "#16a34a", bg: "#f0fdf4", icon: "check-all"             },
};

const CATEGORY_META = {
  "Public Disturbance":   { color: "#f97316", icon: "bullhorn"      },
  "Suspicious Gathering": { color: "#8b5cf6", icon: "account-group" },
  "Risky Behavior":       { color: "#dc2626", icon: "alert-octagon" },
};

function timeAgo(dateStr) {
  const diff = Math.floor((Date.now() - new Date(dateStr)) / 1000);
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/* How long it took from report creation to resolution */
function resolveTime(createdAt, updatedAt) {
  if (!createdAt || !updatedAt) return null;
  const ms = new Date(updatedAt) - new Date(createdAt);
  if (ms <= 0) return null;
  const totalSecs = Math.floor(ms / 1000);
  if (totalSecs < 60)   return `${totalSecs}s`;
  const mins = Math.floor(totalSecs / 60);
  if (mins < 60)        return `${mins}m`;
  const hrs  = Math.floor(mins / 60);
  const rem  = mins % 60;
  if (hrs < 24)         return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remH = hrs % 24;
  return remH > 0 ? `${days}d ${remH}h` : `${days}d`;
}

/* ════════════════════════════════════════════
   MAIN COMPONENT
════════════════════════════════════════════ */
export default function IncidentReportsScreen({ token, user, goBack }) {
  const role       = decodeJwtRole(token);
  const isAuthority = role === "admin";

  const [tab,        setTab]        = useState("pending");   // "pending" | "mine" | "all"
  const [reports,    setReports]    = useState([]);
  const [allReports, setAllReports] = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [detail,     setDetail]     = useState(null);        // report shown in modal
  const [actioning,  setActioning]  = useState(false);

  /* toast */
  const [toast, setToast] = useState({ visible: false, msg: "", success: true });
  const toastAnim = useRef(new Animated.Value(0)).current;

  const showToast = (msg, success = true) => {
    setToast({ visible: true, msg, success });
    Animated.sequence([
      Animated.timing(toastAnim, { toValue: 1, duration: 280, useNativeDriver: true }),
      Animated.delay(2600),
      Animated.timing(toastAnim, { toValue: 0, duration: 280, useNativeDriver: true }),
    ]).start(() => setToast(t => ({ ...t, visible: false })));
  };

  /* ── fetch ── */
  const fetchMyReports = useCallback(async () => {
    try {
      const data = await apiFetch("/api/incident/my-reports", { method: "GET" }, token);
      setReports(data.reports || []);
    } catch (err) {
      showToast(err instanceof AuthError ? "Session expired." : "Failed to load reports.", false);
    }
  }, [token]);

  const fetchPending = useCallback(async () => {
    try {
      const data = await apiFetch("/api/incident/pending", { method: "GET" }, token);
      setReports(data.reports || []);
    } catch (err) {
      showToast(err instanceof AuthError ? "Session expired." : "Failed to load reports.", false);
    }
  }, [token]);

  const fetchAll = useCallback(async () => {
    try {
      const data = await apiFetch("/api/incident/all", { method: "GET" }, token);
      setAllReports(data.reports || []);
    } catch (err) {
      showToast("Failed to load.", false);
    }
  }, [token]);

  const load = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    if (isAuthority) {
      await Promise.all([fetchPending(), fetchAll()]);
    } else {
      await fetchMyReports();
    }
    setLoading(false);
  }, [isAuthority, fetchMyReports, fetchPending, fetchAll]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load(false);
    setRefreshing(false);
  };

  /* ── acknowledge / resolve ── */
  const handleAction = async (reportId, status) => {
    setActioning(true);
    try {
      await apiFetch(
        `/api/incident/acknowledge/${reportId}`,
        { method: "POST", body: { status } },
        token
      );
      showToast(`Report marked as ${status}.`, true);
      setDetail(null);
      await load(false);
    } catch (err) {
      showToast(err.message || "Action failed.", false);
    } finally {
      setActioning(false);
    }
  };

  /* ── open in maps ── */
  const openMaps = (lat, lng) => {
    const url = Platform.OS === "ios"
      ? `maps://?q=${lat},${lng}`
      : `geo:${lat},${lng}?q=${lat},${lng}`;
    Linking.openURL(url).catch(() =>
      Linking.openURL(`https://maps.google.com/?q=${lat},${lng}`)
    );
  };

  /* ── displayed list based on tab ── */
  const displayedReports = isAuthority
    ? (tab === "all" ? allReports : reports)
    : reports;

  /* ── tabs ── */
  const tabs = isAuthority
    ? [
        { id: "pending", label: "Pending",  badge: reports.filter(r => r.status === "pending").length },
        { id: "all",     label: "All",      badge: null },
      ]
    : [
        { id: "mine", label: "My Reports", badge: null },
      ];

  /* ════════════════════════════════════════════
     RENDER
  ════════════════════════════════════════════ */
  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />

      {/* ── Header ── */}
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={goBack}>
          <Ionicons name="arrow-back" size={22} color="#0f1c14" />
        </TouchableOpacity>
        <View style={s.headerCenter}>
          <Text style={s.headerTitle}>Incident Reports</Text>
          <Text style={s.headerSub}>
            {isAuthority ? "Authority view" : `Citizen · ${user?.username || ""}`}
          </Text>
        </View>
        <TouchableOpacity style={s.refreshBtn} onPress={() => load(false)}>
          <Ionicons name="refresh" size={20} color="#64748b" />
        </TouchableOpacity>
      </View>

      {/* ── Role badge ── */}
      <View style={[s.roleBadgeRow]}>
        <View style={[s.roleBadge, isAuthority ? s.roleBadgeAdmin : s.roleBadgeCitizen]}>
          <MaterialCommunityIcons
            name={isAuthority ? "shield-star" : "account"}
            size={13}
            color={isAuthority ? "#1e40af" : "#065f46"}
          />
          <Text style={[s.roleBadgeText, isAuthority ? { color: "#1e40af" } : { color: "#065f46" }]}>
            {isAuthority ? "Admin / Authority" : "Citizen"}
          </Text>
        </View>
      </View>

      {/* ── Tabs ── */}
      {tabs.length > 1 && (
        <View style={s.tabRow}>
          {tabs.map(t => (
            <TouchableOpacity
              key={t.id}
              style={[s.tabBtn, tab === t.id && s.tabBtnActive]}
              onPress={() => setTab(t.id)}
            >
              <Text style={[s.tabBtnText, tab === t.id && s.tabBtnTextActive]}>
                {t.label}
              </Text>
              {t.badge > 0 && (
                <View style={s.tabBadge}>
                  <Text style={s.tabBadgeText}>{t.badge}</Text>
                </View>
              )}
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* ── List ── */}
      {loading ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color="#dc2626" />
          <Text style={s.loadingText}>Loading reports…</Text>
        </View>
      ) : displayedReports.length === 0 ? (
        <View style={s.center}>
          <MaterialCommunityIcons name="clipboard-check-outline" size={56} color="#cbd5e1" />
          <Text style={s.emptyTitle}>No reports found</Text>
          <Text style={s.emptyDesc}>
            {isAuthority
              ? "No pending incident reports at this time."
              : "You haven't submitted any incident reports yet."}
          </Text>
        </View>
      ) : (
        <FlatList
          data={displayedReports}
          keyExtractor={item => String(item._id)}
          contentContainerStyle={s.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#dc2626" />
          }
          renderItem={({ item }) => (
            <ReportCard
              report={item}
              isAuthority={isAuthority}
              onPress={() => setDetail(item)}
            />
          )}
        />
      )}

      {/* ════════════════════════════════════════════
          DETAIL MODAL
      ════════════════════════════════════════════ */}
      <Modal
        visible={!!detail}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setDetail(null)}
      >
        {detail && (
          <SafeAreaView style={s.modalRoot}>
            {/* modal header */}
            <View style={s.modalHeader}>
              <TouchableOpacity style={s.backBtn} onPress={() => setDetail(null)}>
                <Ionicons name="close" size={20} color="#0f1c14" />
              </TouchableOpacity>
              <Text style={s.modalTitle}>Report Detail</Text>
              <View style={{ width: 38 }} />
            </View>

            <FlatList
              data={[detail]}
              keyExtractor={() => "detail"}
              contentContainerStyle={s.modalContent}
              showsVerticalScrollIndicator={false}
              renderItem={() => (
                <DetailBody
                  report={detail}
                  isAuthority={isAuthority}
                  actioning={actioning}
                  onAction={handleAction}
                  onOpenMaps={openMaps}
                />
              )}
            />
          </SafeAreaView>
        )}
      </Modal>

      {/* ── Toast ── */}
      {toast.visible && (
        <Animated.View
          style={[
            s.toast,
            toast.success ? s.toastSuccess : s.toastError,
            {
              opacity: toastAnim,
              transform: [{ translateY: toastAnim.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
            },
          ]}
        >
          <Ionicons name={toast.success ? "checkmark-circle" : "alert-circle"} size={18} color="#fff" />
          <Text style={s.toastText}>{toast.msg}</Text>
        </Animated.View>
      )}
    </SafeAreaView>
  );
}

/* ════════════════════════════════════════════
   REPORT CARD
════════════════════════════════════════════ */
function ReportCard({ report, isAuthority, onPress }) {
  const catMeta    = CATEGORY_META[report.category]  || { color: "#64748b", icon: "alert" };
  const statusMeta = STATUS_META[report.status]      || STATUS_META.pending;

  return (
    <TouchableOpacity style={s.card} onPress={onPress} activeOpacity={0.78}>
      {/* left accent bar */}
      <View style={[s.cardAccent, { backgroundColor: catMeta.color }]} />

      <View style={s.cardBody}>
        {/* top row */}
        <View style={s.cardTopRow}>
          <View style={[s.cardIconBox, { backgroundColor: catMeta.color + "18" }]}>
            <MaterialCommunityIcons name={catMeta.icon} size={18} color={catMeta.color} />
          </View>
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={s.cardCategory}>{report.category}</Text>
            <Text style={s.cardCrowd}>{report.crowdSize}</Text>
          </View>
          <View style={[s.statusPill, { backgroundColor: statusMeta.bg }]}>
            <MaterialCommunityIcons name={statusMeta.icon} size={12} color={statusMeta.color} />
            <Text style={[s.statusPillText, { color: statusMeta.color }]}>{statusMeta.label}</Text>
          </View>
        </View>

        {/* indicators row */}
        {report.behaviorIndicators?.length > 0 && (
          <View style={s.indicatorsRow}>
            {report.behaviorIndicators.slice(0, 3).map(b => (
              <View key={b} style={s.indicatorChip}>
                <Text style={s.indicatorChipText}>{b}</Text>
              </View>
            ))}
            {report.behaviorIndicators.length > 3 && (
              <Text style={s.indicatorMore}>+{report.behaviorIndicators.length - 3}</Text>
            )}
          </View>
        )}

        {/* footer */}
        <View style={s.cardFooter}>
          {isAuthority && report.username && (
            <View style={s.cardFooterItem}>
              <Ionicons name="person-outline" size={12} color="#64748b" />
              <Text style={s.cardFooterText}>{report.username}</Text>
            </View>
          )}
          <View style={s.cardFooterItem}>
            <Ionicons name="time-outline" size={12} color="#64748b" />
            <Text style={s.cardFooterText}>{timeAgo(report.createdAt)}</Text>
          </View>
          {report.assignedOfficerName && (
            <View style={s.cardFooterItem}>
              <MaterialIcons name="local-police" size={12} color="#3b82f6" />
              <Text style={[s.cardFooterText, { color: "#3b82f6" }]}>
                {report.assignedOfficerName}
              </Text>
            </View>
          )}
          {report.status === "resolved" && resolveTime(report.createdAt, report.updatedAt) && (
            <View style={s.cardFooterItem}>
              <MaterialCommunityIcons name="timer-check-outline" size={12} color="#16a34a" />
              <Text style={[s.cardFooterText, { color: "#16a34a", fontWeight: "700" }]}>
                Resolved in {resolveTime(report.createdAt, report.updatedAt)}
              </Text>
            </View>
          )}
        </View>
      </View>

      <Ionicons name="chevron-forward" size={16} color="#94a3b8" style={{ marginLeft: 4 }} />
    </TouchableOpacity>
  );
}

/* ════════════════════════════════════════════
   DETAIL BODY (inside modal)
════════════════════════════════════════════ */
function DetailBody({ report, isAuthority, actioning, onAction, onOpenMaps }) {
  const catMeta    = CATEGORY_META[report.category]  || { color: "#64748b", icon: "alert" };
  const statusMeta = STATUS_META[report.status]      || STATUS_META.pending;

  return (
    <View>
      {/* category header */}
      <View style={[s.detailCatHeader, { backgroundColor: catMeta.color + "12", borderColor: catMeta.color + "30" }]}>
        <MaterialCommunityIcons name={catMeta.icon} size={32} color={catMeta.color} />
        <View style={{ flex: 1, marginLeft: 14 }}>
          <Text style={[s.detailCatTitle, { color: catMeta.color }]}>{report.category}</Text>
          <Text style={s.detailCatSub}>{timeAgo(report.createdAt)}</Text>
        </View>
        <View style={[s.statusPill, { backgroundColor: statusMeta.bg }]}>
          <MaterialCommunityIcons name={statusMeta.icon} size={12} color={statusMeta.color} />
          <Text style={[s.statusPillText, { color: statusMeta.color }]}>{statusMeta.label}</Text>
        </View>
      </View>

      {/* details grid */}
      <View style={s.detailGrid}>
        <DetailRow icon="account-group"  label="Crowd Size"  value={report.crowdSize} />
        {isAuthority && report.username && (
          <DetailRow icon="account"        label="Reported by" value={report.username} />
        )}
        {report.assignedOfficerName ? (
          <DetailRow icon="shield-account" label="Assigned to" value={report.assignedOfficerName} color="#3b82f6" />
        ) : (
          <DetailRow icon="shield-off-outline" label="Assigned to" value="No patrol nearby at time of report" color="#94a3b8" />
        )}
        {report.status === "resolved" && resolveTime(report.createdAt, report.updatedAt) && (
          <DetailRow
            icon="timer-check-outline"
            label="Resolved in"
            value={resolveTime(report.createdAt, report.updatedAt)}
            color="#16a34a"
          />
        )}
      </View>

      {/* behavior indicators */}
      <Text style={s.detailSectionTitle}>Behavior Indicators</Text>
      <View style={s.behaviorWrap}>
        {report.behaviorIndicators?.length > 0
          ? report.behaviorIndicators.map(b => (
              <View key={b} style={[s.behaviorTag, { borderColor: catMeta.color + "50", backgroundColor: catMeta.color + "0D" }]}>
                <Text style={[s.behaviorTagText, { color: catMeta.color }]}>{b}</Text>
              </View>
            ))
          : <Text style={s.emptyDesc}>None recorded</Text>
        }
      </View>

      {/* optional note */}
      {!!report.note && (
        <>
          <Text style={s.detailSectionTitle}>Note</Text>
          <View style={s.noteBox}>
            <Text style={s.noteText}>{report.note}</Text>
          </View>
        </>
      )}

      {/* location */}
      {report.location?.latitude != null && (
        <>
          <Text style={s.detailSectionTitle}>Location</Text>
          <TouchableOpacity
            style={s.locationBtn}
            onPress={() => onOpenMaps(report.location.latitude, report.location.longitude)}
            activeOpacity={0.8}
          >
            <Ionicons name="location" size={18} color="#3b82f6" />
            <Text style={s.locationBtnText}>
              {report.location.latitude.toFixed(5)}, {report.location.longitude.toFixed(5)}
            </Text>
            <View style={s.locationOpenTag}>
              <Text style={s.locationOpenTagText}>Open in Maps</Text>
            </View>
          </TouchableOpacity>
        </>
      )}

      {/* authority actions */}
      {isAuthority && report.status !== "resolved" && (
        <>
          <Text style={s.detailSectionTitle}>Actions</Text>
          <View style={s.actionRow}>
            {report.status === "pending" && (
              <TouchableOpacity
                style={[s.actionBtn, s.actionBtnBlue]}
                onPress={() => onAction(report._id, "acknowledged")}
                disabled={actioning}
                activeOpacity={0.8}
              >
                {actioning ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <Ionicons name="checkmark" size={16} color="#fff" />
                    <Text style={s.actionBtnText}>Acknowledge</Text>
                  </>
                )}
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[s.actionBtn, s.actionBtnGreen]}
              onPress={() => onAction(report._id, "resolved")}
              disabled={actioning}
              activeOpacity={0.8}
            >
              {actioning ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <>
                  <MaterialCommunityIcons name="check-all" size={16} color="#fff" />
                  <Text style={s.actionBtnText}>Mark Resolved</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </>
      )}

      {report.status === "resolved" && (
        <View style={s.resolvedBanner}>
          <MaterialCommunityIcons name="check-circle" size={20} color="#16a34a" />
          <View style={{ flex: 1 }}>
            <Text style={s.resolvedBannerText}>This incident has been resolved.</Text>
            {resolveTime(report.createdAt, report.updatedAt) && (
              <View style={s.resolvedTimeRow}>
                <MaterialCommunityIcons name="timer-outline" size={13} color="#16a34a" />
                <Text style={s.resolvedTimeText}>
                  Response time:{" "}
                  <Text style={s.resolvedTimeValue}>
                    {resolveTime(report.createdAt, report.updatedAt)}
                  </Text>
                </Text>
              </View>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

function DetailRow({ icon, label, value, color }) {
  return (
    <View style={s.detailRow}>
      <MaterialCommunityIcons name={icon} size={15} color="#64748b" style={{ marginRight: 8 }} />
      <Text style={s.detailRowLabel}>{label}</Text>
      <Text style={[s.detailRowValue, color && { color }]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

/* ════════════════════════════════════════════
   STYLES
════════════════════════════════════════════ */
const s = StyleSheet.create({
  root:         { flex: 1, backgroundColor: "#f8fafc" },

  /* header */
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: "#ffffff",marginTop:40,
    borderBottomWidth: 1, borderBottomColor: "#e2e8f0",
  },
  backBtn: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: "#f1f5f9",
    alignItems: "center", justifyContent: "center",
  },
  refreshBtn: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: "#f1f5f9",
    alignItems: "center", justifyContent: "center",
  },
  headerCenter:  { flex: 1, alignItems: "center" },
  headerTitle:   { fontSize: 16, fontWeight: "700", color: "#0f1c14" },
  headerSub:     { fontSize: 12, color: "#64748b", marginTop: 1 },

  /* role badge */
  roleBadgeRow: {
    paddingHorizontal: 16, paddingVertical: 8,
    backgroundColor: "#ffffff",
    borderBottomWidth: 1, borderBottomColor: "#f1f5f9",
    alignItems: "flex-start",
  },
  roleBadge: {
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 20, borderWidth: 1,
  },
  roleBadgeAdmin:   { backgroundColor: "#eff6ff", borderColor: "#bfdbfe" },
  roleBadgeCitizen: { backgroundColor: "#f0fdf4", borderColor: "#bbf7d0" },
  roleBadgeText:    { fontSize: 12, fontWeight: "600" },

  /* tabs */
  tabRow: {
    flexDirection: "row",
    backgroundColor: "#ffffff",
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 10,
  },
  tabBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 16, paddingVertical: 8,
    borderRadius: 20, borderWidth: 1.5, borderColor: "#e2e8f0",
    backgroundColor: "#f8fafc",
  },
  tabBtnActive:     { backgroundColor: "#0f1c14", borderColor: "#0f1c14" },
  tabBtnText:       { fontSize: 13, fontWeight: "600", color: "#64748b" },
  tabBtnTextActive: { color: "#ffffff" },
  tabBadge: {
    backgroundColor: "#dc2626", borderRadius: 10,
    paddingHorizontal: 6, paddingVertical: 1, minWidth: 18, alignItems: "center",
  },
  tabBadgeText: { color: "#fff", fontSize: 11, fontWeight: "700" },

  /* list */
  listContent: { padding: 16, gap: 12, paddingBottom: 48 },

  /* card */
  card: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 14, borderWidth: 1, borderColor: "#e2e8f0",
    overflow: "hidden",
    elevation: 2,
    shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
  },
  cardAccent: { width: 4, alignSelf: "stretch" },
  cardBody:   { flex: 1, padding: 14 },
  cardTopRow: { flexDirection: "row", alignItems: "center", marginBottom: 8 },
  cardIconBox: {
    width: 36, height: 36, borderRadius: 10,
    alignItems: "center", justifyContent: "center",
  },
  cardCategory: { fontSize: 14, fontWeight: "700", color: "#0f172a" },
  cardCrowd:    { fontSize: 12, color: "#64748b", marginTop: 1 },

  /* status pill */
  statusPill: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 20,
  },
  statusPillText: { fontSize: 11, fontWeight: "600" },

  /* indicators in card */
  indicatorsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 },
  indicatorChip: {
    backgroundColor: "#f1f5f9", borderRadius: 6,
    paddingHorizontal: 7, paddingVertical: 3,
  },
  indicatorChipText: { fontSize: 11, color: "#475569", fontWeight: "500" },
  indicatorMore:     { fontSize: 11, color: "#94a3b8", alignSelf: "center" },

  /* card footer */
  cardFooter:     { flexDirection: "row", gap: 12, flexWrap: "wrap" },
  cardFooterItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  cardFooterText: { fontSize: 11, color: "#64748b" },

  /* empty / loading */
  center:      { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  loadingText: { fontSize: 14, color: "#64748b" },
  emptyTitle:  { fontSize: 16, fontWeight: "700", color: "#374151", marginTop: 8 },
  emptyDesc:   { fontSize: 13, color: "#94a3b8", textAlign: "center", paddingHorizontal: 32 },

  /* modal */
  modalRoot:    { flex: 1, backgroundColor: "#f8fafc" },
  modalHeader: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: "#ffffff",
    borderBottomWidth: 1, borderBottomColor: "#e2e8f0",
  },
  modalTitle:   { flex: 1, textAlign: "center", fontSize: 16, fontWeight: "700", color: "#0f1c14" },
  modalContent: { padding: 16, paddingBottom: 48 },

  /* detail */
  detailCatHeader: {
    flexDirection: "row", alignItems: "center",
    padding: 16, borderRadius: 14, borderWidth: 1, marginBottom: 16,
  },
  detailCatTitle: { fontSize: 17, fontWeight: "800" },
  detailCatSub:   { fontSize: 12, color: "#64748b", marginTop: 2 },

  detailGrid: {
    backgroundColor: "#ffffff", borderRadius: 14,
    borderWidth: 1, borderColor: "#e2e8f0",
    paddingVertical: 4, marginBottom: 16,
  },
  detailRow: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 14, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: "#f1f5f9",
  },
  detailRowLabel: { fontSize: 13, color: "#64748b", width: 96 },
  detailRowValue: { flex: 1, fontSize: 13, fontWeight: "600", color: "#0f172a" },

  detailSectionTitle: {
    fontSize: 11, fontWeight: "800", color: "#94a3b8",
    letterSpacing: 1.2, textTransform: "uppercase",
    marginBottom: 10, marginTop: 4,
  },

  behaviorWrap:    { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 20 },
  behaviorTag: {
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 10, borderWidth: 1.5,
  },
  behaviorTagText: { fontSize: 13, fontWeight: "600" },

  noteBox:  {
    backgroundColor: "#ffffff", borderRadius: 12,
    borderWidth: 1, borderColor: "#e2e8f0",
    padding: 14, marginBottom: 20,
  },
  noteText: { fontSize: 14, color: "#374151", lineHeight: 21 },

  locationBtn: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: "#eff6ff", borderRadius: 12,
    borderWidth: 1, borderColor: "#bfdbfe",
    padding: 14, marginBottom: 20,
  },
  locationBtnText:    { flex: 1, fontSize: 13, color: "#1e40af", fontWeight: "500" },
  locationOpenTag: {
    backgroundColor: "#3b82f6", borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  locationOpenTagText: { fontSize: 11, color: "#fff", fontWeight: "700" },

  /* actions */
  actionRow:     { flexDirection: "row", gap: 10, marginBottom: 24 },
  actionBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    paddingVertical: 13, borderRadius: 12, gap: 7,
  },
  actionBtnBlue:  { backgroundColor: "#3b82f6" },
  actionBtnGreen: { backgroundColor: "#16a34a" },
  actionBtnText:  { fontSize: 14, fontWeight: "700", color: "#ffffff" },

  resolvedBanner: {
    flexDirection: "row", alignItems: "flex-start", gap: 10,
    backgroundColor: "#f0fdf4", borderRadius: 12,
    borderWidth: 1, borderColor: "#bbf7d0",
    padding: 14, marginBottom: 24,
  },
  resolvedBannerText: { fontSize: 14, fontWeight: "600", color: "#15803d" },
  resolvedTimeRow: {
    flexDirection: "row", alignItems: "center", gap: 5, marginTop: 5,
  },
  resolvedTimeText: { fontSize: 12, color: "#16a34a" },
  resolvedTimeValue: { fontWeight: "800", color: "#15803d" },

  /* toast */
  toast: {
    position: "absolute", bottom: 32, left: 20, right: 20,
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 16, paddingVertical: 13, borderRadius: 14,
    shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 }, elevation: 6,
  },
  toastSuccess: { backgroundColor: "#059669" },
  toastError:   { backgroundColor: "#dc2626" },
  toastText:    { flex: 1, color: "#fff", fontSize: 13, fontWeight: "600", lineHeight: 18 },
});
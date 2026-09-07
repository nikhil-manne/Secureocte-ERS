import React, { useState, useEffect } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Alert, ScrollView, KeyboardAvoidingView, Platform,
  SafeAreaView, StatusBar, Modal, FlatList,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { BASE_URL, getDeviceId } from "./api";

/* ─────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────── */
const DAYS   = Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, "0"));
const MONTHS = [
  { label: "January",   value: "01" }, { label: "February", value: "02" },
  { label: "March",     value: "03" }, { label: "April",    value: "04" },
  { label: "May",       value: "05" }, { label: "June",     value: "06" },
  { label: "July",      value: "07" }, { label: "August",   value: "08" },
  { label: "September", value: "09" }, { label: "October",  value: "10" },
  { label: "November",  value: "11" }, { label: "December", value: "12" },
];
const currentYear = new Date().getFullYear();
// Allow ages 10–100 → years from (current-100) to (current-10)
const YEARS = Array.from(
  { length: 91 },
  (_, i) => String(currentYear - 10 - i)
);

const GENDER_OPTIONS = [
  { label: "Male",   value: "male",   icon: "👨" },
  { label: "Female", value: "female", icon: "👩" },
  { label: "Other",  value: "other",  icon: "🧑" },
];

/* ─────────────────────────────────────────
   REUSABLE FIELD
───────────────────────────────────────── */
const Field = ({ icon, placeholder, value, onChangeText, secureTextEntry, keyboardType, maxLength }) => (
  <View style={styles.fieldWrap}>
    <Text style={styles.fieldIcon}>{icon}</Text>
    <TextInput
      style={styles.fieldInput}
      placeholder={placeholder}
      placeholderTextColor="#9CA8A5"
      value={value}
      onChangeText={onChangeText}
      secureTextEntry={secureTextEntry}
      keyboardType={keyboardType || "default"}
      autoCapitalize="none"
      maxLength={maxLength}
    />
  </View>
);

/* ─────────────────────────────────────────
   PICKER MODAL — generic scrollable list
───────────────────────────────────────── */
function PickerModal({ visible, title, data, selected, onSelect, onClose, labelKey }) {
  return (
    <Modal visible={visible} transparent animationType="slide">
      <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={onClose}>
        <View style={styles.pickerSheet}>
          <View style={styles.pickerHandle} />
          <Text style={styles.pickerTitle}>{title}</Text>
          <FlatList
            data={data}
            keyExtractor={(item) => (typeof item === "string" ? item : item.value)}
            style={styles.pickerList}
            showsVerticalScrollIndicator={false}
            initialScrollIndex={Math.max(0, data.findIndex(
              (item) => (typeof item === "string" ? item : item.value) === selected
            ))}
            getItemLayout={(_, index) => ({ length: 52, offset: 52 * index, index })}
            renderItem={({ item }) => {
              const val   = typeof item === "string" ? item : item.value;
              const lbl   = typeof item === "string" ? item : (item[labelKey] || item.label);
              const isSelected = val === selected;
              return (
                <TouchableOpacity
                  style={[styles.pickerItem, isSelected && styles.pickerItemSelected]}
                  onPress={() => { onSelect(val); onClose(); }}
                  activeOpacity={0.7}
                >
                  {item.icon ? <Text style={styles.pickerItemIcon}>{item.icon}</Text> : null}
                  <Text style={[styles.pickerItemText, isSelected && styles.pickerItemTextSelected]}>
                    {lbl}
                  </Text>
                  {isSelected && <Text style={styles.pickerCheck}>✓</Text>}
                </TouchableOpacity>
              );
            }}
          />
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

/* ─────────────────────────────────────────
   DOB DISPLAY ROW
   Shows three tappable chips: Day · Month · Year
───────────────────────────────────────── */
function DobPicker({ dobDay, dobMonth, dobYear, onDayChange, onMonthChange, onYearChange }) {
  const [openPicker, setOpenPicker] = useState(null); // "day"|"month"|"year"|null

  const monthLabel = MONTHS.find((m) => m.value === dobMonth)?.label || "Month";

  /* Compute age preview */
  let agePreview = null;
  if (dobDay && dobMonth && dobYear) {
    const birth   = new Date(`${dobYear}-${dobMonth}-${dobDay}`);
    const today   = new Date();
    let age       = today.getFullYear() - birth.getFullYear();
    const md      = today.getMonth() - birth.getMonth();
    if (md < 0 || (md === 0 && today.getDate() < birth.getDate())) age--;
    if (age >= 10 && age <= 120) agePreview = age;
  }

  return (
    <View style={styles.dobWrap}>
      <View style={styles.dobLabelRow}>
        <Text style={styles.fieldIcon}>🎂</Text>
        <Text style={styles.dobLabel}>Date of Birth</Text>
        {agePreview !== null && (
          <View style={styles.ageBadge}>
            <Text style={styles.ageBadgeText}>Age {agePreview}</Text>
          </View>
        )}
      </View>

      <View style={styles.dobChipsRow}>
        {/* Day */}
        <TouchableOpacity
          style={[styles.dobChip, dobDay && styles.dobChipFilled]}
          onPress={() => setOpenPicker("day")}
          activeOpacity={0.75}
        >
          <Text style={[styles.dobChipText, dobDay && styles.dobChipTextFilled]}>
            {dobDay || "DD"}
          </Text>
        </TouchableOpacity>

        <Text style={styles.dobSep}>·</Text>

        {/* Month */}
        <TouchableOpacity
          style={[styles.dobChip, styles.dobChipWide, dobMonth && styles.dobChipFilled]}
          onPress={() => setOpenPicker("month")}
          activeOpacity={0.75}
        >
          <Text style={[styles.dobChipText, dobMonth && styles.dobChipTextFilled]}>
            {dobMonth ? monthLabel : "Month"}
          </Text>
        </TouchableOpacity>

        <Text style={styles.dobSep}>·</Text>

        {/* Year */}
        <TouchableOpacity
          style={[styles.dobChip, styles.dobChipWide, dobYear && styles.dobChipFilled]}
          onPress={() => setOpenPicker("year")}
          activeOpacity={0.75}
        >
          <Text style={[styles.dobChipText, dobYear && styles.dobChipTextFilled]}>
            {dobYear || "YYYY"}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Pickers */}
      <PickerModal
        visible={openPicker === "day"}
        title="Select Day"
        data={DAYS}
        selected={dobDay}
        onSelect={onDayChange}
        onClose={() => setOpenPicker(null)}
      />
      <PickerModal
        visible={openPicker === "month"}
        title="Select Month"
        data={MONTHS}
        selected={dobMonth}
        onSelect={onMonthChange}
        onClose={() => setOpenPicker(null)}
        labelKey="label"
      />
      <PickerModal
        visible={openPicker === "year"}
        title="Select Year"
        data={YEARS}
        selected={dobYear}
        onSelect={onYearChange}
        onClose={() => setOpenPicker(null)}
      />
    </View>
  );
}

/* ─────────────────────────────────────────
   GENDER SELECTOR — three inline chips
───────────────────────────────────────── */
function GenderSelector({ value, onChange }) {
  return (
    <View style={styles.genderWrap}>
      <View style={styles.dobLabelRow}>
        <Text style={styles.fieldIcon}>⚧️</Text>
        <Text style={styles.dobLabel}>Gender</Text>
      </View>
      <View style={styles.genderChipsRow}>
        {GENDER_OPTIONS.map((opt) => {
          const active = value === opt.value;
          return (
            <TouchableOpacity
              key={opt.value}
              style={[styles.genderChip, active && styles.genderChipActive]}
              onPress={() => onChange(opt.value)}
              activeOpacity={0.75}
            >
              <Text style={styles.genderChipIcon}>{opt.icon}</Text>
              <Text style={[styles.genderChipText, active && styles.genderChipTextActive]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

/* ─────────────────────────────────────────
   VALIDATION
───────────────────────────────────────── */
const MOBILE_REGEX  = /^[0-9]{10}$/;
const TRUSTED_REGEX = /^[0-9]{10}$/;

function validateSignup(username, password, mobile, trusted1, gender, dobDay, dobMonth, dobYear) {
  if (!username.trim()) return "Username is required.";
  if (username.trim().length < 3)  return "Username must be at least 3 characters.";
  if (username.trim().length > 50) return "Username must be under 50 characters.";
  if (!MOBILE_REGEX.test(mobile))  return "Mobile number must be exactly 10 digits.";
  if (!password)                   return "Password is required.";
  if (password.length < 6)         return "Password must be at least 6 characters.";
  if (password.length > 128)       return "Password is too long.";
  if (trusted1 && !TRUSTED_REGEX.test(trusted1))
    return "Trusted Contact 1 must be a valid 10-digit number.";

  if (!gender)                     return "Please select your gender.";
  if (!dobDay || !dobMonth || !dobYear) return "Please select your complete date of birth.";

  /* Age check client-side too */
  const birth = new Date(`${dobYear}-${dobMonth}-${dobDay}`);
  if (isNaN(birth.getTime()))      return "Invalid date of birth.";
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const md = today.getMonth() - birth.getMonth();
  if (md < 0 || (md === 0 && today.getDate() < birth.getDate())) age--;
  if (age < 10)  return "You must be at least 10 years old to register.";
  if (age > 120) return "Invalid date of birth.";

  return null;
}

function validateLogin(mobile, password) {
  if (!MOBILE_REGEX.test(mobile)) return "Mobile number must be exactly 10 digits.";
  if (!password) return "Password is required.";
  return null;
}

/* ─────────────────────────────────────────
   MAIN SCREEN
───────────────────────────────────────── */
export default function AuthScreen({ onAuthSuccess }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [mobile,   setMobile]   = useState("");
  const [trusted1, setTrusted1] = useState("");
  const [trusted2, setTrusted2] = useState("");
  const [gender,   setGender]   = useState("");
  const [dobDay,   setDobDay]   = useState("");
  const [dobMonth, setDobMonth] = useState("");
  const [dobYear,  setDobYear]  = useState("");
  const [mode,     setMode]     = useState("login");
  const [loading,  setLoading]  = useState(false);

  /* ── Auto-login ── */
  useEffect(() => {
    const checkLogin = async () => {
      try {
        const storedUser = await AsyncStorage.getItem("userData");
        if (storedUser) {
          const stored     = JSON.parse(storedUser);
          // The stored data may be the full API response ({ message, token, user: {...} })
          // or just the user object — normalise the same way the fresh-login path does.
          const user       = stored.user || stored;
          const storedToken = await SecureStore.getItemAsync("userToken");
          if (storedToken) {
            onAuthSuccess(
              user.id || user.userId || user._id,
              user.username,
              user.mobile,
              storedToken,
              user.gender,
              user.dob
            );
          }
        }
      } catch (err) {
        console.log("Error reading stored user:", err);
      }
    };
    checkLogin();
  }, []);

  const handleAuth = async () => {
    const validationError =
      mode === "signup"
        ? validateSignup(username, password, mobile, trusted1, gender, dobDay, dobMonth, dobYear)
        : validateLogin(mobile, password);

    if (validationError) {
      Alert.alert("Invalid Input", validationError);
      return;
    }

    setLoading(true);
    try {
      const deviceId = await getDeviceId();

      const body =
        mode === "signup"
          ? {
              username:        username.trim(),
              password,
              mobile:          mobile.trim(),
              trustedContacts: [trusted1, trusted2].filter((c) => c.trim()),
              deviceId,
              gender,
              /* Send ISO date string — backend parses to Date */
              dob: `${dobYear}-${dobMonth}-${dobDay}`,
            }
          : { mobile: mobile.trim(), password, deviceId };

      const apiUrl = BASE_URL ? `${BASE_URL}/api/auth/${mode}` : `https://securebackend.in/api/auth/${mode}`;
      const response = await fetch(apiUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });

      const data = await response.json();
      if (!response.ok) {
        Alert.alert("Error", data.error || "Something went wrong.");
        return;
      }

      if (data.token) {
        await SecureStore.setItemAsync("userToken", data.token);
      }

      const u = data.user || data;
      await AsyncStorage.setItem("userData", JSON.stringify(u));
      onAuthSuccess(
        u.id || u._id || data.userId,
        u.username || data.username,
        u.mobile || data.mobile,
        data.token,
        u.gender || data.gender,
        u.dob || data.dob
      );
    } catch (err) {
      Alert.alert("Error", "Network error. Please check your connection.");
    } finally {
      setLoading(false);
    }
  };

  const isLogin = mode === "login";

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor="#EDF2EC" />
      <SafeAreaView style={{ flex: 1 }}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 20}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* ── BRAND ── */}
            <View style={styles.brandBlock}>
              <View style={styles.brandBadge}>
                <Text style={styles.brandBadgeIcon}>🛡️</Text>
              </View>
              <Text style={styles.brandName}>SecureOcte</Text>
              <Text style={styles.brandTagline}>Your personal safety companion</Text>
            </View>

            {/* ── CARD ── */}
            <View style={styles.card}>

              {/* Tabs */}
              <View style={styles.tabRow}>
                <TouchableOpacity style={[styles.tab, isLogin && styles.tabActive]} onPress={() => setMode("login")} activeOpacity={0.75}>
                  <Text style={[styles.tabText, isLogin && styles.tabTextActive]}>Login</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.tab, !isLogin && styles.tabActive]} onPress={() => setMode("signup")} activeOpacity={0.75}>
                  <Text style={[styles.tabText, !isLogin && styles.tabTextActive]}>Sign Up</Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.cardTitle}>{isLogin ? "Welcome back 👋" : "Create your account"}</Text>
              <Text style={styles.cardSub}>
                {isLogin ? "Login to continue your safe journey" : "Sign up to start travelling safely"}
              </Text>

              {/* ── FIELDS ── */}
              <View style={styles.fields}>
                {!isLogin && (
                  <Field icon="👤" placeholder="Username (3–50 characters)" value={username} onChangeText={setUsername} maxLength={50} />
                )}

                <Field icon="📱" placeholder="Mobile Number (10 digits)" value={mobile} onChangeText={(t) => setMobile(t.replace(/[^0-9]/g, ""))} keyboardType="phone-pad" maxLength={10} />
                <Field icon="🔒" placeholder="Password (min 6 characters)" value={password} onChangeText={setPassword} secureTextEntry maxLength={128} />

                {!isLogin && (
                  <>
                    {/* ── Gender ── */}
                    <View style={styles.sectionDivider}>
                      <View style={styles.dividerLine} />
                      <Text style={styles.dividerLabel}>Personal Info</Text>
                      <View style={styles.dividerLine} />
                    </View>

                    <GenderSelector value={gender} onChange={setGender} />

                    <DobPicker
                      dobDay={dobDay}   dobMonth={dobMonth}   dobYear={dobYear}
                      onDayChange={setDobDay}
                      onMonthChange={setDobMonth}
                      onYearChange={setDobYear}
                    />

                    {/* ── Trusted Contacts ── */}
                    <View style={styles.sectionDivider}>
                      <View style={styles.dividerLine} />
                      <Text style={styles.dividerLabel}>Trusted Contacts</Text>
                      <View style={styles.dividerLine} />
                    </View>

                    <Field icon="🤝" placeholder="Trusted Contact 1 (10-digit mobile)" value={trusted1} onChangeText={(t) => setTrusted1(t.replace(/[^0-9]/g, ""))} keyboardType="phone-pad" maxLength={10} />
                    <Field icon="🤝" placeholder="Trusted Contact 2 (optional)" value={trusted2} onChangeText={(t) => setTrusted2(t.replace(/[^0-9]/g, ""))} keyboardType="phone-pad" maxLength={10} />
                  </>
                )}
              </View>

              {/* ── CTA ── */}
              <TouchableOpacity style={[styles.ctaBtn, loading && styles.ctaBtnLoading]} onPress={handleAuth} activeOpacity={0.85} disabled={loading}>
                <Text style={styles.ctaBtnText}>
                  {loading ? "Please wait…" : isLogin ? "Login  →" : "Create Account  →"}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity onPress={() => setMode(isLogin ? "signup" : "login")} style={styles.switchLink} activeOpacity={0.7}>
                <Text style={styles.switchLinkText}>
                  {isLogin ? "Don't have an account? " : "Already have an account? "}
                  <Text style={styles.switchLinkHighlight}>{isLogin ? "Sign Up" : "Login"}</Text>
                </Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.footerNote}>🔐 Your data is encrypted and never shared without your consent.</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

/* ─────────────────────────────────────────
   STYLES
───────────────────────────────────────── */
const styles = StyleSheet.create({
  root:       { flex: 1, backgroundColor: "#EDF2EC" },
  scroll:     { flexGrow: 1, paddingHorizontal: 20, paddingTop: 40, paddingBottom: 32 },

  brandBlock: { alignItems: "center", marginBottom: 32 },
  brandBadge: { width: 72, height: 72, borderRadius: 36, backgroundColor: "#CDFAD5", justifyContent: "center", alignItems: "center", borderWidth: 2, borderColor: "#22C55E", marginBottom: 12, shadowColor: "#22C55E", shadowOpacity: 0.2, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
  brandBadgeIcon: { fontSize: 36 },
  brandName:  { fontSize: 32, fontWeight: "900", color: "#1A2420", letterSpacing: 0.5, marginBottom: 4 },
  brandTagline: { fontSize: 14, color: "#6B7F78", fontWeight: "500" },

  card:       { backgroundColor: "#FFFFFF", borderRadius: 24, padding: 24, shadowColor: "#000", shadowOpacity: 0.07, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 5, borderWidth: 1, borderColor: "#E8EEE7" },
  tabRow:     { flexDirection: "row", backgroundColor: "#F0F5EF", borderRadius: 12, padding: 4, marginBottom: 20 },
  tab:        { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: "center" },
  tabActive:  { backgroundColor: "#FFFFFF", shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  tabText:    { fontSize: 14, fontWeight: "600", color: "#9CA8A5" },
  tabTextActive: { color: "#1A2420", fontWeight: "800" },
  cardTitle:  { fontSize: 20, fontWeight: "800", color: "#1A2420", marginBottom: 4 },
  cardSub:    { fontSize: 13, color: "#6B7F78", marginBottom: 20 },
  fields:     { gap: 12 },

  fieldWrap:  { flexDirection: "row", alignItems: "center", backgroundColor: "#F0F5EF", borderRadius: 14, paddingHorizontal: 14, paddingVertical: 4, borderWidth: 1, borderColor: "#D8E4D6" },
  fieldIcon:  { fontSize: 18, marginRight: 10 },
  fieldInput: { flex: 1, fontSize: 15, color: "#1A2420", paddingVertical: 12 },

  sectionDivider: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4, marginBottom: 4 },
  dividerLine:    { flex: 1, height: 1, backgroundColor: "#D8E4D6" },
  dividerLabel:   { fontSize: 11, fontWeight: "700", color: "#9CA8A5", letterSpacing: 1, textTransform: "uppercase" },

  /* Gender */
  genderWrap:       { backgroundColor: "#F0F5EF", borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1, borderColor: "#D8E4D6" },
  genderChipsRow:   { flexDirection: "row", gap: 8, marginTop: 10 },
  genderChip:       { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 10, backgroundColor: "#FFFFFF", borderWidth: 1.5, borderColor: "#D8E4D6" },
  genderChipActive: { backgroundColor: "#CDFAD5", borderColor: "#22C55E" },
  genderChipIcon:   { fontSize: 16 },
  genderChipText:   { fontSize: 13, fontWeight: "600", color: "#9CA8A5" },
  genderChipTextActive: { color: "#14532D", fontWeight: "800" },

  /* DOB */
  dobWrap:      { backgroundColor: "#F0F5EF", borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1, borderColor: "#D8E4D6" },
  dobLabelRow:  { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  dobLabel:     { fontSize: 14, color: "#6B7F78", fontWeight: "600", flex: 1 },
  ageBadge:     { backgroundColor: "#CDFAD5", paddingHorizontal: 10, paddingVertical: 3, borderRadius: 20 },
  ageBadgeText: { fontSize: 12, fontWeight: "800", color: "#14532D" },
  dobChipsRow:  { flexDirection: "row", alignItems: "center", gap: 6 },
  dobSep:       { fontSize: 18, color: "#9CA8A5", fontWeight: "300" },
  dobChip:      { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, backgroundColor: "#FFFFFF", borderWidth: 1.5, borderColor: "#D8E4D6", alignItems: "center", justifyContent: "center" },
  dobChipWide:  { flex: 1 },
  dobChipFilled:    { backgroundColor: "#CDFAD5", borderColor: "#22C55E" },
  dobChipText:      { fontSize: 14, fontWeight: "600", color: "#9CA8A5" },
  dobChipTextFilled: { color: "#14532D", fontWeight: "800" },

  /* Picker modal */
  modalOverlay:  { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  pickerSheet:   { backgroundColor: "#FFFFFF", borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 12, paddingBottom: 34, maxHeight: "60%" },
  pickerHandle:  { width: 40, height: 4, borderRadius: 2, backgroundColor: "#D8E4D6", alignSelf: "center", marginBottom: 16 },
  pickerTitle:   { fontSize: 16, fontWeight: "800", color: "#1A2420", textAlign: "center", marginBottom: 8, paddingHorizontal: 20 },
  pickerList:    { paddingHorizontal: 16 },
  pickerItem:    { height: 52, flexDirection: "row", alignItems: "center", paddingHorizontal: 14, borderRadius: 12, marginVertical: 2 },
  pickerItemSelected: { backgroundColor: "#CDFAD5" },
  pickerItemIcon: { fontSize: 20, marginRight: 12 },
  pickerItemText: { flex: 1, fontSize: 15, color: "#6B7F78", fontWeight: "500" },
  pickerItemTextSelected: { color: "#14532D", fontWeight: "800" },
  pickerCheck:   { fontSize: 16, color: "#22C55E", fontWeight: "900" },

  ctaBtn:       { backgroundColor: "#22C55E", borderRadius: 14, paddingVertical: 16, alignItems: "center", marginTop: 24, shadowColor: "#22C55E", shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
  ctaBtnLoading: { backgroundColor: "#A3D9B1", shadowOpacity: 0, elevation: 0 },
  ctaBtnText:   { color: "#FFFFFF", fontSize: 16, fontWeight: "800", letterSpacing: 0.3 },
  switchLink:   { marginTop: 16, alignItems: "center" },
  switchLinkText: { fontSize: 14, color: "#6B7F78" },
  switchLinkHighlight: { color: "#22C55E", fontWeight: "800" },
  footerNote:   { marginTop: 24, textAlign: "center", fontSize: 12, color: "#9CA8A5", lineHeight: 18 },
});

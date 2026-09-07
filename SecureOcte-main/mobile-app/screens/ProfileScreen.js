import React, { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, Alert,
  StyleSheet, ScrollView, KeyboardAvoidingView, Platform,
  SafeAreaView, StatusBar, Modal, FlatList,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AuthContext } from "./AuthContext";
import { BASE_URL } from "./api";

/* ─────────────────────────────────────────────────────────────
   CONSTANTS  (same as AuthScreen so DOB logic is identical)
───────────────────────────────────────────────────────────── */
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
const YEARS = Array.from({ length: 91 }, (_, i) => String(currentYear - 10 - i));

const GENDER_META = {
  male:   { label: "Male",   icon: "👨" },
  female: { label: "Female", icon: "👩" },
  other:  { label: "Other",  icon: "🧑" },
};

/* ─────────────────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────────────────── */
function calcAge(dob) {
  if (!dob) return null;
  const birth   = new Date(dob);
  if (isNaN(birth.getTime())) return null;
  const today   = new Date();
  let age       = today.getFullYear() - birth.getFullYear();
  const md      = today.getMonth() - birth.getMonth();
  if (md < 0 || (md === 0 && today.getDate() < birth.getDate())) age--;
  return age >= 0 ? age : null;
}

/** Parse a Date / ISO string into { day, month, year } strings */
function parseDob(dob) {
  if (!dob) return { day: "", month: "", year: "" };
  const d = new Date(dob);
  if (isNaN(d.getTime())) return { day: "", month: "", year: "" };
  return {
    day:   String(d.getUTCDate()).padStart(2, "0"),
    month: String(d.getUTCMonth() + 1).padStart(2, "0"),
    year:  String(d.getUTCFullYear()),
  };
}

/* ─────────────────────────────────────────────────────────────
   EDITABLE TEXT FIELD
───────────────────────────────────────────────────────────── */
const Field = ({ icon, label, value, onChangeText, keyboardType, placeholder }) => (
  <View style={styles.fieldBlock}>
    <Text style={styles.fieldLabel}>{label}</Text>
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldIcon}>{icon}</Text>
      <TextInput
        style={styles.fieldInput}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder || label}
        placeholderTextColor="#9CA8A5"
        keyboardType={keyboardType || "default"}
        autoCapitalize="none"
      />
    </View>
  </View>
);

/* ─────────────────────────────────────────────────────────────
   READ-ONLY INFO ROW  (for gender — not editable)
───────────────────────────────────────────────────────────── */
const ReadonlyRow = ({ icon, label, value }) => (
  <View style={styles.fieldBlock}>
    <Text style={styles.fieldLabel}>{label}</Text>
    <View style={[styles.fieldWrap, styles.fieldWrapReadonly]}>
      <Text style={styles.fieldIcon}>{icon}</Text>
      <Text style={styles.fieldReadonlyText}>{value}</Text>
      <View style={styles.lockedBadge}>
        <Text style={styles.lockedBadgeText}>🔒 Fixed</Text>
      </View>
    </View>
  </View>
);

/* ─────────────────────────────────────────────────────────────
   PICKER MODAL
───────────────────────────────────────────────────────────── */
function PickerModal({ visible, title, data, selected, onSelect, onClose, labelKey }) {
  const indexOf = data.findIndex(
    (item) => (typeof item === "string" ? item : item.value) === selected
  );
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
            initialScrollIndex={Math.max(0, indexOf)}
            getItemLayout={(_, index) => ({ length: 52, offset: 52 * index, index })}
            renderItem={({ item }) => {
              const val      = typeof item === "string" ? item : item.value;
              const lbl      = typeof item === "string" ? item : (item[labelKey] || item.label);
              const isActive = val === selected;
              return (
                <TouchableOpacity
                  style={[styles.pickerItem, isActive && styles.pickerItemSelected]}
                  onPress={() => { onSelect(val); onClose(); }}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.pickerItemText, isActive && styles.pickerItemTextSelected]}>
                    {lbl}
                  </Text>
                  {isActive && <Text style={styles.pickerCheck}>✓</Text>}
                </TouchableOpacity>
              );
            }}
          />
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

/* ─────────────────────────────────────────────────────────────
   DOB PICKER ROW  (editable)
───────────────────────────────────────────────────────────── */
function DobPickerRow({ dobDay, dobMonth, dobYear, onDayChange, onMonthChange, onYearChange }) {
  const [openPicker, setOpenPicker] = useState(null);

  const monthLabel = MONTHS.find((m) => m.value === dobMonth)?.label || "Month";

  let agePreview = null;
  if (dobDay && dobMonth && dobYear) {
    const age = calcAge(`${dobYear}-${dobMonth}-${dobDay}`);
    if (age !== null) agePreview = age;
  }

  return (
    <View style={styles.fieldBlock}>
      <Text style={styles.fieldLabel}>Date of Birth</Text>

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

        {/* Live age badge */}
        {agePreview !== null && (
          <View style={styles.ageBadge}>
            <Text style={styles.ageBadgeText}>Age {agePreview}</Text>
          </View>
        )}
      </View>

      <PickerModal
        visible={openPicker === "day"}   title="Select Day"
        data={DAYS} selected={dobDay}
        onSelect={onDayChange} onClose={() => setOpenPicker(null)}
      />
      <PickerModal
        visible={openPicker === "month"} title="Select Month"
        data={MONTHS} selected={dobMonth} labelKey="label"
        onSelect={onMonthChange} onClose={() => setOpenPicker(null)}
      />
      <PickerModal
        visible={openPicker === "year"}  title="Select Year"
        data={YEARS} selected={dobYear}
        onSelect={onYearChange} onClose={() => setOpenPicker(null)}
      />
    </View>
  );
}

/* ─────────────────────────────────────────────────────────────
   MAIN SCREEN
───────────────────────────────────────────────────────────── */
export default function ProfileScreen({ user, token, goBack, updateUser, navigation }) {
  const originalUser = user;

  /* Editable fields */
  const [username, setUsername] = useState(user.username || "");
  const [mobile,   setMobile]   = useState(user.mobile   || "");
  const [trusted1, setTrusted1] = useState(user.trustedContacts?.[0] || "");
  const [trusted2, setTrusted2] = useState(user.trustedContacts?.[1] || "");
  const [saving,   setSaving]   = useState(false);

  /* DOB — editable, split into parts */
  const initDob = parseDob(user.dob);
  const [dobDay,   setDobDay]   = useState(initDob.day);
  const [dobMonth, setDobMonth] = useState(initDob.month);
  const [dobYear,  setDobYear]  = useState(initDob.year);

  /* Gender — read from user, NOT editable */
  const genderInfo = GENDER_META[user.gender] || { label: user.gender || "—", icon: "⚧️" };

  /* Current age derived from live DOB chips */
  const currentAge = (dobDay && dobMonth && dobYear)
    ? calcAge(`${dobYear}-${dobMonth}-${dobDay}`)
    : calcAge(user.dob);

  const handleSave = async () => {
    try {
      setSaving(true);
      const payload = {};

      if (username.trim() && username.trim() !== originalUser.username)
        payload.username = username.trim();
      if (mobile.trim() && mobile.trim() !== originalUser.mobile)
        payload.mobile = mobile.trim();

      const newContacts = [trusted1, trusted2].map((c) => c.trim()).filter(Boolean);
      if (JSON.stringify(newContacts) !== JSON.stringify(originalUser.trustedContacts || []))
        payload.trustedContacts = newContacts;

      /* DOB change */
      if (dobDay && dobMonth && dobYear) {
        const newDob = `${dobYear}-${dobMonth}-${dobDay}`;
        const origParsed = parseDob(originalUser.dob);
        const origDob    = `${origParsed.year}-${origParsed.month}-${origParsed.day}`;
        if (newDob !== origDob) {
          /* Client-side age check before sending */
          const age = calcAge(newDob);
          if (age === null || age < 10) {
            Alert.alert("Invalid Date", "You must be at least 10 years old.");
            return;
          }
          payload.dob = newDob;
        }
      }

      if (Object.keys(payload).length === 0) {
        Alert.alert("No Changes", "Nothing to update.");
        return;
      }

      const response = await fetch(
        `${BASE_URL}/api/auth/update/${user._id || user.id}`,
        {
          method:  "PUT",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(payload),
        }
      );

      const data = await response.json();
      if (!response.ok) { Alert.alert("Error", data.error || "Update failed"); return; }

      Alert.alert("✅ Saved", "Profile updated successfully.");
      updateUser({ ...user, ...payload });
      goBack();
    } catch (err) {
      Alert.alert("Error", err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = () => {
    Alert.alert("Logout", "Are you sure you want to logout?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Logout", style: "destructive",
        onPress: async () => {
          await AsyncStorage.removeItem("userData");
          navigation?.replace("AuthScreen");
        },
      },
    ]);
  };

  const initials = (user.username || "U").slice(0, 2).toUpperCase();

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor="#EDF2EC" />
      <SafeAreaView style={{ flex: 1 }}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 20}
        >
          {/* ── HEADER ── */}
          <View style={styles.header}>
            <TouchableOpacity onPress={goBack} style={styles.headerBack} activeOpacity={0.7}>
              <Text style={styles.headerBackArrow}>←</Text>
            </TouchableOpacity>
            <Text style={styles.headerTitle}>My Profile</Text>
            <View style={styles.headerBadge}>
              <Text style={styles.headerBadgeIcon}>🛡️</Text>
            </View>
          </View>

          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* ── AVATAR BLOCK ── */}
            <View style={styles.avatarBlock}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{initials}</Text>
              </View>
              <Text style={styles.avatarName}>{user.username || "User"}</Text>
              <Text style={styles.avatarMobile}>{user.mobile || ""}</Text>

              {/* Gender + Age pills under avatar */}
              <View style={styles.pillRow}>
                {user.gender && (
                  <View style={styles.pill}>
                    <Text style={styles.pillText}>
                      {genderInfo.icon}  {genderInfo.label}
                    </Text>
                  </View>
                )}
                {currentAge !== null && (
                  <View style={[styles.pill, styles.pillGreen]}>
                    <Text style={[styles.pillText, styles.pillTextGreen]}>
                      🎂  Age {currentAge}
                    </Text>
                  </View>
                )}
              </View>
            </View>

            {/* ── PERSONAL INFO CARD ── */}
            <View style={styles.card}>
              <Text style={styles.cardSection}>PERSONAL INFO</Text>

              {/* Gender — read only */}
              <ReadonlyRow
                icon={genderInfo.icon}
                label="Gender"
                value={genderInfo.label}
              />

              {/* DOB — editable via picker */}
              <DobPickerRow
                dobDay={dobDay}     dobMonth={dobMonth}     dobYear={dobYear}
                onDayChange={setDobDay}
                onMonthChange={setDobMonth}
                onYearChange={setDobYear}
              />
            </View>

            {/* ── ACCOUNT DETAILS CARD ── */}
            <View style={styles.card}>
              <Text style={styles.cardSection}>ACCOUNT DETAILS</Text>

              <Field
                icon="👤" label="Username"
                value={username} onChangeText={setUsername}
                placeholder="Your username"
              />
              <Field
                icon="📱" label="Mobile Number"
                value={mobile}   onChangeText={setMobile}
                keyboardType="phone-pad" placeholder="Your mobile number"
              />
            </View>

            {/* ── TRUSTED CONTACTS CARD ── */}
            <View style={styles.card}>
              <Text style={styles.cardSection}>TRUSTED CONTACTS</Text>
              <Text style={styles.cardHint}>
                These contacts will be alerted in case of an emergency.
              </Text>
              <Field
                icon="🤝" label="Contact 1"
                value={trusted1} onChangeText={setTrusted1}
                keyboardType="phone-pad" placeholder="Required"
              />
              <Field
                icon="🤝" label="Contact 2"
                value={trusted2} onChangeText={setTrusted2}
                keyboardType="phone-pad" placeholder="Optional"
              />
            </View>

            {/* ── SAVE ── */}
            <TouchableOpacity
              style={[styles.saveBtn, saving && styles.saveBtnLoading]}
              onPress={handleSave} activeOpacity={0.85} disabled={saving}
            >
              <Text style={styles.saveBtnText}>
                {saving ? "Saving…" : "Save Changes  →"}
              </Text>
            </TouchableOpacity>

            {/* ── LOGOUT ── */}
            <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout} activeOpacity={0.85}>
              <Text style={styles.logoutBtnText}>🚪  Logout</Text>
            </TouchableOpacity>

            <View style={{ height: 32 }} />
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

/* ─────────────────────────────────────────────────────────────
   STYLES
───────────────────────────────────────────────────────────── */
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#EDF2EC" },

  /* Header */
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 18, paddingTop: 36, paddingBottom: 14, backgroundColor: "#EDF2EC", borderBottomWidth: 1, borderBottomColor: "#D8E4D6" },
  headerBack: { width: 36, height: 36, justifyContent: "center" },
  headerBackArrow: { fontSize: 24, color: "#1A2420", fontWeight: "600" },
  headerTitle: { flex: 1, textAlign: "center", fontSize: 18, fontWeight: "800", color: "#1A2420", letterSpacing: 0.2 },
  headerBadge: { width: 36, height: 36, borderRadius: 18, backgroundColor: "#CDFAD5", justifyContent: "center", alignItems: "center", borderWidth: 1.5, borderColor: "#22C55E" },
  headerBadgeIcon: { fontSize: 18 },

  scroll: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 16 },

  /* Avatar */
  avatarBlock: { alignItems: "center", marginBottom: 24 },
  avatar: { width: 80, height: 80, borderRadius: 40, backgroundColor: "#22C55E", justifyContent: "center", alignItems: "center", marginBottom: 12, shadowColor: "#22C55E", shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
  avatarText: { fontSize: 28, fontWeight: "900", color: "#FFFFFF", letterSpacing: 1 },
  avatarName: { fontSize: 20, fontWeight: "800", color: "#1A2420", marginBottom: 2 },
  avatarMobile: { fontSize: 14, color: "#6B7F78", fontWeight: "500", marginBottom: 12 },

  /* Gender + Age pills under avatar */
  pillRow:        { flexDirection: "row", gap: 8, marginTop: 4 },
  pill:           { flexDirection: "row", alignItems: "center", backgroundColor: "#F0F5EF", borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6, borderWidth: 1, borderColor: "#D8E4D6" },
  pillGreen:      { backgroundColor: "#CDFAD5", borderColor: "#22C55E" },
  pillText:       { fontSize: 13, fontWeight: "700", color: "#6B7F78" },
  pillTextGreen:  { color: "#14532D" },

  /* Cards */
  card: { backgroundColor: "#FFFFFF", borderRadius: 20, padding: 20, marginBottom: 16, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 3, borderWidth: 1, borderColor: "#E8EEE7" },
  cardSection: { fontSize: 11, fontWeight: "800", color: "#9CA8A5", letterSpacing: 1.5, marginBottom: 16, textTransform: "uppercase" },
  cardHint: { fontSize: 12, color: "#9CA8A5", marginTop: -10, marginBottom: 14, lineHeight: 17 },

  /* Fields */
  fieldBlock: { marginBottom: 12 },
  fieldLabel: { fontSize: 12, fontWeight: "700", color: "#6B7F78", marginBottom: 6, letterSpacing: 0.3 },
  fieldWrap:  { flexDirection: "row", alignItems: "center", backgroundColor: "#F0F5EF", borderRadius: 14, paddingHorizontal: 14, paddingVertical: 4, borderWidth: 1, borderColor: "#D8E4D6" },
  fieldWrapReadonly: { backgroundColor: "#F8FAF8", borderColor: "#E0EAE0" },
  fieldIcon:  { fontSize: 18, marginRight: 10 },
  fieldInput: { flex: 1, fontSize: 15, color: "#1A2420", paddingVertical: 12 },
  fieldReadonlyText: { flex: 1, fontSize: 15, color: "#6B7F78", paddingVertical: 12, fontWeight: "600" },
  lockedBadge: { backgroundColor: "#F0F5EF", borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: "#D8E4D6" },
  lockedBadgeText: { fontSize: 10, color: "#9CA8A5", fontWeight: "700" },

  /* DOB chips */
  dobChipsRow:      { flexDirection: "row", alignItems: "center", gap: 6 },
  dobSep:           { fontSize: 18, color: "#9CA8A5", fontWeight: "300" },
  dobChip:          { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, backgroundColor: "#F0F5EF", borderWidth: 1.5, borderColor: "#D8E4D6", alignItems: "center", justifyContent: "center" },
  dobChipWide:      { flex: 1 },
  dobChipFilled:    { backgroundColor: "#CDFAD5", borderColor: "#22C55E" },
  dobChipText:      { fontSize: 14, fontWeight: "600", color: "#9CA8A5" },
  dobChipTextFilled: { color: "#14532D", fontWeight: "800" },
  ageBadge:         { backgroundColor: "#CDFAD5", paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, marginLeft: 4 },
  ageBadgeText:     { fontSize: 12, fontWeight: "800", color: "#14532D" },

  /* Picker modal */
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  pickerSheet:  { backgroundColor: "#FFFFFF", borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 12, paddingBottom: 34, maxHeight: "60%" },
  pickerHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: "#D8E4D6", alignSelf: "center", marginBottom: 16 },
  pickerTitle:  { fontSize: 16, fontWeight: "800", color: "#1A2420", textAlign: "center", marginBottom: 8, paddingHorizontal: 20 },
  pickerList:   { paddingHorizontal: 16 },
  pickerItem:   { height: 52, flexDirection: "row", alignItems: "center", paddingHorizontal: 14, borderRadius: 12, marginVertical: 2 },
  pickerItemSelected: { backgroundColor: "#CDFAD5" },
  pickerItemText: { flex: 1, fontSize: 15, color: "#6B7F78", fontWeight: "500" },
  pickerItemTextSelected: { color: "#14532D", fontWeight: "800" },
  pickerCheck:  { fontSize: 16, color: "#22C55E", fontWeight: "900" },

  /* Save / logout */
  saveBtn:       { backgroundColor: "#22C55E", borderRadius: 16, paddingVertical: 16, alignItems: "center", marginBottom: 12, shadowColor: "#22C55E", shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
  saveBtnLoading: { backgroundColor: "#A3D9B1", shadowOpacity: 0, elevation: 0 },
  saveBtnText:   { color: "#FFFFFF", fontSize: 16, fontWeight: "800", letterSpacing: 0.3 },
  logoutBtn:     { backgroundColor: "#FFFFFF", borderRadius: 16, paddingVertical: 16, alignItems: "center", borderWidth: 1.5, borderColor: "#FCA5A5" },
  logoutBtnText: { color: "#EF4444", fontSize: 15, fontWeight: "800" },
});
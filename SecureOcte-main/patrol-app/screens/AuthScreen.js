import React, { useState, useContext } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  SafeAreaView,
  StatusBar,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { AuthContext } from "./AuthContext";
import { BASE_URL, getDeviceId } from "./api";

export default function AuthScreen() {
  const { login } = useContext(AuthContext);
  const [isLogin, setIsLogin] = useState(true);
  const [mobile, setMobile] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [badgeNumber, setBadgeNumber] = useState("");
  const [station, setStation] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!mobile.trim() || !password.trim()) {
      Alert.alert("Missing Fields", "Please enter both mobile number and password.");
      return;
    }

    setLoading(true);
    try {
      const deviceId = await getDeviceId();
      const endpoint = isLogin ? "/api/auth/login" : "/api/auth/register";
      const payload = isLogin
        ? { mobile: mobile.trim(), password }
        : {
          mobile: mobile.trim(),
          password,
          name: name.trim() || mobile.trim(),
          badgeNumber: badgeNumber.trim(),
          station: station.trim(),
          role: "officer",
        };

      const response = await fetch(`${BASE_URL}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Device-Id": deviceId,
        },
        body: JSON.stringify(payload),
      });

      const contentType = response.headers.get("content-type") || "";
      const isJson = contentType.includes("application/json");
      const data = isJson ? await response.json().catch(() => ({})) : { error: await response.text().catch(() => "") };

      if (!response.ok) {
        throw new Error(data.error || data.message || `Authentication failed (${response.status})`);
      }

      if (data.token) {
        await login(data.user || { mobile: mobile.trim(), role: "officer" }, data.token);
      } else {
        Alert.alert("Success", "Account created successfully. Please log in.");
        setIsLogin(true);
      }
    } catch (err) {
      Alert.alert("Authentication Error", err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0b1329" />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.keyboardWrap}
      >
        <View style={styles.headerBox}>
          <Text style={styles.badgeIcon}>🚔</Text>
          <Text style={styles.title}>PATROL OFFICER APP</Text>
          <Text style={styles.subtitle}>
            {isLogin ? "Shift Sign-in & Authentication" : "Register Officer Account"}
          </Text>
        </View>

        <View style={styles.card}>
          {!isLogin && (
            <>
              <Text style={styles.label}>Full Name</Text>
              <TextInput
                style={styles.input}
                placeholder="Officer Name"
                placeholderTextColor="#64748b"
                value={name}
                onChangeText={setName}
              />

              <Text style={styles.label}>Badge Number</Text>
              <TextInput
                style={styles.input}
                placeholder="Badge # (e.g. PB-4092)"
                placeholderTextColor="#64748b"
                value={badgeNumber}
                onChangeText={setBadgeNumber}
                autoCapitalize="characters"
              />

              <Text style={styles.label}>Police Station</Text>
              <TextInput
                style={styles.input}
                placeholder="Police Station Name"
                placeholderTextColor="#64748b"
                value={station}
                onChangeText={setStation}
              />
            </>
          )}

          <Text style={styles.label}>Officer Mobile Number</Text>
          <TextInput
            style={styles.input}
            placeholder="Mobile # (e.g. 9876543210)"
            placeholderTextColor="#64748b"
            value={mobile}
            onChangeText={setMobile}
            keyboardType="phone-pad"
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            style={styles.input}
            placeholder="••••••••"
            placeholderTextColor="#64748b"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />

          <TouchableOpacity
            style={[styles.submitBtn, loading && styles.disabledBtn]}
            onPress={handleSubmit}
            disabled={loading}
          >
            <Text style={styles.submitBtnText}>
              {loading ? "Authenticating..." : isLogin ? "SIGN IN FOR SHIFT" : "CREATE OFFICER ACCOUNT"}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.toggleBtn}
            onPress={() => setIsLogin(!isLogin)}
          >
            <Text style={styles.toggleText}>
              {isLogin ? "Need a new officer account? Register" : "Already registered? Sign in"}
            </Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0b1329",
  },
  keyboardWrap: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  headerBox: {
    alignItems: "center",
    marginBottom: 32,
  },
  badgeIcon: {
    fontSize: 54,
    marginBottom: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: "900",
    color: "#38bdf8",
    letterSpacing: 1.5,
  },
  subtitle: {
    fontSize: 14,
    color: "#94a3b8",
    marginTop: 4,
  },
  card: {
    backgroundColor: "#1e293b",
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: "#334155",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 8,
  },
  label: {
    fontSize: 13,
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
    marginTop: 24,
  },
  disabledBtn: {
    opacity: 0.6,
  },
  submitBtnText: {
    color: "#ffffff",
    fontWeight: "800",
    fontSize: 15,
    letterSpacing: 1,
  },
  toggleBtn: {
    marginTop: 16,
    alignItems: "center",
  },
  toggleText: {
    color: "#38bdf8",
    fontSize: 13,
  },
});

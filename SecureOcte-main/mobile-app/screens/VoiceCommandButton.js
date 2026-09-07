/**
 * VoiceCommandButton.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Floating mic button — tap to record and process a voice command.
 * Decisions: WALK_MONITORING | CAB_MONITORING | SOS
 *
 * Props:
 *   user            — user object from AuthContext
 *   token           — JWT token
 *   onSelectSection — navigation callback (same as HomeScreen)
 */

import React, { useState, useRef } from "react";
import {
  TouchableOpacity,
  StyleSheet,
  Alert,
  Animated,
  Vibration,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Audio }     from "expo-av";
import * as Location from "expo-location";
import { apiMultipart, rawFetchWithSecurity, BASE_URL } from "./api";

const RECORD_DURATION_MS = 5000;

const RECORDING_OPTIONS = {
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

export default function VoiceCommandButton({ user, token, onSelectSection }) {
  const [phase, setPhase]     = useState("idle");   // idle | listening | processing
  const recordingRef          = useRef(null);
  const pulseAnim             = useRef(new Animated.Value(1)).current;
  const pulseLoop             = useRef(null);

  /* ── Pulse animation while listening ── */
  const startPulse = () => {
    pulseLoop.current = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.25, duration: 500, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1,    duration: 500, useNativeDriver: true }),
      ])
    );
    pulseLoop.current.start();
  };

  const stopPulse = () => {
    pulseLoop.current?.stop();
    Animated.spring(pulseAnim, { toValue: 1, useNativeDriver: true }).start();
  };

  /* ── Main handler ── */
  const handlePress = async () => {
    if (phase !== "idle") return;

    setPhase("listening");
    startPulse();
    Vibration.vibrate(100);

    try {
      /* Permission */
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) {
        Alert.alert("Microphone Required", "Please allow mic access.");
        return;
      }

      /* Record */
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording } = await Audio.Recording.createAsync(RECORDING_OPTIONS);
      recordingRef.current = recording;

      await new Promise((r) => setTimeout(r, RECORD_DURATION_MS));

      await recording.stopAndUnloadAsync();
      const audioUri = recording.getURI();
      recordingRef.current = null;
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });

      if (!audioUri) throw new Error("No audio captured");

      setPhase("processing");
      stopPulse();

      /* Transcribe + decide in one call */
      const formData = new FormData();
      formData.append("audio", { uri: audioUri, name: "voice.wav", type: "audio/wav" });
      const result     = await apiMultipart("/api/speech/command", formData, token);
      const transcript = result?.transcript || "";
      const decision   = (result?.decision  || "UNKNOWN").trim().toUpperCase();

      if (!transcript) {
        Alert.alert("No Speech Detected", "Please speak clearly and try again.");
        return;
      }

      /* Execute */
      if (decision === "WALK_MONITORING") {
        Vibration.vibrate(200);
        Alert.alert("✅ Walk Monitoring", `Starting walk monitoring.\nYou said: "${transcript}"`);
        onSelectSection("walk");

      } else if (decision === "CAB_MONITORING") {
        Vibration.vibrate(200);
        Alert.alert("✅ Cab Monitoring", `Starting cab monitoring.\nYou said: "${transcript}"`);
        onSelectSection("cabVoiceAssistant");

      } else if (decision === "SOS") {
        Vibration.vibrate([0, 300, 100, 300]);
        await _dispatchSOS({ user, token });

      } else {
        Alert.alert(
          "Command Not Understood",
          `You said: "${transcript}"\n\nTry:\n• "Start walk monitoring"\n• "Start cab monitoring"\n• "Send SOS" / "Help me"`,
        );
      }
    } catch (err) {
      console.error("[VoiceCommandButton]", err.message);
      if (recordingRef.current) {
        try { await recordingRef.current.stopAndUnloadAsync(); } catch (_) {}
        recordingRef.current = null;
      }
      Alert.alert("Error", "Voice processing failed. Please try again.");
    } finally {
      stopPulse();
      setPhase("idle");
    }
  };

  const label =
    phase === "listening"   ? "Listening…"  :
    phase === "processing"  ? "Processing…" : "Voice";

  const bgColor =
    phase === "listening"  ? "#ef4444" :
    phase === "processing" ? "#f97316" : "#13ec49";

  return (
    <Animated.View style={[styles.wrapper, { transform: [{ scale: pulseAnim }] }]}>
      <TouchableOpacity
        style={[styles.btn, { backgroundColor: bgColor }]}
        onPress={handlePress}
        activeOpacity={0.85}
        disabled={phase !== "idle"}
      >
        <Ionicons
          name={phase === "listening" ? "mic-circle" : "mic"}
          size={30}
          color="#0f1c14"
        />
      </TouchableOpacity>
      <Text style={styles.label}>{label}</Text>
    </Animated.View>
  );
}

/* ── SOS dispatch (same logic as HardwareVoiceService) ── */
async function _dispatchSOS({ user, token }) {
  let lat = null, lng = null, address = "Location unavailable";

  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status === "granted") {
      let loc = null;
      try { loc = await Location.getLastKnownPositionAsync({ maxAge: 60000, requiredAccuracy: 500 }); } catch (_) {}
      if (!loc) {
        loc = await Promise.race([
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 6000)),
        ]);
      }
      lat = loc.coords.latitude;
      lng = loc.coords.longitude;

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

  const res = await rawFetchWithSecurity(`${BASE_URL}/api/secureme/alert`, {
    method: "POST",
    body: {
      userId:    user?.username,
      username:  user?.username,
      trigger:   "voice_sos",
      reason:    "SOS triggered via voice command button",
      lat,
      lng,
      location:  address,
      mode:      "voice",
      timestamp: new Date().toISOString(),
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `SOS failed (${res.status})`);
  }

  Alert.alert("🚨 SOS Sent", "Emergency alert sent to authorities with your location.", [{ text: "OK" }]);
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: "center",
    gap: 4,
  },
  btn: {
    width: 62,
    height: 62,
    borderRadius: 31,
    justifyContent: "center",
    alignItems: "center",
    elevation: 8,
    shadowColor: "#13ec49",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
  },
  label: {
    color: "#64748b",
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
});
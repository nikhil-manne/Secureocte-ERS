/**
 * HardwareVoiceService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Activates voice assistant via Bluetooth / wired earphone button press.
 *
 * Flow:
 *   Press BT/wired earphone button (play/pause)
 *     → expo-speech says "Voice assistant activated, speak now"
 *     → wait for speech to finish
 *     → record 5 s of audio
 *     → POST /api/speech/command  (STT + Gemini decision)
 *     → WALK_MONITORING | CAB_MONITORING | SOS
 *
 * Packages used — all already in package.json:
 *   expo-speech    (activation prompt)
 *   expo-av        (recording)
 *   expo-location  (SOS coords)
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { Alert, Vibration, Platform, DeviceEventEmitter } from "react-native";
import { Audio }    from "expo-av";
import * as Speech  from "expo-speech";
import * as Location from "expo-location";
import { apiMultipart, rawFetchWithSecurity, BASE_URL } from "./api";

/* ─── Tuning ─────────────────────────────────────────────────────────────── */
const RECORD_DURATION_MS = 5000;   // how long to record after activation
const DEBOUNCE_MS        = 6000;   // min gap between two full triggers

/* ─── WAV recording options ──────────────────────────────────────────────── */
const RECORDING_OPTIONS = {
  android: {
    extension: ".wav",
    outputFormat: Audio.AndroidOutputFormat.DEFAULT,
    audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
    sampleRate: 16000, numberOfChannels: 1, bitRate: 256000,
  },
  ios: {
    extension: ".wav",
    audioQuality: Audio.IOSAudioQuality.HIGH,
    sampleRate: 16000, numberOfChannels: 1, bitRate: 256000,
    linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false,
  },
};

/* ══════════════════════════════════════════════════════════════════════════
   useHardwareVoiceTrigger
══════════════════════════════════════════════════════════════════════════ */
export function useHardwareVoiceTrigger({ user, token, onSelectSection, onSOS }) {
  const lastTriggerRef   = useRef(0);
  const isProcessingRef  = useRef(false);
  const recordingRef     = useRef(null);

  // UI feedback state exposed to HomeScreen
  const [hwPhase, setHwPhase] = useState("idle");
  // "idle" | "activating" | "listening" | "processing"

  /* ── Speak activation prompt, then call back when done ── */
  const speakActivation = useCallback(() => {
    return new Promise((resolve) => {
      Speech.stop(); // stop anything already speaking
      Speech.speak("Voice assistant activated, speak now", {
        language: "en-IN",
        pitch: 1.0,
        rate: 1.1,
        onDone: resolve,
        onError: resolve,  // resolve even on error so pipeline continues
        onStopped: resolve,
      });
    });
  }, []);

  /* ── Core voice pipeline ─────────────────────────────────────────────── */
  const runVoicePipeline = useCallback(async (source = "unknown") => {
    const now = Date.now();
    if (now - lastTriggerRef.current < DEBOUNCE_MS) {
      console.log("[HardwareVoice] Debounced");
      return;
    }
    if (isProcessingRef.current) {
      console.log("[HardwareVoice] Already processing");
      return;
    }

    lastTriggerRef.current  = now;
    isProcessingRef.current = true;

    console.log(`[HardwareVoice] 🎙 Triggered by: ${source}`);

    try {
      /* ── Step 1: mic permission ── */
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) {
        Alert.alert("Microphone Required", "Please allow microphone access for voice commands.");
        return;
      }

      /* ── Step 2: speak activation prompt ── */
      setHwPhase("activating");
      Vibration.vibrate(200);
      console.log("[HardwareVoice] 🔊 Speaking activation prompt…");

      // Set audio mode for playback first (speech needs this)
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      });

      await speakActivation();
      console.log("[HardwareVoice] ✅ Prompt done — starting recording");

      /* ── Step 3: start recording ── */
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording } = await Audio.Recording.createAsync(RECORDING_OPTIONS);
      recordingRef.current = recording;

      setHwPhase("listening");
      Vibration.vibrate([0, 80, 60, 80]); // double buzz = "speak now"
      console.log("[HardwareVoice] 🔴 Recording for", RECORD_DURATION_MS, "ms…");

      await new Promise((r) => setTimeout(r, RECORD_DURATION_MS));

      /* ── Step 4: stop recording ── */
      await recording.stopAndUnloadAsync();
      const audioUri = recording.getURI();
      recordingRef.current = null;
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });

      if (!audioUri) throw new Error("No audio URI from recording");

      setHwPhase("processing");
      console.log("[HardwareVoice] Uploading audio:", audioUri);

      /* ── Step 5: transcribe + decide ── */
      let result;
      try {
        const formData = new FormData();
        formData.append("audio", { uri: audioUri, name: "voice.wav", type: "audio/wav" });
        result = await apiMultipart("/api/speech/command", formData, token, 30000);
      } catch (uploadErr) {
        console.error("[HardwareVoice] Upload failed:", uploadErr.message);
        Alert.alert("Voice Failed", `Could not process audio.\n${uploadErr.message}`);
        return;
      }

      const transcript = result?.transcript || "";
      const decision   = (result?.decision  || "UNKNOWN").trim().toUpperCase();
      console.log("[HardwareVoice] Transcript:", transcript, "| Decision:", decision);

      if (!transcript) {
        Speech.speak("Sorry, I could not hear you. Please try again.");
        return;
      }

      /* ── Step 6: execute decision ── */
      switch (decision) {
        case "WALK_MONITORING":
          Vibration.vibrate(200);
          Speech.speak("Starting walk monitoring");
          onSelectSection("walk");
          break;

        case "CAB_MONITORING":
          Vibration.vibrate(200);
          Speech.speak("Starting cab monitoring");
          onSelectSection("cabVoiceAssistant");
          break;

        case "SOS":
          Vibration.vibrate([0, 300, 100, 300, 100, 300]);
          Speech.speak("Sending SOS alert");
          await _dispatchVoiceSOS({ user, token });
          onSOS?.();
          break;

        default:
          Speech.speak("Sorry, I did not understand. Try saying start walk monitoring, start cab monitoring, or send SOS.");
          break;
      }

    } catch (err) {
      console.error("[HardwareVoice] Pipeline error:", err.message);
      if (recordingRef.current) {
        try { await recordingRef.current.stopAndUnloadAsync(); } catch (_) {}
        recordingRef.current = null;
      }
      Alert.alert("Voice Assistant Error", "Something went wrong. Please try again.");
    } finally {
      isProcessingRef.current = false;
      setHwPhase("idle");
    }
  }, [user, token, onSelectSection, onSOS, speakActivation]);

  /* ══════════════════════════════════════════════════════
     TRIGGER — Bluetooth / wired earphone button
     Single press on earbuds → fire immediately (no hold needed,
     since earbuds only have one button and holding is awkward).

     Android: DeviceEventEmitter "onAudioFocusChange"
     iOS:     Audio session remote-control (play/pause)
  ══════════════════════════════════════════════════════ */
  useEffect(() => {
    // iOS — prime audio session to capture remote-control events
    if (Platform.OS === "ios") {
      Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        interruptionModeIOS: Audio.INTERRUPTION_MODE_IOS_DO_NOT_MIX,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      }).catch(() => {});
    }

    // Android — media button via DeviceEventEmitter
    let mediaSub = null;
    if (Platform.OS === "android") {
      try {
        mediaSub = DeviceEventEmitter.addListener("onAudioFocusChange", (event) => {
          if (
            event?.focusChange === "AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK" ||
            event?.focusChange === "AUDIOFOCUS_GAIN"
          ) {
            console.log("[HardwareVoice] ✅ BT button press (Android)");
            runVoicePipeline("bluetooth_button");
          }
        });
      } catch (e) {
        console.warn("[HardwareVoice] BT media button listener failed:", e.message);
      }
    }

    return () => {
      try { mediaSub?.remove?.(); } catch (_) {}
    };
  }, [runVoicePipeline]);

  return { triggerVoice: runVoicePipeline, hwPhase };
}

/* ─────────────────────────────────────────────────────────────────────────────
   _dispatchVoiceSOS — get location + POST to /api/secureme/alert
───────────────────────────────────────────────────────────────────────────── */
async function _dispatchVoiceSOS({ user, token }) {
  let lat = null, lng = null, address = "Location unavailable";

  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status === "granted") {
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
  } catch (e) {
    console.warn("[HardwareVoice] SOS location error:", e.message);
  }

  const res = await rawFetchWithSecurity(`${BASE_URL}/api/secureme/alert`, {
    method: "POST",
    body: {
      userId:    user?.username,
      username:  user?.username,
      trigger:   "voice_sos",
      reason:    "SOS triggered via voice command on hardware button",
      lat, lng,
      location:  address,
      mode:      "voice",
      timestamp: new Date().toISOString(),
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `SOS failed (${res.status})`);
  }

  console.log("[HardwareVoice] ✅ SOS dispatched");
  Alert.alert("🚨 SOS Sent", "Emergency alert sent to authorities.", [{ text: "OK" }]);
}
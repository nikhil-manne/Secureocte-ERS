import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  TextInput,
} from "react-native";

import * as Speech from "expo-speech";
import { Ionicons } from "@expo/vector-icons";

import CabDestinationMapScreen from "./CabDestinationMapScreen";

export default function VoiceCabAssistantScreen({ goBack, navigateToCabMonitoring }) {
  const [step, setStep] = useState(1);

  // ✅ Speaker Toggle
  const [speakerOn, setSpeakerOn] = useState(false);

  // Step Data
  const [destination, setDestination] = useState(null);
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [vehicleType, setVehicleType] = useState("");

  // Map Page Toggle
  const [mapOpen, setMapOpen] = useState(false);

  // ✅ Step Instructions
  const stepsText = {
    1: "Step 1. Select your destination on the map.",
    2: "Step 2. Enter your vehicle number.",
    3: "Step 3. Choose your vehicle type and start escort.",
  };

  // ✅ Speak Helper
  const speak = (text) => {
    if (speakerOn) {
      Speech.speak(text);
    }
  };

  // ✅ Toggle Speaker
  const toggleSpeaker = () => {
    const newState = !speakerOn;
    setSpeakerOn(newState);

    if (newState) {
      Speech.speak(stepsText[step]); // Speak current step immediately
    } else {
      Speech.stop();
    }
  };

 const handleVoiceCommand = async (spokenText) => {
  const res = await fetch("/parse-command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: spokenText }),
  });

  const data = await res.json();

  console.log("Voice Parsed:", data);

  if (data.mode === "CAB_MONITORING") {
    if (data.destination) {
      setDestination({
        address: data.destination,
        source: "voice",
      });

      Speech.speak(`Trip started to ${data.destination}`);

      // ✅ Navigate directly to CabMonitoringScreen with startTripDirectly flag
      navigateToCabMonitoring({
        destination: { address: data.destination, source: "voice" },
        vehicleType: data.vehicleType ?? "driving",
        vehicleNumber: data.vehicleNumber ?? "",
        startTripDirectly: true,
      });
    } else {
      // fallback — go to Step 1 to pick destination on map
      setStep(1);
      setMapOpen(true);
    }
  }
};



  // ✅ Move to Next Step + Speak
  const goNext = (next) => {
    setStep(next);
    speak(stepsText[next]);
  };

  // ✅ Map Page Screen
  if (mapOpen) {
    return (
      <CabDestinationMapScreen
        onBack={() => setMapOpen(false)}
        onConfirm={(dest) => {
          setDestination(dest);
          setMapOpen(false);

          // Speak destination selected
          speak("Destination selected. You can proceed to the next step.");
        }}
      />
    );
  }

  return (
    <View style={styles.container}>
      {/* ✅ Speaker Button */}
      <TouchableOpacity style={styles.speakerBtn} onPress={toggleSpeaker}>
        <Ionicons
          name={speakerOn ? "volume-high" : "volume-mute"}
          size={28}
          color="black"
        />
      </TouchableOpacity>

      <Text style={styles.heading}>Cab Voice Assistant</Text>

      {/* STEP 1 */}
      {step === 1 && (
        <View style={styles.card}>
          <Text style={styles.title}>Step 1: Select Destination</Text>

          <TouchableOpacity
            style={styles.blueBtn}
            onPress={() => setMapOpen(true)}
          >
            <Text style={styles.btnText}>Open Map</Text>
          </TouchableOpacity>

          {destination && (
            <Text style={styles.selected}>
              ✅ Selected: {destination.address}
            </Text>
          )}

          <TouchableOpacity
            style={styles.greenBtn}
            disabled={!destination}
            onPress={() => goNext(2)}
          >
            <Text style={styles.btnText}>Next Step</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* STEP 2 */}
      {step === 2 && (
        <View style={styles.card}>
          <Text style={styles.title}>Step 2: Vehicle Number (Optional)</Text>

          <TextInput
            style={styles.input}
            placeholder="TS09AB1234 (optional)"
            value={vehicleNumber}
            onChangeText={setVehicleNumber}
          />

          <TouchableOpacity
            style={styles.greenBtn}
            onPress={() => goNext(3)}
          >
            <Text style={styles.btnText}>Next Step</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* STEP 3 */}
      {step === 3 && (
        <View style={styles.card}>
          <Text style={styles.title}>Step 3: Choose Vehicle Type</Text>

          <TouchableOpacity
            style={[
              styles.optionBtn,
              vehicleType === "motorcycle" && styles.selectedBtn,
            ]}
            onPress={() => setVehicleType("motorcycle")}
          >
            <Text>🛵 2/3 Wheeler</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.optionBtn,
              vehicleType === "driving" && styles.selectedBtn,
            ]}
            onPress={() => setVehicleType("driving")}
          >
            <Text>🚗 4 Wheeler</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.greenBtn}
            disabled={!vehicleType}
            onPress={() => {
              speak("Starting trip escort now.");
              // ✅ Pass routeData in the shape CabMonitoringScreen expects:
              //    { destination, vehicleType, vehicleNumber, startTripDirectly: true }
              navigateToCabMonitoring({
                destination,
                vehicleType,
                vehicleNumber,
                startTripDirectly: true,
              });
            }}
          >
            <Text style={styles.btnText}>Start Trip Escort</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Back */}
      <TouchableOpacity style={styles.backBtn} onPress={goBack}>
        <Text style={styles.btnText}>← Back</Text>
      </TouchableOpacity>
    </View>
  );
}

/* ✅ Styles */
const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: "#fff" },

  speakerBtn: {
    alignSelf: "flex-end",
    marginTop: 20,
    marginBottom: 10,
  },

  heading: { fontSize: 22, fontWeight: "bold", marginBottom: 20 },

  card: {
    padding: 20,
    borderRadius: 12,
    backgroundColor: "#f2f2f2",
  },

  title: { fontSize: 18, fontWeight: "bold", marginBottom: 15 },

  blueBtn: {
    backgroundColor: "#007AFF",
    padding: 14,
    borderRadius: 10,
    marginBottom: 10,
  },

  greenBtn: {
    backgroundColor: "green",
    padding: 14,
    borderRadius: 10,
    marginTop: 15,
  },

  btnText: { color: "#fff", textAlign: "center", fontWeight: "bold" },

  selected: { marginTop: 10, fontSize: 14, color: "green" },

  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    padding: 12,
    borderRadius: 10,
    backgroundColor: "#fff",
  },

  optionBtn: {
    padding: 15,
    borderRadius: 10,
    backgroundColor: "#fff",
    marginBottom: 10,
  },

  selectedBtn: {
    borderWidth: 2,
    borderColor: "green",
  },

  backBtn: {
    marginTop: 25,
    backgroundColor: "#444",
    padding: 14,
    borderRadius: 10,
  },
});
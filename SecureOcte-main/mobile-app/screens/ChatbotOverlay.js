import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { GooglePlacesAutocomplete } from "react-native-google-places-autocomplete";

/* -------- CHATBOT STEPS -------- */
const STEPS = {
  LANGUAGE: "LANGUAGE",
  MODE: "MODE",
  CAB_IMAGE: "CAB_IMAGE",
  CAB_DETAILS: "CAB_DETAILS",
};

export default function ChatbotOverlay({ onClose, onSelect }) {
  const [step, setStep] = useState(STEPS.LANGUAGE);
  const [language, setLanguage] = useState(null);

  const [driverImage, setDriverImage] = useState(null);
  const [destination, setDestination] = useState(null);
  const [vehicleType, setVehicleType] = useState(null);

  /* -------- STEP HANDLERS -------- */

  const chooseLanguage = (lang) => {
    setLanguage(lang);
    setStep(STEPS.MODE);
  };

  const startWalkMonitoring = () => {
    onClose();
    onSelect("walk"); // handled in HomeScreen/App.js
  };

  const startCabFlow = async () => {
    const result = await ImagePicker.launchCameraAsync({
      quality: 0.6,
      allowsEditing: true,
    });

    if (!result.canceled) {
      setDriverImage(result.assets[0].uri);
      setStep(STEPS.CAB_DETAILS);
    }
  };

  const startCabMonitoring = () => {
    if (!driverImage || !destination || !vehicleType) return;

    onClose();
    onSelect("cab", {
      driverImage,
      destination,
      vehicleType,
      language,
    });
  };

  /* -------- UI -------- */

  return (
    <View style={styles.overlay}>
      <View style={styles.card}>

        {/* -------- LANGUAGE -------- */}
        {step === STEPS.LANGUAGE && (
          <>
            <Text style={styles.title}>🤖 Choose your language</Text>
            <Btn text="Telugu" onPress={() => chooseLanguage("te")} />
            <Btn text="Hindi" onPress={() => chooseLanguage("hi")} />
            <Btn text="English" onPress={() => chooseLanguage("en")} />
          </>
        )}

        {/* -------- MODE -------- */}
        {step === STEPS.MODE && (
          <>
            <Text style={styles.title}>Choose travelling mode</Text>
            <Btn text="🚶 Walk Monitoring" onPress={startWalkMonitoring} />
            <Btn text="🚖 Cab Monitoring" onPress={startCabFlow} />
          </>
        )}

        {/* -------- CAB DETAILS -------- */}
        {step === STEPS.CAB_DETAILS && (
          <>
            <Text style={styles.title}>Cab Details</Text>

            {/* Destination autocomplete */}
            <GooglePlacesAutocomplete
              placeholder="Enter destination"
              fetchDetails={true}
              onPress={(data, details = null) => {
                setDestination({
                  address: data.description,
                  location: details?.geometry?.location,
                });
              }}
              query={{
                key: "AIzaSyAzfiI2Oh632S5vjsbDn0s_FMXJuzFGKwk",
                language: "en",
              }}
              styles={{
                textInput: styles.input,
                container: { marginBottom: 10 },
              }}
            />

            {/* Vehicle type */}
            <View style={styles.vehicleRow}>
              <VehicleBtn
                label="Auto"
                selected={vehicleType === "Auto"}
                onPress={() => setVehicleType("Auto")}
              />
              <VehicleBtn
                label="Cab"
                selected={vehicleType === "Cab"}
                onPress={() => setVehicleType("Cab")}
              />
              <VehicleBtn
                label="Bike"
                selected={vehicleType === "Bike"}
                onPress={() => setVehicleType("Bike")}
              />
            </View>

            <Btn text="Start Cab Monitoring" onPress={startCabMonitoring} />
          </>
        )}

        {/* Close */}
        <TouchableOpacity onPress={onClose}>
          <Text style={styles.close}>Close</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/* -------- REUSABLE COMPONENTS -------- */

const Btn = ({ text, onPress }) => (
  <TouchableOpacity style={styles.btn} onPress={onPress}>
    <Text style={styles.btnText}>{text}</Text>
  </TouchableOpacity>
);

const VehicleBtn = ({ label, selected, onPress }) => (
  <TouchableOpacity
    style={[
      styles.vehicleBtn,
      selected && styles.vehicleBtnSelected,
    ]}
    onPress={onPress}
  >
    <Text style={styles.vehicleText}>{label}</Text>
  </TouchableOpacity>
);

/* -------- STYLES -------- */

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    alignItems: "center",
  },
  card: {
    width: "88%",
    backgroundColor: "#0F1C2E",
    borderRadius: 20,
    padding: 20,
  },
  title: {
    color: "#F3F4ED",
    fontSize: 18,
    textAlign: "center",
    marginBottom: 15,
    fontWeight: "600",
  },
  btn: {
    backgroundColor: "#3A8694",
    paddingVertical: 14,
    borderRadius: 25,
    marginBottom: 10,
  },
  btnText: {
    color: "#fff",
    textAlign: "center",
    fontWeight: "600",
    fontSize: 15,
  },
  input: {
    backgroundColor: "#1C2B3A",
    color: "#fff",
    padding: 12,
    borderRadius: 10,
    fontSize: 14,
  },
  vehicleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  vehicleBtn: {
    flex: 1,
    backgroundColor: "#1C2B3A",
    padding: 10,
    borderRadius: 20,
    marginHorizontal: 4,
  },
  vehicleBtnSelected: {
    backgroundColor: "#3A8694",
  },
  vehicleText: {
    color: "#fff",
    textAlign: "center",
    fontWeight: "600",
  },
  close: {
    color: "#aaa",
    textAlign: "center",
    marginTop: 10,
  },
});

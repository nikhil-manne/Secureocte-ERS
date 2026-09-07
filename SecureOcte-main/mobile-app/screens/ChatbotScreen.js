import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import * as Speech from "expo-speech";
import * as ImagePicker from "expo-image-picker";

const STEPS = {
  LANGUAGE: "LANGUAGE",
  MODE: "MODE",
  CAB_CAMERA: "CAB_CAMERA",
  CAB_DETAILS: "CAB_DETAILS",
};

export default function ChatbotScreen({ onDone }) {
  const [step, setStep] = useState(STEPS.LANGUAGE);

  const speak = (text) => Speech.speak(text);

  const chooseLanguage = () => {
    speak("Choose your travelling mode");
    setStep(STEPS.MODE);
  };

  const startWalk = () => {
    onDone("walk");
  };

  const startCab = async () => {
    speak("Please take a photo of the vehicle");
    await ImagePicker.launchCameraAsync();
    onDone("cab");
  };

  return (
    <View style={styles.container}>
      {step === STEPS.LANGUAGE && (
        <>
          <Text style={styles.title}>Choose Language</Text>
          <Btn title="Telugu" onPress={chooseLanguage} />
          <Btn title="Hindi" onPress={chooseLanguage} />
          <Btn title="English" onPress={chooseLanguage} />
        </>
      )}

      {step === STEPS.MODE && (
        <>
          <Text style={styles.title}>Choose Travel Mode</Text>
          <Btn title="🚶 Walk Monitoring" onPress={startWalk} />
          <Btn title="🚖 Cab Monitoring" onPress={startCab} />
        </>
      )}
    </View>
  );
}

const Btn = ({ title, onPress }) => (
  <TouchableOpacity style={styles.btn} onPress={onPress}>
    <Text style={styles.btnText}>{title}</Text>
  </TouchableOpacity>
);

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0F1C2E",
    justifyContent: "center",
    padding: 20,
  },
  title: {
    fontSize: 22,
    color: "#F3F4ED",
    textAlign: "center",
    marginBottom: 20,
  },
  btn: {
    backgroundColor: "#3A8694",
    padding: 15,
    borderRadius: 30,
    marginBottom: 15,
  },
  btnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
});

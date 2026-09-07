import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import MapView, { Marker } from "react-native-maps";

export default function MapPickerScreen({ onSelectSection, params }) {
  const [pin, setPin] = useState(null);

  const confirm = () => {
    if (!pin) return;

    /* Send back destination */
    params.onDestinationSelected(pin);

    /* Return to cab assistant */
    onSelectSection("cabVoiceAssistant");
  };

  return (
    <View style={{ flex: 1 }}>
      <MapView
        style={{ flex: 1 }}
        onPress={(e) => setPin(e.nativeEvent.coordinate)}
      >
        {pin && <Marker coordinate={pin} />}
      </MapView>

      <TouchableOpacity style={styles.confirmBtn} onPress={confirm}>
        <Text style={{ color: "white" }}>Confirm Destination</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  confirmBtn: {
    position: "absolute",
    bottom: 30,
    alignSelf: "center",
    backgroundColor: "green",
    padding: 15,
    borderRadius: 20,
  },
});
